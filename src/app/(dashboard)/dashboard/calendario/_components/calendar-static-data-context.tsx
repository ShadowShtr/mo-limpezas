"use client";

import { createContext, useContext, type ReactNode } from "react";

type Client = { id: string; name: string };
type Loc = { id: string; client_id: string; name: string; address: string; hourly_rate: number | null };

type CalendarStaticData = { clients: Client[]; locations: Loc[] };

// Clientes e locais não dependem do dia/semana selecionado — são fornecidos
// pelo layout do calendário (fetched uma única vez ao entrar na rota) para
// que trocar de dia/semana/mês não tenha de os voltar a carregar (ver
// calendario/layout.tsx).
const CalendarStaticDataContext = createContext<CalendarStaticData | null>(null);

export function CalendarStaticDataProvider({
  clients, locations, children,
}: CalendarStaticData & { children: ReactNode }) {
  return (
    <CalendarStaticDataContext.Provider value={{ clients, locations }}>
      {children}
    </CalendarStaticDataContext.Provider>
  );
}

export function useCalendarStaticData(): CalendarStaticData {
  const ctx = useContext(CalendarStaticDataContext);
  if (!ctx) throw new Error("useCalendarStaticData tem de ser usado dentro de CalendarStaticDataProvider");
  return ctx;
}
