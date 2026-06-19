import JSZip from "jszip";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COMPANY_TABLES = [
  "clients",
  "locations",
  "teams",
  "profiles",
  "contracts",
  "services",
  "timesheets",
  "absences",
  "vacation_requests",
  "company_settings",
  "invoices",
  "payroll_records",
  "cash_flow_entries",
  "client_notifications",
  "service_photos",
] as const;

function stamp(date = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}-${p(date.getMinutes())}`;
}

function jsonFile(zip: JSZip, path: string, data: unknown) {
  zip.file(path, JSON.stringify(data, null, 2));
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Nao autenticado." }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return Response.json({ error: "Sem permissao." }, { status: 403 });
  }

  const { data: company } = await admin
    .from("companies")
    .select("id, name, slug, created_at")
    .eq("id", profile.company_id)
    .single();

  const zip = new JSZip();
  const exportedAt = new Date();
  const manifest = {
    app: "mo-limpezas",
    backup_version: 1,
    exported_at: exportedAt.toISOString(),
    company,
    exported_by: user.id,
    format: "json dentro de zip",
    restore_status: "preparado para restauracao futura; sem restore automatico nesta fase",
  };

  jsonFile(zip, "manifest.json", manifest);
  zip.file(
    "README_RESTORE.txt",
    [
      "Backup Mo Limpezas",
      "",
      "Este ficheiro ZIP contem exportacao operacional dos dados da empresa em JSON.",
      "Nesta fase nao existe botao de restore automatico na aplicacao.",
      "Para restauracao futura, validar manifest.json, schema da base de dados e importar tabela a tabela com controlo tecnico.",
      "Este backup local nao substitui os backups reais da infraestrutura/Supabase.",
      "",
    ].join("\n"),
  );

  const datasets: Record<string, unknown> = {};

  for (const table of COMPANY_TABLES) {
    const { data, error } = await admin
      .from(table)
      .select("*")
      .eq("company_id", profile.company_id);
    datasets[table] = error ? { error: error.message } : data ?? [];
    jsonFile(zip, `data/${table}.json`, datasets[table]);
  }

  const services = Array.isArray(datasets.services) ? datasets.services as Array<{ id: string }> : [];
  const teams = Array.isArray(datasets.teams) ? datasets.teams as Array<{ id: string }> : [];
  const invoices = Array.isArray(datasets.invoices) ? datasets.invoices as Array<{ id: string }> : [];
  const serviceIds = services.map((s) => s.id);
  const teamIds = teams.map((t) => t.id);
  const invoiceIds = invoices.map((i) => i.id);

  if (teamIds.length > 0) {
    const { data } = await admin.from("team_members").select("*").in("team_id", teamIds);
    jsonFile(zip, "data/team_members.json", data ?? []);
  } else {
    jsonFile(zip, "data/team_members.json", []);
  }

  if (serviceIds.length > 0) {
    const { data } = await admin.from("service_reinforcements").select("*").in("service_id", serviceIds);
    jsonFile(zip, "data/service_reinforcements.json", data ?? []);
  } else {
    jsonFile(zip, "data/service_reinforcements.json", []);
  }

  if (invoiceIds.length > 0) {
    const { data } = await admin.from("invoice_items").select("*").in("invoice_id", invoiceIds);
    jsonFile(zip, "data/invoice_items.json", data ?? []);
  } else {
    jsonFile(zip, "data/invoice_items.json", []);
  }

  const buffer = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const body = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(body).set(buffer);
  const filename = `mo-limpezas-backup-${stamp(exportedAt)}.zip`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
