// ============================================================================
// GERADO — não editar à mão
// ============================================================================
//
// Produzido por `scripts/generate-profile-fk-inventory.ts` a partir do
// `pg_constraint` de um palco com a forma real do schema de produção.
//
// 🔴 Este ficheiro é a lista COMPLETA de sítios onde um perfil pode ser
//    responsável por alguma coisa. O guard de remoção percorre-o inteiro: uma
//    entrada em falta não é uma imprecisão de documentação, é um perfil
//    apagado com histórico atrás.
//
//    `src/__tests__/collaborator-lifecycle-postgres.test.ts` volta a ler o
//    catálogo e compara-o com isto. Uma FK nova para `profiles` que não passe
//    por aqui deixa esse ensaio vermelho — de propósito.
//
// Para regenerar:  npx tsx scripts/generate-profile-fk-inventory.ts
// ============================================================================

import type { ReferenciaPerfil } from "./lifecycle-types";

export const INVENTARIO_FK_PERFIS: readonly ReferenciaPerfil[] = [
  { tabela: "absences", coluna: "approved_by", restricao: "absences_approved_by_fkey", onDelete: "NO ACTION", composta: false, area: "faltas" },
  { tabela: "absences", coluna: "collaborator_id", restricao: "absences_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "faltas" },
  { tabela: "absences", coluna: "created_by", restricao: "absences_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "faltas" },
  { tabela: "absences", coluna: "replaced_by", restricao: "absences_replaced_by_fkey", onDelete: "NO ACTION", composta: false, area: "faltas" },
  { tabela: "app_notice_reads", coluna: "profile_id", restricao: "app_notice_reads_profile_id_fkey", onDelete: "CASCADE", composta: false, area: "notificacoes" },
  { tabela: "app_notice_targets", coluna: "profile_id", restricao: "app_notice_targets_profile_id_fkey", onDelete: "CASCADE", composta: false, area: "notificacoes" },
  { tabela: "app_notices", coluna: "created_by", restricao: "app_notices_created_by_fkey", onDelete: "SET NULL", composta: false, area: "notificacoes" },
  { tabela: "attachments", coluna: "created_by", restricao: "attachments_created_by_fkey", onDelete: "SET NULL", composta: false, area: "documentos" },
  { tabela: "audit_logs", coluna: "actor_id", restricao: "audit_logs_actor_id_fkey", onDelete: "SET NULL", composta: false, area: "auditoria" },
  { tabela: "bank_reconciliation_matches", coluna: "confirmed_by", restricao: "bank_reconciliation_matches_confirmed_by_fkey", onDelete: "NO ACTION", composta: false, area: "conciliacao" },
  { tabela: "bank_statement_imports", coluna: "uploaded_by", restricao: "bank_statement_imports_uploaded_by_fkey", onDelete: "NO ACTION", composta: false, area: "conciliacao" },
  { tabela: "building_cards", coluna: "created_by", restricao: "building_cards_created_by_fkey", onDelete: "SET NULL", composta: false, area: "tarefas" },
  { tabela: "cash_flow_entries", coluna: "created_by", restricao: "cash_flow_entries_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "financeiro" },
  { tabela: "client_notifications", coluna: "created_by", restricao: "client_notifications_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "notificacoes" },
  { tabela: "collaborator_documents", coluna: "collaborator_id", restricao: "collaborator_documents_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "documentos" },
  { tabela: "collaborator_documents", coluna: "uploaded_by", restricao: "collaborator_documents_uploaded_by_fkey", onDelete: "NO ACTION", composta: false, area: "documentos" },
  { tabela: "collaborator_ride_assignments", coluna: "assigned_by", restricao: "collaborator_ride_assignments_assigned_by_fkey", onDelete: "SET NULL", composta: false, area: "transporte" },
  { tabela: "collaborator_ride_assignments", coluna: "collaborator_id", restricao: "collaborator_ride_assignments_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "transporte" },
  { tabela: "contracts", coluna: "created_by", restricao: "contracts_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "contratos" },
  { tabela: "crm_lead_interactions", coluna: "author_id", restricao: "crm_lead_interactions_author_mesma_empresa", onDelete: "NO ACTION", composta: true, area: "crm" },
  { tabela: "crm_leads", coluna: "created_by", restricao: "crm_leads_created_by_mesma_empresa", onDelete: "NO ACTION", composta: true, area: "crm" },
  { tabela: "crm_leads", coluna: "owner_id", restricao: "crm_leads_owner_mesma_empresa", onDelete: "NO ACTION", composta: true, area: "crm" },
  { tabela: "daily_clocks", coluna: "collaborator_id", restricao: "daily_clocks_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "ponto" },
  { tabela: "financial_periods", coluna: "closed_by", restricao: "financial_periods_closed_by_fkey", onDelete: "NO ACTION", composta: false, area: "financeiro" },
  { tabela: "financial_periods", coluna: "reopened_by", restricao: "financial_periods_reopened_by_fkey", onDelete: "NO ACTION", composta: false, area: "financeiro" },
  { tabela: "fixed_variable_payments", coluna: "created_by", restricao: "fixed_variable_payments_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "financeiro" },
  { tabela: "invoices", coluna: "created_by", restricao: "invoices_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "financeiro" },
  { tabela: "management_tasks", coluna: "assigned_to", restricao: "management_tasks_assigned_to_fkey", onDelete: "NO ACTION", composta: false, area: "tarefas" },
  { tabela: "management_tasks", coluna: "created_by", restricao: "management_tasks_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "tarefas" },
  { tabela: "notifications", coluna: "user_id", restricao: "notifications_user_id_fkey", onDelete: "CASCADE", composta: false, area: "notificacoes" },
  { tabela: "payroll_records", coluna: "approved_by", restricao: "payroll_records_approved_by_fkey", onDelete: "NO ACTION", composta: false, area: "payroll" },
  { tabela: "payroll_records", coluna: "collaborator_id", restricao: "payroll_records_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "payroll" },
  { tabela: "platform_admins", coluna: "granted_by", restricao: "platform_admins_granted_by_fkey", onDelete: "SET NULL", composta: false, area: "plataforma" },
  { tabela: "platform_admins", coluna: "profile_id", restricao: "platform_admins_profile_id_fkey", onDelete: "CASCADE", composta: false, area: "plataforma" },
  { tabela: "push_subscriptions", coluna: "user_id", restricao: "push_subscriptions_user_id_fkey", onDelete: "CASCADE", composta: false, area: "notificacoes" },
  { tabela: "service_photos", coluna: "collaborator_id", restricao: "service_photos_collaborator_id_fkey", onDelete: "SET NULL", composta: false, area: "servicos" },
  { tabela: "service_price_audit", coluna: "changed_by", restricao: "service_price_audit_changed_by_fkey", onDelete: "NO ACTION", composta: false, area: "servicos" },
  { tabela: "service_reinforcements", coluna: "collaborator_id", restricao: "service_reinforcements_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "servicos" },
  { tabela: "services", coluna: "cancelled_by", restricao: "services_cancelled_by_fkey", onDelete: "NO ACTION", composta: false, area: "servicos" },
  { tabela: "services", coluna: "created_by", restricao: "services_created_by_fkey", onDelete: "NO ACTION", composta: false, area: "servicos" },
  { tabela: "team_members", coluna: "collaborator_id", restricao: "team_members_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "equipas" },
  { tabela: "teams", coluna: "leader_id", restricao: "teams_leader_id_fkey", onDelete: "SET NULL", composta: false, area: "equipas" },
  { tabela: "timesheets", coluna: "collaborator_id", restricao: "timesheets_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "ponto" },
  { tabela: "vacation_requests", coluna: "collaborator_id", restricao: "vacation_requests_collaborator_id_fkey", onDelete: "CASCADE", composta: false, area: "ferias" },
  { tabela: "vacation_requests", coluna: "reviewed_by", restricao: "vacation_requests_reviewed_by_fkey", onDelete: "NO ACTION", composta: false, area: "ferias" },
  { tabela: "vehicle_allocations", coluna: "driver_id", restricao: "vehicle_allocations_driver_id_fkey", onDelete: "SET NULL", composta: false, area: "transporte" },
] as const;
