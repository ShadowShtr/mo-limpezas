import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type ManualChargeTable = {
  Row: {
    id: string;
    company_id: string;
    client_id: string;
    charge_date: string;
    description: string;
    amount: number;
    apply_vat: boolean;
    payment_status: "nao_informado" | "sinal_50" | "pago_total";
    paid_amount: number | null;
    paid_at: string | null;
    notes: string | null;
    voided_at: string | null;
    voided_by: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  };
  Insert: {
    id?: string;
    company_id: string;
    client_id: string;
    charge_date: string;
    description: string;
    amount: number;
    apply_vat?: boolean;
    payment_status?: "nao_informado" | "sinal_50" | "pago_total";
    paid_amount?: number | null;
    paid_at?: string | null;
    notes?: string | null;
    voided_at?: string | null;
    voided_by?: string | null;
    created_by?: string | null;
    created_at?: string;
    updated_at?: string;
  };
  Update: {
    client_id?: string;
    charge_date?: string;
    description?: string;
    amount?: number;
    apply_vat?: boolean;
    payment_status?: "nao_informado" | "sinal_50" | "pago_total";
    paid_amount?: number | null;
    paid_at?: string | null;
    notes?: string | null;
    voided_at?: string | null;
    voided_by?: string | null;
    updated_at?: string;
  };
  Relationships: [];
};

/**
 * A migration 086 já está em produção, mas `src/types/database.ts` é um
 * snapshot manual anterior. Este overlay é estreito e removível quando o
 * snapshot global for regenerado; não usa `any` nem inventa colunas.
 */
export type Database086 = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      manual_charges: ManualChargeTable;
    };
  };
};

export function database086Client(client: SupabaseClient<Database>): SupabaseClient<Database086> {
  return client as unknown as SupabaseClient<Database086>;
}
