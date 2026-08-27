"use client";

import { useState } from "react";
import { KeyRound, Loader2, Copy, Check, ShieldOff, ShieldCheck, UserPlus } from "lucide-react";
import {
  criarAcesso, definirSenhaTemporaria, desativarAcesso, reativarAcesso,
} from "@/app/actions/collaborator-access";
import type { EstadoAcesso } from "@/domain/collaborators/access-lifecycle";

interface Props {
  colaboradorId: string;
  nome: string;
  estado: EstadoAcesso;
}

const DESCRICAO: Record<EstadoAcesso, string> = {
  sem_acesso: "Esta pessoa não entra na aplicação. Consta da lista, das equipas e da folha.",
  ativo: "Esta pessoa entra na aplicação normalmente.",
  desativado: "O acesso foi desativado. Os dados e o histórico mantêm-se.",
  troca_pendente: "Tem uma senha temporária por trocar. Vai ser obrigada a mudá-la ao entrar.",
};

const ETIQUETA: Record<EstadoAcesso, string> = {
  sem_acesso: "Sem acesso",
  ativo: "Ativo",
  desativado: "Desativado",
  troca_pendente: "Troca de senha pendente",
};

/**
 * Gera uma senha temporária legível ao telefone.
 *
 * 🔴 Sem `l`, `I`, `1`, `O` nem `0`: esta senha vai ser ditada a alguém, e um
 *    caracter que se confunde com outro transforma-se numa chamada de volta.
 */
function gerarSenha(): string {
  const letras = "abcdefghjkmnpqrstuvwxyz";
  const maiusculas = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digitos = "23456789";
  const todos = letras + maiusculas + digitos;
  const aleatorios = new Uint32Array(12);
  crypto.getRandomValues(aleatorios);
  // Garante pelo menos uma letra e um dígito — é o que a validação exige.
  const base = [
    maiusculas[aleatorios[0] % maiusculas.length],
    digitos[aleatorios[1] % digitos.length],
  ];
  for (let i = 2; i < 12; i += 1) base.push(todos[aleatorios[i] % todos.length]);
  return base.join("");
}

export function AccessSection({ colaboradorId, nome, estado }: Props) {
  const [aCorrer, setACorrer] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [senhaMostrada, setSenhaMostrada] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  async function executar(fn: () => Promise<{ ok: boolean; error?: string }>, senha?: string) {
    setACorrer(true);
    setErro(null);
    setSenhaMostrada(null);
    const r = await fn();
    setACorrer(false);
    if (!r.ok) {
      setErro(r.error ?? "Não foi possível concluir a operação.");
      return;
    }
    // 🔴 A senha aparece **uma vez**, agora, porque tem de ser comunicada. Não
    //    fica guardada em lado nenhum, e não há como voltar a vê-la — nem aqui,
    //    nem na base, nem nos registos.
    if (senha) setSenhaMostrada(senha);
  }

  function criar() {
    const senha = gerarSenha();
    if (!confirm(
      `Criar acesso para ${nome}?\n\nVai ser gerada uma senha temporária que ` +
      `terá de lhe comunicar. Ela é obrigada a trocá-la no primeiro acesso.`
    )) return;
    void executar(() => criarAcesso(colaboradorId, senha), senha);
  }

  function novaSenha() {
    const senha = gerarSenha();
    if (!confirm(
      `Definir uma senha temporária nova para ${nome}?\n\nA senha atual deixa ` +
      `de funcionar assim que confirmar.`
    )) return;
    void executar(() => definirSenhaTemporaria(colaboradorId, senha), senha);
  }

  function desativar() {
    if (!confirm(
      `Desativar o acesso de ${nome}?\n\nDeixa de conseguir entrar. Os dados, ` +
      `a folha, os documentos e o histórico mantêm-se.`
    )) return;
    void executar(() => desativarAcesso(colaboradorId));
  }

  function reativar() {
    void executar(() => reativarAcesso(colaboradorId));
  }

  function copiar() {
    if (!senhaMostrada) return;
    navigator.clipboard.writeText(senhaMostrada);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  const temAcesso = estado !== "sem_acesso";

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-[var(--color-primary)]" />
        <p className="text-sm font-semibold text-[var(--color-text-main)]">
          Acesso ao sistema
        </p>
        <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
          estado === "ativo" ? "bg-green-100 text-green-800"
          : estado === "desativado" ? "bg-gray-100 text-gray-700"
          : estado === "troca_pendente" ? "bg-amber-100 text-amber-800"
          : "bg-gray-100 text-gray-600"}`}>
          {ETIQUETA[estado]}
        </span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">{DESCRICAO[estado]}</p>

      <div className="flex flex-wrap gap-2">
        {!temAcesso && (
          <button
            type="button" onClick={criar} disabled={aCorrer}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
                       bg-[var(--color-primary)] text-white disabled:opacity-60"
          >
            {aCorrer ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            Criar acesso
          </button>
        )}

        {temAcesso && (
          <button
            type="button" onClick={novaSenha} disabled={aCorrer}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
                       border border-[var(--color-border)] disabled:opacity-60"
          >
            {aCorrer ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
            Definir senha temporária
          </button>
        )}

        {estado === "ativo" || estado === "troca_pendente" ? (
          <button
            type="button" onClick={desativar} disabled={aCorrer}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
                       border border-[var(--color-border)] text-red-700 disabled:opacity-60"
          >
            <ShieldOff className="w-4 h-4" />
            Desativar acesso
          </button>
        ) : null}

        {estado === "desativado" && (
          <button
            type="button" onClick={reativar} disabled={aCorrer}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
                       border border-[var(--color-border)] disabled:opacity-60"
          >
            <ShieldCheck className="w-4 h-4" />
            Reativar acesso
          </button>
        )}
      </div>

      {senhaMostrada && (
        <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <p className="text-xs text-amber-900 mb-2">
            Anote ou copie agora. <strong>Não é possível voltar a ver esta senha.</strong>
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm font-mono bg-white px-2 py-1 rounded border
                             border-amber-200 select-all">
              {senhaMostrada}
            </code>
            <button
              type="button" onClick={copiar}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border
                         border-amber-300 text-amber-900"
            >
              {copiado ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiado ? "Copiado" : "Copiar"}
            </button>
          </div>
        </div>
      )}

      {erro && <p className="mt-3 text-xs text-red-700">{erro}</p>}
    </div>
  );
}
