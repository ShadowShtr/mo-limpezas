"use client";

import { useState, useRef, useTransition } from "react";
import {
  Upload, X, Loader2, AlertCircle, CheckCircle2, ArrowDownRight, ArrowUpRight,
  Check, Ban, Link2, EyeOff, FilePlus2, RefreshCw, History, Search, Trash2,
} from "lucide-react";
import { usePagination, Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";
import {
  getBankReconciliationData, confirmMatch, rejectMatch, manualMatch,
  ignoreTransaction, createEntryFromTransaction, recalcSuggestions, searchCashFlowEntries,
  deleteImport,
  type BankTransactionDTO, type ImportDTO, type BankAccountDTO,
} from "@/app/actions/bank-reconciliation";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtDate(s: string) {
  return new Date(s + "T00:00:00").toLocaleDateString("pt-PT");
}
function confidence(score: number) {
  if (score >= 90) return { label: "muito provável", cls: "bg-green-100 text-green-700" };
  if (score >= 70) return { label: "provável", cls: "bg-emerald-100 text-emerald-700" };
  if (score >= 50) return { label: "possível", cls: "bg-amber-100 text-amber-700" };
  return { label: "baixa", cls: "bg-gray-100 text-gray-600" };
}

const STATUS_BADGE: Record<BankTransactionDTO["status"], { label: string; cls: string }> = {
  pending:    { label: "Por conciliar", cls: "bg-gray-100 text-gray-600" },
  matched:    { label: "Sugerido", cls: "bg-amber-100 text-amber-700" },
  reconciled: { label: "Conciliado", cls: "bg-green-100 text-green-700" },
  ignored:    { label: "Ignorado", cls: "bg-gray-100 text-gray-400" },
  duplicate:  { label: "Duplicado", cls: "bg-red-100 text-red-600" },
};

interface InitialData {
  transactions: BankTransactionDTO[];
  imports: ImportDTO[];
  accounts: BankAccountDTO[];
}

interface Props {
  initial: InitialData | null;
  error: string | null;
}

const STATUS_FILTERS: { value: "" | BankTransactionDTO["status"]; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "pending", label: "Por conciliar" },
  { value: "matched", label: "Com sugestão" },
  { value: "reconciled", label: "Conciliados" },
  { value: "ignored", label: "Ignorados" },
  { value: "duplicate", label: "Duplicados" },
];

export function ReconciliationClient({ initial, error: initErr }: Props) {
  const { toast } = useToast();
  const [data, setData] = useState<InitialData | null>(initial);
  const [error] = useState(initErr);
  const [statusFilter, setStatusFilter] = useState<"" | BankTransactionDTO["status"]>("");
  const [showImport, setShowImport] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [manualFor, setManualFor] = useState<BankTransactionDTO | null>(null);
  const [isPending, startTransition] = useTransition();

  function reload() {
    startTransition(async () => {
      const res = await getBankReconciliationData(statusFilter ? { status: statusFilter } : undefined);
      if (res.ok) setData({ transactions: res.transactions, imports: res.imports, accounts: res.accounts });
      else toast(res.error, "error");
    });
  }

  function applyFilter(v: "" | BankTransactionDTO["status"]) {
    setStatusFilter(v);
    startTransition(async () => {
      const res = await getBankReconciliationData(v ? { status: v } : undefined);
      if (res.ok) setData({ transactions: res.transactions, imports: res.imports, accounts: res.accounts });
    });
  }

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    const res = await fn();
    if (res.ok) { toast(okMsg, "success"); reload(); }
    else toast(res.error ?? "Erro.", "error");
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-2 text-red-700">
        <AlertCircle className="w-5 h-5" /> {error}
      </div>
    );
  }
  if (!data) return null;

  const txs = data.transactions;

  return (
    <div className="space-y-5">
      {/* Barra de ações */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => applyFilter(f.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                statusFilter === f.value
                  ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                  : "bg-white text-[var(--color-text-muted)] border-[var(--color-border)] hover:bg-gray-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => act(() => recalcSuggestions(), "Sugestões recalculadas.")}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-[var(--color-border)] bg-white hover:bg-gray-50"
          >
            <RefreshCw className="w-4 h-4" /> Recalcular
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-[var(--color-border)] bg-white hover:bg-gray-50"
          >
            <History className="w-4 h-4" /> Histórico
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--color-primary)] text-white hover:opacity-90"
          >
            <Upload className="w-4 h-4" /> Importar Extrato
          </button>
        </div>
      </div>

      {isPending && (
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" /> A carregar…
        </div>
      )}

      {/* Tabela de movimentos */}
      <TransactionsTable
        txs={txs}
        onConfirm={(id) => act(() => confirmMatch(id), "Conciliação confirmada.")}
        onReject={(id) => act(() => rejectMatch(id), "Sugestão rejeitada.")}
        onIgnore={(id) => act(() => ignoreTransaction(id, true), "Movimento ignorado.")}
        onCreateEntry={(id) => act(() => createEntryFromTransaction(id), "Lançamento criado e conciliado.")}
        onManual={(tx) => setManualFor(tx)}
      />

      {showImport && (
        <ImportModal
          accounts={data.accounts}
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); reload(); }}
        />
      )}
      {showHistory && (
        <HistoryModal
          imports={data.imports}
          onClose={() => setShowHistory(false)}
          onDelete={(id) => act(() => deleteImport(id), "Importação apagada.")}
        />
      )}
      {manualFor && (
        <ManualMatchModal
          tx={manualFor}
          onClose={() => setManualFor(null)}
          onMatch={(entryId) => {
            const txId = manualFor.id;
            setManualFor(null);
            act(() => manualMatch(txId, entryId), "Associação manual feita.");
          }}
        />
      )}
    </div>
  );
}

// ─── Tabela ────────────────────────────────────────────────────────────────────

function TransactionsTable({
  txs, onConfirm, onReject, onIgnore, onCreateEntry, onManual,
}: {
  txs: BankTransactionDTO[];
  onConfirm: (matchId: string) => void;
  onReject: (matchId: string) => void;
  onIgnore: (txId: string) => void;
  onCreateEntry: (txId: string) => void;
  onManual: (tx: BankTransactionDTO) => void;
}) {
  const pg = usePagination(txs, 20);

  if (txs.length === 0) {
    return (
      <div className="bg-white border border-dashed border-[var(--color-border)] rounded-xl p-10 text-center text-[var(--color-text-muted)]">
        Sem movimentos. Importe um extrato para começar.
      </div>
    );
  }

  return (
    <div className="bg-white border border-[var(--color-border)] rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)] uppercase">
              <th className="px-4 py-3 font-medium">Data</th>
              <th className="px-4 py-3 font-medium">Descrição do banco</th>
              <th className="px-4 py-3 font-medium text-right">Valor</th>
              <th className="px-4 py-3 font-medium">Sugestão do sistema</th>
              <th className="px-4 py-3 font-medium text-center">Pontuação</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 font-medium text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {pg.pageItems.map((tx) => {
              const best = tx.suggestions.find((s) => s.status === "suggested") ?? tx.suggestions[0];
              const conf = best ? confidence(best.match_score) : null;
              const badge = STATUS_BADGE[tx.status];
              const isCredit = tx.direction === "credit";
              return (
                <tr key={tx.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDate(tx.transaction_date)}</td>
                  <td className="px-4 py-3 max-w-[260px]">
                    <p className="truncate" title={tx.description}>{tx.description || "—"}</p>
                    {tx.counterparty_name && <p className="text-xs text-[var(--color-text-muted)] truncate">{tx.counterparty_name}</p>}
                  </td>
                  <td className={`px-4 py-3 text-right whitespace-nowrap font-medium ${isCredit ? "text-[var(--color-primary)]" : "text-red-500"}`}>
                    <span className="inline-flex items-center gap-1 justify-end">
                      {isCredit ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                      {fmtEur(tx.amount)}
                    </span>
                  </td>
                  <td className="px-4 py-3 max-w-[220px]">
                    {best?.entry_description ? (
                      <div>
                        <p className="truncate" title={best.entry_description}>{best.entry_description}</p>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          {best.entry_amount != null ? fmtEur(best.entry_amount) : ""} · {best.entry_date ? fmtDate(best.entry_date) : ""}
                        </p>
                      </div>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {best && conf ? (
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${conf.cls}`}>
                        {best.match_score} · {conf.label}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end flex-wrap">
                      {tx.status !== "reconciled" && tx.status !== "duplicate" && (
                        <>
                          {best?.status === "suggested" && best.match_id && (
                            <>
                              <IconBtn title="Confirmar" onClick={() => onConfirm(best.match_id)} cls="text-green-600 hover:bg-green-50"><Check className="w-4 h-4" /></IconBtn>
                              <IconBtn title="Rejeitar" onClick={() => onReject(best.match_id)} cls="text-red-500 hover:bg-red-50"><Ban className="w-4 h-4" /></IconBtn>
                            </>
                          )}
                          <IconBtn title="Associar manualmente" onClick={() => onManual(tx)} cls="text-blue-600 hover:bg-blue-50"><Link2 className="w-4 h-4" /></IconBtn>
                          <IconBtn title="Criar lançamento" onClick={() => onCreateEntry(tx.id)} cls="text-[var(--color-primary)] hover:bg-green-50"><FilePlus2 className="w-4 h-4" /></IconBtn>
                          {tx.status !== "ignored" && (
                            <IconBtn title="Ignorar" onClick={() => onIgnore(tx.id)} cls="text-gray-400 hover:bg-gray-100"><EyeOff className="w-4 h-4" /></IconBtn>
                          )}
                        </>
                      )}
                      {tx.status === "reconciled" && <CheckCircle2 className="w-5 h-5 text-green-600" />}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination {...pg} hideWhenSinglePage />
    </div>
  );
}

function IconBtn({ title, onClick, cls, children }: { title: string; onClick: () => void; cls: string; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} className={`p-1.5 rounded-lg transition ${cls}`}>{children}</button>
  );
}

// ─── Modal de importação ────────────────────────────────────────────────────────

interface PreviewRow {
  transaction_date: string;
  description: string;
  amount: number;
  direction: "credit" | "debit";
  counterparty_name: string | null;
}

function ImportModal({ accounts, onClose, onDone }: { accounts: BankAccountDTO[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [preview, setPreview] = useState<{ total: number; skipped: number; rows: PreviewRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function send(mode: "preview" | "commit") {
    if (!file) { setErr("Selecione um ficheiro."); return; }
    setErr(""); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", mode);
      if (accountId) fd.append("bank_account_id", accountId);
      const resp = await fetch("/api/finance/bank-statements/import", { method: "POST", body: fd });
      const json = await resp.json();
      if (!resp.ok) { setErr(json.error ?? "Falha na importação."); return; }
      if (mode === "preview") {
        setPreview({ total: json.total, skipped: json.skipped, rows: json.transactions });
      } else {
        toast(`${json.imported} movimentos importados · ${json.duplicates} duplicados · ${json.suggestions} sugestões.`, "success");
        onDone();
      }
    } catch {
      setErr("Erro de rede.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title="Importar Extrato Bancário" wide>
      <div className="space-y-4">
        {accounts.length > 0 && (
          <div>
            <label className="block text-sm font-medium mb-1">Conta bancária (opcional)</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm">
              <option value="">— Sem conta específica —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.bank_name} · {a.account_name}{a.iban_last4 ? ` (••${a.iban_last4})` : ""}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Ficheiro (CSV, XLSX, XLS ou PDF com texto)</label>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,.pdf"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
            className="block w-full text-sm border border-[var(--color-border)] rounded-lg p-2"
          />
          <p className="text-xs text-[var(--color-text-muted)] mt-1">Máx 8 MB. PDF digitalizado/imagem não é suportado.</p>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {err}
          </div>
        )}

        {preview && (
          <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 text-sm font-medium flex justify-between">
              <span>Pré-visualização: {preview.total} movimentos{preview.skipped > 0 ? ` · ${preview.skipped} linhas ignoradas` : ""}</span>
            </div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {preview.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(r.transaction_date)}</td>
                      <td className="px-3 py-1.5 max-w-[320px] truncate" title={r.description}>{r.description || "—"}</td>
                      <td className={`px-3 py-1.5 text-right whitespace-nowrap ${r.direction === "credit" ? "text-[var(--color-primary)]" : "text-red-500"}`}>
                        {r.direction === "credit" ? "+" : "−"}{fmtEur(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] bg-white hover:bg-gray-50">Cancelar</button>
          {!preview ? (
            <button onClick={() => send("preview")} disabled={busy || !file} className="px-4 py-2 rounded-lg text-sm font-semibold bg-white border border-[var(--color-primary)] text-[var(--color-primary)] hover:bg-green-50 disabled:opacity-50 inline-flex items-center gap-1.5">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Pré-visualizar
            </button>
          ) : (
            <button onClick={() => send("commit")} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Confirmar importação
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Modal de histórico ──────────────────────────────────────────────────────

function HistoryModal({ imports, onClose, onDelete }: { imports: ImportDTO[]; onClose: () => void; onDelete: (id: string) => void }) {
  return (
    <Modal onClose={onClose} title="Histórico de importações" wide>
      {imports.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Sem importações registadas.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)] uppercase">
                <th className="px-3 py-2 font-medium">Ficheiro</th>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium text-center">Total</th>
                <th className="px-3 py-2 font-medium text-center">Importados</th>
                <th className="px-3 py-2 font-medium text-center">Duplicados</th>
                <th className="px-3 py-2 font-medium">Estado</th>
                <th className="px-3 py-2 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-3 py-2 max-w-[200px] truncate" title={imp.file_name}>{imp.file_name}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(imp.created_at).toLocaleString("pt-PT")}</td>
                  <td className="px-3 py-2 text-center">{imp.total_rows}</td>
                  <td className="px-3 py-2 text-center">{imp.imported_rows}</td>
                  <td className="px-3 py-2 text-center">{imp.duplicate_rows}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${imp.status === "completed" ? "bg-green-100 text-green-700" : imp.status === "failed" ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>
                      {imp.status}
                    </span>
                    {imp.error_message && <p className="text-xs text-red-500 mt-1">{imp.error_message}</p>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      title="Apagar importação e os seus movimentos"
                      onClick={() => { if (confirm(`Apagar a importação "${imp.file_name}" e todos os seus movimentos? Esta ação não pode ser desfeita.`)) onDelete(imp.id); }}
                      className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ─── Modal de associação manual ───────────────────────────────────────────────

function ManualMatchModal({ tx, onClose, onMatch }: { tx: BankTransactionDTO; onClose: () => void; onMatch: (entryId: string) => void }) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; description: string; amount: number; date: string; type: "entrada" | "saida" }[]>([]);
  const [busy, setBusy] = useState(false);

  async function doSearch() {
    setBusy(true);
    const res = await searchCashFlowEntries(query);
    setBusy(false);
    if (res.ok) setResults(res.entries);
    else toast(res.error, "error");
  }

  return (
    <Modal onClose={onClose} title="Associar a lançamento existente">
      <div className="space-y-3">
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-medium">{tx.description || "Movimento"}</p>
          <p className="text-[var(--color-text-muted)]">{fmtDate(tx.transaction_date)} · {tx.direction === "credit" ? "+" : "−"}{fmtEur(tx.amount)}</p>
        </div>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSearch(); }}
            placeholder="Procurar lançamento por descrição…"
            className="flex-1 border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm"
          />
          <button onClick={doSearch} disabled={busy} className="px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white inline-flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </button>
        </div>
        <div className="max-h-64 overflow-y-auto divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-lg">
          {results.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] p-3">Sem resultados. Pesquise para listar lançamentos.</p>
          ) : results.map((r) => (
            <button key={r.id} onClick={() => onMatch(r.id)} className="w-full text-left px-3 py-2 hover:bg-gray-50 flex justify-between items-center gap-2">
              <span className="min-w-0">
                <span className="block truncate text-sm">{r.description}</span>
                <span className="block text-xs text-[var(--color-text-muted)]">{fmtDate(r.date)} · {r.type}</span>
              </span>
              <span className={`text-sm font-medium whitespace-nowrap ${r.type === "entrada" ? "text-[var(--color-primary)]" : "text-red-500"}`}>{fmtEur(r.amount)}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ─── Modal genérico ──────────────────────────────────────────────────────────

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-xl w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-semibold text-[var(--color-text-main)]">{title}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
