"use client";

import { useState, cloneElement, isValidElement } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X, Loader2, Check } from "lucide-react";
import { saveEquipa } from "@/app/actions/equipas";

type Member = { id: string; full_name: string; avatar_url: string | null };

type Equipa = {
  id: string;
  name: string;
  color: string;
  active: boolean;
  leader_id: string | null;
  members: Member[];
};

type Colaborador = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  role: string;
  status: string;
};

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  colaboradores: Colaborador[];
  equipa?: Equipa;
}

const COLORS = [
  "#16A34A", "#15803D", "#0EA5E9", "#6366F1", "#F59E0B",
  "#EF4444", "#EC4899", "#8B5CF6", "#14B8A6", "#F97316",
];

export function EquipaSheet({ trigger, companyId, colaboradores, equipa }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [name, setName] = useState(equipa?.name ?? "");
  const [color, setColor] = useState(equipa?.color ?? COLORS[0]);
  const [active, setActive] = useState(equipa?.active ?? true);
  const [leaderId, setLeaderId] = useState(equipa?.leader_id ?? "");
  const [selectedMembers, setSelectedMembers] = useState<string[]>(
    equipa?.members.map((m) => m.id) ?? []
  );

  const isEdit = !!equipa;

  function toggleMember(id: string) {
    setSelectedMembers((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const result = await saveEquipa(
      equipa?.id ?? null,
      companyId,
      { name, color, active, leader_id: leaderId || null },
      selectedMembers,
    );

    setLoading(false);

    if (!result.ok) {
      setMessage({ type: "error", text: result.error });
      return;
    }

    setMessage({ type: "success", text: isEdit ? "Equipa atualizada." : "Equipa criada com sucesso." });
    router.refresh();
  }

  const triggerWithOpen = isValidElement(trigger)
    ? cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, { onClick: () => setOpen(true) })
    : trigger;

  const overlay = open ? createPortal(
    <>
      <div className="fixed inset-0 bg-black/30 z-[9998]" onClick={() => setOpen(false)} />
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-[9999] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">{isEdit ? "Editar equipa" : "Nova equipa"}</h2>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form id="equipa-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Nome da equipa *</label>
                <input required value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="ex: Equipa A"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>

              {/* Cor */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-2">Cor da equipa</label>
                <div className="flex gap-2 flex-wrap">
                  {COLORS.map((c) => (
                    <button key={c} type="button" onClick={() => setColor(c)}
                      className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                      style={{ backgroundColor: c }}>
                      {color === c && <Check className="w-4 h-4 text-white" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Lider */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Líder da equipa</label>
                <select value={leaderId} onChange={(e) => setLeaderId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-white text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] appearance-auto">
                  <option value="">Sem líder definido</option>
                  {selectedMembers.map((id) => {
                    const c = colaboradores.find((col) => col.id === id);
                    return c ? <option key={id} value={id}>{c.full_name}</option> : null;
                  })}
                </select>
              </div>

              {/* Membros */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-2">
                  Membros <span className="text-[var(--color-text-muted)] font-normal">({selectedMembers.length} selecionados)</span>
                </label>
                <div className="space-y-1 max-h-52 overflow-y-auto border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]">
                  {colaboradores.map((c) => {
                    const selected = selectedMembers.includes(c.id);
                    const initials = c.full_name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
                    return (
                      <button key={c.id} type="button" onClick={() => toggleMember(c.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${selected ? "bg-[var(--color-primary-light)]" : "hover:bg-[var(--color-background)]"}`}>
                        <div className="w-7 h-7 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0 overflow-hidden">
                          {c.avatar_url
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={c.avatar_url} alt={c.full_name} className="w-full h-full object-cover" />
                            : <span className="text-[var(--color-primary)] font-semibold text-xs">{initials}</span>
                          }
                        </div>
                        <span className={`text-sm flex-1 ${selected ? "font-medium text-[var(--color-primary)]" : "text-[var(--color-text-main)]"}`}>
                          {c.full_name}
                        </span>
                        {selected && <Check className="w-4 h-4 text-[var(--color-primary)]" />}
                      </button>
                    );
                  })}
                  {colaboradores.length === 0 && (
                    <p className="px-3 py-4 text-sm text-[var(--color-text-muted)] text-center">Sem colaboradores ativos.</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setActive((a) => !a)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${active ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${active ? "translate-x-5" : "translate-x-0.5"}`} style={{ left: 0 }} />
                </button>
                <span className="text-sm text-[var(--color-text-main)]">{active ? "Equipa ativa" : "Equipa inativa"}</span>
              </div>

              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg ${message.type === "error" ? "bg-red-50 text-[var(--color-danger)] border border-red-100" : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
                  {message.text}
                </div>
              )}
            </form>

            <div className="border-t border-[var(--color-border)] px-6 py-4">
              <button form="equipa-form" type="submit" disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar equipa"}
              </button>
            </div>
          </div>
    </>,
    document.body
  ) : null;

  return (
    <>
      {triggerWithOpen}
      {overlay}
    </>
  );
}
