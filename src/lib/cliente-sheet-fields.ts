// Fonte única das colunas que o formulário ClienteSheet precisa para editar
// um cliente sem apagar dados (em especial type/notes — ver contrato-sheet-fields.ts
// para o mesmo problema já corrigido em Contratos).
//
// Havia duas queries independentes a "clients" com esta lista de colunas
// escrita à mão (clientes/page.tsx e clientes/[id]/page.tsx) — a da listagem
// ficou sem type/notes, o que fazia o ClienteSheet abrir com esses campos
// vazios e, ao gravar (editar pelo ícone "..." da lista), apagar o valor
// real do cliente. Qualquer query que alimente o ClienteSheet deve usar
// esta constante, nunca repetir a lista de colunas à mão.
export const CLIENTE_SHEET_SELECT = "id, name, email, phone, nif, type, notes, status, vat_exempt, created_at";

export interface ClienteSheetRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  nif: string | null;
  type: string | null;
  notes: string | null;
  status: string;
  vat_exempt: boolean;
  created_at: string;
}
