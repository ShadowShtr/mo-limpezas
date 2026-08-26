"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { X, Loader2, Plus, Trash2 } from "lucide-react";
import { createColaborador, updateColaborador } from "@/app/actions/colaboradores";
import { inviteCollaborator } from "@/app/actions/auth";
import { isValidIsoDateString } from "@/lib/utils";

type Colaborador = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  iban: string | null;
  hourly_rate: number | null;
  contract_start: string | null;
  contract_end: string | null;
  role: string;
  status: string;
  contracted_hours_month: number | null;
  skills: string[];
  avatar_url: string | null;
  invited_at: string | null;
};

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  colaborador?: Colaborador;
}

const SKILLS_SUGESTOES = [
  "Vidros", "Industrial", "Carpetes", "Escritórios", "Cozinhas",
  "Casas de banho", "Exterior", "Hospitalar", "Alta pressão", "Encerador",
];

export function ColaboradorSheet({ trigger, companyId, colaborador }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [name, setName] = useState(colaborador?.full_name ?? "");
  const [email, setEmail] = useState(colaborador?.email ?? "");
  const [phone, setPhone] = useState(colaborador?.phone ?? "");
  const [nif, setNif] = useState(colaborador?.nif ?? "");
  const [iban, setIban] = useState(colaborador?.iban ?? "");
  const [hourlyRate, setHourlyRate] = useState(colaborador?.hourly_rate != null ? String(colaborador.hourly_rate) : "");
  const [contractStart, setContractStart] = useState(colaborador?.contract_start ?? "");
  const [contractEnd, setContractEnd] = useState(colaborador?.contract_end ?? "");
  const [role, setRole] = useState(colaborador?.role ?? "colaborador");
  const [status, setStatus] = useState(colaborador?.status ?? "ativo");
  const [hours, setHours] = useState(String(colaborador?.contracted_hours_month ?? "168"));
  const [skills, setSkills] = useState<string[]>(colaborador?.skills ?? []);
  const [skillInput, setSkillInput] = useState("");

  const isEdit = !!colaborador;

  function addSkill(s: string) {
    const trimmed = s.trim();
    if (trimmed && !skills.includes(trimmed)) setSkills((prev) => [...prev, trimmed]);
    setSkillInput("");
  }
  function removeSkill(s: string) { setSkills((prev) => prev.filter((sk) => sk !== s)); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const input = {
        full_name: name,
        email: email || undefined,
        phone: phone || undefined,
        nif: nif || undefined,
        iban: iban || undefined,
        hourly_rate: hourlyRate ? parseFloat(hourlyRate) : null,
        contract_start: contractStart || null,
        contract_end: contractEnd || null,
        role,
        status,
        contracted_hours_month: parseFloat(hours) || 168,
        skills,
      };

      const res = isEdit
        ? await updateColaborador(colaborador.id, input)
        : await createColaborador({ ...input, company_id: companyId });

      if (res.ok) {
        setMessage({
          type: "success",
          text: isEdit ? "Colaborador atualizado." : "Colaborador criado com sucesso.",
        });
        if (!isEdit) {
          setName(""); setEmail(""); setPhone(""); setNif(""); setIban("");
          setHourlyRate(""); setContractStart(""); setContractEnd("");
          setRole("colaborador"); setStatus("ativo"); setHours("168"); setSkills([]);
        }
        router.refresh();
        setTimeout(() => { setOpen(false); setMessage(null); }, 700);
      } else {
        setMessage({ type: "error", text: res.error });
      }
    });
  }

  async function handleSendInvite() {
    if (!email) return;
    setSending(true);
    setMessage(null);
    const fd = new FormData();
    fd.set("email", email);
    fd.set("name", name);
    fd.set("company_id", companyId);
    const result = await inviteCollaborator(fd);
    setSending(false);
    if ("error" in result) {
      setMessage({ type: "error", text: String(result.error) });
    } else {
      setMessage({ type: "success", text: "Convite enviado para " + email });
    }
  }

  const overlay = open ? createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998] animate-in fade-in duration-150"
        style={{ background: "rgba(9,14,26,0.45)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
        onClick={() => setOpen(false)}
      />
      <div
        className="fixed right-0 top-0 h-full w-full max-w-md z-[9999] flex flex-col animate-in slide-in-from-right duration-200"
        style={{
          background: "rgba(255,255,255,0.97)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          boxShadow: "-8px 0 40px rgba(9,14,26,0.14), -1px 0 0 rgba(15,23,42,0.07)",
        }}
      >

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
              <div>
                <h2 className="text-base font-semibold text-[var(--color-text-main)]">
                  {isEdit ? "Editar colaborador" : "Novo colaborador"}
                </h2>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  {isEdit ? "Atualiza os dados abaixo." : "Preenche os dados. Email é opcional para testes."}
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Formulário */}
            <form id="colaborador-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

              {/* Nome */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Nome completo *</label>
                <input required value={name} onChange={(e) => setName(e.target.value)}
                  className={inputCls} />
              </div>

              {/* Email — opcional */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">
                  Email <span className="text-[var(--color-text-muted)] font-normal">(opcional)</span>
                </label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="nome@exemplo.com"
                  className={inputCls} />
              </div>

              {/* Telefone */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Telefone</label>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="+351 900 000 000"
                  className={inputCls} />
              </div>

              {/* NIF + IBAN */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">NIF</label>
                  <input value={nif} onChange={(e) => setNif(e.target.value)}
                    placeholder="000 000 000"
                    className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">€/hora</label>
                  <input type="number" step="0.01" min="0" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)}
                    placeholder="0.00"
                    className={inputCls} />
                </div>
              </div>

              {/* IBAN */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">IBAN</label>
                <input value={iban} onChange={(e) => setIban(e.target.value)}
                  placeholder="PT50 0000 0000 0000 0000 0000 0"
                  className={inputCls} />
              </div>

              {/* Datas de contrato */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Início contrato</label>
                  <input type="date" value={contractStart} onChange={(e) => { if (!e.target.value || isValidIsoDateString(e.target.value)) setContractStart(e.target.value); }}
                    className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Fim contrato</label>
                  <input type="date" value={contractEnd} onChange={(e) => { if (!e.target.value || isValidIsoDateString(e.target.value)) setContractEnd(e.target.value); }}
                    className={inputCls} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Função</label>
                  <select value={role} onChange={(e) => setRole(e.target.value)} className={selectCls}>
                    <option value="colaborador">Colaborador</option>
                    <option value="gestor">Gestor</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Estado</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
                    <option value="ativo">Ativo</option>
                    <option value="inativo">Inativo</option>
                    <option value="suspenso">Suspenso</option>
                  </select>
                </div>
              </div>

              {/* Horas/mês */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Horas contratuais/mês</label>
                <input type="number" min={0} max={300} value={hours} onChange={(e) => setHours(e.target.value)}
                  className={inputCls} />
              </div>

              {/* Skills */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Skills</label>
                <div className="flex gap-2 mb-2">
                  <input value={skillInput} onChange={(e) => setSkillInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(skillInput); } }}
                    placeholder="Adicionar skill..." className={`${inputCls} flex-1`} />
                  <button type="button" onClick={() => addSkill(skillInput)}
                    className="p-2 rounded-lg bg-[var(--color-primary-light)] text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)] transition-colors">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {SKILLS_SUGESTOES.filter((s) => !skills.includes(s)).map((s) => (
                    <button key={s} type="button" onClick={() => addSkill(s)}
                      className="text-xs px-2 py-1 rounded-full border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
                      + {s}
                    </button>
                  ))}
                </div>
                {skills.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {skills.map((s) => (
                      <span key={s} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)] font-medium">
                        {s}
                        <button type="button" onClick={() => removeSkill(s)}><Trash2 className="w-3 h-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg ${
                  message.type === "error"
                    ? "bg-red-50 text-[var(--color-danger)] border border-red-100"
                    : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"
                }`}>{message.text}</div>
              )}
            </form>

            {/* Footer */}
            <div className="border-t border-[var(--color-border)] px-6 py-4 space-y-2">
              {email && (
                <button type="button" onClick={handleSendInvite} disabled={sending}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-primary)] text-[var(--color-primary)] text-sm font-medium hover:bg-[var(--color-primary-light)] transition-colors disabled:opacity-50">
                  {sending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isEdit && colaborador?.invited_at ? "Reenviar convite" : "Enviar convite por email"}
                </button>
              )}
              <button form="colaborador-form" type="submit" disabled={pending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar colaborador"}
              </button>
            </div>
          </div>
    </>,
    document.body
  ) : null;

  return (
    <>
      <span onClick={() => { setMessage(null); setOpen(true); }} style={{ display: "contents", cursor: "pointer" }}>
        {trigger}
      </span>
      {overlay}
    </>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-white text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

const selectCls =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-white text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] appearance-auto";
