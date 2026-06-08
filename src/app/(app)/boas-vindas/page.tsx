"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Smartphone, Bell, MapPin, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const STEPS = [
  {
    icon: CheckCircle2,
    title: "Bem-vinda à Mó Limpezas!",
    description:
      "Esta é a tua plataforma de trabalho. Aqui vês o teu horário, registas entradas e saídas e geris as tuas férias.",
    color: "text-[var(--color-primary)]",
    bg: "bg-[var(--color-primary-light)]",
  },
  {
    icon: Smartphone,
    title: "Instala a app no teu telemóvel",
    description:
      'Para uma experiência melhor, instala a app como se fosse uma app nativa. No iPhone: toca em "Partilhar" → "Adicionar ao ecrã principal". No Android: toca nos 3 pontos → "Instalar app".',
    color: "text-[var(--color-info)]",
    bg: "bg-blue-50",
  },
  {
    icon: Bell,
    title: "Ativa as notificações",
    description:
      "Receberás alertas quando a tua escala mudar, quando houver um novo serviço ou quando precisares de substituir uma colega.",
    color: "text-[var(--color-warning)]",
    bg: "bg-amber-50",
  },
  {
    icon: MapPin,
    title: "GPS para registo de ponto",
    description:
      "Quando chegares a um local de trabalho, usa o botão \"Registar Entrada\". A app vai confirmar que estás no sítio certo. O GPS nunca bloqueia a entrada — apenas avisa se estiveres longe.",
    color: "text-[var(--color-primary)]",
    bg: "bg-[var(--color-primary-light)]",
  },
];

export default function BoasVindasPage() {
  const [step, setStep] = useState(0);
  const router = useRouter();
  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  function next() {
    if (isLast) {
      router.push("/app");
    } else {
      setStep((s) => s + 1);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--color-background)] px-6 py-12">
      <div className="w-full max-w-sm flex flex-col items-center text-center gap-6">

        {/* Ícone */}
        <div className={`w-20 h-20 rounded-2xl flex items-center justify-center ${current.bg}`}>
          <Icon className={`w-10 h-10 ${current.color}`} />
        </div>

        {/* Texto */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-[var(--color-text-main)]">
            {current.title}
          </h1>
          <p className="text-sm text-[var(--color-text-sub)] leading-relaxed">
            {current.description}
          </p>
        </div>

        {/* Indicadores de passo */}
        <div className="flex gap-2">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step
                  ? "w-6 bg-[var(--color-primary)]"
                  : i < step
                  ? "w-1.5 bg-[var(--color-primary-muted)]"
                  : "w-1.5 bg-[var(--color-border)]"
              }`}
            />
          ))}
        </div>

        {/* Botão */}
        <Button
          onClick={next}
          className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium"
        >
          {isLast ? "Ir para a app" : "Continuar"}
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>

        {/* Skip (só se não for o último) */}
        {!isLast && (
          <button
            onClick={() => router.push("/app")}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-sub)] transition-colors"
          >
            Saltar introdução
          </button>
        )}
      </div>
    </div>
  );
}
