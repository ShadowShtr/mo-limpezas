"use client";

// ============================================================================
// «Dar saída» — o que substitui o caixote do lixo
// ============================================================================
//
// 🔴 O que estava aqui antes era um `window.confirm` com uma frase que
//    prometia exactamente aquilo que nunca devia acontecer:
//
//      «Apaga a conta de acesso e os registos dela (equipas, pontos,
//       ausências, férias, folha). Os serviços e contratos ficam, sem a
//       autoria. Não pode ser desfeito.»
//
//    Estava certa a descrever o código antigo, e é por isso que era grave: a
//    interface tinha normalizado a perda de histórico como comportamento
//    esperado. Quem lia aquilo aprendia que um serviço podia legitimamente
//    ficar sem saber quem o fez.
//
// Este ecrã não pergunta «tem a certeza?» antes de saber a resposta. Abre,
// conta o que existe, e só depois mostra o que é possível fazer. A eliminação
// definitiva não está escondida atrás de um aviso — está AUSENTE enquanto
// houver registos, porque um botão desativado convida a procurar a forma de o
// destravar, e aqui não há forma nenhuma.
// ============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { AlertTriangle, Archive, Loader2, Trash2, X } from "lucide-react";

import {
  avaliarSaidaColaborador, desativarColaborador, deleteColaborador,
} from "@/app/actions/colaboradores";

type Avaliacao = Awaited<ReturnType<typeof avaliarSaidaColaborador>>;
type AvaliacaoOk = Extract<Avaliacao, { ok: true }>;

interface Props {
  trigger: React.ReactElement;
  colaboradorId: string;
  nome: string;
  companyId: string;
}

export function SaidaColaboradorDialog({ trigger, colaboradorId, nome, companyId }: Props) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [avaliacao, setAvaliacao] = useState<AvaliacaoOk | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aCarregar, setACarregar] = useState(false);
  const [confirmaEliminar, setConfirmaEliminar] = useState(false);
  const [aExecutar, executar] = useTransition();

  async function abrir() {
    setAberto(true);
    setAvaliacao(null);
    setErro(null);
    setConfirmaEliminar(false);
    setACarregar(true);
    // A contagem é pedida ao abrir, e não no arranque da lista: são
    // quarenta e seis contagens por pessoa, e fazê-las para trinta linhas que
    // ninguém vai tocar seria pagar o preço todo para não mostrar nada.
    const resultado = await avaliarSaidaColaborador(colaboradorId, companyId);
    setACarregar(false);
    if (!resultado.ok) { setErro(resultado.error); return; }
    setAvaliacao(resultado);
  }

  function fechar() {
    setAberto(false);
    setAvaliacao(null);
    setErro(null);
    setConfirmaEliminar(false);
  }

  function desativar() {
    executar(async () => {
      const r = await desativarColaborador(colaboradorId, companyId);
      if (!r.ok) { setErro(r.error); return; }
      fechar();
      router.refresh();
    });
  }

  function eliminar() {
    executar(async () => {
      const r = await deleteColaborador(colaboradorId, companyId);
      if (!r.ok) {
        // A recusa pode chegar aqui mesmo depois de a avaliação ter dito que
        // era possível: alguém pode ter criado um registo entretanto. O
        // servidor decide outra vez, e é a decisão dele que vale.
        setErro(r.error);
        setConfirmaEliminar(false);
        return;
      }
      fechar();
      router.refresh();
    });
  }

  const corpo = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) fechar(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`Dar saída a ${nome}`}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-[var(--color-border)] px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-main)]">
              Dar saída a {nome}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Nada é apagado sem estar aqui explicado.
            </p>
          </div>
          <button
            onClick={fechar}
            aria-label="Fechar"
            className="rounded-lg p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-background)]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-6 py-5">
          {aCarregar && (
            <p className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <Loader2 className="size-4 animate-spin" />
              A verificar o que está ligado a esta pessoa...
            </p>
          )}

          {erro && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{erro}</span>
            </div>
          )}

          {avaliacao && (
            <>
              <p className="text-sm text-[var(--color-text-main)]">{avaliacao.explicacao}</p>

              {avaliacao.areas.length > 0 && (
                <div className="rounded-xl border border-[var(--color-border)]">
                  <p className="border-b border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                    O que fica guardado
                  </p>
                  <ul className="divide-y divide-[var(--color-border)]">
                    {avaliacao.areas.map((a) => (
                      <li key={a.area} className="flex items-center justify-between px-4 py-2 text-sm">
                        <span className="text-[var(--color-text-main)]">{a.nome}</span>
                        <span className="text-[var(--color-text-muted)]">
                          {a.contagem} {a.contagem === 1 ? "registo" : "registos"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {avaliacao.status === "inativo" && (
                <p className="rounded-lg bg-[var(--color-background)] p-3 text-xs text-[var(--color-text-sub)]">
                  Esta pessoa já está marcada como inativa. Desativar outra vez volta a
                  garantir que o acesso está retirado.
                </p>
              )}
            </>
          )}
        </div>

        {avaliacao && (
          <div className="space-y-2 border-t border-[var(--color-border)] bg-[var(--color-background)] px-6 py-4">
            {/* A opção correcta na esmagadora maioria dos casos vem primeiro e
                é a única com peso visual. */}
            <button
              onClick={desativar}
              disabled={aExecutar || avaliacao.proprioUtilizador}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {aExecutar ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
              Desativar e retirar o acesso
            </button>
            <p className="text-center text-xs text-[var(--color-text-muted)]">
              A pessoa deixa de entrar e sai das equipas, escalas e folha.
              Tudo o que fez continua no sistema. É reversível.
            </p>

            {avaliacao.veredicto.elegivel && !avaliacao.proprioUtilizador && (
              <div className="pt-2">
                {!confirmaEliminar ? (
                  <button
                    onClick={() => setConfirmaEliminar(true)}
                    disabled={aExecutar}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-white px-4 py-2 text-sm text-[var(--color-text-sub)] transition-colors hover:border-red-200 hover:text-red-600 disabled:opacity-50"
                  >
                    <Trash2 className="size-4" />
                    Eliminar definitivamente
                  </button>
                ) : (
                  <div className="space-y-2 rounded-lg bg-red-50 p-3">
                    <p className="text-xs text-red-700">
                      {nome} não tem nenhum registo no sistema. Eliminar apaga o perfil e
                      a conta de acesso, e não pode ser desfeito.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmaEliminar(false)}
                        disabled={aExecutar}
                        className="flex-1 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-sm text-[var(--color-text-sub)] disabled:opacity-50"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={eliminar}
                        disabled={aExecutar}
                        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {aExecutar && <Loader2 className="size-4 animate-spin" />}
                        Eliminar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {avaliacao.proprioUtilizador && (
              <p className="text-center text-xs text-[var(--color-text-muted)]">
                Não podes dar saída a ti própria.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <span onClick={abrir}>{trigger}</span>
      {aberto && typeof document !== "undefined" && createPortal(corpo, document.body)}
    </>
  );
}
