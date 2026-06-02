import Link from "next/link";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)] px-4">
      <div className="text-center">
        <p className="text-6xl font-bold text-[var(--color-primary)] mb-4">404</p>
        <h1 className="text-xl font-semibold text-[var(--color-text-main)] mb-2">Página não encontrada</h1>
        <p className="text-sm text-[var(--color-text-sub)] mb-8">
          A página que procuras não existe ou foi movida.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          <Home className="w-4 h-4" />
          Ir para o Dashboard
        </Link>
      </div>
    </div>
  );
}
