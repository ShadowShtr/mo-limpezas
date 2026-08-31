/**
 * 086 — cobrança avulsa e o dinheiro da cobrança numa só transação.
 *
 * Três coisas provadas aqui, todas em PostgreSQL 17 real:
 *
 *   1. `manual_charges` existe como entidade própria, com as guardas de
 *      tenant, valor e anulação.
 *
 *   2. 🔴 ATOMICIDADE. Hoje `setServicePayment` faz `UPDATE services` e só
 *      DEPOIS sincroniza o caixa. Se a segunda falhar, o serviço fica
 *      «recebido» e o caixa fica no estado anterior. Os testes de injecção de
 *      falha provam que, com a RPC, isso deixa de ser possível: ou mudam os
 *      dois lados, ou não muda nenhum.
 *
 *   3. 🔴 APAGAR UM SERVIÇO PAGO passa a ser recusado. `cash_flow_entries`
 *      não tem FK para `services` — apagar um serviço com recebimento
 *      deixaria o movimento órfão. Produção tem hoje ZERO órfãos; estes
 *      testes existem para que continue a ter.
 *
 * Postgres 17 real, em Docker: é a versão de produção.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `mc-086-${process.pid}`;
const IMAGEM = "postgres:17-alpine";
let port = 0;
let cli: pg.Client;

const EMP_A = "11111111-1111-4111-8111-111111111111";
const EMP_B = "22222222-2222-4222-8222-222222222222";
const CLI_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const CLI_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ADMIN_A = "aaaaaaaa-0000-4000-8000-000000000001";

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}
const sql = (f: string) => readFileSync(join(ROOT, "supabase", "migrations", f), "utf8");

/** Schema mínimo com o que a 086 toca. */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, role text);
  CREATE TABLE public.clients (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL,
    status text DEFAULT 'ativo');
  CREATE TABLE public.company_settings (
    company_id uuid PRIMARY KEY, vat_rate numeric DEFAULT 23);
  CREATE TABLE public.contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    status text DEFAULT 'ativo', fixed_monthly boolean DEFAULT false,
    fixed_price numeric, apply_vat boolean DEFAULT true,
    excluded_dates date[] DEFAULT '{}');
  CREATE TABLE public.services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    contract_id uuid, location_id uuid, reference_number text,
    scheduled_start timestamptz NOT NULL, status text DEFAULT 'agendado',
    manual_value numeric, calculated_value numeric, apply_vat boolean DEFAULT true,
    payment_status text DEFAULT 'nao_informado', paid_amount numeric,
    paid_at timestamptz);
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')),
    amount numeric(10,2) NOT NULL, description text NOT NULL,
    category text DEFAULT 'outro', date date NOT NULL,
    reference_id uuid, reference_type text,
    status text NOT NULL DEFAULT 'confirmado',
    notes text, created_by uuid, created_at timestamptz DEFAULT now(),
    expense_category_id uuid);
  CREATE TABLE public.data_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text, row_id uuid,
    op text, old_data jsonb, new_data jsonb, actor uuid, company_id uuid,
    changed_fields text[], created_at timestamptz DEFAULT now());

  -- O índice único da 024: no máximo um movimento automático por origem.
  CREATE UNIQUE INDEX cash_flow_entries_reference_unique
    ON public.cash_flow_entries (company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

  ALTER TABLE public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_reference_type_check
    CHECK (reference_type IS NULL OR reference_type IN
      ('invoice','payroll','service_payment','fixed_variable_payment'));

  CREATE OR REPLACE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $g$ SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $g$;
  CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $r$ SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;

  -- A função de histórico da 062, de que a 086 pendura um trigger.
  CREATE OR REPLACE FUNCTION public.fn_capture_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $h$
  DECLARE v_old jsonb; v_new jsonb; v_actor uuid;
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
    v_old := to_jsonb(OLD);
    IF TG_OP = 'DELETE' THEN
      INSERT INTO public.data_history (table_name, row_id, op, old_data, actor, company_id)
      VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', v_old, v_actor,
              NULLIF(v_old ->> 'company_id','')::uuid);
      RETURN OLD;
    END IF;
    v_new := to_jsonb(NEW);
    IF v_old IS DISTINCT FROM v_new THEN
      INSERT INTO public.data_history (table_name, row_id, op, old_data, new_data, actor, company_id)
      VALUES (TG_TABLE_NAME, OLD.id, 'UPDATE', v_old, v_new, v_actor,
              NULLIF(v_new ->> 'company_id','')::uuid);
    END IF;
    RETURN NEW;
  END $h$;

  -- A 062, tal como está no master — a 086 faz CREATE OR REPLACE dela.
  CREATE OR REPLACE FUNCTION public.delete_calendar_service_safe(
    p_service_id uuid, p_scope text, p_company_id uuid, p_actor uuid DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $d$
  DECLARE v_svc record; v_deleted int := 0;
  BEGIN
    SELECT id, contract_id, scheduled_start, location_id INTO v_svc
      FROM public.services WHERE id = p_service_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Serviço não encontrado.'; END IF;
    DELETE FROM public.services WHERE id = p_service_id AND company_id = p_company_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN jsonb_build_object('deleted', v_deleted, 'recurring', false);
  END $d$;
`;

const SEED = `
  INSERT INTO public.companies(id,name) VALUES('${EMP_A}','A'),('${EMP_B}','B');
  INSERT INTO public.profiles(id,company_id,role) VALUES('${ADMIN_A}','${EMP_A}','admin');
  INSERT INTO public.clients(id,company_id,name) VALUES
    ('${CLI_A}','${EMP_A}','Cliente A'), ('${CLI_B}','${EMP_B}','Cliente B');
  INSERT INTO public.company_settings(company_id, vat_rate) VALUES('${EMP_A}', 23);
`;

/** Cria uma cobrança avulsa e devolve o id. */
async function novaCobranca(amount = 100, applyVat = true): Promise<string> {
  const r = await cli.query(
    `INSERT INTO public.manual_charges
       (company_id, client_id, charge_date, description, amount, apply_vat)
     VALUES ($1,$2,CURRENT_DATE,'Cobranca teste',$3,$4) RETURNING id`,
    [EMP_A, CLI_A, amount, applyVat],
  );
  return r.rows[0].id;
}

/** Cria um serviço e devolve o id. */
async function novoServico(valor = 100): Promise<string> {
  const r = await cli.query(
    `INSERT INTO public.services
       (company_id, reference_number, scheduled_start, manual_value, apply_vat)
     VALUES ($1,'S-001', now(), $2, true) RETURNING id`,
    [EMP_A, valor],
  );
  return r.rows[0].id;
}

const caixaDe = async (tipo: string, id: string) =>
  cli.query(
    `SELECT amount, status FROM public.cash_flow_entries
      WHERE company_id=$1 AND reference_type=$2 AND reference_id=$3`,
    [EMP_A, tipo, id],
  );

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const up = docker(["run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=az",
    "-p", "127.0.0.1::5432", IMAGEM]);
  if (up.status !== 0) throw new Error(up.stderr || up.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));

  for (let i = 0; i < 90; i++) {
    try {
      cli = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "az" });
      await cli.connect();
      break;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }

  await cli.query(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $u$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $u$;
    GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;`);
  await cli.query(BASELINE);
  await cli.query(SEED);
  await cli.query(sql("086_manual_charges_and_atomic_billing.sql"));
}, 300_000);

afterAll(async () => {
  await cli?.end();
  docker(["rm", "-f", CONTAINER]);
});

// ═══════════════════════════════════════════════════════════════════════════
// A–C. manual_charges — a entidade e as suas guardas
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("086 — manual_charges existe e protege-se", () => {
  it("A. cria uma cobrança avulsa válida", async () => {
    const id = await novaCobranca(250, true);
    const r = await cli.query("SELECT * FROM public.manual_charges WHERE id=$1", [id]);
    expect(r.rowCount).toBe(1);
    expect(Number(r.rows[0].amount)).toBe(250);
    expect(r.rows[0].payment_status).toBe("nao_informado");
    expect(r.rows[0].voided_at).toBeNull();
  });

  it("🔴 B. cliente de OUTRA empresa é recusado pela base", async () => {
    // Duas FKs separadas não impediriam isto — a FK composta impede.
    await expect(cli.query(
      `INSERT INTO public.manual_charges
         (company_id, client_id, charge_date, description, amount, apply_vat)
       VALUES ($1,$2,CURRENT_DATE,'cross tenant',100,true)`,
      [EMP_A, CLI_B],
    )).rejects.toThrow();
  });

  it("C. valor <= 0 é recusado", async () => {
    for (const mau of [0, -10]) {
      await expect(cli.query(
        `INSERT INTO public.manual_charges
           (company_id, client_id, charge_date, description, amount, apply_vat)
         VALUES ($1,$2,CURRENT_DATE,'invalido',$3,true)`,
        [EMP_A, CLI_A, mau],
      )).rejects.toThrow();
    }
  });

  it("uma anulação sem autor é recusada — um void tem de ter dono", async () => {
    const id = await novaCobranca();
    await expect(cli.query(
      "UPDATE public.manual_charges SET voided_at = now() WHERE id=$1", [id],
    )).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D–H. Pagamento de cobrança avulsa — os dois lados, sempre juntos
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("086 — recebimento de cobrança avulsa é atómico", () => {
  it("D. 50%: cobrança e caixa entram juntos", async () => {
    const id = await novaCobranca(100, true); // total c/IVA = 123
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'sinal_50',NULL,$3)",
      [EMP_A, id, ADMIN_A]);

    const chg = await cli.query("SELECT payment_status, paid_at FROM public.manual_charges WHERE id=$1", [id]);
    const cx = await caixaDe("manual_charge", id);
    expect(chg.rows[0].payment_status).toBe("sinal_50");
    expect(chg.rows[0].paid_at).not.toBeNull();
    expect(cx.rowCount).toBe(1);
    expect(Number(cx.rows[0].amount)).toBe(61.5);
  });

  it("E. 100%: cobrança e caixa entram juntos, com o total c/IVA", async () => {
    const id = await novaCobranca(100, true);
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    const cx = await caixaDe("manual_charge", id);
    expect(Number(cx.rows[0].amount)).toBe(123);
  });

  it("sem IVA, o total é o valor da obrigação", async () => {
    const id = await novaCobranca(80, false);
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    const cx = await caixaDe("manual_charge", id);
    expect(Number(cx.rows[0].amount)).toBe(80);
  });

  it("F. valor livre: o valor exacto nos DOIS lados", async () => {
    const id = await novaCobranca(100, true);
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'sinal_50',$3,$4)",
      [EMP_A, id, 42.75, ADMIN_A]);
    const chg = await cli.query("SELECT paid_amount FROM public.manual_charges WHERE id=$1", [id]);
    const cx = await caixaDe("manual_charge", id);
    expect(Number(chg.rows[0].paid_amount)).toBe(42.75);
    expect(Number(cx.rows[0].amount)).toBe(42.75);
  });

  it("G. remover o recebimento apaga estado e caixa na mesma transação", async () => {
    const id = await novaCobranca(100, true);
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    expect((await caixaDe("manual_charge", id)).rowCount).toBe(1);

    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'nao_informado',NULL,$3)",
      [EMP_A, id, ADMIN_A]);

    const chg = await cli.query("SELECT payment_status, paid_at FROM public.manual_charges WHERE id=$1", [id]);
    expect(chg.rows[0].payment_status).toBe("nao_informado");
    expect(chg.rows[0].paid_at).toBeNull();
    expect((await caixaDe("manual_charge", id)).rowCount).toBe(0);
  });

  it("🔴 H. INJECÇÃO DE FALHA: se o caixa falhar, a cobrança NÃO muda", async () => {
    const id = await novaCobranca(100, true);
    const antes = await cli.query("SELECT payment_status FROM public.manual_charges WHERE id=$1", [id]);

    // Um CHECK impossível na tabela de caixa faz o INSERT rebentar DENTRO da
    // transação da RPC. É a simulação do «segundo passo falhou».
    await cli.query(`ALTER TABLE public.cash_flow_entries
      ADD CONSTRAINT cf_falha_forcada CHECK (reference_type <> 'manual_charge')`);
    let erro = "";
    try {
      await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
        [EMP_A, id, ADMIN_A]);
    } catch (e) { erro = (e as Error).message; }
    await cli.query("ALTER TABLE public.cash_flow_entries DROP CONSTRAINT cf_falha_forcada");

    expect(erro).not.toBe("");
    const depois = await cli.query("SELECT payment_status, paid_at FROM public.manual_charges WHERE id=$1", [id]);
    // 🔴 A prova: o estado ficou EXACTAMENTE como estava.
    expect(depois.rows[0].payment_status).toBe(antes.rows[0].payment_status);
    expect(depois.rows[0].paid_at).toBeNull();
    expect((await caixaDe("manual_charge", id)).rowCount).toBe(0);
  });

  it("uma cobrança anulada não aceita recebimento", async () => {
    const id = await novaCobranca();
    await cli.query("SELECT * FROM public.void_manual_charge_atomic($1,$2,$3)", [EMP_A, id, ADMIN_A]);
    await expect(cli.query(
      "SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A],
    )).rejects.toThrow(/MANUAL_CHARGE_VOIDED/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I–J. Pagamento de SERVIÇO — o buraco de atomicidade que existia
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("086 — recebimento de serviço é atómico", () => {
  it("I. serviço e caixa mudam juntos", async () => {
    const id = await novoServico(100); // 100 + IVA = 123
    await cli.query("SELECT * FROM public.set_service_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);

    const svc = await cli.query("SELECT payment_status, paid_at FROM public.services WHERE id=$1", [id]);
    const cx = await caixaDe("service_payment", id);
    expect(svc.rows[0].payment_status).toBe("pago_total");
    expect(svc.rows[0].paid_at).not.toBeNull();
    expect(Number(cx.rows[0].amount)).toBe(123);
  });

  it("🔴 J. INJECÇÃO DE FALHA: se o caixa falhar, o SERVIÇO fica intacto", async () => {
    // Este é o defeito que existia: `UPDATE services` commitava e o caixa
    // podia falhar a seguir, deixando «recebido» sem dinheiro nenhum.
    const id = await novoServico(100);
    await cli.query(`ALTER TABLE public.cash_flow_entries
      ADD CONSTRAINT cf_falha_svc CHECK (reference_type <> 'service_payment')`);
    let erro = "";
    try {
      await cli.query("SELECT * FROM public.set_service_payment_atomic($1,$2,'pago_total',NULL,$3)",
        [EMP_A, id, ADMIN_A]);
    } catch (e) { erro = (e as Error).message; }
    await cli.query("ALTER TABLE public.cash_flow_entries DROP CONSTRAINT cf_falha_svc");

    expect(erro).not.toBe("");
    const svc = await cli.query("SELECT payment_status, paid_amount, paid_at FROM public.services WHERE id=$1", [id]);
    expect(svc.rows[0].payment_status).toBe("nao_informado");
    expect(svc.rows[0].paid_amount).toBeNull();
    expect(svc.rows[0].paid_at).toBeNull();
    expect((await caixaDe("service_payment", id)).rowCount).toBe(0);
  });

  it("remover o recebimento do serviço apaga os dois lados", async () => {
    const id = await novoServico(100);
    await cli.query("SELECT * FROM public.set_service_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    await cli.query("SELECT * FROM public.set_service_payment_atomic($1,$2,'nao_informado',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    const svc = await cli.query("SELECT payment_status FROM public.services WHERE id=$1", [id]);
    expect(svc.rows[0].payment_status).toBe("nao_informado");
    expect((await caixaDe("service_payment", id)).rowCount).toBe(0);
  });

  it("avença mensal: o valor é a FATIA do mês, não o preço todo", async () => {
    const ct = await cli.query(
      `INSERT INTO public.contracts(company_id, fixed_monthly, fixed_price, apply_vat)
       VALUES($1, true, 400, false) RETURNING id`, [EMP_A]);
    const contractId = ct.rows[0].id;
    // Quatro serviços no mesmo mês → fatia = 100.
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await cli.query(
        `INSERT INTO public.services(company_id, contract_id, reference_number, scheduled_start)
         VALUES($1,$2,$3, date_trunc('month', now()) + interval '1 day') RETURNING id`,
        [EMP_A, contractId, `AV-${i}`]);
      ids.push(r.rows[0].id);
    }
    await cli.query("SELECT * FROM public.set_service_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, ids[0], ADMIN_A]);
    const cx = await caixaDe("service_payment", ids[0]);
    expect(Number(cx.rows[0].amount)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K–O. Apagar serviço pago — fail-closed, e zero órfãos
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("086 — apagar serviço com recebimento é recusado", () => {
  it("K. serviço PAGO: delete bloqueado", async () => {
    const id = await novoServico(100);
    await cli.query("SELECT * FROM public.set_service_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);

    await expect(cli.query("SELECT public.delete_calendar_service_safe($1,'single',$2,$3)",
      [id, EMP_A, ADMIN_A])).rejects.toThrow(/SERVICE_DELETE_BLOCKED_BY_PAYMENT/);

    // E nada foi apagado.
    const r = await cli.query("SELECT id FROM public.services WHERE id=$1", [id]);
    expect(r.rowCount).toBe(1);
  });

  it("L. serviço com CASHFLOW mas estado limpo: delete bloqueado na mesma", async () => {
    // O caixa é a autoridade: mesmo que alguém tivesse limpo o estado à mão,
    // o movimento continua a existir e não pode ficar órfão.
    const id = await novoServico(100);
    await cli.query(
      `INSERT INTO public.cash_flow_entries
         (company_id,type,amount,description,category,date,reference_id,reference_type,status)
       VALUES($1,'entrada',50,'manual','faturacao',CURRENT_DATE,$2,'service_payment','confirmado')`,
      [EMP_A, id]);

    await expect(cli.query("SELECT public.delete_calendar_service_safe($1,'single',$2,$3)",
      [id, EMP_A, ADMIN_A])).rejects.toThrow(/SERVICE_DELETE_BLOCKED_BY_PAYMENT/);
  });

  it("M. serviço LIMPO: continua a poder ser apagado", async () => {
    const id = await novoServico(100);
    const r = await cli.query("SELECT public.delete_calendar_service_safe($1,'single',$2,$3) AS j",
      [id, EMP_A, ADMIN_A]);
    expect(r.rows[0].j.deleted).toBe(1);
    expect((await cli.query("SELECT id FROM public.services WHERE id=$1", [id])).rowCount).toBe(0);
  });

  it("🔴 N. scope=all com UMA ocorrência paga: ZERO apagadas", async () => {
    const ct = await cli.query(
      `INSERT INTO public.contracts(company_id, status) VALUES($1,'ativo') RETURNING id`, [EMP_A]);
    const contractId = ct.rows[0].id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await cli.query(
        `INSERT INTO public.services(company_id, contract_id, reference_number, scheduled_start, manual_value)
         VALUES($1,$2,$3, now() + ($4 || ' days')::interval, 100) RETURNING id`,
        [EMP_A, contractId, `R-${i}`, String(i)]);
      ids.push(r.rows[0].id);
    }
    // Só a do meio tem recebimento.
    await cli.query("SELECT * FROM public.set_service_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, ids[1], ADMIN_A]);

    await expect(cli.query("SELECT public.delete_calendar_service_safe($1,'all',$2,$3)",
      [ids[0], EMP_A, ADMIN_A])).rejects.toThrow(/SERVICE_DELETE_BLOCKED_BY_PAYMENT/);

    // 🔴 Nenhuma foi apagada — nem as duas que estavam limpas. Apagar duas e
    //    parar na terceira seria pior do que não apagar nenhuma.
    const restantes = await cli.query(
      "SELECT count(*)::int n FROM public.services WHERE contract_id=$1", [contractId]);
    expect(restantes.rows[0].n).toBe(3);
    // E o contrato não foi arquivado.
    const ctr = await cli.query("SELECT status FROM public.contracts WHERE id=$1", [contractId]);
    expect(ctr.rows[0].status).toBe("ativo");
  });

  it("🔴 O. depois de tudo isto: ZERO movimentos órfãos", async () => {
    // O invariante que produção tem hoje e que estas guardas preservam.
    const orfaos = await cli.query(`
      SELECT count(*)::int n FROM public.cash_flow_entries c
       WHERE c.reference_type = 'service_payment'
         AND NOT EXISTS (SELECT 1 FROM public.services s WHERE s.id = c.reference_id)`);
    expect(orfaos.rows[0].n).toBe(0);

    const orfaosMc = await cli.query(`
      SELECT count(*)::int n FROM public.cash_flow_entries c
       WHERE c.reference_type = 'manual_charge'
         AND NOT EXISTS (SELECT 1 FROM public.manual_charges m WHERE m.id = c.reference_id)`);
    expect(orfaosMc.rows[0].n).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Editar / anular cobrança avulsa — fail-closed sobre dinheiro
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("086 — editar e anular cobrança avulsa", () => {
  it("sem recebimento: editar e anular funcionam", async () => {
    const id = await novaCobranca(100);
    await cli.query(
      `SELECT * FROM public.update_manual_charge_atomic($1,$2,$3::jsonb,$4)`,
      [EMP_A, id, JSON.stringify({ description: "Nova descrição", amount: 150 }), ADMIN_A]);
    const r = await cli.query("SELECT description, amount FROM public.manual_charges WHERE id=$1", [id]);
    expect(r.rows[0].description).toBe("Nova descrição");
    expect(Number(r.rows[0].amount)).toBe(150);

    await cli.query("SELECT * FROM public.void_manual_charge_atomic($1,$2,$3)", [EMP_A, id, ADMIN_A]);
    const v = await cli.query("SELECT voided_at, voided_by FROM public.manual_charges WHERE id=$1", [id]);
    expect(v.rows[0].voided_at).not.toBeNull();
    expect(v.rows[0].voided_by).toBe(ADMIN_A);
  });

  it("🔴 com recebimento: alterar o VALOR é recusado", async () => {
    const id = await novaCobranca(100);
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    await expect(cli.query(
      `SELECT * FROM public.update_manual_charge_atomic($1,$2,$3::jsonb,$4)`,
      [EMP_A, id, JSON.stringify({ amount: 999 }), ADMIN_A],
    )).rejects.toThrow(/MANUAL_CHARGE_PAID_AMOUNT_LOCKED/);
  });

  it("com recebimento: a DESCRIÇÃO continua editável — não mexe em dinheiro", async () => {
    const id = await novaCobranca(100);
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    await cli.query(
      `SELECT * FROM public.update_manual_charge_atomic($1,$2,$3::jsonb,$4)`,
      [EMP_A, id, JSON.stringify({ description: "Corrigida" }), ADMIN_A]);
    const r = await cli.query("SELECT description FROM public.manual_charges WHERE id=$1", [id]);
    expect(r.rows[0].description).toBe("Corrigida");
  });

  it("🔴 com recebimento: anular é recusado — o movimento ficaria sem origem", async () => {
    const id = await novaCobranca(100);
    await cli.query("SELECT * FROM public.set_manual_charge_payment_atomic($1,$2,'pago_total',NULL,$3)",
      [EMP_A, id, ADMIN_A]);
    await expect(cli.query("SELECT * FROM public.void_manual_charge_atomic($1,$2,$3)",
      [EMP_A, id, ADMIN_A])).rejects.toThrow(/MANUAL_CHARGE_HAS_PAYMENT/);
  });

  it("campo não editável é recusado por nome", async () => {
    const id = await novaCobranca(100);
    await expect(cli.query(
      `SELECT * FROM public.update_manual_charge_atomic($1,$2,$3::jsonb,$4)`,
      [EMP_A, id, JSON.stringify({ payment_status: "pago_total" }), ADMIN_A],
    )).rejects.toThrow(/MANUAL_CHARGE_FIELD_NOT_EDITABLE/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P–Q. ACL, RLS e idempotência
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("086 — ACL, RLS e reaplicação", () => {
  it("P. ACL de tabela: anon nada, authenticated só SELECT", async () => {
    const priv = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
    const cols = priv.map((p) => `has_table_privilege('anon','public.manual_charges','${p}') "a_${p}", has_table_privilege('authenticated','public.manual_charges','${p}') "u_${p}"`).join(", ");
    const r = await cli.query(`SELECT ${cols}`);
    for (const p of priv) {
      expect(r.rows[0][`a_${p}`], `anon ${p}`).toBe(false);
      expect(r.rows[0][`u_${p}`], `authenticated ${p}`).toBe(p === "SELECT");
    }
  });

  it("P. as RPCs são service_role-only", async () => {
    const r = await cli.query(`SELECT p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
        has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('set_service_payment_atomic','set_manual_charge_payment_atomic',
         'void_manual_charge_atomic','update_manual_charge_atomic',
         'delete_calendar_service_safe')`);
    expect(r.rowCount).toBe(5);
    for (const f of r.rows) {
      expect(f.anon_x, `${f.proname} anon`).toBe(false);
      expect(f.auth_x, `${f.proname} authenticated`).toBe(false);
      expect(f.svc_x, `${f.proname} service_role`).toBe(true);
    }
  });

  it("P. RLS ligado, e só a policy de leitura de gestão", async () => {
    const rls = await cli.query(
      "SELECT relrowsecurity FROM pg_class WHERE oid='public.manual_charges'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const pol = await cli.query(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname='public' AND tablename='manual_charges'`);
    expect(pol.rows.map((p: { policyname: string }) => p.policyname)).toEqual(["manual_charges_manager_select"]);
    expect(pol.rows[0].cmd).toBe("SELECT");
  });

  it("P. reference_type aceita manual_charge e mantém os anteriores", async () => {
    const def = await cli.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conname='cash_flow_entries_reference_type_check'`);
    const d = def.rows[0].d as string;
    for (const t of ["invoice", "payroll", "service_payment", "fixed_variable_payment", "manual_charge"]) {
      expect(d, t).toContain(t);
    }
  });

  it("Q. reaplicar a migration é seguro (idempotente)", async () => {
    await cli.query(sql("086_manual_charges_and_atomic_billing.sql"));
    const r = await cli.query("SELECT count(*)::int n FROM public.manual_charges");
    expect(r.rows[0].n).toBeGreaterThan(0); // não apagou nada
    const pol = await cli.query(
      `SELECT count(*)::int n FROM pg_policies
        WHERE schemaname='public' AND tablename='manual_charges'`);
    expect(pol.rows[0].n).toBe(1); // não duplicou a policy
  });
});
