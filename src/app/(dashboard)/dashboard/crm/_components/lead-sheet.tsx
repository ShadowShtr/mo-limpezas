"use client";

// ============================================================================
// Formulário da lead — criar e editar
// ============================================================================
//
// Padrão do projeto: `createPortal`, estado por campo, `useTransition`, e o
// resultado da action tratado sempre (nunca ignorado — foi esse o defeito que
// a auditoria encontrou em dez sítios).
//
// Só o nome é obrigatório, e é deliberado: uma lead nasce de um telefonema em
// que se apanha o nome e mais nada. Um formulário que exigisse email ou
// telefone deixaria essas de fora do sistema — que é o problema que este
// módulo existe para resolver.
//
// Criar começa por PESQUISAR. Quem já é cliente não entra no funil como lead
// nova: a conversão criaria um segundo cliente com o mesmo nome. Para esses,
// a proposta de serviço novo faz-se por visita ou orçamento ao cliente — que
// a 102 e a 103 já aceitam. Uma lead que já existe abre-se, não se repete.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CalendarPlus, FileText, User, X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_VALUE_KINDS,
  LEAD_VALUE_KIND_LABELS,
} from "@/lib/crm/sources";
import { createLead, updateLead, type LeadRow } from "@/app/actions/crm-leads";
import {
  PesquisaDestinatario,
  type Destinatario,
  type DestinatarioOpcao,
} from "@/components/crm/pesquisa-destinatario";

import type { Membro } from "./pipeline-client";

/** O mesmo input em todo o formulário. Tailwind, como o resto do projeto. */
const CAMPO =
  "mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal bg-white border-[var(--color-border)]";

const TIPOS_SERVICO: { value: string; label: string }[] = [
  { value: "limpeza_regular", label: "Limpeza regular" },
  { value: "manutencao", label: "Manutenção" },
  { value: "pos_obra", label: "Pós-obra" },
  { value: "vidros", label: "Vidros" },
  { value: "carpetes", label: "Carpetes" },
  { value: "industrial", label: "Industrial" },
  { value: "outro", label: "Outro" },
];

interface Props {
  /** `null` cria; uma lead edita. */
  lead: LeadRow | null;
  membros: Membro[];
  /**
   * Para a pesquisa antes de criar. Sem eles (editar, ou a ficha da lead) o
   * formulário abre directamente.
   */
  leads?: DestinatarioOpcao[];
  clientes?: DestinatarioOpcao[];
  /** Nome já escrito noutro sítio (`?nova=`): salta a pesquisa. */
  nomeInicial?: string;
  onClose: () => void;
}

export function LeadSheet({ lead, membros, leads, clientes, nomeInicial, onClose }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [erros, setErros] = useState<Record<string, string[]>>({});

  const comPesquisa = !lead && !nomeInicial && Boolean(leads || clientes);
  const [fase, setFase] = useState<"pesquisa" | "formulario">(
    comPesquisa ? "pesquisa" : "formulario",
  );
  const [encontrado, setEncontrado] = useState<Destinatario | null>(null);

  const [name, setName] = useState(lead?.name ?? nomeInicial ?? "");
  const [leadType, setLeadType] = useState<"individual" | "empresa">(lead?.lead_type ?? "empresa");
  const [contactName, setContactName] = useState(lead?.contact_name ?? "");
  const [email, setEmail] = useState(lead?.email ?? "");
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [nif, setNif] = useState(lead?.nif ?? "");
  const [address, setAddress] = useState(lead?.address ?? "");
  const [source, setSource] = useState(lead?.source ?? "");
  const [sourceDetail, setSourceDetail] = useState(lead?.source_detail ?? "");
  const [ownerId, setOwnerId] = useState(lead?.owner_id ?? "");
  const [valor, setValor] = useState(lead?.estimated_value?.toString() ?? "");
  const [valorTipo, setValorTipo] = useState(lead?.estimated_value_kind ?? "mensal");
  const [proximaData, setProximaData] = useState(lead?.next_action_at ?? "");
  const [proximaNota, setProximaNota] = useState(lead?.next_action_note ?? "");
  const [servico, setServico] = useState(lead?.service_type ?? "");
  const [frequencia, setFrequencia] = useState(lead?.frequency_hint ?? "");
  const [notas, setNotas] = useState(lead?.notes ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  function submeter(e: React.FormEvent) {
    e.preventDefault();
    setErros({});

    const input = {
      name,
      lead_type: leadType,
      contact_name: contactName || null,
      email: email || null,
      phone: phone || null,
      nif: nif || null,
      address: address || null,
      source: (source || null) as never,
      source_detail: sourceDetail || null,
      owner_id: ownerId || null,
      // Um campo vazio é "não sei", e não zero. Zero diria que o trabalho não
      // vale nada, e entraria na soma da coluna.
      estimated_value: valor === "" ? null : Number(valor),
      estimated_value_kind: valorTipo as never,
      next_action_at: proximaData || null,
      next_action_note: proximaNota || null,
      service_type: servico || null,
      frequency_hint: frequencia || null,
      notes: notas || null,
    };

    startTransition(async () => {
      const res = lead ? await updateLead(lead.id, input) : await createLead(input);

      if (!res.ok) {
        // Ramifica pelo código, nunca pelo texto da mensagem.
        if (res.error.fieldErrors) setErros(res.error.fieldErrors);
        toast(res.error.message, "error");
        return;
      }

      toast(lead ? "Lead atualizada." : "Lead criada.", "success");
      onClose();
      router.refresh();
    });
  }

  const erro = (campo: string) => erros[campo]?.[0];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-lead"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <form
        onSubmit={submeter}
        className="flex h-full w-full max-w-md flex-col bg-white shadow-xl"
      >
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 id="titulo-lead" className="text-[15px] font-semibold">
            {lead ? "Editar lead" : fase === "pesquisa" ? "Cliente ou lead" : "Nova lead"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Fechar"
            className="rounded-lg p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {fase === "pesquisa" ? (
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="block text-[12.5px] font-medium">
              Procure primeiro — pode já existir
              <PesquisaDestinatario
                leads={leads ?? []}
                clientes={clientes ?? []}
                valor={encontrado}
                onEscolher={(d) => {
                  // Uma lead que já existe abre-se na ficha dela.
                  if (d?.tipo === "lead") {
                    onClose();
                    router.push(`/dashboard/crm/${d.id}`);
                    return;
                  }
                  setEncontrado(d);
                }}
                onCriarNovo={(texto) => {
                  setName(texto);
                  setFase("formulario");
                }}
                placeholder="Nome, email, telefone ou NIF…"
                autoFocus
              />
            </div>

            {encontrado?.tipo === "cliente" ? (
              <div
                className="rounded-lg border p-3"
                style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
              >
                <p className="text-[12.5px]">
                  <strong>{encontrado.name}</strong> já é cliente. Para lhe propor serviço novo,
                  marque uma visita ou faça um orçamento ao cliente — sem criar uma lead nova.
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  {(
                    [
                      [`/dashboard/crm/visitas?cliente=${encontrado.id}`, CalendarPlus, "Marcar visita"],
                      [`/dashboard/crm/orcamentos?cliente=${encontrado.id}`, FileText, "Novo orçamento"],
                      [`/dashboard/clientes/${encontrado.id}`, User, "Abrir ficha do cliente"],
                    ] as const
                  ).map(([href, Icone, etiqueta]) => (
                    <button
                      key={href}
                      type="button"
                      onClick={() => {
                        onClose();
                        router.push(href);
                      }}
                      className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-left text-[13px] font-medium"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <Icone className="h-4 w-4" style={{ color: "#16A34A" }} />
                      {etiqueta}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                Se não aparecer ninguém, escolha «Criar nova lead» no fim da lista.
              </p>
            )}
          </div>
        ) : (
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Campo label="Empresa / Nome" obrigatorio erro={erro("name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              autoFocus
              className={CAMPO}
            />
          </Campo>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="Tipo">
              <select
                value={leadType}
                onChange={(e) => setLeadType(e.target.value as "individual" | "empresa")}
                className={CAMPO}
              >
                <option value="empresa">Empresa</option>
                <option value="individual">Particular</option>
              </select>
            </Campo>
            <Campo label="Pessoa de contacto">
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                maxLength={500}
                className={CAMPO}
              />
            </Campo>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="Email" erro={erro("email")}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={CAMPO}
              />
            </Campo>
            <Campo label="Telefone">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={CAMPO} />
            </Campo>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="NIF">
              <input value={nif} onChange={(e) => setNif(e.target.value)} className={CAMPO} />
            </Campo>
            <Campo label="Responsável">
              <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={CAMPO}>
                <option value="">Sem responsável</option>
                {membros.map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name}</option>
                ))}
              </select>
            </Campo>
          </div>

          <Campo label="Morada">
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={CAMPO} />
          </Campo>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="Como nos encontrou">
              <select value={source} onChange={(e) => setSource(e.target.value)} className={CAMPO}>
                <option value="">Não indicado</option>
                {LEAD_SOURCES.map((s) => (
                  <option key={s} value={s}>{LEAD_SOURCE_LABELS[s]}</option>
                ))}
              </select>
            </Campo>
            <Campo label="Detalhe da origem">
              <input
                value={sourceDetail}
                onChange={(e) => setSourceDetail(e.target.value)}
                placeholder="Quem recomendou, que anúncio…"
                className={CAMPO}
              />
            </Campo>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="Valor estimado (€)" erro={erro("estimated_value")}>
              <input
                type="number"
                min={0}
                step="0.01"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                className={CAMPO}
              />
            </Campo>
            <Campo label="Natureza do valor">
              <select
                value={valorTipo}
                onChange={(e) => setValorTipo(e.target.value)}
                className={CAMPO}
              >
                {LEAD_VALUE_KINDS.map((k) => (
                  <option key={k} value={k}>{LEAD_VALUE_KIND_LABELS[k]}</option>
                ))}
              </select>
            </Campo>
          </div>
          <p className="-mt-2 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
            Um valor por mês e um valor único não se somam — por isso é preciso
            dizer qual é qual.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="Tipo de serviço">
              <select value={servico} onChange={(e) => setServico(e.target.value)} className={CAMPO}>
                <option value="">Não indicado</option>
                {TIPOS_SERVICO.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </Campo>
            <Campo label="Periodicidade pedida">
              <input
                value={frequencia}
                onChange={(e) => setFrequencia(e.target.value)}
                placeholder="2x por semana…"
                className={CAMPO}
              />
            </Campo>
          </div>

          <div
            className="rounded-lg border p-3"
            style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
          >
            <p className="text-[12px] font-semibold">Próxima ação</p>
            <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
              Com data no passado, o cartão fica assinalado no quadro.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Campo label="Quando" erro={erro("next_action_at")}>
                <input
                  type="date"
                  value={proximaData}
                  onChange={(e) => {
                    // Ignora valores malformados: foi um ano com um dígito a
                    // mais, vindo de um input nativo, que rebentou a ficha de
                    // um cliente real em 2026-07-14.
                    const v = e.target.value;
                    if (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) setProximaData(v);
                  }}
                  className={CAMPO}
                />
              </Campo>
              <Campo label="O quê">
                <input
                  value={proximaNota}
                  onChange={(e) => setProximaNota(e.target.value)}
                  placeholder="Ligar, enviar orçamento…"
                  className={CAMPO}
                />
              </Campo>
            </div>
          </div>

          <Campo label="Notas">
            <textarea
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              rows={3}
              maxLength={5000}
              className={CAMPO}
            />
          </Campo>
        </div>
        )}

        <div
          className="flex justify-end gap-2 border-t px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border px-3 py-2 text-[13px] font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            Cancelar
          </button>
          {fase === "formulario" && (
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "#16A34A" }}
          >
            {pending ? "A guardar…" : lead ? "Guardar" : "Criar lead"}
          </button>
          )}
        </div>
      </form>

    </div>,
    document.body,
  );
}

function Campo({
  label,
  obrigatorio,
  erro,
  children,
}: {
  label: string;
  obrigatorio?: boolean;
  erro?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[12.5px] font-medium">
      {label}
      {obrigatorio && <span className="ml-0.5 text-red-500">*</span>}
      {children}
      {erro && <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">{erro}</span>}
    </label>
  );
}
