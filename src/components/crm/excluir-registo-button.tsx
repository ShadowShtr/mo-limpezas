"use client";

import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { excluirRegistoCrm } from "@/app/actions/crm-excluir";

export function ExcluirRegistoButton({ tipo, id, nome, onDeleted }: {
  tipo: "lead" | "visita" | "orcamento";
  id: string;
  nome: string;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  return (
    <span onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <ConfirmDialog
        trigger={
          <button type="button" aria-label={`Excluir ${nome}`}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-red-600 hover:bg-red-50">
            <Trash2 className="h-3.5 w-3.5" />Excluir
          </button>
        }
        title={`Excluir ${nome}?`}
        description={tipo === "lead"
          ? "A lead, os contactos, as visitas e os orçamentos associados serão excluídos. O cliente e os locais mantêm-se. Esta ação não pode ser desfeita aqui."
          : "Este registo será excluído. Esta ação não pode ser desfeita aqui. O cliente mantém-se."}
        confirmLabel="Excluir"
        onConfirm={async () => {
          try {
            const result = await excluirRegistoCrm(tipo, id);
            if (!result.ok) { toast(result.error.message, "error"); return; }
            toast("Registo excluído.", "success");
            onDeleted?.();
            router.refresh();
          } catch {
            toast("Não foi possível excluir. Tente novamente.", "error");
          }
        }}
      />
    </span>
  );
}
