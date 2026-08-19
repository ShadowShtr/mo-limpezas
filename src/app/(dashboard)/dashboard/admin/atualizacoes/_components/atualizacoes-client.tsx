"use client";

// ============================================================================
// PAINEL DE AVISOS — publicar e ver o histórico
// ============================================================================
// Formulário à esquerda, preview à direita. O preview usa exactamente o mesmo
// componente que o popup real (`UpdateNoticeCard`) — se usasse outro caminho,
// acabaria por mostrar algo diferente do que sai.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { Loader2, AlertCircle, Send, Archive, Search } from "lucide-react";
import { UpdateNoticeCard } from "@/components/update-notices/update-notice-card";
import {
  NOTICE_KINDS,
  NOTICE_KIND_LABEL,
  NOTICE_MESSAGE_MAX,
  NOTICE_TITLE_MAX,
  type NoticeAudience,
  type NoticeKind,
} from "@/domain/update-notices/types";
import {
  archiveNotice,
  countRecipients,
  publishNotice,
  type NoticeListItem,
} from "@/app/actions/update-notices";

interface Props {
  notices: NoticeListItem[];
  loadError: string | null;
  companies: { id: string; name: string }[];
  profiles: { id: string; name: string; company: string }[];
}

const AUDIENCE_LABEL: Record<NoticeAudience, string> = {
  all: "Todos",
  companies: "Empresas específicas",
  profiles: "Perfis específicos",
};

export function AtualizacoesClient({ notices, loadError, companies, profiles }: Props) {
  const [kind, setKind] = useState<NoticeKind>("novidade");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<NoticeAudience>("all");
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [busca, setBusca] = useState("");

  const [destinatarios, setDestinatarios] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Quantos perfis recebem — calculado no servidor, nunca estimado no cliente.
  useEffect(() => {
    let cancelado = false;
    async function contar() {
      const res = await countRecipients(audience, companyIds, profileIds);
      if (cancelado) return;
      setDestinatarios(res.ok ? res.count : null);
    }
    contar();
    return () => { cancelado = true; };
  }, [audience, companyIds, profileIds]);

  function alternar(lista: string[], id: string): string[] {
    return lista.includes(id) ? lista.filter((x) => x !== id) : [...lista, id];
  }

  function publicar() {
    setErro(null);
    setSucesso(null);
    startTransition(async () => {
      const res = await publishNotice({ kind, title, message, audience, companyIds, profileIds });
      if (!res.ok) {
        setErro(res.error);
        setConfirmar(false);
        return;
      }
      setSucesso(`Aviso publicado para ${res.recipients} ${res.recipients === 1 ? "perfil" : "perfis"}.`);
      setTitle("");
      setMessage("");
      setCompanyIds([]);
      setProfileIds([]);
      setAudience("all");
      setConfirmar(false);
    });
  }

  function arquivar(id: string) {
    if (!confirm("Arquivar este aviso? Deixa de ser mostrado a quem ainda não o leu.")) return;
    startTransition(async () => {
      const res = await archiveNotice(id);
      if (!res.ok) setErro(res.error);
    });
  }

  const perfisFiltrados = busca.trim()
    ? profiles.filter((p) =>
        `${p.name} ${p.company}`.toLowerCase().includes(busca.trim().toLowerCase()),
      ).slice(0, 40)
    : profiles.slice(0, 40);

  const podePublicar =
    title.trim().length > 0 &&
    message.trim().length > 0 &&
    title.length <= NOTICE_TITLE_MAX &&
    message.length <= NOTICE_MESSAGE_MAX &&
    (audience === "all" ||
      (audience === "companies" && companyIds.length > 0) ||
      (audience === "profiles" && profileIds.length > 0));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-text-main)]">Atualizações</h1>
        <p className="mt-1 text-sm text-[var(--color-text-sub)]">
          Avisos mostrados a quem entra na aplicação. Cada pessoa confirma o seu, uma vez.
        </p>
      </div>

      {(loadError || erro) && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {loadError ?? erro}
        </div>
      )}

      {sucesso && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          {sucesso}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Formulário ── */}
        <div className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-white p-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-main)]">Tipo</label>
            <div className="flex flex-wrap gap-2">
              {NOTICE_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    kind === k
                      ? "bg-[var(--color-primary)] text-white"
                      : "border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                  }`}
                >
                  {NOTICE_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-main)]">
              Título{" "}
              <span className="font-normal text-[var(--color-text-muted)]">
                {title.length}/{NOTICE_TITLE_MAX}
              </span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={NOTICE_TITLE_MAX}
              className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
              placeholder="Financeiro e anexos mais estáveis"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-main)]">
              Mensagem{" "}
              <span className="font-normal text-[var(--color-text-muted)]">
                {message.length}/{NOTICE_MESSAGE_MAX}
              </span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={NOTICE_MESSAGE_MAX}
              rows={4}
              className="w-full resize-none rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
              placeholder="O que mudou, em linguagem de quem usa o sistema."
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-main)]">Destinatários</label>
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value as NoticeAudience)}
              className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            >
              {(Object.keys(AUDIENCE_LABEL) as NoticeAudience[]).map((a) => (
                <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>
              ))}
            </select>
          </div>

          {audience === "companies" && (
            <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
              {companies.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--color-background)]">
                  <input
                    type="checkbox"
                    checked={companyIds.includes(c.id)}
                    onChange={() => setCompanyIds((p) => alternar(p, c.id))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}

          {audience === "profiles" && (
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Procurar por nome ou empresa…"
                  className="w-full rounded-lg border border-[var(--color-border)] py-2 pl-9 pr-3 text-sm outline-none focus:border-[var(--color-primary)]"
                />
              </div>
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
                {perfisFiltrados.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--color-background)]">
                    <input
                      type="checkbox"
                      checked={profileIds.includes(p.id)}
                      onChange={() => setProfileIds((prev) => alternar(prev, p.id))}
                    />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-[var(--color-text-muted)]">{p.company}</span>
                  </label>
                ))}
                {perfisFiltrados.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">Nenhum perfil encontrado.</p>
                )}
              </div>
            </div>
          )}

          <div className="border-t border-[var(--color-border)] pt-4">
            {destinatarios !== null && (
              <p className="mb-3 text-sm text-[var(--color-text-sub)]">
                Este aviso será enviado para{" "}
                <strong className="text-[var(--color-text-main)]">
                  {destinatarios} {destinatarios === 1 ? "perfil" : "perfis"}
                </strong>.
              </p>
            )}

            {!confirmar ? (
              <button
                type="button"
                onClick={() => setConfirmar(true)}
                disabled={!podePublicar || isPending}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                Publicar aviso
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-[var(--color-text-sub)]">
                  Depois de publicado, o conteúdo não pode ser alterado.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmar(false)}
                    className="flex-1 rounded-lg border border-[var(--color-border)] py-2.5 text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={publicar}
                    disabled={isPending}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                  >
                    {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Confirmar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Preview: o mesmo componente do popup ── */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--color-text-main)]">Pré-visualização</p>
          <div className="overflow-hidden rounded-[26px] border border-[var(--color-border)] bg-white/85 shadow-sm">
            <UpdateNoticeCard
              kind={kind}
              title={title.trim() || "Título do aviso"}
              message={message.trim() || "A mensagem aparece aqui, tal como será mostrada."}
              publishedAt={new Date().toISOString()}
            />
            <div className="px-7 pb-7 pt-3 sm:px-8 sm:pb-8">
              <div className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-center text-[15px] font-medium text-white">
                Entendi
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Histórico ── */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-white">
        <div className="border-b border-[var(--color-border)] px-5 py-3.5">
          <p className="text-sm font-semibold text-[var(--color-text-main)]">Histórico</p>
        </div>

        {notices.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-[var(--color-text-muted)]">
            Ainda não foi publicado nenhum aviso manual.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)]">
                  <th className="px-5 py-2.5 font-medium">Título</th>
                  <th className="px-3 py-2.5 font-medium">Tipo</th>
                  <th className="px-3 py-2.5 font-medium">Data</th>
                  <th className="px-3 py-2.5 font-medium">Destino</th>
                  <th className="px-3 py-2.5 font-medium">Lidos</th>
                  <th className="px-3 py-2.5 font-medium">Estado</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {notices.map((n) => (
                  <tr key={n.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="max-w-[240px] truncate px-5 py-3 text-[var(--color-text-main)]">{n.title}</td>
                    <td className="px-3 py-3 text-[var(--color-text-sub)]">{NOTICE_KIND_LABEL[n.kind]}</td>
                    <td className="px-3 py-3 text-[var(--color-text-sub)]">
                      {n.publishedAt ? new Date(n.publishedAt).toLocaleDateString("pt-PT") : "—"}
                    </td>
                    <td className="px-3 py-3 text-[var(--color-text-sub)]">{AUDIENCE_LABEL[n.audience]}</td>
                    <td className="px-3 py-3 text-[var(--color-text-sub)]">{n.reads} / {n.recipients}</td>
                    <td className="px-3 py-3">
                      <span className={n.archivedAt ? "text-[var(--color-text-muted)]" : "text-emerald-600"}>
                        {n.archivedAt ? "Arquivado" : n.publishedAt ? "Publicado" : "Rascunho"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {!n.archivedAt && (
                        <button
                          type="button"
                          onClick={() => arquivar(n.id)}
                          title="Arquivar"
                          className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)]"
                        >
                          <Archive className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
