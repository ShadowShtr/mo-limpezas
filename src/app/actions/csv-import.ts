"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

async function getCompanyId() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) return null;
  return profile.company_id as string;
}

// ─── Colaboradoras ───────────────────────────────────────────────────────────

export interface CsvColaboradora {
  nome: string;
  email?: string;
  telefone?: string;
  funcao?: string;
  horas_mes?: string;
}

export async function importColaboradorasCSV(rows: CsvColaboradora[]) {
  const company_id = await getCompanyId();
  if (!company_id) return { ok: false as const, error: "Sem permissão." };

  const admin = createAdminClient();
  const results: { row: number; ok: boolean; error?: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.nome?.trim()) {
      results.push({ row: i + 1, ok: false, error: "Nome obrigatório." });
      continue;
    }

    const role = ["admin", "gestor", "colaborador"].includes(r.funcao ?? "")
      ? r.funcao!
      : "colaborador";

    const email =
      r.email?.trim() ||
      `${r.nome.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "")}.${Date.now()}@demo.escala.pt`;

    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { company_id, role, full_name: r.nome.trim() },
    });

    if (authError) {
      results.push({ row: i + 1, ok: false, error: authError.message });
      continue;
    }

    const { error: profileError } = await admin
      .from("profiles")
      .upsert(
        {
          id: authData.user.id,
          company_id,
          role,
          full_name: r.nome.trim(),
          email: r.email?.trim() || null,
          phone: r.telefone?.trim() || null,
          contracted_hours_month: r.horas_mes ? parseFloat(r.horas_mes) : 168,
          status: "ativo",
          skills: [],
        },
        { onConflict: "id" },
      );

    if (profileError) {
      results.push({ row: i + 1, ok: false, error: profileError.message });
    } else {
      results.push({ row: i + 1, ok: true });
    }
  }

  revalidatePath("/dashboard/colaboradores");
  return { ok: true as const, results };
}

// ─── Clientes ─────────────────────────────────────────────────────────────────

export interface CsvCliente {
  nome: string;
  nif?: string;
  contacto_nome?: string;
  contacto_email?: string;
  contacto_telefone?: string;
  notas?: string;
}

export async function importClientesCSV(rows: CsvCliente[]) {
  const company_id = await getCompanyId();
  if (!company_id) return { ok: false as const, error: "Sem permissão." };

  const admin = createAdminClient();
  const results: { row: number; ok: boolean; error?: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.nome?.trim()) {
      results.push({ row: i + 1, ok: false, error: "Nome obrigatório." });
      continue;
    }

    const { error } = await admin.from("clients").insert({
      company_id,
      name: r.nome.trim(),
      nif: r.nif?.trim() || null,
      contact_name: r.contacto_nome?.trim() || null,
      contact_email: r.contacto_email?.trim() || null,
      contact_phone: r.contacto_telefone?.trim() || null,
      notes: r.notas?.trim() || null,
      active: true,
    });

    if (error) {
      results.push({ row: i + 1, ok: false, error: error.message });
    } else {
      results.push({ row: i + 1, ok: true });
    }
  }

  revalidatePath("/dashboard/clientes");
  return { ok: true as const, results };
}

// ─── Locais ───────────────────────────────────────────────────────────────────

export interface CsvLocal {
  nome: string;
  morada: string;
  cliente: string;
  preco_hora?: string;
  instrucoes?: string;
  codigo_acesso?: string;
}

export async function importLocaisCSV(rows: CsvLocal[]) {
  const company_id = await getCompanyId();
  if (!company_id) return { ok: false as const, error: "Sem permissão." };

  const admin = createAdminClient();

  // Pre-carregar todos os clientes da empresa para resolver pelo nome
  const { data: clientes } = await admin
    .from("clients")
    .select("id, name")
    .eq("company_id", company_id);

  const clientMap = new Map(
    (clientes ?? []).map((c: { id: string; name: string }) => [c.name.toLowerCase(), c.id]),
  );

  const results: { row: number; ok: boolean; error?: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.nome?.trim()) {
      results.push({ row: i + 1, ok: false, error: "Nome obrigatório." });
      continue;
    }
    if (!r.morada?.trim()) {
      results.push({ row: i + 1, ok: false, error: "Morada obrigatória." });
      continue;
    }
    if (!r.cliente?.trim()) {
      results.push({ row: i + 1, ok: false, error: "Cliente obrigatório." });
      continue;
    }

    const client_id = clientMap.get(r.cliente.trim().toLowerCase());
    if (!client_id) {
      results.push({ row: i + 1, ok: false, error: `Cliente "${r.cliente}" não encontrado.` });
      continue;
    }

    const { error } = await admin.from("locations").insert({
      company_id,
      client_id,
      name: r.nome.trim(),
      address: r.morada.trim(),
      hourly_rate: r.preco_hora ? parseFloat(r.preco_hora) : null,
      instructions: r.instrucoes?.trim() || null,
      access_code: r.codigo_acesso?.trim() || null,
      active: true,
    });

    if (error) {
      results.push({ row: i + 1, ok: false, error: error.message });
    } else {
      results.push({ row: i + 1, ok: true });
    }
  }

  revalidatePath("/dashboard/locais");
  return { ok: true as const, results };
}
