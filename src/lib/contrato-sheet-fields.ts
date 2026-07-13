// Fonte única das colunas que o formulário ContratoSheet precisa para editar
// um contrato sem apagar dados (em especial fixed_price/fixed_monthly/apply_vat,
// que definem o valor da avença).
//
// Havia duas queries independentes a "contracts" com esta lista de colunas
// escrita à mão (contratos/page.tsx e clientes/[id]/page.tsx) — uma delas
// ficou sem fixed_price/fixed_monthly/apply_vat, o que fazia o ContratoSheet
// abrir com o valor da avença vazio e, ao gravar, apagar o valor real do
// contrato (e, em cascata, zerar o valor dos serviços futuros). Qualquer
// query que alimente o ContratoSheet deve usar esta constante, nunca repetir
// a lista de colunas à mão.
// As 3 colunas de preço fixo/avença em si — extraídas à parte para que outras
// queries de "contracts" que só precisam do valor (ex.: o cron de geração de
// serviços) possam partilhar exatamente os mesmos nomes de coluna, em vez de
// as repetir à mão e arriscar o mesmo tipo de drift.
export const CONTRACT_FINANCIAL_FIELDS = "fixed_price, fixed_monthly, apply_vat";

export const CONTRATO_SHEET_SELECT = `
  id, name, frequency, interval_days, weekdays, schedule_days,
  starts_on, ends_on, status, notes, created_at,
  cleaning_type, payment_status, upholstery_type, upholstery_notes,
  upholstery_units, upholstery_unit_price, ${CONTRACT_FINANCIAL_FIELDS}, num_people,
  locations ( id, name, address, hourly_rate, clients ( id, name ) )
`;

export type ContratosTableRow = {
  id: string;
  name: string | null;
  frequency: string;
  interval_days: number;
  weekdays: number[] | null;
  schedule_days: import("@/types/database").ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  status: string;
  notes: string | null;
  cleaning_type: string | null;
  payment_status: string | null;
  upholstery_type: string | null;
  upholstery_notes: string | null;
  upholstery_units: number | null;
  upholstery_unit_price: number | null;
  fixed_price: number | null;
  fixed_monthly: boolean;
  apply_vat: boolean;
  num_people: number | null;
  created_at: string;
  locations: {
    id: string;
    name: string;
    address: string;
    hourly_rate: number | null;
    clients: { id: string; name: string } | null;
  } | null;
};
