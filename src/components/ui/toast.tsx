"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle, AlertCircle, Info, X } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

let _nextId = 0;

// ── Provider ──────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = "success") => {
    const id = ++_nextId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismiss = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        aria-live="assertive"
        className="pointer-events-none fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2 sm:bottom-4 sm:right-4 sm:left-auto sm:translate-x-0"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast: t,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const icons: Record<ToastType, ReactNode> = {
    success: <CheckCircle size={16} className="shrink-0 text-green-600" />,
    error: <AlertCircle size={16} className="shrink-0 text-red-500" />,
    info: <Info size={16} className="shrink-0 text-blue-500" />,
  };
  const colors: Record<ToastType, string> = {
    success: "border-green-200 bg-white text-green-900",
    error: "border-red-200 bg-white text-red-900",
    info: "border-blue-200 bg-white text-blue-900",
  };

  return (
    <div
      className={`pointer-events-auto flex w-[min(calc(100vw-2rem),22rem)] items-center gap-3 rounded-xl border px-4 py-3 shadow-lg ${colors[t.type]}`}
    >
      {icons[t.type]}
      <p className="flex-1 text-sm font-medium">{t.message}</p>
      <button
        onClick={() => onDismiss(t.id)}
        className="text-current opacity-50 hover:opacity-100"
        aria-label="Fechar"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast deve ser usado dentro de <ToastProvider>");
  return ctx;
}
