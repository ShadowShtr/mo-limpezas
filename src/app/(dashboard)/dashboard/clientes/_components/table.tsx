"use client";

import { useState } from "react";
import { Search, MoreHorizontal } from "lucide-react";
import { ClienteSheet } from "./sheet";
import { usePagination, Pagination } from "@/components/ui/pagination";

type Cliente = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  status: string;
  vat_exempt: boolean;
  created_at: string;
};

interface Props {
  clientes: Cliente[];
  companyId: string;
}

export function ClientesTable({ clientes, companyId }: Props) {
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState("todos");

  const filtered = clientes.filter((c) => {
    const matchSearch =
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.email ?? "").toLowerCase().includes(search.toLowerCase());
    const matchActive =
      filterActive === "todos" ||
      (filterActive === "ativo" && c.status === "ativo") ||
      (filterActive === "inativo" && c.status !== "ativo");
    return matchSearch && matchActive;
  });

  const pag = usePagination(filtered, 10);
  const paginated = pag.pageItems;

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-[var(--color-border)]">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); pag.setPage(1); }}
            placeholder="Pesquisar cliente..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-white
                       text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                       focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
          />
        </div>
        <select
          value={filterActive}
          onChange={(e) => { setFilterActive(e.target.value); pag.setPage(1); }}
          className="text-sm rounded-lg border border-[var(--color-border)] px-3 py-2 bg-white text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          <option value="todos">Todos</option>
          <option value="ativo">Ativos</option>
          <option value="inativo">Inativos</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Cliente</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Contacto</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">NIF</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-12 text-sm text-[var(--color-text-muted)]">
                  {search ? "Nenhum cliente encontrado." : "Ainda não há clientes."}
                </td>
              </tr>
            ) : (
              paginated.map((c) => (
                <tr key={c.id} className="hover:bg-[var(--color-background)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
                        <span className="text-[var(--color-primary)] font-bold text-sm">{c.name[0].toUpperCase()}</span>
                      </div>
                      <p className="text-sm font-medium text-[var(--color-text-main)]">{c.name}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-[var(--color-text-main)]">{c.email ?? "—"}</p>
                    <p className="text-xs text-[var(--color-text-muted)]">{c.phone ?? "—"}</p>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">{c.nif ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                      c.status === "ativo"
                        ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                        : "bg-[var(--color-background)] text-[var(--color-text-muted)]"
                    }`}>
                      {c.status === "ativo" ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <ClienteSheet
                        companyId={companyId}
                        cliente={c}
                        trigger={
                          <button className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                            <MoreHorizontal className="w-4 h-4" />
                          </button>
                        }
                      />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination {...pag} />
    </div>
  );
}
