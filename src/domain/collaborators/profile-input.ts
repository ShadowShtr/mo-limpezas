import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

function nifValido(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{9}$/.test(digits)) return false;
  const sum = digits
    .slice(0, 8)
    .split("")
    .reduce((total, digit, index) => total + Number(digit) * (9 - index), 0);
  const remainder = 11 - (sum % 11);
  const checkDigit = remainder >= 10 ? 0 : remainder;
  return Number(digits[8]) === checkDigit;
}

function ibanValido(value: string): boolean {
  const normalized = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

const optionalText = (max: number) => z.preprocess(
  emptyToUndefined,
  z.string().trim().max(max).optional(),
);

const optionalDate = z.preprocess(
  emptyToUndefined,
  z.iso.date("Data inválida.").optional(),
);

const collaboratorInputSchema = z.object({
  full_name: z.string().trim().min(1, "Nome obrigatório.").max(120),
  email: z.preprocess(emptyToUndefined, z.email("Email inválido.").optional()),
  phone: optionalText(20),
  nif: z.preprocess(
    emptyToUndefined,
    z.string().trim().refine(nifValido, "NIF inválido.").optional(),
  ),
  iban: z.preprocess(
    emptyToUndefined,
    z.string().trim().refine(ibanValido, "IBAN inválido.").optional(),
  ),
  hourly_rate: z.number().finite().min(0).max(10000).nullable().optional(),
  contract_start: optionalDate.nullable().optional(),
  contract_end: optionalDate.nullable().optional(),
  role: z.enum(["colaborador", "gestor", "admin"]).optional().default("colaborador"),
  status: z.enum(["ativo", "inativo", "suspenso"]).optional().default("ativo"),
  contracted_hours_month: z.number().finite().min(0).max(744).optional().default(168),
  skills: z.array(z.string().trim().min(1).max(60)).optional().default([]),
});

export type ColaboradorInput = z.input<typeof collaboratorInputSchema>;

export type NormalizedColaboradorInput = {
  full_name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  iban: string | null;
  hourly_rate: number | null;
  contract_start: string | null;
  contract_end: string | null;
  role: "colaborador" | "gestor" | "admin";
  status: "ativo" | "inativo" | "suspenso";
  contracted_hours_month: number;
  skills: string[];
};

export function normalizarColaborador(
  input: unknown,
): { ok: true; data: NormalizedColaboradorInput } | { ok: false; error: string } {
  const parsed = collaboratorInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

  return {
    ok: true,
    data: {
      ...parsed.data,
      email: parsed.data.email?.toLowerCase() ?? null,
      phone: parsed.data.phone ?? null,
      nif: parsed.data.nif?.replace(/\D/g, "") ?? null,
      iban: parsed.data.iban?.replace(/\s/g, "").toUpperCase() ?? null,
      hourly_rate: parsed.data.hourly_rate ?? null,
      contract_start: parsed.data.contract_start ?? null,
      contract_end: parsed.data.contract_end ?? null,
    },
  };
}
