import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type ExistingPayment = Database["public"]["Tables"]["fixed_variable_payments"];

type Payment089 = {
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
 * Overlay local da migration 089 ainda NÃO aplicada. Mantém o snapshot global
 * alinhado com produção enquanto a PR consegue tipar o schema que propõe.
 */
export type Database089 = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Omit<Database["public"]["Tables"], "fixed_variable_payments"> & {
      fixed_variable_payments: Payment089;
    };
  };
};

export function database089Client(client: SupabaseClient<Database>): SupabaseClient<Database089> {
  return client as unknown as SupabaseClient<Database089>;
}
