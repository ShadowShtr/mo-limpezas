"use client";

// ============================================================================
// Pesquisa de destinatário — clientes e leads numa só caixa
// ============================================================================
//
// O CRM só sabia criar: quem já era cliente tinha de ser procurado num
// <select> com a lista inteira, ou — no funil — era criado outra vez como
// lead, e a conversão fazia dele um cliente duplicado. Esta caixa procura nos
// dois sítios ao mesmo tempo e, se não houver ninguém, oferece criar.
//
// A pesquisa é local: as listas já vêm do servidor com a página. Ignora
// maiúsculas e acentos («Condominio» encontra «Condomínio») e procura também
// no email, no telefone e no NIF, quando os há.
// ============================================================================

import { useId, useMemo, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";

export type DestinatarioTipo = "lead" | "cliente";

export interface DestinatarioOpcao {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  nif?: string | null;
}

export interface Destinatario {
  tipo: DestinatarioTipo;
  id: string;
  name: string;
}

interface Props {
  leads: DestinatarioOpcao[];
  clientes: DestinatarioOpcao[];
  /** O destinatário escolhido, ou `null` enquanto se pesquisa. */
  valor: Destinatario | null;
  onEscolher: (d: Destinatario | null) => void;
  /** Sem isto não há opção de criar — só se escolhe quem já existe. */
  onCriarNovo?: (texto: string) => void;
  criarEtiqueta?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

const MAX_RESULTADOS = 8;

/** Minúsculas e sem acentos — «Óscar» e «oscar» são a mesma pesquisa. */
export function normalizarPesquisa(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function corresponde(o: DestinatarioOpcao, termo: string): boolean {
  if (normalizarPesquisa(o.name).includes(termo)) return true;
  if (o.email && normalizarPesquisa(o.email).includes(termo)) return true;
  // Telefone e NIF comparam-se só pelos dígitos: «912 345 678» = «912345678».
  const digitos = termo.replace(/\D/g, "");
  if (digitos.length >= 3) {
    if (o.phone && o.phone.replace(/\D/g, "").includes(digitos)) return true;
    if (o.nif && o.nif.replace(/\D/g, "").includes(digitos)) return true;
  }
  return false;
}

export function PesquisaDestinatario({
  leads,
  clientes,
  valor,
  onEscolher,
  onCriarNovo,
  criarEtiqueta = "Criar nova lead",
  placeholder = "Procurar cliente ou lead…",
  autoFocus,
  disabled,
}: Props) {
  const listaId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);
  const [ativo, setAtivo] = useState(0);

  const resultados = useMemo(() => {
    const termo = normalizarPesquisa(texto);
    // Clientes primeiro: quem já é cliente é o que mais importa não duplicar.
    const todos: Destinatario[] = [
      ...clientes.map((c) => ({ tipo: "cliente" as const, id: c.id, name: c.name, o: c })),
      ...leads.map((l) => ({ tipo: "lead" as const, id: l.id, name: l.name, o: l })),
    ]
      .filter((x) => !termo || corresponde(x.o, termo))
      .map(({ tipo, id, name }) => ({ tipo, id, name }));
    return todos.slice(0, MAX_RESULTADOS);
  }, [texto, leads, clientes]);

  // A opção de criar fica sempre no fim, mesmo com resultados: «Ana Silva»
  // pode ser outra Ana Silva.
  const nOpcoes = resultados.length + (onCriarNovo ? 1 : 0);

  function escolher(i: number) {
    if (i < resultados.length) {
      onEscolher(resultados[i]);
      setTexto("");
      setAberto(false);
    } else if (onCriarNovo) {
      onCriarNovo(texto.trim());
      setAberto(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAberto(true);
      setAtivo((a) => (nOpcoes ? (a + 1) % nOpcoes : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAtivo((a) => (nOpcoes ? (a - 1 + nOpcoes) % nOpcoes : 0));
    } else if (e.key === "Enter") {
      // Nunca submete o formulário à volta: Enter aqui é escolher.
      e.preventDefault();
      if (aberto && nOpcoes > 0) escolher(ativo);
    } else if (e.key === "Escape" && aberto) {
      // Fecha a lista, e não o formulário inteiro (que também ouve o Escape).
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setAberto(false);
    }
  }

  if (valor) {
    return (
      <div
        className="mt-1 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px]"
        style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Etiqueta tipo={valor.tipo} />
          <span className="truncate font-medium">{valor.name}</span>
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              onEscolher(null);
              // Volta à pesquisa com o cursor lá — trocar é pesquisar outra vez.
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-muted)" }}
            aria-label={`Trocar ${valor.name}`}
          >
            <X className="h-3.5 w-3.5" />
            Trocar
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative mt-1">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
        style={{ color: "var(--color-text-muted)" }}
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={aberto}
        aria-controls={listaId}
        aria-autocomplete="list"
        aria-activedescendant={aberto && nOpcoes > 0 ? `${listaId}-${ativo}` : undefined}
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          setAberto(true);
          setAtivo(0);
        }}
        onFocus={() => setAberto(true)}
        // O atraso deixa o clique numa opção chegar antes de a lista fechar.
        onBlur={() => setTimeout(() => setAberto(false), 150)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        className="w-full rounded-lg border bg-white py-2 pl-9 pr-3 text-[13px] font-normal border-[var(--color-border)]"
      />

      {aberto && (
        <ul
          id={listaId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border bg-white py-1 shadow-lg"
          style={{ borderColor: "var(--color-border)" }}
        >
          {resultados.map((r, i) => (
            <li
              key={`${r.tipo}-${r.id}`}
              id={`${listaId}-${i}`}
              role="option"
              aria-selected={ativo === i}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => escolher(i)}
              onMouseEnter={() => setAtivo(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-normal ${
                ativo === i ? "bg-slate-100" : ""
              }`}
            >
              <Etiqueta tipo={r.tipo} />
              <span className="truncate">{r.name}</span>
            </li>
          ))}

          {resultados.length === 0 && (
            <li className="px-3 py-2 text-[12.5px] font-normal" style={{ color: "var(--color-text-muted)" }}>
              {texto.trim() ? "Nenhum cliente ou lead com este nome." : "Ainda não há clientes nem leads."}
            </li>
          )}

          {onCriarNovo && (
            <li
              id={`${listaId}-${resultados.length}`}
              role="option"
              aria-selected={ativo === resultados.length}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => escolher(resultados.length)}
              onMouseEnter={() => setAtivo(resultados.length)}
              className={`flex cursor-pointer items-center gap-2 border-t px-3 py-2 text-[13px] font-medium text-green-700 ${
                ativo === resultados.length ? "bg-green-50" : ""
              }`}
              style={{ borderColor: "var(--color-border)" }}
            >
              <Plus className="h-4 w-4" />
              {texto.trim() ? `${criarEtiqueta} «${texto.trim()}»` : criarEtiqueta}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function Etiqueta({ tipo }: { tipo: DestinatarioTipo }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${
        tipo === "cliente" ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700"
      }`}
    >
      {tipo === "cliente" ? "Cliente" : "Lead"}
    </span>
  );
}
