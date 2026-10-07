"use client";

// ============================================================================
// Ganhar uma lead que já é cliente — escolher o cliente e o local
// ============================================================================
//
// A alternativa a «Converter em cliente» (104) para quem já estava na base de
// clientes antes de entrar no funil: em vez de nascer um segundo cliente com
// o mesmo nome, a lead fecha-se em «ganho» ligada ao cliente que já existe.
//
// O cliente escolhe-se pela mesma pesquisa do resto do CRM, só entre clientes.
// O local é um dos que esse cliente já tem, ou um novo com a morada da visita
// (ou da lead) — a mesma regra da conversão normal.
//
// 🔴 A ficha do cliente não é alterada. Diz-se isso no ecrã, para ninguém
//    contar que o NIF ou o email da lead passem para lá.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import {
  PesquisaDestinatario,
  type Destinatario,
  type DestinatarioOpcao,
} from "@/components/crm/pesquisa-destinatario";
import {
  getClientLocationsForLink,
  linkLeadToExistingClient,
  type LocalDoCliente,
} from "@/app/actions/crm-associar-cliente";

/** Valor do rádio para «criar um local novo». */
const LOCAL_NOVO = "__novo__";

interface Props {
  quoteId: string;
  /** O nome da lead, para a frase de confirmação. */
  leadName: string;
  clientes: DestinatarioOpcao[];
  onClose: () => void;
  onDone: (clientId: string, alreadyConverted: boolean) => void;
}

export function AssociarClienteDialog({ quoteId, leadName, clientes, onClose, onDone }: Props) {
  const { toast } = useToast();
  const [cliente, setCliente] = useState<Destinatario | null>(null);
  const [locais, setLocais] = useState<LocalDoCliente[] | null>(null);
  const [erroLocais, setErroLocais] = useState<string | null>(null);
  const [local, setLocal] = useState(LOCAL_NOVO);
  const [aGravar, setAGravar] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !aGravar) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, aGravar]);

  // O pedido mais recente ganha: com dois cliques rápidos em clientes
  // diferentes, a resposta do primeiro não pode chegar depois e ficar.
  const pedido = useRef(0);

  /**
   * Escolher (ou trocar) o cliente volta sempre a «local novo»: um local do
   * cliente anterior nunca pode ficar escolhido por arrasto.
   */
  async function escolherCliente(d: Destinatario | null) {
    setCliente(d);
    setLocal(LOCAL_NOVO);
    setLocais(null);
    setErroLocais(null);
    if (!d) return;

    const meu = ++pedido.current;
    const res = await getClientLocationsForLink(d.id);
    if (meu !== pedido.current) return;
    if (res.ok) setLocais(res.data);
    else setErroLocais(res.error.message);
  }

  async function confirmar() {
    if (!cliente) return;
    setAGravar(true);
    try {
      const res = await linkLeadToExistingClient(
        quoteId,
        cliente.id,
        local === LOCAL_NOVO ? null : local,
      );
      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      onDone(res.data.clientId, res.data.alreadyConverted);
    } finally {
      setAGravar(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-associar-cliente"
      onClick={(e) => {
        if (e.target === e.currentTarget && !aGravar) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 id="titulo-associar-cliente" className="text-[15px] font-semibold">
            Associar a cliente existente
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={aGravar}
            aria-label="Fechar"
            className="rounded-lg p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-[12.5px]" style={{ color: "var(--color-text-muted)" }}>
            A lead <strong>{leadName}</strong> fica ganha e o orçamento passa para o cliente
            escolhido. Não é criado nenhum cliente novo, e a ficha do cliente não é alterada.
          </p>

          <div className="block text-[12.5px] font-medium">
            Cliente<span className="ml-0.5 text-red-500">*</span>
            <PesquisaDestinatario
              leads={[]}
              clientes={clientes}
              valor={cliente}
              onEscolher={(d) => void escolherCliente(d)}
              placeholder="Procurar cliente por nome, email, telefone ou NIF…"
              autoFocus
              disabled={aGravar}
            />
          </div>

          {cliente && (
            <fieldset>
              <legend className="text-[12.5px] font-medium">Onde fica o serviço</legend>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2 text-[13px]">
                  <input
                    type="radio"
                    name="local-associacao"
                    value={LOCAL_NOVO}
                    checked={local === LOCAL_NOVO}
                    onChange={() => setLocal(LOCAL_NOVO)}
                    disabled={aGravar}
                    className="mt-0.5"
                  />
                  <span>
                    Local novo
                    <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                      Com a morada da visita, ou da lead se a visita não tiver.
                    </span>
                  </span>
                </label>

                {locais === null && !erroLocais && (
                  <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
                    A carregar os locais do cliente…
                  </p>
                )}
                {erroLocais && <p className="text-[12px] text-red-600">{erroLocais}</p>}

                {locais?.map((l) => (
                  <label key={l.id} className="flex items-start gap-2 text-[13px]">
                    <input
                      type="radio"
                      name="local-associacao"
                      value={l.id}
                      checked={local === l.id}
                      onChange={() => setLocal(l.id)}
                      disabled={aGravar}
                      className="mt-0.5"
                    />
                    <span>
                      {l.name}
                      <span className="block text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                        {l.address}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>

        <div
          className="flex justify-end gap-2 border-t px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={aGravar}
            className="rounded-lg border px-3 py-2 text-[13px] font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={confirmar}
            disabled={!cliente || aGravar}
            className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "#16A34A" }}
          >
            {aGravar ? "A associar…" : "Associar e marcar como ganha"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
