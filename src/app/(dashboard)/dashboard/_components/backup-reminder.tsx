"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, X } from "lucide-react";

const LAST_BACKUP_KEY = "mo_limpezas_last_backup_at";
const SNOOZE_KEY = "mo_limpezas_backup_snoozed_until";

function weekKey(date: Date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function shouldShowReminder(now: Date) {
  const friday = now.getDay() === 5;
  const afterFour = now.getHours() >= 16;
  if (!friday || !afterFour) return false;

  const lastBackup = window.localStorage.getItem(LAST_BACKUP_KEY);
  if (lastBackup && weekKey(new Date(lastBackup)) === weekKey(now)) return false;

  const snoozedUntil = window.localStorage.getItem(SNOOZE_KEY);
  if (snoozedUntil && new Date(snoozedUntil) > now) return false;

  return true;
}

export function BackupReminder() {
  const [visible, setVisible] = useState(() =>
    typeof window === "undefined" ? false : shouldShowReminder(new Date()),
  );

  if (!visible) return null;

  function snooze() {
    const until = new Date(Date.now() + 4 * 60 * 60 * 1000);
    window.localStorage.setItem(SNOOZE_KEY, until.toISOString());
    setVisible(false);
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Download className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
        <div>
          <p className="text-sm font-semibold text-amber-900">Backup semanal recomendado.</p>
          <p className="mt-0.5 text-xs text-amber-800">
            Faça uma cópia dos dados da empresa para guardar no computador.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Link
          href="/dashboard/configuracoes#backup"
          className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800"
        >
          Fazer backup
        </Link>
        <button
          type="button"
          onClick={snooze}
          className="inline-flex items-center gap-1 rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100"
        >
          <X className="h-3.5 w-3.5" />
          Lembrar-me mais tarde
        </button>
      </div>
    </div>
  );
}
