import { Car, FileText, Percent, Settings, Wrench, type LucideIcon } from "lucide-react";

export type TaskCategory = "orcamento" | "servico" | "assistencia" | "comercial" | "viatura";

export const TASK_CATEGORIES: { value: TaskCategory; label: string; icon: LucideIcon }[] = [
  { value: "orcamento",   label: "Orçamento",   icon: FileText },
  { value: "servico",     label: "Serviço",     icon: Settings },
  { value: "assistencia", label: "Assistência", icon: Wrench },
  { value: "comercial",   label: "Comercial",   icon: Percent },
  { value: "viatura",     label: "Viatura",     icon: Car },
];

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = Object.fromEntries(
  TASK_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<TaskCategory, string>;
