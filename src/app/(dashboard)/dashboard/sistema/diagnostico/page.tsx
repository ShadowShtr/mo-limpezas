import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/header";
import { getDeepHealthReport, type HealthCheck } from "@/lib/deep-health";

// Página de diagnóstico — prova, para quem dá suporte, exatamente qual
// commit/ambiente/projeto Supabase/migration este dispositivo está a falar
// com, sem nunca mostrar URL completa, chave ou segredo. Ver plano de
// correção T01. Reaproveita getDeepHealthReport (mesma lógica de
// /api/health/deep, nunca duplicada).

export const dynamic = "force-dynamic";

const CHECK_LABELS: Record<string, string> = {
  db: "Base de dados",
  storage: "Storage (ficheiros)",
  migration: "Migration aplicada vs código",
  outbox: "Outbox (company_change_events)",
  rateLimit: "Rate limit distribuído",
  env: "Variáveis de ambiente",
};

function CheckRow({ name, check }: { name: string; check: HealthCheck }) {
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 ${
      check.ok ? "border-[var(--color-border)] bg-white" : "border-red-200 bg-red-50"
    }`}>
      <div>
        <p className="text-sm font-medium text-[var(--color-text-main)]">{CHECK_LABELS[name] ?? name}</p>
        {check.error && <p className="text-xs text-red-700 mt-0.5">{check.error}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {typeof check.latencyMs === "number" && (
          <span className="text-xs text-[var(--color-text-muted)]">{check.latencyMs}ms</span>
        )}
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
          check.ok ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-red-100 text-red-700"
        }`}>
          {check.ok ? "OK" : "FALHA"}
        </span>
      </div>
    </div>
  );
}

export default async function DiagnosticoPage() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const canView = profile && ["admin", "gestor"].includes(profile.role);

  return (
    <div>
      <Header
        title="Diagnóstico do Sistema"
        subtitle="Prova de commit, ambiente, projeto Supabase e estado das migrations — sem expor segredos"
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-4 mx-auto max-w-[900px]">
        {!canView ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Sem permissão para ver esta página.
          </div>
        ) : (
          <DiagnosticoBody />
        )}
      </div>
    </div>
  );
}

async function DiagnosticoBody() {
  const report = await getDeepHealthReport();

  return (
    <>
      <div className={`rounded-xl border px-4 py-3 text-sm ${
        report.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"
      }`}>
        {report.ok
          ? "Todos os checks passaram — código, banco e ambiente estão coerentes."
          : "Há divergência entre o código publicado e o estado real do banco/ambiente — ver detalhe abaixo."}
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-white p-4">
        <p className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-3">
          Identidade deste dispositivo/publicação
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-[var(--color-text-muted)]">Commit</dt>
          <dd className="text-[var(--color-text-main)] font-mono">{report.deploy.commit}</dd>
          <dt className="text-[var(--color-text-muted)]">Branch</dt>
          <dd className="text-[var(--color-text-main)] font-mono">{report.deploy.branch ?? "—"}</dd>
          <dt className="text-[var(--color-text-muted)]">Ambiente</dt>
          <dd className="text-[var(--color-text-main)]">{report.deploy.env}</dd>
          <dt className="text-[var(--color-text-muted)]">Migration esperada pelo código</dt>
          <dd className="text-[var(--color-text-main)] font-mono">{report.deploy.migrationVersion}</dd>
          <dt className="text-[var(--color-text-muted)]">Projeto Supabase (ref)</dt>
          <dd className="text-[var(--color-text-main)] font-mono">{report.deploy.supabaseProjectRef ?? "—"}</dd>
        </dl>
      </div>

      <div className="space-y-2">
        {Object.entries(report.checks).map(([name, check]) => (
          <CheckRow key={name} name={name} check={check} />
        ))}
      </div>

      <p className="text-xs text-[var(--color-text-muted)] pt-1">
        Gerado em {new Date(report.ts).toLocaleString("pt-PT")}. Esta página nunca mostra URL completa,
        chaves ou segredos — só identificadores suficientes para confirmar que dois dispositivos
        falam com o mesmo projeto e o mesmo código.
      </p>
    </>
  );
}
