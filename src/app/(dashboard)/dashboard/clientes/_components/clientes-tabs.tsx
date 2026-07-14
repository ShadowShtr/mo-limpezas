"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { ClientesTable } from "./table";
import { ClienteSheet } from "./sheet";
import { PrediosTable } from "./predios-table";
import type { BuildingCard } from "@/app/actions/building-cards";

type Cliente = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  status: string;
  vat_exempt: boolean;
  created_at: string;
};
type Team = { id: string; name: string; color: string };

interface Props {
  clientes: Cliente[];
  buildingCards: BuildingCard[];
  teams: Team[];
  companyId: string;
}

export function ClientesTabs({ clientes, buildingCards, teams, companyId }: Props) {
  const [tab, setTab] = useState<"clientes" | "predios">("clientes");

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
          <button
            onClick={() => setTab("clientes")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === "clientes" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
            }`}
          >
            Clientes
          </button>
          <button
            onClick={() => setTab("predios")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-l border-[var(--color-border)] ${
              tab === "predios" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
            }`}
          >
            Prédios
            <span className="ml-1.5 text-xs opacity-75">({buildingCards.length})</span>
          </button>
        </div>

        {tab === "clientes" && (
          <ClienteSheet
            companyId={companyId}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <Plus className="w-4 h-4" />
                Novo cliente
              </button>
            }
          />
        )}
      </div>

      {tab === "clientes" ? (
        <ClientesTable clientes={clientes} companyId={companyId} />
      ) : (
        <PrediosTable buildingCards={buildingCards} teams={teams} />
      )}
    </div>
  );
}
