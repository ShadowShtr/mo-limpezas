import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { parseISO, isToday, isTomorrow, format } from "date-fns";
import { fmtLisbon } from "@/lib/lisbon-time";
import {
  ArrowLeft, Plus, Edit2, Mail, Phone, Hash, Building2, User,
  StickyNote, CalendarClock, MapPin, BadgeEuro,
} from "lucide-react";
import { Header } from "@/components/layout/header";
import { ClienteSheet } from "../_components/sheet";
import { CommunicationTab } from "./_components/communication-tab";
import { InterventionsSection } from "./_components/interventions-section";
import { LocaisTable } from "../../locais/_components/table";
import { LocalSheet } from "../../locais/_components/sheet";
import type { ContratosTableRow } from "../../contratos/page";
import { CONTRATO_SHEET_SELECT } from "@/lib/contrato-sheet-fields";
import { CLIENTE_SHEET_SELECT } from "@/lib/cliente-sheet-fields";

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  agendado:  { bg: "#F0FDF4", text: "#15803D", label: "Agendado" },
  em_curso:  { bg: "#FFFBEB", text: "#92400E", label: "Em curso" },
  concluido: { bg: "#F1F5F9", text: "#475569", label: "Concluído" },
  cancelado: { bg: "#FEF2F2", text: "#B91C1C", label: "Cancelado" },
  falta:     { bg: "#FEF2F2", text: "#B91C1C", label: "Falta" },
  sem_cobertura: { bg: "#FEF2F2", text: "#B91C1C", label: "Sem cobertura" },
};

function serviceValue(s: { calculated_value: number | null; manual_value: number | null }) {
  return s.manual_value ?? s.calculated_value ?? 0;
}

function dayLabel(iso: string) {
  const d = parseISO(iso);
  if (isToday(d)) return "Hoje";
  if (isTomorrow(d)) return "Amanhã";
  return fmtLisbon(iso, { weekday: "short", day: "numeric", month: "short" });
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!me) redirect("/login");
  if (me.role === "colaborador") redirect("/app");

  const nowIso = new Date().toISOString();

  const [
    { data: client },
    { data: notifications },
    { data: locaisRaw },
    { data: upcomingRaw },
    { data: recentRaw },
    { data: doneRaw },
    { data: pointServicesRaw },
    { data: teamsRaw },
  ] = await Promise.all([
    admin
      .from("clients")
      .select(CLIENTE_SHEET_SELECT)
      .eq("id", id)
      .eq("company_id", me.company_id)
      .single(),

    admin
      .from("client_notifications")
      .select("id, method, status, sent_at, message_body, contact_used, created_at")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .order("created_at", { ascending: false })
      .limit(50),

    admin
      .from("locations")
      .select("id, name, address, lat, lng, hourly_rate, fixed_price, pricing_type, active, client_id, access_code, has_key, key_label, instructions")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .order("name"),

    // Próximas intervenções
    admin
      .from("services_full")
      .select("id, reference_number, scheduled_start, scheduled_end, status, location_name, team_name, team_color, calculated_value, manual_value")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .gte("scheduled_start", nowIso)
      .neq("status", "cancelado")
      .order("scheduled_start", { ascending: true })
      .limit(15),

    // Histórico recente
    admin
      .from("services_full")
      .select("id, reference_number, scheduled_start, status, location_name, team_name, team_color, calculated_value, manual_value")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .lt("scheduled_start", nowIso)
      .order("scheduled_start", { ascending: false })
      .limit(10),

    // Concluídos (para KPI de faturação)
    admin
      .from("services_full")
      .select("calculated_value, manual_value")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .eq("status", "concluido")
      .limit(2000),

    admin
      .from("services_full")
      .select("id, reference_number, location_id, location_name, scheduled_start, scheduled_end, status, team_name, team_color, notes")
      .eq("client_id", id)
      .eq("company_id", me.company_id)
      .is("contract_id", null)
      .order("scheduled_start", { ascending: false })
      .limit(20),

    admin
      .from("teams_with_members")
      .select("id, name, color, members")
      .eq("company_id", me.company_id)
      .eq("active", true)
      .order("name"),
  ]);

  if (!client) notFound();

  const locais = (locaisRaw ?? []).map((l) => {
    const r = l as typeof l & { fixed_price?: number | null; pricing_type?: string };
    return { ...r, fixed_price: r.fixed_price ?? null, pricing_type: (r.pricing_type ?? "hourly") as "hourly" | "fixed" };
  });
  const locationIds = locais.map((l) => l.id);
  const { data: contractsRaw } = locationIds.length
    ? await admin
      .from("contracts")
      .select(CONTRATO_SHEET_SELECT)
      .eq("company_id", me.company_id)
      .in("location_id", locationIds)
      .order("created_at", { ascending: false })
    : { data: [] };
  const clienteRef = [{ id: client.id, name: client.name }];

  const upcoming = upcomingRaw ?? [];
  const recent = recentRaw ?? [];
  const done = doneRaw ?? [];
  const contracts = (contractsRaw ?? []) as unknown as ContratosTableRow[];
  const pointServices = pointServicesRaw ?? [];
  const teams = (teamsRaw ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    member_count: Array.isArray(t.members) ? t.members.length : 0,
  }));
  const totalBilled = done.reduce((acc, s) => acc + serviceValue(s), 0);
  const nextService = upcoming[0] ?? null;

  const initials = client.name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const isCompany = (client.type ?? "empresa") === "empresa";

  return (
    <div>
      <Header
        title={client.name}
        subtitle="Ficha do cliente"
        actions={
          <ClienteSheet
            companyId={me.company_id}
            cliente={client}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-sm font-medium hover:bg-[var(--color-background)] transition-colors">
                <Edit2 className="w-4 h-4" />
                Editar
              </button>
            }
          />
        }
      />

      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-6 mx-auto max-w-[1200px]">
        <Link
          href="/dashboard/clientes"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-sub)] hover:text-[var(--color-text-main)] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Clientes
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ─── Coluna esquerda — perfil ─────────────────────────── */}
          <div className="space-y-4">
            {/* Card principal */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-6 text-center">
              <div className="w-20 h-20 rounded-2xl bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-4">
                {isCompany
                  ? <Building2 className="w-9 h-9 text-[var(--color-primary)]" />
                  : <span className="text-[var(--color-primary)] font-bold text-2xl">{initials}</span>}
              </div>
              <h2 className="text-lg font-bold text-[var(--color-text-main)]">{client.name}</h2>
              <p className="text-sm text-[var(--color-text-sub)] mt-0.5 flex items-center justify-center gap-1.5">
                {isCompany ? <Building2 className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
                {isCompany ? "Empresa" : "Particular"}
              </p>
              <div className="flex items-center justify-center gap-2 mt-3">
                <span className={`inline-block text-xs font-medium px-3 py-1 rounded-full ${
                  client.status === "ativo"
                    ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                    : "bg-[var(--color-background)] text-[var(--color-text-muted)]"
                }`}>
                  {client.status === "ativo" ? "Ativo" : "Inativo"}
                </span>
                {client.vat_exempt && (
                  <span className="inline-block text-xs font-medium px-3 py-1 rounded-full bg-amber-50 text-amber-700">
                    Isento de IVA
                  </span>
                )}
              </div>
            </div>

            {/* Contacto */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-3">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Contacto</h3>
              {client.email ? (
                <a href={`mailto:${client.email}`} className="flex items-center gap-3 group">
                  <Mail className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-sm text-[var(--color-text-main)] group-hover:text-[var(--color-primary)] truncate">{client.email}</span>
                </a>
              ) : null}
              {client.phone ? (
                <a href={`tel:${client.phone}`} className="flex items-center gap-3 group">
                  <Phone className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-sm text-[var(--color-text-main)] group-hover:text-[var(--color-primary)]">{client.phone}</span>
                </a>
              ) : null}
              {client.nif ? (
                <div className="flex items-center gap-3">
                  <Hash className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-sm text-[var(--color-text-main)]">NIF {client.nif}</span>
                </div>
              ) : null}
              {!client.email && !client.phone && !client.nif && (
                <p className="text-sm text-[var(--color-text-muted)]">Sem contactos registados.</p>
              )}
            </div>

            {/* Notas */}
            {client.notes ? (
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
                <div className="flex items-center gap-2 mb-2">
                  <StickyNote className="w-4 h-4 text-[var(--color-text-muted)]" />
                  <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Notas</h3>
                </div>
                <p className="text-sm text-[var(--color-text-sub)] whitespace-pre-wrap">{client.notes}</p>
              </div>
            ) : null}
          </div>

          {/* ─── Coluna direita — atividade ───────────────────────── */}
          <div className="lg:col-span-2 space-y-4">
            {/* KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--color-text-main)]">{locais.length}</p>
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Locais</p>
              </div>
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--color-text-main)]">{upcoming.length}</p>
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Agendados</p>
              </div>
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--color-text-main)]">{done.length}</p>
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Concluídos</p>
              </div>
              <div className="bg-white rounded-xl border border-[var(--color-border)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--color-text-main)]">€{totalBilled.toFixed(2)}</p>
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Faturado</p>
              </div>
            </div>

            <InterventionsSection
              companyId={me.company_id}
              userId={user.id}
              client={{ id: client.id, name: client.name }}
              locais={locais}
              equipas={teams}
              contratos={contracts}
              pointServices={pointServices}
            />

            {/* Próximas intervenções */}
            <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <CalendarClock className="w-4 h-4 text-[var(--color-primary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-text-main)]">
                  Próximas intervenções <span className="text-[var(--color-text-muted)] font-normal">({upcoming.length})</span>
                </h2>
                {nextService && (
                  <span className="ml-auto text-xs text-[var(--color-text-muted)]">
                    Próxima: {dayLabel(nextService.scheduled_start)}
                  </span>
                )}
              </div>
              {upcoming.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">Nenhuma intervenção agendada.</p>
              ) : (
                <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
                  {upcoming.map((s) => {
                    const st = STATUS_STYLE[s.status ?? "agendado"] ?? STATUS_STYLE.agendado;
                    return (
                      <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                        <div className="flex flex-col items-center justify-center w-14 shrink-0 text-center">
                          <span className="text-xs font-semibold text-[var(--color-text-main)] capitalize leading-tight">
                            {fmtLisbon(s.scheduled_start, { day: "numeric", month: "short" })}
                          </span>
                          <span className="text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">
                            {fmtLisbon(s.scheduled_start, { hour: "2-digit", minute: "2-digit", hour12: false })}
                            –
                            {fmtLisbon(s.scheduled_end, { hour: "2-digit", minute: "2-digit", hour12: false })}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--color-text-main)] truncate">
                            {s.location_name ?? "—"}
                          </p>
                          <p className="text-xs text-[var(--color-text-muted)] flex items-center gap-1.5">
                            {s.reference_number ? `#${s.reference_number}` : ""}
                            {s.team_name && (
                              <span className="inline-flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ background: s.team_color ?? "#94A3B8" }} />
                                {s.team_name}
                              </span>
                            )}
                          </p>
                        </div>
                        <span className="text-xs font-semibold text-[var(--color-text-sub)] flex items-center gap-1 shrink-0">
                          <BadgeEuro className="w-3.5 h-3.5" />{serviceValue(s).toFixed(2)}
                        </span>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: st.bg, color: st.text }}>
                          {st.label}
                        </span>
                        <Link
                          href={`/dashboard/calendario?date=${format(parseISO(s.scheduled_start), "yyyy-MM-dd")}`}
                          title="Editar no calendário"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] shrink-0"
                        >
                          <Edit2 className="w-4 h-4" />
                        </Link>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Histórico recente */}
            {recent.length > 0 && (
              <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
                <h2 className="text-sm font-semibold text-[var(--color-text-main)] mb-4">
                  Histórico recente <span className="text-[var(--color-text-muted)] font-normal">({recent.length})</span>
                </h2>
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {recent.map((s) => {
                    const st = STATUS_STYLE[s.status ?? "concluido"] ?? STATUS_STYLE.concluido;
                    return (
                      <div key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)] text-sm">
                        <span className="text-xs text-[var(--color-text-muted)] w-20 shrink-0">
                          {fmtLisbon(s.scheduled_start, { day: "numeric", month: "short", year: "numeric" })}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-[var(--color-text-main)]">{s.location_name ?? "—"}</span>
                        <span className="text-xs text-[var(--color-text-sub)] flex items-center gap-1 shrink-0">
                          <BadgeEuro className="w-3.5 h-3.5" />{serviceValue(s).toFixed(2)}
                        </span>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: st.bg, color: st.text }}>
                          {st.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Locais */}
            <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-[var(--color-text-main)] flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-[var(--color-primary)]" />
                  Locais <span className="text-[var(--color-text-muted)] font-normal">({locais.length})</span>
                </h2>
                <LocalSheet
                  companyId={me.company_id}
                  clientes={clienteRef}
                  fixedClientId={client.id}
                  trigger={
                    <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                      <Plus className="w-4 h-4" />
                      Novo local
                    </button>
                  }
                />
              </div>
              <LocaisTable
                locais={locais}
                clientes={clienteRef}
                companyId={me.company_id}
              />
            </section>

            {/* Comunicação */}
            <CommunicationTab
              client={client}
              notifications={notifications ?? []}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
