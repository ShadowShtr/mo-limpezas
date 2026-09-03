"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { filterClientes, type ClienteSearchItem } from "./cliente-search";

interface Props {
  clientes: ClienteSearchItem[];
  value: string;
  onChange: (clienteId: string) => void;
  fixedClientId?: string;
}

export function ClienteSearchSelect({ clientes, value, onChange, fixedClientId }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const listId = `${inputId}-clientes`;
  const selectedId = fixedClientId ?? value;
  const selectedClient = clientes.find((cliente) => cliente.id === selectedId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(selectedClient?.name ?? "");
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredClientes = filterClientes(clientes, query);

  useEffect(() => {
    if (open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery(selectedClient?.name ?? "");
  }, [open, selectedClient?.name]);

  useEffect(() => {
    if (!open) return;

    function closeWhenOutside(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery(selectedClient?.name ?? "");
      }
    }

    document.addEventListener("pointerdown", closeWhenOutside);
    return () => document.removeEventListener("pointerdown", closeWhenOutside);
  }, [open, selectedClient?.name]);

  function openMenu() {
    if (fixedClientId) return;
    setOpen(true);
    setQuery("");
    setActiveIndex(0);
  }

  function closeMenu() {
    setOpen(false);
    setQuery(selectedClient?.name ?? "");
  }

  function selectCliente(cliente: ClienteSearchItem) {
    onChange(cliente.id);
    setQuery(cliente.name);
    setOpen(false);
    setActiveIndex(0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((index) => Math.min(index + 1, Math.max(filteredClientes.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      const cliente = filteredClientes[activeIndex];
      if (cliente) selectCliente(cliente);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
    } else if (event.key === "Tab" && open) {
      closeMenu();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-label="Cliente"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={open}
          aria-activedescendant={
            open && filteredClientes[activeIndex]
              ? `${listId}-${filteredClientes[activeIndex].id}`
              : undefined
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onFocus={openMenu}
          onKeyDown={handleKeyDown}
          readOnly={!!fixedClientId}
          disabled={!!fixedClientId}
          placeholder="Pesquisar cliente..."
          className={`w-full px-3 py-2 pr-9 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent ${fixedClientId ? "opacity-70 cursor-not-allowed" : ""}`}
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
      </div>

      {open && !fixedClientId && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Clientes"
          className="absolute z-30 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-white py-1 shadow-lg"
        >
          {filteredClientes.length === 0 ? (
            <li className="px-3 py-2 text-sm text-[var(--color-text-muted)]" role="status">
              Nenhum cliente encontrado.
            </li>
          ) : (
            filteredClientes.map((cliente, index) => (
              <li
                id={`${listId}-${cliente.id}`}
                key={cliente.id}
                role="option"
                aria-selected={cliente.id === selectedId}
                className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm ${index === activeIndex ? "bg-[var(--color-background)]" : "hover:bg-[var(--color-background)]"}`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  selectCliente(cliente);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span>{cliente.name}</span>
                {cliente.id === selectedId && <Check className="h-4 w-4 text-[var(--color-primary)]" />}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
