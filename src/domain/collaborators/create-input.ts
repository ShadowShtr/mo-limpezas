/**
 * O que é preciso para criar uma pessoa — e o que não é.
 *
 * Só o **nome** é obrigatório. Tudo o resto pode ficar por preencher e ser
 * completado mais tarde no perfil: NIF, IBAN, email de contacto, telefone,
 * datas de contrato, valor à hora.
 *
 * 🔴 Um campo vazio guarda-se como `NULL`, nunca como valor inventado. Nem
 *    email placeholder, nem NIF a zeros, nem `salary = 0` a fingir de
 *    «desconhecido», nem `"N/A"`. Um valor inventado é indistinguível de um
 *    verdadeiro para quem o ler a seguir, e alguém acaba por pagar um salário
 *    ou emitir um recibo com ele.
 *
 * O código anterior fabricava um email:
 *
 *     `${nome}.${Date.now()}@demo.escala.pt`
 *
 * …porque o GoTrue exige um email para criar a conta. Isso ficava guardado
 * como se fosse o email da pessoa, e uma pessoa sem conta nem sequer podia
 * existir. Depois do EXPAND pode, e criar a pessoa deixa de criar conta
 * nenhuma — passa a ser uma acção própria, separada.
 */

/** O que o formulário envia. Nada aqui é de confiança até ser validado. */
export interface CreateCollaboratorInput {
  full_name?: unknown;
  email?: unknown;
  phone?: unknown;
  nif?: unknown;
  iban?: unknown;
  hourly_rate?: unknown;
  contract_start?: unknown;
  contract_end?: unknown;
  contracted_hours_month?: unknown;
  role?: unknown;
  status?: unknown;
  skills?: unknown;
}

/** O que se escreve na base. `company_id` não vem daqui — vem da sessão. */
export interface CollaboratorRow {
  full_name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  iban: string | null;
  hourly_rate: number | null;
  contract_start: string | null;
  contract_end: string | null;
  contracted_hours_month: number | null;
  role: "colaborador" | "gestor" | "admin";
  status: "ativo" | "inativo" | "arquivado";
  skills: string[];
}

export type CreateCollaboratorResult =
  | { ok: true; row: CollaboratorRow }
  | { ok: false; error: string };

const PAPEIS = ["colaborador", "gestor", "admin"] as const;
const ESTADOS = ["ativo", "inativo", "arquivado"] as const;

/** Texto vazio, só espaços, ou ausente → `NULL`. */
function texto(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Número ausente → `NULL`, e **não** zero.
 *
 * 🔴 Um `hourly_rate` a zero é um valor real: quer dizer que a pessoa trabalha
 *    de graça. «Ainda não sabemos quanto ganha» é `NULL`. Confundir os dois faz
 *    a folha de pagamento calcular zero em vez de recusar calcular.
 */
function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Uma data só conta se for uma data. `"2026-13-45"` é ausência, não data. */
function data(v: unknown): string | null {
  const t = texto(v);
  if (t === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return Number.isNaN(Date.parse(t)) ? null : t;
}

/**
 * Valida e normaliza. O nome é a única coisa que faz uma criação falhar.
 *
 * `company_id` não é aceite: quem cria a pessoa é a empresa de quem está
 * autenticado, e o servidor resolve-o. Um `company_id` vindo do browser é
 * ignorado — não é validado nem rejeitado, simplesmente não existe aqui.
 */
export function prepararCriacao(input: CreateCollaboratorInput): CreateCollaboratorResult {
  const nome = texto(input.full_name);
  if (nome === null) {
    return { ok: false, error: "O nome é obrigatório." };
  }
  if (nome.length < 2) {
    return { ok: false, error: "O nome tem de ter pelo menos 2 caracteres." };
  }
  if (nome.length > 120) {
    return { ok: false, error: "O nome não pode ter mais de 120 caracteres." };
  }

  // Um email mal escrito é erro, não silêncio: quem o escreveu quis pôr um.
  const email = texto(input.email);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Email inválido." };
  }

  const papel = texto(input.role);
  if (papel !== null && !(PAPEIS as readonly string[]).includes(papel)) {
    return { ok: false, error: "Função inválida." };
  }

  const estado = texto(input.status);
  if (estado !== null && !(ESTADOS as readonly string[]).includes(estado)) {
    return { ok: false, error: "Estado inválido." };
  }

  const horas = numero(input.contracted_hours_month);
  if (horas !== null && (horas < 0 || horas > 744)) {
    return { ok: false, error: "Horas contratadas fora do intervalo." };
  }

  const valorHora = numero(input.hourly_rate);
  if (valorHora !== null && valorHora < 0) {
    return { ok: false, error: "O valor à hora não pode ser negativo." };
  }

  const skills = Array.isArray(input.skills)
    ? input.skills.filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => s.trim())
    : [];

  return {
    ok: true,
    row: {
      full_name: nome,
      email,
      phone: texto(input.phone),
      nif: texto(input.nif),
      iban: texto(input.iban),
      hourly_rate: valorHora,
      contract_start: data(input.contract_start),
      contract_end: data(input.contract_end),
      contracted_hours_month: horas,
      // Por omissão, uma pessoa nova é uma colaboradora activa. Promover é uma
      // decisão explícita de quem tem autoridade para a tomar.
      role: (papel ?? "colaborador") as CollaboratorRow["role"],
      status: (estado ?? "ativo") as CollaboratorRow["status"],
      skills,
    },
  };
}

/**
 * Criar uma pessoa **não** cria conta de acesso.
 *
 * Existe como função para que haja um sítio onde a regra está escrita e um
 * teste que a lê. `COLLABORATOR_CREATE_AUTH_WRITE = 0`.
 */
export function criacaoEscreveNoAuth(): boolean {
  return false;
}
