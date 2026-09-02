import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type ExistingPayment = Database["public"]["Tables"]["fixed_variable_payments"];

type Payment091 = {
  Row: ExistingPayment["Row"] & {
    recurrence_interval_months: number | null;
    recurrence_anchor_date: string | null;
    recurrence_state: "NOT_RECURRING" | "LEGACY_RECURRENCE_UNKNOWN" | "CONFIGURED";
  };
  Insert: ExistingPayment["Insert"] & {
    recurrence_interval_months?: number | null;
    recurrence_anchor_date?: string | null;
  };
  Update: ExistingPayment["Update"] & {
    recurrence_interval_months?: number | null;
    recurrence_anchor_date?: string | null;
  };
  Relationships: ExistingPayment["Relationships"];
};

/**
 * Overlay local da migration 091 ainda NÃO aplicada. Mantém o snapshot global
 * alinhado com produção enquanto a PR consegue tipar o schema que propõe.
 */
export type Database091 = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Omit<Database["public"]["Tables"], "fixed_variable_payments"> & {
      fixed_variable_payments: Payment091;
    };
  };
};

export function database091Client(client: SupabaseClient<Database>): SupabaseClient<Database091> {
  return client as unknown as SupabaseClient<Database091>;
}
