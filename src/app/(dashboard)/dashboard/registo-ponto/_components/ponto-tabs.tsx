"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clock, AlertTriangle } from "lucide-react";

// Faltas vivem dentro do Registo de Ponto (saíram do menu lateral):
// estas tabs ligam as duas páginas como se fossem uma só secção.
const TABS = [
  { href: "/dashboard/registo-ponto", label: "Registos de ponto", icon: Clock },
  { href: "/dashboard/faltas",        label: "Faltas e férias",   icon: AlertTriangle },
];

export function PontoTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 bg-[var(--color-background)] rounded-xl p-1 w-fit mb-5">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              active
                ? "bg-white text-[var(--color-primary)] shadow-sm border border-[var(--color-border)]"
                : "text-[var(--color-text-sub)] hover:text-[var(--color-text-main)]"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
