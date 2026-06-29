"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Users, Trash2 } from "lucide-react";
import { EquipaSheet } from "./sheet";
import { deleteEquipa } from "@/app/actions/equipas";

type Member = { id: string; full_name: string; avatar_url: string | null };

type Equipa = {
  id: string;
  name: string;
  color: string;
  active: boolean;
  leader_id: string | null;
  members: Member[];
};

type Colaborador = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  role: string;
  status: string;
};

interface Props {
  equipas: Equipa[];
  colaboradores: Colaborador[];
  companyId: string;
}

export function EquipasGrid({ equipas, colaboradores, companyId }: Props) {
  const router = useRouter();
  const [deleting, startDelete] = useTransition();

  function handleDelete(equipa: Equipa) {
    if (!window.confirm(
      `Excluir a equipa "${equipa.name}"?\n\nOs serviços que tinham esta equipa ficam "sem equipa" (não são apagados). Não pode ser desfeito.`,
    )) return;
    startDelete(async () => {
      const res = await deleteEquipa(equipa.id, companyId);
      if (!res.ok) { window.alert(res.error); return; }
      router.refresh();
    });
  }

  if (equipas.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-[var(--color-border)] py-16 text-center">
        <div className="w-12 h-12 rounded-full bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-4">
          <Users className="w-6 h-6 text-[var(--color-primary)]" />
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">Ainda não há equipas. Cria a primeira!</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {equipas.map((equipa) => {
        const members: Member[] = Array.isArray(equipa.members) ? equipa.members : [];
        const leader = members.find((m) => m.id === equipa.leader_id);

        return (
          <div key={equipa.id} className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
            {/* Barra de cor */}
            <div className="h-1.5" style={{ backgroundColor: equipa.color }} />

            <div className="p-5">
              {/* Nome e estado */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--color-text-main)]">{equipa.name}</h3>
                  {leader && (
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      Lider: {leader.full_name}
                    </p>
                  )}
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  equipa.active
                    ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                    : "bg-[var(--color-background)] text-[var(--color-text-muted)]"
                }`}>
                  {equipa.active ? "Ativa" : "Inativa"}
                </span>
              </div>

              {/* Membros */}
              {members.length > 0 ? (
                <div className="flex items-center gap-1 mb-4 flex-wrap">
                  {members.slice(0, 5).map((m) => {
                    const initials = m.full_name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
                    return (
                      <div
                        key={m.id}
                        title={m.full_name}
                        className="w-8 h-8 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center overflow-hidden border-2 border-white -ml-1 first:ml-0"
                      >
                        {m.avatar_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.avatar_url} alt={m.full_name} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[var(--color-primary)] font-semibold text-xs">{initials}</span>
                        )}
                      </div>
                    );
                  })}
                  {members.length > 5 && (
                    <div className="w-8 h-8 rounded-full bg-[var(--color-background)] border border-[var(--color-border)] flex items-center justify-center -ml-1">
                      <span className="text-xs text-[var(--color-text-muted)] font-medium">+{members.length - 5}</span>
                    </div>
                  )}
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                    {members.length} {members.length === 1 ? "membro" : "membros"}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)] mb-4">Sem membros</p>
              )}

              {/* Editar / Excluir */}
              <div className="flex items-center gap-2">
                <EquipaSheet
                  companyId={companyId}
                  colaboradores={colaboradores}
                  equipa={{ ...equipa, members }}
                  trigger={
                    <button className="flex-1 text-sm text-[var(--color-text-sub)] py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors font-medium">
                      Editar equipa
                    </button>
                  }
                />
                <button
                  title="Excluir equipa"
                  disabled={deleting}
                  onClick={() => handleDelete(equipa)}
                  className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
