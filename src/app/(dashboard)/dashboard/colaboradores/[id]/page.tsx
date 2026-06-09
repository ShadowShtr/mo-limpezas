import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { ColaboradorSheet } from "../_components/sheet";
import { ColaboradorAbsences } from "./_components/colaborador-absences";
import { PresencaHistory } from "./_components/presenca-history";
import { DocumentsSection } from "./_components/documents-section";
import { getCollaboratorDocuments } from "@/app/actions/collaborator-documents";
import {
  ArrowLeft, Mail, Phone, Calendar, Award, Edit2,
} from "lucide-react";
import Link from "next/link";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ColaboradorDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();

  const companyRes = await supabase
    .from("profiles")
    .select("company_id")
    .eq("id", (await supabase.auth.getUser()).data.user!.id)
    .single();

  const [profileRes, timesheetsRes, docsRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("*")
      .eq("id", id)
      .single(),
    supabase
      .from("timesheets")
      .select("id, clock_in_at, clock_out_at, duration_minutes, location_warning, service_id")
      .eq("collaborator_id", id)
      .not("clock_in_at", "is", null)
      .order("clock_in_at", { ascending: false })
      .limit(30),
    getCollaboratorDocuments(id),
  ]);

  if (!profileRes.data) notFound();

  const profile = profileRes.data;
  const timesheets = timesheetsRes.data ?? [];
  const documents = docsRes.ok ? docsRes.documents : [];
  const company = companyRes;

  // Faltas do colaborador (últimas + futuras)
  const { data: rawAbsences } = await admin
    .from("absences")
    .select("id, absence_type, starts_on, ends_on, notes, replaced_by")
    .eq("collaborator_id", id)
    .order("starts_on", { ascending: false })
    .limit(20);

  // Resolver nomes de substitutos
  const replacedByIds = [...new Set((rawAbsences ?? []).map((a) => a.replaced_by).filter((id): id is string => !!id))];
  let substituteNames: Record<string, string> = {};
  if (replacedByIds.length > 0) {
    const { data: subs } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", replacedByIds);
    substituteNames = Object.fromEntries((subs ?? []).map((s) => [s.id, s.full_name]));
  }

  const absences = (rawAbsences ?? []).map((a) => ({
    id: a.id,
    absence_type: a.absence_type,
    starts_on: a.starts_on,
    ends_on: a.ends_on,
    notes: a.notes,
    replaced_by_name: a.replaced_by ? (substituteNames[a.replaced_by] ?? null) : null,
  }));

  const totalMinutes = timesheets
    .filter((t) => t.duration_minutes)
    .reduce((acc, t) => acc + (t.duration_minutes ?? 0), 0);
  const totalHours = (totalMinutes / 60).toFixed(1);

  const inviteStatus = profile.invite_accepted_at
    ? "Conta ativa"
    : profile.invited_at
    ? "Convite enviado"
    : "Sem convite";

  const initials = profile.full_name
    .split(" ")
    .slice(0, 2)
    .map((w: string) => w[0])
    .join("")
    .toUpperCase();

  return (
    <div>
      <Header
        title={profile.full_name}
        subtitle={`${profile.role} · ${inviteStatus}`}
        actions={
          <ColaboradorSheet
            companyId={company.data?.company_id ?? ""}
            colaborador={profile}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-sm font-medium hover:bg-[var(--color-background)] transition-colors">
                <Edit2 className="w-4 h-4" />
                Editar
              </button>
            }
          />
        }
      />

      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-6 max-w-[1200px]">
        {/* Voltar */}
        <Link
          href="/dashboard/colaboradores"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-sub)] hover:text-[var(--color-text-main)] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Colaboradores
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Coluna esquerda — perfil */}
          <div className="space-y-4">
            {/* Card principal */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-6 text-center">
              <div className="w-20 h-20 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center mx-auto mb-4 overflow-hidden">
                {profile.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.avatar_url} alt={profile.full_name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[var(--color-primary)] font-bold text-2xl">{initials}</span>
                )}
              </div>
              <h2 className="text-lg font-bold text-[var(--color-text-main)]">{profile.full_name}</h2>
              <p className="text-sm text-[var(--color-text-sub)] capitalize mt-0.5">{profile.role}</p>
              <span className={`inline-block mt-3 text-xs font-medium px-3 py-1 rounded-full ${
                profile.status === "ativo"
                  ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                  : "bg-[var(--color-background)] text-[var(--color-text-muted)]"
              }`}>
                {profile.status === "ativo" ? "Ativo" : profile.status === "inativo" ? "Inativo" : "Suspenso"}
              </span>
            </div>

            {/* Contactos */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-3">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Contacto</h3>
              {profile.email && (
                <div className="flex items-center gap-3">
                  <Mail className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-sm text-[var(--color-text-main)]">{profile.email}</span>
                </div>
              )}
              {profile.phone && (
                <div className="flex items-center gap-3">
                  <Phone className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-sm text-[var(--color-text-main)]">{profile.phone}</span>
                </div>
              )}
              {profile.contract_start && (
                <div className="flex items-center gap-3">
                  <Calendar className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-sm text-[var(--color-text-main)]">
                    Desde {new Date(profile.contract_start).toLocaleDateString("pt-PT")}
                  </span>
                </div>
              )}
            </div>

            {/* Skills */}
            {(profile.skills ?? []).length > 0 && (
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
                <h3 className="text-sm font-semibold text-[var(--color-text-main)] mb-3">Skills</h3>
                <div className="flex flex-wrap gap-1.5">
                  {(profile.skills as string[]).map((s) => (
                    <span key={s} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)] font-medium">
                      <Award className="w-3 h-3" />
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Faltas */}
            <ColaboradorAbsences
              colaboradorId={id}
              colaboradorName={profile.full_name}
              absences={absences}
            />
          </div>

          {/* Coluna direita — estatísticas + histórico */}
          <div className="lg:col-span-2 space-y-4">
            {/* KPIs */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--color-text-main)]">{totalHours}h</p>
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Horas totais</p>
              </div>
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--color-text-main)]">{timesheets.length}</p>
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Serviços</p>
              </div>
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--color-text-main)]">
                  {profile.contracted_hours_month ?? 168}h
                </p>
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Horas/mês</p>
              </div>
            </div>

            {/* Histórico de presenças */}
            <PresencaHistory timesheets={timesheets} />

            {/* Documentos */}
            <DocumentsSection
              collaboratorId={id}
              companyId={company?.data?.company_id ?? ""}
              initialDocuments={documents}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
