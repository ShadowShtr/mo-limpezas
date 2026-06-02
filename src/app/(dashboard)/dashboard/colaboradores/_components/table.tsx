"use client";

import { useState } from "react";
import { Search, Filter, ChevronLeft, ChevronRight, MoreHorizontal, ExternalLink } from "lucide-react";
import Link from "next/link";
import { ColaboradorSheet } from "./sheet";

type Colaborador = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  contracted_hours_month: number | null;
  skills: string[];
  avatar_url: string | null;
  created_at: string;
  invited_at: string | null;
  invite_accepted_at: string | null;
};

const STATUS_STYLE: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  ativo:    { label: "Ativo",    dot: "bg-[var(--color-success)]",  text: "text-[var(--color-success)]",  bg: "bg-[var(--color-primary-light)]" },
  inativo:  { label: "Inativo",  dot: "bg-[var(--color-text-muted)]", text: "text-[var(--color-text-muted)]", bg: "bg-[var(--color-background)]" },
  suspenso: { label: "Suspenso", dot: "bg-[var(--color-danger)]",   text: "text-[var(--color-danger)]",   bg: "bg-red-50" },
};

const PAGE_SIZE = 15;

interface Props {
  colaboradores: Colaborador[];
  companyId: string;
}

export function ColaboradoresTable({ colaboradores, companyId }: Props) {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("todos");
  const [page, setPage] = useState(1);

  const filtered = colaboradores.filter((c) => {
    const matchSearch =
      c.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (c.email ?? "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === "todos" || c.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function getInitials(name: string) {
    return name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  }

  function getInviteStatus(c: Colaborador) {
    if (c.invite_accepted_at) return { label: "Conta ativa", color: "text-[var(--color-primary)]" };
    if (c.invited_at) return { label: "Convite enviado", color: "text-[var(--color-warning)]" };
    return { label: "Sem convite", color: "text-[var(--color-text-muted)]" };
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-[var(--color-border)]">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Pesquisar por nome ou email..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-white
                       text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                       focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-[var(--color-text-muted)]" />
          <select
            value={filterStatus}
            onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
            className="text-sm rounded-lg border border-[var(--color-border)] px-3 py-2 bg-white text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
          >
            <option value="todos">Todos os estados</option>
            <option value="ativo">Ativo</option>
            <option value="inativo">Inativo</option>
            <option value="suspenso">Suspenso</option>
          </select>
        </div>
      </div>

      {/* Tabela */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Colaborador</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Contacto</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Horas/mês</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Skills</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Acesso</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-sm text-[var(--color-text-muted)]">
                  {search || filterStatus !== "todos" ? "Nenhum colaborador encontrado." : "Ainda não há colaboradores."}
                </td>
              </tr>
            ) : (
              paginated.map((c) => {
                const status = STATUS_STYLE[c.status] ?? STATUS_STYLE.ativo;
                const invite = getInviteStatus(c);
                return (
                  <tr key={c.id} className="hover:bg-[var(--color-background)] transition-colors">
                    {/* Nome + avatar */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0 overflow-hidden">
                          {c.avatar_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.avatar_url} alt={c.full_name} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-[var(--color-primary)] font-semibold text-xs">
                              {getInitials(c.full_name)}
                            </span>
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[var(--color-text-main)]">{c.full_name}</p>
                          <p className="text-xs text-[var(--color-text-muted)] capitalize">{c.role}</p>
                        </div>
                      </div>
                    </td>

                    {/* Contacto */}
                    <td className="px-4 py-3">
                      <p className="text-sm text-[var(--color-text-main)]">{c.email ?? "—"}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">{c.phone ?? "—"}</p>
                    </td>

                    {/* Horas */}
                    <td className="px-4 py-3">
                      <span className="text-sm text-[var(--color-text-main)]">
                        {c.contracted_hours_month ?? "—"}h
                      </span>
                    </td>

                    {/* Skills */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(c.skills ?? []).slice(0, 3).map((s) => (
                          <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-background)] text-[var(--color-text-sub)] border border-[var(--color-border)]">
                            {s}
                          </span>
                        ))}
                        {(c.skills ?? []).length > 3 && (
                          <span className="text-xs text-[var(--color-text-muted)]">+{c.skills.length - 3}</span>
                        )}
                      </div>
                    </td>

                    {/* Estado */}
                    <td className="px-4 py-3">
                      <span className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full w-fit ${status.bg} ${status.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                        {status.label}
                      </span>
                    </td>

                    {/* Acesso */}
                    <td className="px-4 py-3">
                      <span className={`text-xs ${invite.color}`}>{invite.label}</span>
                    </td>

                    {/* Ações */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Link
                          href={`/dashboard/colaboradores/${c.id}`}
                          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] transition-colors"
                          title="Ver detalhe"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </Link>
                        <ColaboradorSheet
                          companyId={companyId}
                          colaborador={c}
                          trigger={
                            <button className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] transition-colors">
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          }
                        />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--color-border)]">
          <p className="text-sm text-[var(--color-text-muted)]">
            {filtered.length} colaboradores · página {page} de {totalPages}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
