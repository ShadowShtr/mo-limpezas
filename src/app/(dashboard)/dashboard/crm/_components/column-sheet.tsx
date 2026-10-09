"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { saveCrmColumn } from "@/app/actions/crm-colunas";
import { useToast } from "@/components/ui/toast";
import { COLUMN_COLORS, type CrmColumn, type ColumnColor } from "@/lib/crm/columns";

const LABELS: Record<ColumnColor,string> = { slate: "Cinza", blue: "Azul", amber: "Amarelo", violet: "Violeta", green: "Verde", red: "Vermelho" };

export function ColumnSheet({ column, onClose }: { column: CrmColumn | null; onClose: () => void }) {
  const [name, setName] = useState(column?.name ?? "");
  const [color, setColor] = useState<ColumnColor>(column?.color ?? "blue");
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form role="dialog" aria-modal="true" aria-labelledby="column-title"
        className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await saveCrmColumn(column?.id ?? null, { name, color });
            if (!result.ok) { toast(result.error.message, "error"); return; }
            toast(column ? "Coluna atualizada." : "Coluna criada.", "success");
            onClose(); router.refresh();
          });
        }}>
        <h2 id="column-title" className="font-semibold">{column ? "Editar coluna" : "Nova coluna"}</h2>
        <label className="block text-sm">Nome
          <input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2" disabled={pending} />
        </label>
        <label className="block text-sm">Cor
          <select value={color} onChange={(e) => setColor(e.target.value as ColumnColor)}
            className="mt-1 w-full rounded-lg border px-3 py-2" disabled={pending}>
            {COLUMN_COLORS.map((c) => <option key={c} value={c}>{LABELS[c]}</option>)}
          </select>
        </label>
        <p className="text-xs text-slate-500">Só para organizar cartões. Não altera o estado comercial.</p>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={pending} onClick={onClose} className="rounded-lg border px-3 py-2 text-sm">Cancelar</button>
          <button disabled={pending || !name.trim()} className="rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {pending ? "A guardar…" : column ? "Guardar" : "Criar coluna"}
          </button>
        </div>
      </form>
    </div>, document.body,
  );
}
