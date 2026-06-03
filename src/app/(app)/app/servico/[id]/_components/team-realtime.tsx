"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Users, CheckCircle, Clock } from "lucide-react";

interface Member {
  id: string;
  full_name: string;
  clockIn: string | null;
  clockOut: string | null;
}

interface Props {
  serviceId: string;
  initialMembers: Member[];
}

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

export function TeamRealtime({ serviceId, initialMembers }: Props) {
  const [members, setMembers] = useState<Member[]>(initialMembers);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`timesheets-service-${serviceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "timesheets",
          filter: `service_id=eq.${serviceId}`,
        },
        (payload) => {
          const ts = payload.new as {
            collaborator_id: string;
            clock_in_at: string | null;
            clock_out_at: string | null;
          };
          setMembers((prev) =>
            prev.map((m) =>
              m.id === ts.collaborator_id
                ? { ...m, clockIn: ts.clock_in_at, clockOut: ts.clock_out_at }
                : m
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [serviceId]);

  if (members.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-4 h-4 text-[var(--color-primary)]" />
        <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Equipa</h3>
      </div>

      <div className="space-y-2">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-2">
            <p className="text-sm text-[var(--color-text-main)] truncate">{m.full_name}</p>

            {m.clockOut ? (
              <span className="flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full shrink-0">
                <CheckCircle className="w-3 h-3" />
                Saiu {fmt(m.clockOut)}
              </span>
            ) : m.clockIn ? (
              <span className="flex items-center gap-1 text-xs text-[var(--color-primary)] bg-[var(--color-primary-light)] px-2 py-0.5 rounded-full shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-pulse" />
                Entrou {fmt(m.clockIn)}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] border border-[var(--color-border)] px-2 py-0.5 rounded-full shrink-0">
                <Clock className="w-3 h-3" />
                Aguarda
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
