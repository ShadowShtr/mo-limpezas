import { redirect } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/layout/header";
import { getPendencias, type PendenciaItem } from "@/app/actions/pendencias";
import {
  MapPinOff, MapPin, LogOut, UserX, ImageOff, ImageUp, CheckCircle2,
} from "lucide-react";

export const dynamic = "force-dynamic";

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

export default async function PendenciasPage() {
  const res = await getPendencias();
  if (!res.ok) {
    if (res.error.includes("permissão") || res.error.includes("autenticado")) redirect("/dashboard");
    return (
      <div>
        <Header title="Pendências" subtitle="Problemas que precisam de atenção" />
        <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
          <p className="text-sm text-[var(--color-danger)]">Erro ao carregar pendências: {res.error}</p>
        </div>
      </div>
    );
  }

  const { data } = res;
  const t = data.totals;

  const sections = [
    {
      key: "noCheckout",
      title: "Serviços sem saída registada",
      desc: "Ponto aberto — falta o clock-out",
      icon: LogOut,
      color: "text-red-600 bg-red-50",
      items: data.noCheckout,
      href: "/dashboard/registo-ponto",
    },
    {
      key: "startedNoClockin",
      title: "Serviços iniciados sem ponto",
      desc: "Hora de início passou e ninguém bateu ponto",
      icon: UserX,
      color: "text-red-600 bg-red-50",
      items: data.startedNoClockin,
      href: "/dashboard/calendario",
    },
    {
      key: "gpsOutOfRange",
      title: "Pontos fora do raio GPS",
      desc: "Registados longe do local do serviço",
      icon: MapPinOff,
      color: "text-amber-600 bg-amber-50",
      items: data.gpsOutOfRange,
      href: "/dashboard/registo-ponto",
    },
    {
      key: "manualClockins",
      title: "Pontos manuais (sem GPS)",
      desc: "Registados sem confirmação de localização",
      icon: MapPin,
      color: "text-amber-600 bg-amber-50",
      items: data.manualClockins,
      href: "/dashboard/registo-ponto",
    },
    {
      key: "photosFailed",
      title: "Fotos falhadas",
      desc: "Não chegaram ao servidor",
      icon: ImageOff,
      color: "text-amber-600 bg-amber-50",
      items: data.photosFailed,
      href: null,
    },
    {
      key: "photosPending",
      title: "Fotos pendentes",
      desc: "A aguardar envio do telemóvel",
      icon: ImageUp,
      color: "text-blue-600 bg-blue-50",
      items: data.photosPending,
      href: null,
    },
  ] as const;

  return (
    <div>
      <Header
        title="Pendências"
        subtitle={t.total === 0 ? "Tudo em ordem hoje" : `${t.total} ${t.total === 1 ? "item precisa" : "itens precisam"} de atenção`}
      />

      <div className="px-4 py-5 sm:p-6 lg:px-8 space-y-6 mx-auto max-w-[1400px]">
        {t.total === 0 ? (
          <div className="bg-white rounded-xl border border-[var(--color-border)] py-16 text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-3">
              <CheckCircle2 className="w-6 h-6 text-[var(--color-primary)]" />
            </div>
            <p className="text-sm font-medium text-[var(--color-text-main)]">Sem pendências</p>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              Não há pontos, fotos ou serviços fora do normal hoje.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {sections
              .filter((s) => s.items.length > 0)
              .map((s) => (
                <PendenciaCard
                  key={s.key}
                  title={s.title}
                  desc={s.desc}
                  Icon={s.icon}
                  color={s.color}
                  items={s.items}
                  href={s.href}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PendenciaCard({
  title, desc, Icon, color, items, href,
}: {
  title: string;
  desc: string;
  Icon: React.ElementType;
  color: string;
  items: PendenciaItem[];
  href: string | null;
}) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--color-border)]">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h2>
          <p className="text-xs text-[var(--color-text-muted)]">{desc}</p>
        </div>
        <span className="text-xs font-medium text-white bg-[var(--color-text-main)] px-2 py-0.5 rounded-full">
          {items.length}
        </span>
      </div>

      <div className="divide-y divide-[var(--color-border)] max-h-80 overflow-y-auto">
        {items.slice(0, 50).map((item) => {
          const row = (
            <div className="px-5 py-3 hover:bg-[var(--color-background)] transition-colors">
              <p className="text-sm font-medium text-[var(--color-text-main)] truncate">{item.title}</p>
              <p className="text-xs text-[var(--color-text-sub)] truncate">{item.subtitle}</p>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{fmtTime(item.at)}</p>
            </div>
          );
          // O calendário abre na semana da data indicada (?date=YYYY-MM-DD).
          const day = item.at ? item.at.slice(0, 10) : null;
          return item.service_id && day ? (
            <Link key={item.id} href={`/dashboard/calendario?date=${day}`} className="block">
              {row}
            </Link>
          ) : (
            <div key={item.id}>{row}</div>
          );
        })}
      </div>

      {href && (
        <div className="px-5 py-3 border-t border-[var(--color-border)]">
          <Link href={href} className="text-xs font-medium text-[var(--color-primary)] hover:underline">
            Resolver no {href.includes("registo-ponto") ? "Registo de Ponto" : "Calendário"} →
          </Link>
        </div>
      )}
    </div>
  );
}
