"use client";

// ============================================================================
// Fechar / reabrir o mês financeiro
// ============================================================================
//
// Pastilha de estado + a acção correspondente. Vive na casca do Financeiro, ao
// lado do seletor de período.
//
// 🔴 Isto é conveniência, não segurança. O botão desaparece num mês fechado e
//    os controlos de mutação ficam `disabled`, mas nada disso protege nada: as
//    server actions revalidam o estado do período por si
//    (`assertFinancialPeriodOpen`), e recusam mesmo que o pedido venha de um
//    cliente modificado ou de um botão que a UI julgava inactivo.
//
//    A UI serve para não deixar a gestora tentar uma coisa que vai falhar. A
//    garantia está no servidor.
// ============================================================================

import { useState, useTransition } from "react";
import { Check, Lock, LockOpen, TriangleAlert } from "lucide-react";

import {
  closeFinancialPeriod,
  getFinancialCloseChecklist,
  reopenFinancialPeriod,
  type ChecklistResposta,
} from "@/app/actions/financial-periods";
import { MIN_CARACTERES_MOTIVO } from "@/domain/finance-v2/financial-period";

type Props = {
  year: number;
  month: number;
  nomePeriodo: string;
  status: "open" | "closed";
  /** Só admin/gestor vê os botões. A action valida o papel de novo. */
  podeGerir: boolean;
  closedByName: string | null;
  reopenReason: string | null;
};

export function PeriodCloseControls({
  year,
  month,
  nomePeriodo,
  status,
  podeGerir,
  closedByName,
  reopenReason,
}: Props) {
  const [modal, setModal] = useState<null | "fechar" | "reabrir">(null);
  const [checklist, setChecklist] = useState<ChecklistResposta | null>(null);
  const [carregandoChecklist, setCarregandoChecklist] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [aGuardar, iniciar] = useTransition();

  const fechado = status === "closed";

  // 🔴 Abrir o modal lê o checklist. Ler, e nada mais — nenhuma escrita até a
  //    gestora confirmar. Cancelar também não escreve nada.
  async function abrirFechar() {
    setErro(null);
    setModal("fechar");
    setCarregandoChecklist(true);
    const r = await getFinancialCloseChecklist({ year, month });
    setCarregandoChecklist(false);
    if (r.ok) setChecklist(r.checklist);
    else setErro(r.error);
  }

  function confirmarFecho() {
    setErro(null);
    iniciar(async () => {
      const r = await closeFinancialPeriod({ year, month });
      if (r.ok) {
        setModal(null);
        setChecklist(null);
      } else {
        setErro(r.error);
      }
    });
  }

  function confirmarReabertura() {
    setErro(null);
    iniciar(async () => {
      const r = await reopenFinancialPeriod({ year, month, reason: motivo });
      if (r.ok) {
        setModal(null);
        setMotivo("");
      } else {
        setErro(r.error);
      }
    });
  }

  const motivoValido = motivo.trim().length >= MIN_CARACTERES_MOTIVO;

  return (
    <>
      <div className="flex items-center gap-2 shrink-0">
        {fechado ? (
          <span
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-2 rounded-[10px] bg-[var(--finance-surface-soft)] border border-[var(--finance-border)] text-[var(--finance-text-secondary)]"
            title={
              closedByName
                ? `Fechado por ${closedByName}. Mês financeiro fechado.`
                : "Mês financeiro fechado."
            }
          >
            <Check className="size-3.5" aria-hidden />
            Mês fechado
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-[10px] bg-[var(--finance-surface-soft)] border border-[var(--finance-border)] text-[var(--finance-text-secondary)]">
            <LockOpen className="size-3.5" aria-hidden />
            Mês aberto
          </span>
        )}

        {podeGerir && (
          <button
            type="button"
            onClick={fechado ? () => setModal("reabrir") : abrirFechar}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-2 rounded-[10px] border border-[var(--finance-border)] bg-[var(--finance-surface)] hover:bg-[var(--finance-surface-soft)] transition-colors"
          >
            {fechado ? <LockOpen className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
            {fechado ? "Reabrir" : "Fechar mês"}
          </button>
        )}
      </div>

      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={modal === "fechar" ? `Fechar ${nomePeriodo}` : `Reabrir ${nomePeriodo}`}
        >
          <div className="w-full max-w-lg rounded-[14px] bg-[var(--finance-surface)] border border-[var(--finance-border)] p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-[15px] font-semibold">
              {modal === "fechar" ? `Fechar ${nomePeriodo}` : `Reabrir ${nomePeriodo}`}
            </h3>

            {modal === "fechar" && (
              <>
                {carregandoChecklist && (
                  <p className="text-[13px] text-[var(--finance-text-secondary)]">A verificar o mês…</p>
                )}

                {checklist && (
                  <ul className="space-y-1.5 text-[13px]">
                    {checklist.itens.map((i) => (
                      <li key={i.chave} className="flex items-start gap-2">
                        {i.gravidade === "ok" && <Check className="size-4 shrink-0 mt-0.5 text-[var(--finance-positive)]" aria-hidden />}
                        {i.gravidade === "warning" && <TriangleAlert className="size-4 shrink-0 mt-0.5 text-[var(--finance-warning)]" aria-hidden />}
                        {i.gravidade === "blocker" && <TriangleAlert className="size-4 shrink-0 mt-0.5 text-[var(--finance-negative)]" aria-hidden />}
                        <span>
                          {i.rotulo}
                          {i.contagem !== null && i.contagem > 0 && <strong> — {i.contagem}</strong>}
                          <span className="block text-[12px] text-[var(--finance-text-secondary)]">{i.detalhe}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {checklist && !checklist.podeFechar && (
                  <p className="text-[13px] text-[var(--finance-negative)]">
                    Há verificações que não foi possível concluir. Não é seguro fechar o mês sem
                    saber o que ele contém.
                  </p>
                )}

                <p className="text-[13px] text-[var(--finance-text-secondary)]">
                  Depois de fechado, alterações financeiras deste período ficam bloqueadas até
                  uma reabertura autorizada.
                </p>
              </>
            )}

            {modal === "reabrir" && (
              <>
                {closedByName && (
                  <p className="text-[12px] text-[var(--finance-text-secondary)]">
                    Fechado por {closedByName}.
                  </p>
                )}
                {reopenReason && (
                  <p className="text-[12px] text-[var(--finance-text-secondary)]">
                    Motivo da última reabertura: {reopenReason}
                  </p>
                )}
                <label className="block space-y-1.5">
                  <span className="text-[13px] font-medium">Motivo da reabertura</span>
                  <textarea
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    rows={3}
                    placeholder="Ex.: correcção da fatura F2026/014"
                    className="w-full text-[13px] rounded-[10px] border border-[var(--finance-border)] bg-[var(--finance-bg)] p-2.5"
                  />
                  <span className="block text-[12px] text-[var(--finance-text-secondary)]">
                    Obrigatório. Daqui a seis meses, é isto que explica porque é que os números
                    deste mês mudaram.
                  </span>
                </label>
              </>
            )}

            {erro && <p className="text-[13px] text-[var(--finance-negative)]">{erro}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setModal(null);
                  setErro(null);
                  setChecklist(null);
                }}
                disabled={aGuardar}
                className="text-[13px] px-3.5 py-2 rounded-[10px] border border-[var(--finance-border)] hover:bg-[var(--finance-surface-soft)] transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={modal === "fechar" ? confirmarFecho : confirmarReabertura}
                disabled={
                  aGuardar ||
                  (modal === "fechar" && (carregandoChecklist || !checklist?.podeFechar)) ||
                  (modal === "reabrir" && !motivoValido)
                }
                className="text-[13px] font-medium px-3.5 py-2 rounded-[10px] bg-[var(--color-primary)] text-white disabled:opacity-50 transition-opacity"
              >
                {aGuardar ? "A guardar…" : modal === "fechar" ? "Fechar mês" : "Reabrir mês"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
