"use client";

import { useState } from "react";
import { Search, ChevronLeft, ChevronRight, MoreHorizontal, MapPin } from "lucide-react";
import { LocalSheet } from "./sheet";

type Local = {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  hourly_rate: number | null;
  active: boolean;
  client_id: string;
  access_code: string | null;
  instructions: string | null;
};

type Cliente = { id: string; name: string };

const PAGE_SIZE = 15;

interface Props {
  locais: Local[];
  clientes: Cliente[];
  companyId: string;
}

export function LocaisTable({ locais, clientes, companyId }: Props) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const clienteMap = Object.fromEntries(clientes.map((c) => [c.id, c.name]));

  const filtered = locais.filter((l) =>
    l.name.toLowerCase().includes(search.toLowerCase()) ||
    l.address.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-[var(--color-border)]">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Pesquisar local ou morada..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Local</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Cliente</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">€/hora</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">GPS</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {paginated.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-sm text-[var(--color-text-muted)]">
                {search ? "Nenhum local encontrado." : "Ainda não há locais."}
              </td></tr>
            ) : (
              paginated.map((l) => (
                <tr key={l.id} className="hover:bg-[var(--color-background)] transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-[var(--color-text-main)]">{l.name}</p>
                    <p className="text-xs text-[var(--color-text-sub)] flex items-center gap-1 mt-0.5">
                      <MapPin className="w-3 h-3" />{l.address}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">
                    {clienteMap[l.client_id] ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">
                    {l.hourly_rate != null ? `€${l.hourly_rate.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs ${l.lat && l.lng ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
                      {l.lat && l.lng ? "✓ Definido" : "Sem GPS"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                      l.active ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "bg-[var(--color-background)] text-[var(--color-text-muted)]"
                    }`}>{l.active ? "Ativo" : "Inativo"}</span>
                  </td>
                  <td className="px-4 py-3">
                    <LocalSheet companyId={companyId} clientes={clientes} local={l}
                      trigger={
                        <button className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                      }
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--color-border)]">
          <p className="text-sm text-[var(--color-text-muted)]">{filtered.length} locais · página {page} de {totalPages}</p>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--color-background)]">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="p-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--color-background)]">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
