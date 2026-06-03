const STATUS: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  agendado:      { label: "Agendado",   dot: "bg-[var(--color-primary)]", text: "text-[var(--color-primary)]",  bg: "bg-[var(--color-primary-light)]" },
  em_curso:      { label: "Em curso",   dot: "bg-amber-500",              text: "text-amber-700",               bg: "bg-amber-50" },
  concluido:     { label: "Concluído",  dot: "bg-[var(--color-success)]", text: "text-[var(--color-success)]",  bg: "bg-[var(--color-primary-light)]" },
  cancelado:     { label: "Cancelado",  dot: "bg-[var(--color-danger)]",  text: "text-[var(--color-danger)]",   bg: "bg-red-50" },
  falta:         { label: "Falta",      dot: "bg-[var(--color-danger)]",  text: "text-[var(--color-danger)]",   bg: "bg-red-50" },
  sem_cobertura: { label: "S/ cobertura", dot: "bg-[var(--color-danger)]", text: "text-[var(--color-danger)]", bg: "bg-red-50" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.agendado;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
