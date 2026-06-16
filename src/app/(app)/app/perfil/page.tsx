import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Phone, Clock, CalendarDays, User, Download } from "lucide-react";
import { SignOutButton } from "./_components/sign-out-button";
import { AppDocumentsSection } from "./_components/documents-section";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyDocuments } from "@/app/actions/collaborator-documents";

export default async function PerfilPage() {
  const supabase = await createClient();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, phone, email, avatar_url, contracted_hours_month, contract_start, vacation_balance, skills")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/login");

  // Horas trabalhadas este mês
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data: timesheets } = await supabase
    .from("timesheets")
    .select("duration_minutes")
    .eq("collaborator_id", user.id)
    .gte("clock_in_at", monthStart)
    .not("clock_out_at", "is", null);

  const workedMins = (timesheets ?? []).reduce((sum, t) => sum + (t.duration_minutes ?? 0), 0);
  const workedHours = (workedMins / 60).toFixed(1);
  const contractedHours = profile.contracted_hours_month ?? 168;

  let myDocs: Awaited<ReturnType<typeof getMyDocuments>>["documents"] = [];
  try {
    const docsRes = await getMyDocuments();
    myDocs = docsRes.ok ? (docsRes.documents ?? []) : [];
  } catch {
    // Continua sem documentos — não crasha a página
  }

  const initials = profile.full_name
    .split(" ")
    .slice(0, 2)
    .map((n: string) => n[0])
    .join("")
    .toUpperCase();

  return (
    <div className="flex flex-col gap-4 pb-2">
      <h1 className="text-xl font-bold text-[var(--color-text-main)]">Perfil</h1>

      {/* Card de identidade */}
      <div className="rounded-2xl p-5 flex items-center gap-4" style={{ background: "var(--glass-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow)" }}>
        {profile.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt={profile.full_name}
            className="w-16 h-16 rounded-full object-cover"
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0">
            <span className="text-xl font-bold text-[var(--color-primary)]">{initials}</span>
          </div>
        )}
        <div>
          <p className="text-base font-bold text-[var(--color-text-main)]">{profile.full_name}</p>
          {profile.phone && (
            <p className="text-sm text-[var(--color-text-sub)] flex items-center gap-1 mt-0.5">
              <Phone className="w-3 h-3" />
              {profile.phone}
            </p>
          )}
          {profile.email && (
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{profile.email}</p>
          )}
        </div>
      </div>

      {/* Estatísticas do mês */}
      <div className="rounded-2xl p-4" style={{ background: "var(--glass-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow)" }}>
        <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-3">
          Este mês
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-[var(--color-primary-light)] rounded-xl p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Clock className="w-3.5 h-3.5 text-[var(--color-primary)]" />
              <span className="text-[10px] font-semibold text-[var(--color-primary)] uppercase tracking-wide">Horas</span>
            </div>
            <p className="text-2xl font-bold text-[var(--color-text-main)]">{workedHours}h</p>
            <p className="text-[10px] text-[var(--color-text-muted)]">de {contractedHours}h contratadas</p>
          </div>
          <div className="bg-blue-50 rounded-xl p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <CalendarDays className="w-3.5 h-3.5 text-[var(--color-info)]" />
              <span className="text-[10px] font-semibold text-[var(--color-info)] uppercase tracking-wide">Férias</span>
            </div>
            <p className="text-2xl font-bold text-[var(--color-text-main)]">{profile.vacation_balance ?? 22}</p>
            <p className="text-[10px] text-[var(--color-text-muted)]">dias disponíveis</p>
          </div>
        </div>
      </div>

      {/* Competências */}
      {profile.skills && profile.skills.length > 0 && (
        <div className="rounded-2xl p-4" style={{ background: "var(--glass-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow)" }}>
          <div className="flex items-center gap-2 mb-3">
            <User className="w-4 h-4 text-[var(--color-primary)]" />
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Competências</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(profile.skills as string[]).map((skill) => (
              <span
                key={skill}
                className="text-xs font-medium px-2.5 py-1 rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)]"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Documentos */}
      <AppDocumentsSection initialDocuments={myDocs} />

      {/* Calendário */}
      <a
        href="/api/app/calendar.ics"
        download="escala.ics"
        className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl text-sm font-medium text-[var(--color-text-main)] active:opacity-80 transition-all"
        style={{ background: "var(--glass-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow)" }}
      >
        <Download className="w-4 h-4 text-[var(--color-primary)]" />
        Exportar escala para calendário
      </a>

      {/* Terminar sessão */}
      <SignOutButton />
    </div>
  );
}
