"use client";

import { useState, useTransition, useRef } from "react";
import { Upload, Download, CheckCircle2, XCircle, Loader2, FileText } from "lucide-react";
import {
  importColaboradorasCSV,
  importClientesCSV,
  importLocaisCSV,
  type CsvColaboradora,
  type CsvCliente,
  type CsvLocal,
} from "@/app/actions/csv-import";

// ─── Templates ───────────────────────────────────────────────────────────────

const TEMPLATES = {
  colaboradoras: {
    label: "Colaboradoras",
    headers: ["nome", "email", "telefone", "funcao", "horas_mes"],
    example: [
      ["Maria Silva", "maria@empresa.pt", "912345678", "colaborador", "168"],
      ["Ana Costa", "ana@empresa.pt", "913456789", "gestor", "168"],
    ],
    hint: "funcao: colaborador | gestor | admin — horas_mes: padrão 168",
  },
  clientes: {
    label: "Clientes",
    headers: ["nome", "nif", "contacto_nome", "contacto_email", "contacto_telefone", "notas"],
    example: [
      ["Empresa ABC", "123456789", "João Silva", "joao@abc.pt", "213456789", ""],
      ["Escritórios XYZ", "987654321", "Ana Costa", "ana@xyz.pt", "912345678", "Pagamento a 30 dias"],
    ],
    hint: "nome obrigatório — nif, contacto e notas opcionais",
  },
  locais: {
    label: "Locais",
    headers: ["nome", "morada", "cliente", "preco_hora", "instrucoes", "codigo_acesso"],
    example: [
      ["Escritório Central", "Rua das Flores 10, Lisboa", "Empresa ABC", "15.00", "Entrar pela lateral", "1234"],
      ["Armazém Norte", "Zona Industrial 5, Porto", "Empresa ABC", "18.00", "", ""],
    ],
    hint: "cliente: nome exato do cliente já registado — preco_hora em €/h",
  },
} as const;

type Tab = keyof typeof TEMPLATES;

function makeCSV(headers: string[], rows: string[][]) {
  return [headers.join(","), ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n");
}

function downloadCSV(filename: string, content: string) {
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCSV(text: string): string[][] {
  // Remove BOM if present
  const clean = text.replace(/^﻿/, "");
  return clean
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const result: string[] = [];
      let current = "";
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuote = !inQuote;
        } else if (ch === "," && !inQuote) {
          result.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    });
}

type ImportResult = { row: number; ok: boolean; error?: string };

// ─── Component ───────────────────────────────────────────────────────────────

export function CsvImport() {
  const [tab, setTab] = useState<Tab>("colaboradoras");
  const [rows, setRows] = useState<string[][] | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function resetFile() {
    setRows(null);
    setHeaders([]);
    setFileName("");
    setResults(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleTabChange(t: Tab) {
    setTab(t);
    resetFile();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResults(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCSV(text);
      if (parsed.length < 2) return;
      setHeaders(parsed[0]);
      setRows(parsed.slice(1));
    };
    reader.readAsText(file, "utf-8");
  }

  function handleImport() {
    if (!rows || rows.length === 0) return;
    const tpl = TEMPLATES[tab];

    // Map rows to objects using the file's header row
    const hdrs = headers.map((h) => h.toLowerCase().trim());

    function val(row: string[], key: string) {
      const idx = hdrs.indexOf(key);
      return idx >= 0 ? row[idx] : "";
    }

    startTransition(async () => {
      let res: { ok: boolean; results?: ImportResult[]; error?: string };

      if (tab === "colaboradoras") {
        const data: CsvColaboradora[] = rows.map((r) => ({
          nome: val(r, "nome"),
          email: val(r, "email"),
          telefone: val(r, "telefone"),
          funcao: val(r, "funcao"),
          horas_mes: val(r, "horas_mes"),
        }));
        res = await importColaboradorasCSV(data);
      } else if (tab === "clientes") {
        const data: CsvCliente[] = rows.map((r) => ({
          nome: val(r, "nome"),
          nif: val(r, "nif"),
          contacto_nome: val(r, "contacto_nome"),
          contacto_email: val(r, "contacto_email"),
          contacto_telefone: val(r, "contacto_telefone"),
          notas: val(r, "notas"),
        }));
        res = await importClientesCSV(data);
      } else {
        const data: CsvLocal[] = rows.map((r) => ({
          nome: val(r, "nome"),
          morada: val(r, "morada"),
          cliente: val(r, "cliente"),
          preco_hora: val(r, "preco_hora"),
          instrucoes: val(r, "instrucoes"),
          codigo_acesso: val(r, "codigo_acesso"),
        }));
        res = await importLocaisCSV(data);
      }

      if (!res.ok) {
        setResults([{ row: 0, ok: false, error: res.error }]);
      } else {
        setResults(res.results ?? []);
      }

      void tpl; // suppress unused warning
    });
  }

  const tpl = TEMPLATES[tab];
  const okCount = results?.filter((r) => r.ok).length ?? 0;
  const errCount = results?.filter((r) => !r.ok).length ?? 0;

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-background)]">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Importação CSV</h2>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          Importa dados em massa a partir de ficheiros CSV.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--color-border)]">
        {(Object.keys(TEMPLATES) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={`px-5 py-3 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"
            }`}
          >
            {TEMPLATES[t].label}
          </button>
        ))}
      </div>

      <div className="px-6 py-5 space-y-4">
        {/* Hint + Download template */}
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed max-w-lg">
            {tpl.hint}
          </p>
          <button
            onClick={() =>
              downloadCSV(
                `modelo_${tab}.csv`,
                makeCSV(tpl.headers as unknown as string[], tpl.example as unknown as string[][]),
              )
            }
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-main)] hover:bg-[var(--color-background)] transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Descarregar modelo
          </button>
        </div>

        {/* Upload */}
        <div>
          <label
            htmlFor="csv-upload"
            className="flex items-center gap-3 px-4 py-3 rounded-lg border-2 border-dashed border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-green-50 cursor-pointer transition-colors"
          >
            <Upload className="w-5 h-5 text-[var(--color-text-muted)]" />
            <span className="text-sm text-[var(--color-text-muted)]">
              {fileName ? (
                <span className="flex items-center gap-2 text-[var(--color-text-main)]">
                  <FileText className="w-4 h-4" />
                  {fileName}
                </span>
              ) : (
                "Clica para seleccionar ficheiro CSV…"
              )}
            </span>
          </label>
          <input
            ref={fileRef}
            id="csv-upload"
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleFile}
          />
        </div>

        {/* Preview */}
        {rows && rows.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-[var(--color-text-muted)]">
              Pré-visualização — {rows.length} linha{rows.length !== 1 ? "s" : ""}
            </p>
            <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
              <table className="w-full text-xs">
                <thead className="bg-[var(--color-background)]">
                  <tr>
                    {headers.map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left font-medium text-[var(--color-text-muted)] border-b border-[var(--color-border)]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, i) => (
                    <tr key={i} className="border-b border-[var(--color-border)] last:border-0">
                      {row.map((cell, j) => (
                        <td key={j} className="px-3 py-2 text-[var(--color-text-main)] max-w-[180px] truncate">
                          {cell || <span className="text-[var(--color-text-muted)]">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 5 && (
              <p className="text-xs text-[var(--color-text-muted)]">
                + {rows.length - 5} linha{rows.length - 5 !== 1 ? "s" : ""} não mostrada{rows.length - 5 !== 1 ? "s" : ""}
              </p>
            )}
          </div>
        )}

        {/* Import button */}
        {rows && rows.length > 0 && !results && (
          <button
            onClick={handleImport}
            disabled={pending}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
          >
            {pending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                A importar…
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Importar {rows.length} registo{rows.length !== 1 ? "s" : ""}
              </>
            )}
          </button>
        )}

        {/* Results */}
        {results && (
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-sm">
              {okCount > 0 && (
                <span className="flex items-center gap-1.5 text-green-600 font-medium">
                  <CheckCircle2 className="w-4 h-4" />
                  {okCount} importado{okCount !== 1 ? "s" : ""}
                </span>
              )}
              {errCount > 0 && (
                <span className="flex items-center gap-1.5 text-red-600 font-medium">
                  <XCircle className="w-4 h-4" />
                  {errCount} erro{errCount !== 1 ? "s" : ""}
                </span>
              )}
              <button
                onClick={resetFile}
                className="ml-auto text-xs text-[var(--color-text-muted)] underline underline-offset-2 hover:text-[var(--color-text-main)]"
              >
                Importar novo ficheiro
              </button>
            </div>

            {errCount > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 divide-y divide-red-100 max-h-48 overflow-y-auto">
                {results
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <div key={r.row} className="px-3 py-2 flex items-start gap-2 text-xs text-red-700">
                      <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>
                        <strong>Linha {r.row}:</strong> {r.error}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
