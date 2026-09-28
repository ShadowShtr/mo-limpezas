"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, X } from "lucide-react";
import { getAvisosVencimento } from "@/app/actions/avisos";
import { agruparPorUrgencia } from "@/domain/avisos/classify";
import {
  URGENCIA_LABEL,
  URGENCIA_ORDEM,
  type AvisoItem,
  type AvisoUrgencia,
} from "@/domain/avisos/types";

// ============================================================================
// O MODAL — uma vez por sessão da aba, e só a ler
// ============================================================================
//
// 🔴 SOMENTE LEITURA. Não marca pagamento, não conclui tarefa, não mexe em
//    lead nem fecha visita.
//
//    Um lembrete que também age é um clique de distância entre «vi o aviso» e
//    «mexi no dinheiro», num ecrã que aparece SOZINHO, à frente do que a pessoa
//    ia fazer. Cada linha navega para a superfície própria, onde a acção tem o
//    contexto e as guardas que aqui não existem.
// ============================================================================

/**
 * 🔴 `sessionStorage`, não `localStorage`, e a chave é versionada.
 *
 *    `localStorage` sobrevive ao fecho do browser: o aviso apareceria uma vez e
 *    nunca mais, e amanhã a pessoa não saberia do que venceu hoje.
 *    `sessionStorage` morre com a aba — abrir de novo é uma sessão nova e o
 *    aviso volta, que é exactamente o comportamento pedido.
 *
 *    O `:v1:` permite mudar de critério no futuro sem herdar o «já vi» de uma
 *    versão que mostrava outra coisa.
 */
const CHAVE_SESSAO = "avisos-vencimento:v1:shown";

/**
 * Todos os acessos a storage em try/catch, sem excepção.
 *
 * 🔴 `sessionStorage` não é garantido. Numa janela privada, com cookies de site
 *    bloqueados, ou dentro de uma captura de ecrã automática, o ACESSO À
 *    PROPRIEDADE lança — não é o `getItem` que falha, é `window.sessionStorage`.
 *    Sem isto, o dashboard inteiro deixava de renderizar por causa da camada de
 *    lembretes, que é precisamente o que não pode acontecer.
 */
function jaMostradoNestaSessao(): boolean {
  try {
    return window.sessionStorage.getItem(CHAVE_SESSAO) === "1";
  } catch {
    // Sem storage legível não há memória de sessão. Assumir «ainda não
    // mostrado» mantém o aviso a funcionar; assumir o contrário silenciá-lo-ia
    // para sempre em quem navega em privado.
    return false;
  }
}

function marcarMostrado(): void {
  try {
    window.sessionStorage.setItem(CHAVE_SESSAO, "1");
  } catch {
    // Não conseguir gravar significa apenas que o aviso pode voltar a aparecer
    // nesta aba. É o modo degradado aceitável — o inaceitável seria rebentar.
  }
}

const ICONE: Record<AvisoUrgencia, typeof AlertTriangle> = {
  atrasado: AlertTriangle,
  hoje: CalendarClock,
  amanha: CalendarClock,
};

const COR: Record<AvisoUrgencia, string> = {
  atrasado: "text-red-600 dark:text-red-400",
  hoje: "text-amber-600 dark:text-amber-400",
  amanha: "text-[var(--color-text-sub)]",
};

export function AvisosVencimentoModal({ inicial }: { inicial: AvisoItem[] }) {
  const [avisos, setAvisos] = useState<AvisoItem[]>(inicial);
  const [aberto, setAberto] = useState(false);

  /**
   * 🔴 Só se marca «mostrado» depois de o modal ter MESMO sido apresentado.
   *
   *    Marcar à entrada, independentemente de haver avisos, criaria este buraco:
   *    a pessoa abre o dashboard às 9h sem nada pendente, deixa a aba aberta, às
   *    11h vence um pagamento — e nunca seria avisada, porque a sessão já
   *    estaria carimbada como vista. É o caso que a reavaliação abaixo existe
   *    para apanhar, e carimbar cedo anulá-lo-ia.
   */
  const talvezMostrar = useCallback((lista: AvisoItem[]) => {
    if (lista.length === 0) return;
    if (jaMostradoNestaSessao()) return;
    setAvisos(lista);
    setAberto(true);
    marcarMostrado();
  }, []);

  // 🔴 A decisão TEM de ser tomada depois da montagem, e por isso o setState
  //    aqui é deliberado.
  //
  //    Depende de `sessionStorage`, que não existe no servidor. Decidir durante
  //    a renderização faria o servidor produzir sempre «mostrar» — não tem como
  //    saber que esta aba já viu — e o cliente, ao hidratar, decidir o
  //    contrário. Era um desencontro de hidratação num elemento que cobre o
  //    ecrã inteiro.
  //
  //    Mesma saída usada noutros pontos do projecto (buildings-column,
  //    calendar-view, service-photos) quando o estado inicial só pode ser
  //    conhecido no browser.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- depende de sessionStorage, indisponível no servidor; decidir em render daria desencontro de hidratação
    talvezMostrar(inicial);
  }, [inicial, talvezMostrar]);

  /**
   * Reavaliação ao voltar à aba — mesmo padrão já usado e testado no
   * `connection-banner`.
   *
   * 🔴 Só reconsulta se AINDA não mostrou nesta sessão. Depois de mostrado, o
   *    `visibilitychange` não reabre nada: um modal que reaparecesse a cada
   *    troca de separador deixaria de ser um aviso e passaria a ser um
   *    obstáculo, e a primeira coisa que se aprende com um obstáculo é a
   *    fechá-lo sem ler.
   */
  useEffect(() => {
    function aoVoltar() {
      if (document.visibilityState !== "visible") return;
      if (jaMostradoNestaSessao()) return;
      void getAvisosVencimento().then(talvezMostrar).catch(() => {
        // A action já engole os seus erros e devolve []. Este catch cobre a
        // falha de transporte da própria Server Action — e não fazer nada é a
        // resposta certa: tenta-se outra vez no próximo regresso à aba.
      });
    }
    document.addEventListener("visibilitychange", aoVoltar);
    return () => document.removeEventListener("visibilitychange", aoVoltar);
  }, [talvezMostrar]);

  if (!aberto || avisos.length === 0) return null;

  const grupos = agruparPorUrgencia(avisos);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="avisos-vencimento-titulo"
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-start justify-between gap-3 p-4 border-b border-[var(--color-border)]">
          <div>
            <h2 id="avisos-vencimento-titulo" className="text-base font-semibold text-[var(--color-text-main)]">
              Prazos a vencer
            </h2>
            <p className="text-xs text-[var(--color-text-sub)] mt-0.5">
              {avisos.length === 1 ? "1 assunto precisa de atenção" : `${avisos.length} assuntos precisam de atenção`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAberto(false)}
            aria-label="Fechar avisos"
            className="shrink-0 p-1.5 rounded-lg hover:bg-[var(--color-surface-hover)] text-[var(--color-text-sub)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-5">
          {URGENCIA_ORDEM.map((urgencia) => {
            const itens = grupos[urgencia];
            if (itens.length === 0) return null;
            const Icone = ICONE[urgencia];
            return (
              <section key={urgencia}>
                <h3 className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider mb-2 ${COR[urgencia]}`}>
                  <Icone className="w-3.5 h-3.5 shrink-0" />
                  {URGENCIA_LABEL[urgencia]} ({itens.length})
                </h3>
                <ul className="space-y-1.5">
                  {itens.map((item) => (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        onClick={() => setAberto(false)}
                        className="block rounded-lg border border-[var(--color-border)] px-3 py-2 hover:bg-[var(--color-surface-hover)]"
                      >
                        <p className="text-sm font-medium text-[var(--color-text-main)] leading-snug">
                          {item.title}
                        </p>
                        <p className="text-xs text-[var(--color-text-sub)] mt-0.5">
                          {item.detail} · {item.date.split("-").reverse().join("/")}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="p-4 border-t border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => setAberto(false)}
            className="w-full rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
