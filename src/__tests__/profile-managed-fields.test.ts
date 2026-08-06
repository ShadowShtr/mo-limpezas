// ============================================================================
// GUARDAS ESTÁTICAS — campos laborais e administrativos de profiles (070)
// ============================================================================
// Task T04 do plano mestre (docs/PLANO-MESTRE.md, secção 25).
//
// LIMITE DESTE FICHEIRO, dito à partida: estes testes leem SQL e código. Provam
// que as cláusulas certas estão escritas e que nenhum fluxo da aplicação passou
// a escrever em `profiles` por fora do service role. NÃO provam que a base
// recusa a escrita — isso exige Postgres, e este repositório não tem
// infraestrutura de testes contra base real (mesmo limite de
// `tenant-isolation-hotfix.test.ts` e `reversao-guards.test.ts`).
//
// A prova de runtime existe e é executável:
//   node scripts/verify-profile-guards.mjs --database-url <descartavel> \
//     --i-know-this-database-is-disposable
//
// O plano mestre é explícito quanto a isto na secção 15.2: um teste que procura
// uma string num ficheiro SQL não prova compilação, existência na base, nem
// isolamento. Estes servem de guarda contra regressão silenciosa, nada mais.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

// Normalizado para LF: um checkout pode materializar as migrations com CRLF.
const readNormalized = (p: string) =>
  fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const migration070 = readNormalized(
  path.join(ROOT, "supabase/migrations/070_guard_profile_managed_fields.sql"),
);

const migration069 = readNormalized(
  path.join(ROOT, "supabase/migrations/069_guard_profile_tenant_role.sql"),
);

/** Campos que só service_role ou admin/gestor da própria empresa podem mudar. */
const CAMPOS_GERIDOS = [
  "hourly_rate",
  "contracted_hours_month",
  "contract_start",
  "contract_end",
  "vacation_balance",
  "status",
  "skills",
  "invited_at",
  "invite_accepted_at",
];

/** Campos pessoais que o próprio continua a poder editar. */
const CAMPOS_PESSOAIS = [
  "full_name",
  "phone",
  "email",
  "nif",
  "iban",
  "avatar_url",
  "availability",
];

describe("070 — proteção dos campos laborais de profiles", () => {
  it("cobre todos os campos geridos identificados no schema", () => {
    const naoCobertos = CAMPOS_GERIDOS.filter(
      (campo) =>
        !new RegExp(`NEW\\.${campo}\\s+IS DISTINCT FROM\\s+OLD\\.${campo}`).test(
          migration070,
        ),
    );

    expect(naoCobertos).toEqual([]);
  });

  it("não bloqueia os campos pessoais", () => {
    // Um campo pessoal não pode aparecer numa comparação NEW/OLD — se
    // aparecesse, passaria a exigir admin para o próprio o editar.
    const bloqueados = CAMPOS_PESSOAIS.filter((campo) =>
      new RegExp(`NEW\\.${campo}\\s+IS DISTINCT FROM\\s+OLD\\.${campo}`).test(
        migration070,
      ),
    );

    expect(bloqueados).toEqual([]);
  });

  it("não repete a guarda de company_id/role que já é da 069", () => {
    // Uma regra, um sítio. Se a 070 também validasse estes campos, passariam
    // a existir duas fontes da mesma decisão.
    for (const campo of ["company_id", "role"]) {
      expect(
        new RegExp(`NEW\\.${campo}\\s+IS DISTINCT FROM\\s+OLD\\.${campo}`).test(
          migration070,
        ),
        `a 070 não deve reimplementar a guarda de ${campo}`,
      ).toBe(false);

      expect(
        new RegExp(`NEW\\.${campo}\\s+IS DISTINCT FROM\\s+OLD\\.${campo}`).test(
          migration069,
        ),
        `a 069 deve continuar a ser dona da guarda de ${campo}`,
      ).toBe(true);
    }
  });

  it("permite service_role e admin/gestor da mesma empresa, e mais ninguém", () => {
    expect(migration070).toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(migration070).toMatch(
      /public\.get_my_role\(\)\s+IN\s+\('admin',\s*'gestor'\)/,
    );
    expect(migration070).toMatch(
      /public\.get_my_company_id\(\)\s*=\s*OLD\.company_id/,
    );
    // A empresa não pode mudar de caminho: sem isto, esta guarda abriria uma
    // segunda porta para o que a 069 fecha.
    expect(migration070).toMatch(/NEW\.company_id\s*=\s*OLD\.company_id/);
  });

  it("falha com um código de erro estável", () => {
    expect(migration070).toContain("PROFILE_MANAGED_FIELD_BLOCKED");
    expect(migration070).toMatch(/USING ERRCODE = 'P0001'/);
  });

  it("é um trigger BEFORE UPDATE em public.profiles", () => {
    expect(migration070).toMatch(
      /CREATE TRIGGER trg_guard_profile_managed_fields\s+BEFORE UPDATE ON public\.profiles/,
    );
    expect(migration070).toMatch(/FOR EACH ROW/);
  });

  it("documenta um rollback que não deixa resíduo", () => {
    expect(migration070).toMatch(
      /DROP TRIGGER IF EXISTS trg_guard_profile_managed_fields ON public\.profiles;/,
    );
    expect(migration070).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_guard_profile_managed_fields\(\);/,
    );
    // Reversível de verdade: não cria, altera nem apaga colunas.
    expect(migration070).not.toMatch(/ALTER TABLE\s+(public\.)?profiles/i);
    expect(migration070).not.toMatch(/DROP COLUMN/i);
  });

  it("a 069 continua intacta — a 070 não a reescreve", () => {
    expect(migration070).not.toMatch(/fn_guard_profile_tenant_role/);
    expect(migration069).toContain("PROFILE_ROLE_ESCALATION_BLOCKED");
    expect(migration069).toContain("PROFILE_COMPANY_CHANGE_BLOCKED");
  });
});

describe("070 — os fluxos administrativos continuam a funcionar", () => {
  const escritores = [
    "src/app/actions/colaboradores.ts",
    "src/app/actions/csv-import.ts",
  ];

  it("todas as escritas em profiles passam por service role", () => {
    // A guarda tem uma única válvula de escape: `auth.role() = 'service_role'`.
    // Se algum fluxo passar a escrever com o cliente do utilizador, deixa de
    // funcionar — e este teste avisa antes de isso chegar a produção.
    for (const rel of escritores) {
      const content = readNormalized(path.join(ROOT, rel));

      expect(content, `${rel} deve usar createAdminClient`).toMatch(
        /createAdminClient/,
      );
    }
  });

  it("nenhum componente client-side escreve em profiles", () => {
    const componentes: string[] = [];

    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) componentes.push(p);
      }
    };

    walk(path.join(ROOT, "src"));

    const infratores = componentes.filter((p) => {
      const content = readNormalized(p);
      if (!/^\s*["']use client["']/m.test(content)) return false;
      if (!/from\(["']profiles["']\)/.test(content)) return false;
      // Leitura é legítima; o problema é escrita a partir do browser.
      return /from\(["']profiles["']\)[\s\S]{0,200}?\.(update|upsert|insert)\(/.test(
        content,
      );
    });

    expect(infratores.map((p) => path.relative(ROOT, p))).toEqual([]);
  });

  it("o script de verificação real existe e recusa-se a tocar em produção", () => {
    const rel = "scripts/verify-profile-guards.mjs";

    expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);

    const script = readNormalized(path.join(ROOT, rel));

    // Nunca lê a URL do ambiente: tem de ser passada à mão.
    expect(script).not.toMatch(/process\.env\.SUPABASE_DB_URL/);
    expect(script).toMatch(/--database-url/);
    expect(script).toMatch(/--i-know-this-database-is-disposable/);
    // Recusa o projeto configurado e reverte sempre.
    expect(script).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(script).toMatch(/ROLLBACK/);
  });
});
