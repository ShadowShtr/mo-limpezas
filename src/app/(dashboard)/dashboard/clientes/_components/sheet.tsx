"use client";

import { useState, cloneElement, isValidElement } from "react";
import { X, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Cliente = {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  nif: string | null;
  active: boolean;
};

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  cliente?: Cliente;
}

export function ClienteSheet({ trigger, companyId, cliente }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [name, setName] = useState(cliente?.name ?? "");
  const [contactName, setContactName] = useState(cliente?.contact_name ?? "");
  const [contactEmail, setContactEmail] = useState(cliente?.contact_email ?? "");
  const [contactPhone, setContactPhone] = useState(cliente?.contact_phone ?? "");
  const [nif, setNif] = useState(cliente?.nif ?? "");
  const [active, setActive] = useState(cliente?.active ?? true);

  const isEdit = !!cliente;
  const supabase = createClient();

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const updateData = {
      name,
      contact_name: contactName || null,
      contact_email: contactEmail || null,
      contact_phone: contactPhone || null,
      nif: nif || null,
      active,
    };

    const query = isEdit
      ? supabase.from("clients").update(updateData).eq("id", cliente.id)
      : supabase.from("clients").insert({ ...updateData, company_id: companyId });

    const { error } = await query;
    setLoading(false);

    if (error) {
      setMessage({ type: "error", text: "Erro ao guardar. Tenta novamente." });
    } else {
      setMessage({ type: "success", text: isEdit ? "Cliente atualizado." : "Cliente criado com sucesso." });
    }
  }

  const triggerWithOpen = isValidElement(trigger)
    ? cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, { onClick: () => setOpen(true) })
    : trigger;

  return (
    <>
      {triggerWithOpen}
      {open && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setOpen(false)} />
          <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-50 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">
                {isEdit ? "Editar cliente" : "Novo cliente"}
              </h2>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form id="cliente-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Nome do cliente *</label>
                <input required value={name} onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Nome do contacto</label>
                <input value={contactName} onChange={(e) => setContactName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Email</label>
                <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Telefone</label>
                <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="+351 900 000 000"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">NIF</label>
                <input value={nif} onChange={(e) => setNif(e.target.value)} placeholder="500 000 000"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setActive((a) => !a)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${active ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${active ? "left-5.5" : "left-0.5"}`} />
                </button>
                <span className="text-sm text-[var(--color-text-main)]">{active ? "Cliente ativo" : "Cliente inativo"}</span>
              </div>
              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg ${message.type === "error" ? "bg-red-50 text-[var(--color-danger)] border border-red-100" : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
                  {message.text}
                </div>
              )}
            </form>

            <div className="border-t border-[var(--color-border)] px-6 py-4">
              <button form="cliente-form" type="submit" disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar cliente"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
