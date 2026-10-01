"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, CalendarDays, CheckCircle2, Loader2, X } from "lucide-react";
import { getAvisosVencimento } from "@/app/actions/avisos";
import { agruparPorUrgencia } from "@/domain/avisos/classify";
import {
  AREA_DA_FONTE,
  AREA_LABEL,
  AREA_ORDEM,
  FONTE_LABEL,
  URGENCIA_LABEL,
  URGENCIA_ORDEM,
  eUrgente,
  type AvisoArea,
  type AvisoItem,
  type AvisoUrgencia,
} from "@/domain/avisos/types";
import type { QuadroAvisos } from "@/lib/avisos/load-avisos";
import { definirContagemAvisos, registarAbridorAvisos } from "./avisos-store";

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
  proximos: CalendarDays,
};

const COR: Record<AvisoUrgencia, string> = {
  atrasado: "text-red-600 dark:text-red-400",
  hoje: "text-amber-600 dark:text-amber-400",
  amanha: "text-[var(--color-text-sub)]",
  proximos: "text-[var(--color-text-muted)]",
};

/** Merece abrir sozinho ao entrar: atrasado, hoje ou amanhã. Os «próximos» não. */
const pedeAtencao = (i: AvisoItem) => i.urgencia !== "proximos";

/**
 * A aba que abre primeiro: a primeira área com algo urgente, senão a primeira
 * com alguma coisa, senão a primeira de todas.
 */
function abaInicial(itens: readonly AvisoItem[]): AvisoArea {
  return AREA_ORDEM.find((a) => itens.some((i) => AREA_DA_FONTE[i.source] === a && eUrgente(i.urgencia)))
    ?? AREA_ORDEM.find((a) => itens.some((i) => AREA_DA_FONTE[i.source] === a))
    ?? AREA_ORDEM[0];
}

export function AvisosVencimentoModal({ inicial }: { inicial: QuadroAvisos }) {
  const [quadro, setQuadro] = useState<QuadroAvisos>(inicial);
  const [aberto, setAberto] = useState(false);
  const [aConsultar, setAConsultar] = useState(false);
  const [aba, setAba] = useState<AvisoArea>(() => abaInicial(inicial.itens));
  const avisos = quadro.itens;

  // O número do botão «!»: atrasados e de hoje. Amanhã e próximos não acendem.
  useEffect(() => {
    definirContagemAvisos(avisos.length, avisos.filter((a) => eUrgente(a.urgencia)).length);
  }, [avisos]);

  /**
   * Abrir a pedido, pelo «!» do cabeçalho.
   *
   * Ao contrário do aviso automático, abre MESMO sem nada pendente — quem
   * carregou quer saber, e «nada pendente» é uma resposta. A lista é
   * reconsultada no clique, para não mostrar a de quando a aba abriu.
   * Conta como «mostrado»: o automático não aparece depois por cima.
   */
  const abrirAPedido = useCallback(() => {
    setAberto(true);
    setAConsultar(true);
    marcarMostrado();
    void getAvisosVencimento()
      .then((novo) => {
        setQuadro(novo);
        setAba(abaInicial(novo.itens));
      })
      .catch(() => {
        // Falha de transporte da própria Server Action: fica a última lista
        // conhecida no ecrã, em vez de a apagar.
      })
      .finally(() => setAConsultar(false));
  }, []);

  useEffect(() => registarAbridorAvisos(abrirAPedido), [abrirAPedido]);

  /**
   * 🔴 Só se marca «mostrado» depois de o modal ter MESMO sido apresentado.
   *
   *    Marcar à entrada, independentemente de haver avisos, criaria este buraco:
   *    a pessoa abre o dashboard às 9h sem nada pendente, deixa a aba aberta, às
   *    11h vence um pagamento — e nunca seria avisada, porque a sessão já
   *    estaria carimbada como vista. É o caso que a reavaliação abaixo existe
   *    para apanhar, e carimbar cedo anulá-lo-ia.
   *
   * 🔴 Só abre sozinho por atrasado, hoje ou amanhã — o que já abria antes da
   *    janela de 15 dias. Com os «próximos» a contar, o quadro saltaria em
   *    praticamente todas as sessões, e um aviso que aparece sempre aprende-se
   *    a fechar sem ler. Os próximos ficam a um clique, no «!».
   */
  const talvezMostrar = useCallback((novo: QuadroAvisos) => {
    if (!novo.itens.some(pedeAtencao)) return;
    if (jaMostradoNestaSessao()) return;
    setQuadro(novo);
    setAba(abaInicial(novo.itens));
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
        // A action nunca lança; este catch cobre a falha de transporte da
        // própria Server Action — e não fazer nada é a resposta certa: tenta-se
        // outra vez no próximo regresso à aba.
      });
    }
    document.addEventListener("visibilitychange", aoVoltar);
    return () => document.removeEventListener("visibilitychange", aoVoltar);
  }, [talvezMostrar]);

  if (!aberto) return null;

  const falhas = quadro.fontesEmFalha;
  const daAba = avisos.filter((i) => AREA_DA_FONTE[i.source] === aba);
  const grupos = agruparPorUrgencia(daAba);
  const falhasDaAba = falhas.filter((f) => AREA_DA_FONTE[f] === aba);

  const subtitulo = avisos.length > 0
    ? (avisos.length === 1 ? "1 assunto em aberto" : `${avisos.length} assuntos em aberto`)
    : falhas.length > 0 ? "Não foi possível verificar tudo" : "Nada pendente";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="avisos-vencimento-titulo"
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-start justify-between gap-3 p-4 pb-3">
          <div>
            <h2 id="avisos-vencimento-titulo" className="text-base font-semibold text-[var(--color-text-main)]">
              Prazos e pendentes
            </h2>
            <p className="text-xs text-[var(--color-text-sub)] mt-0.5">
              {subtitulo} · atrasados até 15 dias e próximos 15 dias
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

        <div role="tablist" aria-label="Áreas" className="flex gap-1 overflow-x-auto px-4 border-b border-[var(--color-border)]">
          {AREA_ORDEM.map((area) => {
            const daArea = avisos.filter((i) => AREA_DA_FONTE[i.source] === area);
            const urgentes = daArea.filter((i) => eUrgente(i.urgencia)).length;
            const ativa = area === aba;
            return (
              <button
                key={area}
                type="button"
                role="tab"
                aria-selected={ativa}
                onClick={() => setAba(area)}
                className={`shrink-0 -mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs font-medium ${ativa ? "border-[var(--color-primary)] text-[var(--color-text-main)]" : "border-transparent text-[var(--color-text-sub)] hover:text-[var(--color-text-main)]"}`}
              >
                {AREA_LABEL[area]}
                <span className={`min-w-[18px] rounded-full px-1.5 text-[10px] leading-[18px] ${urgentes > 0 ? "bg-red-500 text-white" : "bg-[var(--color-background)] text-[var(--color-text-sub)]"}`}>
                  {daArea.length}
                </span>
              </button>
            );
          })}
        </div>

        <div className="overflow-y-auto p-4 space-y-5">
          {falhasDaAba.length > 0 && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>
                Não foi possível verificar: {falhasDaAba.map((f) => FONTE_LABEL[f]).join(", ")}.
                Esta lista pode estar incompleta — tente de novo mais tarde.
              </span>
            </p>
          )}
          {daAba.length === 0 && falhasDaAba.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-[var(--color-text-sub)]">
              {aConsultar
                ? <><Loader2 className="w-4 h-4 animate-spin" /> A verificar…</>
                : <><CheckCircle2 className="w-4 h-4 text-emerald-600" /> Nada pendente em {AREA_LABEL[aba]}.</>}
            </p>
          )}
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
