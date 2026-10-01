"use client";

import { AlertCircle } from "lucide-react";
import { pedirAbrirAvisos, useEstadoAvisos } from "./avisos-store";

/**
 * O «!» ao lado do sino: abre o modal de prazos a qualquer momento.
 *
 * O aviso automático só aparece uma vez por sessão da aba; isto é o caminho
 * para voltar a ele sem fechar a aba. Só abre — não lê nem escreve nada por
 * si: quem consulta é o modal, quando recebe o pedido.
 *
 * Sem modal montado (fora do dashboard), `total` fica `null` e o botão não
 * aparece — um botão que não abre nada é pior do que nenhum.
 */
export function AvisosButton() {
  const { total, urgentes } = useEstadoAvisos();
  if (total === null) return null;

  return (
    <button
      type="button"
      onClick={pedirAbrirAvisos}
      className="relative p-2 rounded-lg text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] transition-colors"
      aria-label={urgentes > 0 ? `Prazos pendentes: ${urgentes} atrasados ou para hoje` : "Prazos pendentes"}
      title="Prazos pendentes"
    >
      <AlertCircle className="w-5 h-5" />
      {urgentes > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 rounded-full text-white text-[10px] font-bold flex items-center justify-center leading-none ring-2 ring-white">
          {urgentes > 99 ? "99+" : urgentes}
        </span>
      )}
    </button>
  );
}
