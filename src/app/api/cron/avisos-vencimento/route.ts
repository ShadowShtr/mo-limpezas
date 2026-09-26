import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/cron-auth";
import { notifyUser } from "@/lib/push-notify";
import { carregarAvisos } from "@/lib/avisos/load-avisos";
import { todayInLisbon } from "@/lib/lisbon-time";
import { estadoAutoriza } from "@/domain/collaborators/status";
import {
  dedupeKey,
  NOTIFICATION_TYPE,
  URGENCIA_LABEL,
  type AvisoItem,
} from "@/domain/avisos/types";

export const maxDuration = 60;

// ============================================================================
// CRON DIÁRIO — os prazos de hoje no sino de quem gere
// ============================================================================
//
// 🔴 As quatro consultas correm UMA VEZ POR EMPRESA, não uma vez por pessoa.
//
//    Uma empresa com cinco gestores tem os mesmos prazos para os cinco. Correr
//    o loader por utilizador multiplicaria por cinco o trabalho da base para
//    obter exactamente a mesma lista — e cresceria com a equipa, que é a pior
//    forma de um cron partir: só na empresa que contratar mais gente.
//
// 🔴 Este cron ESCREVE em produção depois de publicado.
//
//    Insere em `notifications` uma vez por dia, por gestor, por item vencido.
//    Não é efeito secundário: é a função. Fica dito aqui porque quem lê a rota
//    deve saber que a activação do cron é uma decisão com consequência, e não
//    um detalhe de configuração.
// ============================================================================

interface Perfil {
  id: string;
  company_id: string;
  role: string;
  status: string | null;
}

/** O que já foi enviado hoje a esta pessoa. Ver a nota sobre dedupe no GET. */
async function chavesDeHoje(
  admin: ReturnType<typeof createAdminClient>,
  userIds: string[],
  today: string,
): Promise<Map<string, Set<string>>> {
  const porUtilizador = new Map<string, Set<string>>();
  if (userIds.length === 0) return porUtilizador;

  const { data, error } = await admin
    .from("notifications")
    .select("user_id, data")
    .in("user_id", userIds)
    .in("type", Object.values(NOTIFICATION_TYPE))
    .gte("created_at", `${today}T00:00:00+00:00`);

  // 🔴 Falhar a ler o que já foi enviado NÃO pode virar «não foi enviado
  //    nada»: isso mandaria a lista inteira outra vez. Sem esta informação a
  //    execução não pode ser segura, e lançar é o comportamento certo.
  if (error) throw new Error(`leitura de dedupe falhou: ${error.message}`);

  for (const linha of data ?? []) {
    const chave = (linha.data as { dedupe_key?: unknown } | null)?.dedupe_key;
    if (typeof chave !== "string") continue;
    const uid = String(linha.user_id);
    const set = porUtilizador.get(uid) ?? new Set<string>();
    set.add(chave);
    porUtilizador.set(uid, set);
  }
  return porUtilizador;
}

function corpoDoAviso(item: AvisoItem): string {
  const dia = item.date.split("-").reverse().join("/");
  return `${URGENCIA_LABEL[item.urgencia]} · ${item.detail} · ${dia}`;
}

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const today = todayInLisbon();

  // ── Destinatários ─────────────────────────────────────────────────────────
  //
  // 🔴 Só admin/gestor ACTIVOS. A colaboradora não recebe: estes prazos são de
  //    gestão — contas, leads, visitas — e mandá-los para quem limpa seria
  //    expor informação comercial a quem não tem nada que ver com ela.
  //
  // 🔴 `user_id` é `profiles.id`, nunca `auth_user_id`. A coluna referencia
  //    `profiles(id)` (009) e a política de leitura resolve a sessão para esse
  //    mesmo id através de `get_my_profile_id()` (101b). Inserir o
  //    `auth_user_id` criaria uma notificação que ninguém conseguiria ler — e
  //    que nem sequer violaria a chave estrangeira em todas as linhas, porque
  //    na convenção antiga os dois valores coincidem. Falharia só para quem
  //    tivesse acesso criado depois da 101b, que é a pior forma de falhar.
  const { data: perfis, error: perfisErr } = await admin
    .from("profiles")
    .select("id, company_id, role, status")
    .in("role", ["admin", "gestor"]);

  if (perfisErr) {
    return NextResponse.json({ error: perfisErr.message }, { status: 500 });
  }

  // O estado passa pela MESMA função que autoriza o resto do produto. Uma lista
  // de estados escrita à mão aqui divergiria no dia em que aparecesse um estado
  // novo — e divergir em silêncio é como uma pessoa suspensa volta a receber.
  // `estadoAutoriza` aceita `unknown` de propósito — o estado chega de fora e
  // a função é que decide. Aqui basta filtrar e depois nomear o tipo.
  const destinatarios: Perfil[] = (perfis ?? [])
    .filter((linha) => estadoAutoriza((linha as { status?: unknown }).status))
    .map((linha) => linha as Perfil);

  if (destinatarios.length === 0) {
    return NextResponse.json({ ok: true, today, empresas: 0, enviados: 0, falhados: 0 });
  }

  const porEmpresa = new Map<string, Perfil[]>();
  for (const p of destinatarios) {
    const lista = porEmpresa.get(p.company_id) ?? [];
    lista.push(p);
    porEmpresa.set(p.company_id, lista);
  }

  let enviados = 0;
  let falhados = 0;
  let saltados = 0;
  const erros: string[] = [];

  for (const [companyId, pessoas] of porEmpresa) {
    // ── Uma falha numa empresa não cala as outras ───────────────────────────
    //
    // 🔴 Antes de haver este try, bastava a primeira empresa falhar para a rota
    //    abortar — e todas as seguintes ficavam sem aviso nenhum nesse dia, sem
    //    que ninguém soubesse porquê. As falhas acumulam-se e saem no fim.
    try {
      const avisos = await carregarAvisos(admin, companyId, today);
      if (avisos.length === 0) continue;

      const jaEnviadas = await chavesDeHoje(admin, pessoas.map((p) => p.id), today);

      for (const pessoa of pessoas) {
        const existentes = jaEnviadas.get(pessoa.id) ?? new Set<string>();

        for (const item of avisos) {
          const chave = dedupeKey(today, item.source, item.itemId);
          if (existentes.has(chave)) { saltados += 1; continue; }

          const r = await notifyUser(admin, {
            companyId,
            userId: pessoa.id,
            type: NOTIFICATION_TYPE[item.source],
            title: item.title,
            body: corpoDoAviso(item),
            // 🔴 Só metadados de navegação e de dedupe. Nada de valores,
            //    contactos ou notas: este JSON é lido pelo cliente e não há
            //    razão para lá pôr informação que o sino não mostra.
            data: {
              dedupe_key: chave,
              source: item.source,
              item_id: item.itemId,
              date: item.date,
              urgencia: item.urgencia,
            },
            url: item.href,
          });

          if (r.stored) {
            enviados += 1;
            // Marca em memória: se a mesma pessoa tiver o mesmo item por outra
            // via dentro desta execução, não sai duas vezes.
            existentes.add(chave);
            jaEnviadas.set(pessoa.id, existentes);
          } else {
            falhados += 1;
          }
        }
      }
    } catch (e) {
      falhados += 1;
      erros.push(`empresa ${companyId}: ${(e as Error).message}`);
    }
  }

  // ── O resultado diz a verdade sobre o que ficou gravado ───────────────────
  //
  // 🔴 Um 200 com falhas escondidas seria pior do que um erro: o cron passaria
  //    a parecer saudável enquanto ninguém recebia nada, e a primeira pessoa a
  //    dar por isso seria quem falhasse um pagamento.
  //
  //    O sino é o canal DURÁVEL — `stored` é o que conta. `notified` fala só do
  //    Push, que é best-effort por natureza (o telemóvel pode estar desligado)
  //    e não pode decidir se o cron correu bem.
  //
  // 🔴 Numa retry, o que já ficou gravado é cortado pela dedupe e o que falhou
  //    volta a ser tentado. Isso torna a reexecução idempotente na prática.
  //
  //    O que NÃO é: exactly-once atómico. Não há UNIQUE em `notifications`
  //    sobre a chave, portanto duas execuções CONCORRENTES podem ler o mesmo
  //    «ainda não enviado» e inserir as duas. Para um cron diário isso não
  //    acontece na prática, e a alternativa era uma migration só para dedupe.
  //    Fica escrito para ninguém acreditar numa garantia que a base não dá.
  const ok = falhados === 0;
  return NextResponse.json(
    {
      ok,
      today,
      empresas: porEmpresa.size,
      destinatarios: destinatarios.length,
      enviados,
      saltados,
      falhados,
      ...(erros.length > 0 ? { erros } : {}),
    },
    { status: ok ? 200 : 500 },
  );
}
