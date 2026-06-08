"use client";

import { useState, useTransition, cloneElement, isValidElement } from "react";
import { X, Loader2 } from "lucide-react";
import { createCliente, updateCliente } from "@/app/actions/clientes";

type Cliente = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  status: string;
};

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  cliente?: Cliente;
}

export function ClienteSheet({ trigger, companyId, cliente }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [name, setName] = useState(cliente?.name ?? "");
  const [email, setEmail] = useState(cliente?.email ?? "");
  const [phone, setPhone] = useState(cliente?.phone ?? "");
  const [nif, setNif] = useState(cliente?.nif ?? "");
  const [status, setStatus] = useState(cliente?.status ?? "ativo");

  const isEdit = !!cliente;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const input = {
        name,
        email: email || undefined,
        phone: phone || undefined,
        nif: nif || undefined,
        status,
      };

      const res = isEdit
        ? await updateCliente(cliente.id, input)
        : await createCliente({ ...input, company_id: companyId });

      if (res.ok) {
        setMessage({
          type: "success",
          text: isEdit ? "Cliente atualizado." : "Cliente criado com sucesso.",
        });
        if (!isEdit) {
          setName(""); setEmail(""); setPhone(""); setNif(""); setStatus("ativo");
        }
      } else {
        setMessage({ type: "error", text: res.error });
      }
    });
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
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Telefone</label>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="+351 900 000 000"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">NIF</label>
                <input value={nif} onChange={(e) => setNif(e.target.value)} placeholder="500 000 000"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Estado</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent">
                  <option value="ativo">Ativo</option>
                  <option value="inativo">Inativo</option>
                </select>
              </div>
              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg ${message.type === "error" ? "bg-red-50 text-[var(--color-danger)] border border-red-100" : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
                  {message.text}
                </div>
              )}
            </form>

            <div className="border-t border-[var(--color-border)] px-6 py-4">
              <button form="cliente-form" type="submit" disabled={pending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar cliente"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
