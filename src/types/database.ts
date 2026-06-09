// Tipos manuais — serão substituídos pelos gerados automaticamente após as migrations:
// npx supabase gen types typescript --project-id <project-id> > src/types/database.ts

export type ScheduleDay = {
  day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "all";
  start_time: string; // "HH:MM"
  duration_min: number;
  team_id: string | null;
};

export type Database = {
  public: {
    Tables: {
      companies: {
        Row: { id: string; name: string; slug: string; created_at: string; updated_at: string };
        Insert: { name: string; slug: string; id?: string };
        Update: { name?: string; slug?: string };
        Relationships: [];
      };
      company_settings: {
        Row: { id: string; company_id: string; hourly_rate: number; meal_allowance_day: number; overtime_rate_pct: number; vacation_days_year: number; vat_rate: number; invoice_prefix: string; gps_radius_meters: number; timezone: string; primary_color: string; currency: string; checkin_before_minutes: number; checkout_after_minutes: number; created_at: string; updated_at: string };
        Insert: { company_id: string; hourly_rate?: number; meal_allowance_day?: number; overtime_rate_pct?: number; vacation_days_year?: number; vat_rate?: number; invoice_prefix?: string; gps_radius_meters?: number; timezone?: string; primary_color?: string; currency?: string; checkin_before_minutes?: number; checkout_after_minutes?: number };
        Update: { hourly_rate?: number; meal_allowance_day?: number; overtime_rate_pct?: number; vacation_days_year?: number; vat_rate?: number; invoice_prefix?: string; gps_radius_meters?: number; timezone?: string; primary_color?: string; currency?: string; checkin_before_minutes?: number; checkout_after_minutes?: number };
        Relationships: [];
      };
      profiles: {
        Row: { id: string; company_id: string; full_name: string; phone: string | null; email: string | null; nif: string | null; iban: string | null; avatar_url: string | null; role: string; contracted_hours_month: number | null; hourly_rate: number | null; contract_start: string | null; contract_end: string | null; vacation_balance: number | null; skills: string[]; availability: Record<string, boolean>; status: string; invited_at: string | null; invite_accepted_at: string | null; created_at: string; updated_at: string };
        Insert: { id?: string; company_id: string; full_name: string; email?: string | null; phone?: string | null; role?: string; status?: string; skills?: string[]; contracted_hours_month?: number | null; avatar_url?: string | null };
        Update: { full_name?: string; phone?: string | null; email?: string | null; nif?: string | null; iban?: string | null; hourly_rate?: number | null; avatar_url?: string | null; role?: string; contracted_hours_month?: number | null; contract_start?: string | null; contract_end?: string | null; vacation_balance?: number | null; skills?: string[]; availability?: Record<string, boolean>; status?: string; invited_at?: string | null; invite_accepted_at?: string | null; company_id?: string };
        Relationships: [];
      };
      clients: {
        Row: { id: string; company_id: string; name: string; nif: string | null; email: string | null; phone: string | null; address: string | null; type: string | null; notes: string | null; status: string; vat_exempt: boolean; created_at: string; updated_at: string };
        Insert: { company_id: string; name: string; nif?: string | null; email?: string | null; phone?: string | null; address?: string | null; type?: string | null; notes?: string | null; status?: string; vat_exempt?: boolean };
        Update: { name?: string; nif?: string | null; email?: string | null; phone?: string | null; address?: string | null; type?: string | null; notes?: string | null; status?: string; vat_exempt?: boolean };
        Relationships: [];
      };
      client_notifications: {
        Row: { id: string; company_id: string; client_id: string; service_id: string | null; method: string; status: string; sent_at: string | null; message_body: string | null; contact_used: string | null; created_by: string | null; created_at: string };
        Insert: { company_id: string; client_id: string; method: string; status?: string; service_id?: string | null; sent_at?: string | null; message_body?: string | null; contact_used?: string | null; created_by?: string | null };
        Update: { status?: string; sent_at?: string | null };
        Relationships: [];
      };
      locations: {
        Row: { id: string; company_id: string; client_id: string; name: string; address: string; lat: number | null; lng: number | null; access_code: string | null; instructions: string | null; hourly_rate: number | null; fixed_price: number | null; pricing_type: "hourly" | "fixed"; active: boolean; created_at: string; updated_at: string };
        Insert: { company_id: string; client_id: string; name: string; address: string; lat?: number | null; lng?: number | null; access_code?: string | null; instructions?: string | null; hourly_rate?: number | null; fixed_price?: number | null; pricing_type?: "hourly" | "fixed"; active?: boolean };
        Update: { name?: string; address?: string; lat?: number | null; lng?: number | null; access_code?: string | null; instructions?: string | null; hourly_rate?: number | null; fixed_price?: number | null; pricing_type?: "hourly" | "fixed"; active?: boolean };
        Relationships: [];
      };
      teams: {
        Row: { id: string; company_id: string; name: string; color: string; leader_id: string | null; active: boolean; vehicle: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; name: string; color?: string; leader_id?: string | null; active?: boolean; vehicle?: string | null };
        Update: { name?: string; color?: string; leader_id?: string | null; active?: boolean; vehicle?: string | null };
        Relationships: [];
      };
      team_members: {
        Row: { id: string; team_id: string; collaborator_id: string; joined_at: string; left_at: string | null };
        Insert: { team_id: string; collaborator_id: string; joined_at?: string; left_at?: string | null };
        Update: { left_at?: string | null };
        Relationships: [];
      };
      contracts: {
        Row: { id: string; company_id: string; location_id: string; name: string | null; frequency: string; interval_days: number; weekdays: number[] | null; month_day: number | null; month_week: number | null; month_weekday: number | null; schedule_days: ScheduleDay[]; starts_on: string; ends_on: string | null; status: string; notes: string | null; created_by: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; location_id: string; frequency: string; schedule_days: ScheduleDay[]; starts_on: string; name?: string | null; interval_days?: number; weekdays?: number[] | null; month_day?: number | null; ends_on?: string | null; status?: string; notes?: string | null; created_by?: string | null };
        Update: { location_id?: string; name?: string | null; frequency?: string; interval_days?: number; weekdays?: number[] | null; schedule_days?: ScheduleDay[]; starts_on?: string; ends_on?: string | null; status?: string; notes?: string | null };
        Relationships: [];
      };
      services: {
        Row: { id: string; company_id: string; location_id: string; team_id: string | null; contract_id: string | null; reference_number: string; scheduled_start: string; scheduled_end: string; hourly_rate: number | null; calculated_value: number | null; manual_value: number | null; discount_pct: number; status: string; actual_start: string | null; actual_end: string | null; is_exception: boolean; original_date: string | null; notes: string | null; created_by: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; location_id: string; reference_number: string; scheduled_start: string; scheduled_end: string; team_id?: string | null; contract_id?: string | null; hourly_rate?: number | null; calculated_value?: number | null; manual_value?: number | null; discount_pct?: number; status?: string; is_exception?: boolean; original_date?: string | null; notes?: string | null; created_by?: string | null };
        Update: { team_id?: string | null; status?: string; scheduled_start?: string; scheduled_end?: string; actual_start?: string | null; actual_end?: string | null; notes?: string | null; manual_value?: number | null; discount_pct?: number };
        Relationships: [];
      };
      service_reinforcements: {
        Row: { id: string; service_id: string; collaborator_id: string };
        Insert: { service_id: string; collaborator_id: string };
        Update: Record<string, never>;
        Relationships: [];
      };
      timesheets: {
        Row: { id: string; service_id: string; collaborator_id: string; company_id: string; clock_in_at: string | null; clock_out_at: string | null; clock_in_lat: number | null; clock_in_lng: number | null; clock_out_lat: number | null; clock_out_lng: number | null; location_warning: boolean; duration_minutes: number | null; notes: string | null; created_at: string; updated_at: string };
        Insert: { service_id: string; collaborator_id: string; company_id: string; clock_in_at?: string | null; clock_in_lat?: number | null; clock_in_lng?: number | null; clock_in_distance_m?: number | null; location_warning?: boolean };
        Update: { clock_in_at?: string | null; clock_out_at?: string | null; clock_out_lat?: number | null; clock_out_lng?: number | null; location_warning?: boolean; duration_minutes?: number | null; notes?: string | null };
        Relationships: [];
      };
      absences: {
        Row: { id: string; company_id: string; collaborator_id: string; absence_type: string; starts_on: string; ends_on: string; notes: string | null; document_url: string | null; replaced_by: string | null; approved_by: string | null; created_by: string | null; created_at: string };
        Insert: { company_id: string; collaborator_id: string; absence_type: string; starts_on: string; ends_on: string; notes?: string | null; document_url?: string | null; replaced_by?: string | null; approved_by?: string | null; created_by?: string | null };
        Update: { absence_type?: string; starts_on?: string; ends_on?: string; notes?: string | null; approved_by?: string | null; replaced_by?: string | null };
        Relationships: [];
      };
      vacation_requests: {
        Row: { id: string; company_id: string; collaborator_id: string; starts_on: string; ends_on: string; days_count: number | null; status: string; notes: string | null; rejection_reason: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string };
        Insert: { company_id: string; collaborator_id: string; starts_on: string; ends_on: string; days_count?: number | null; status?: string; notes?: string | null; rejection_reason?: string | null; reviewed_by?: string | null; reviewed_at?: string | null };
        Update: { starts_on?: string; ends_on?: string; days_count?: number | null; status?: string; notes?: string | null; rejection_reason?: string | null; reviewed_by?: string | null; reviewed_at?: string | null };
        Relationships: [];
      };
      invoices: {
        Row: { id: string; company_id: string; client_id: string; invoice_number: string; invoice_date: string; due_date: string | null; period_start: string | null; period_end: string | null; subtotal: number; vat_rate: number; vat_amount: number; total: number; status: string; paid_at: string | null; payment_method: string | null; notes: string | null; created_by: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; client_id: string; invoice_number: string; invoice_date: string; subtotal: number; vat_rate?: number; vat_amount: number; total: number; status?: string; due_date?: string | null; period_start?: string | null; period_end?: string | null; notes?: string | null; created_by?: string | null };
        Update: { status?: string; paid_at?: string | null; payment_method?: string | null; due_date?: string | null; notes?: string | null };
        Relationships: [];
      };
      invoice_items: {
        Row: { id: string; invoice_id: string; service_id: string | null; description: string; quantity: number; unit_price: number; total: number; sort_order: number };
        Insert: { invoice_id: string; description: string; quantity: number; unit_price: number; total: number; service_id?: string | null; sort_order?: number };
        Update: { description?: string; quantity?: number; unit_price?: number; total?: number; sort_order?: number };
        Relationships: [];
      };
      payroll_records: {
        Row: { id: string; company_id: string; collaborator_id: string; period_year: number; period_month: number; contracted_hours: number; worked_hours: number; overtime_hours: number; absence_hours: number; days_worked: number; hourly_rate: number; gross_salary: number; meal_allowance: number; overtime_bonus: number; absence_deductions: number; other_deductions: number; other_additions: number; net_salary: number; status: string; notes: string | null; approved_by: string | null; paid_at: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; collaborator_id: string; period_year: number; period_month: number; contracted_hours?: number; worked_hours?: number; overtime_hours?: number; absence_hours?: number; days_worked?: number; hourly_rate?: number; gross_salary?: number; meal_allowance?: number; overtime_bonus?: number; absence_deductions?: number; other_deductions?: number; other_additions?: number; net_salary?: number; status?: string; notes?: string | null; approved_by?: string | null; paid_at?: string | null };
        Update: { other_additions?: number; other_deductions?: number; net_salary?: number; status?: string; notes?: string | null; approved_by?: string | null; paid_at?: string | null };
        Relationships: [];
      };
      notifications: {
        Row: { id: string; company_id: string; user_id: string; type: string; title: string; body: string | null; data: Record<string, unknown> | null; read_at: string | null; created_at: string };
        Insert: { company_id: string; user_id: string; type: string; title: string; body?: string | null; data?: Record<string, unknown> | null };
        Update: { read_at?: string | null };
        Relationships: [];
      };
      push_subscriptions: {
        Row: { id: string; user_id: string; company_id: string; endpoint: string; p256dh: string; auth_key: string; user_agent: string | null; created_at: string };
        Insert: { user_id: string; company_id: string; endpoint: string; p256dh: string; auth_key: string; user_agent?: string | null };
        Update: Record<string, never>;
        Relationships: [];
      };
      vehicles: {
        Row: { id: string; company_id: string; model: string; plate: string; status: string; notes: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; model: string; plate: string; status?: string; notes?: string | null; id?: string };
        Update: { model?: string; plate?: string; status?: string; notes?: string | null };
        Relationships: [];
      };
      vehicle_allocations: {
        Row: { id: string; company_id: string; vehicle_id: string; team_id: string; driver_id: string | null; date: string; created_at: string };
        Insert: { company_id: string; vehicle_id: string; team_id: string; date: string; driver_id?: string | null; id?: string };
        Update: { vehicle_id?: string; team_id?: string; driver_id?: string | null };
        Relationships: [];
      };
      cash_flow_entries: {
        Row: { id: string; company_id: string; type: "entrada" | "saida"; amount: number; description: string; category: "faturacao" | "salario" | "despesa" | "fornecedor" | "outro" | null; date: string; reference_id: string | null; reference_type: "invoice" | "payroll" | null; status: "pendente" | "confirmado"; notes: string | null; created_by: string | null; created_at: string };
        Insert: { company_id: string; type: "entrada" | "saida"; amount: number; description: string; date: string; category?: "faturacao" | "salario" | "despesa" | "fornecedor" | "outro" | null; reference_id?: string | null; reference_type?: "invoice" | "payroll" | null; status?: "pendente" | "confirmado"; notes?: string | null; created_by?: string | null };
        Update: { description?: string; amount?: number; date?: string; category?: string | null; status?: "pendente" | "confirmado"; notes?: string | null };
        Relationships: [];
      };
      collaborator_documents: {
        Row: { id: string; company_id: string; collaborator_id: string; file_name: string; file_url: string; file_size: number | null; mime_type: string | null; category: "contrato" | "recibo_salario" | "identificacao" | "outro"; uploaded_by: string | null; created_at: string };
        Insert: { company_id: string; collaborator_id: string; file_name: string; file_url: string; file_size?: number | null; mime_type?: string | null; category?: "contrato" | "recibo_salario" | "identificacao" | "outro"; uploaded_by?: string | null };
        Update: { category?: string; file_name?: string };
        Relationships: [];
      };
      management_tasks: {
        Row: { id: string; company_id: string; title: string; body: string | null; status: "pendente" | "em_curso" | "concluido"; priority: "normal" | "urgente"; assigned_to: string | null; created_by: string | null; due_date: string | null; completed_at: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; title: string; body?: string | null; status?: "pendente" | "em_curso" | "concluido"; priority?: "normal" | "urgente"; assigned_to?: string | null; created_by?: string | null; due_date?: string | null };
        Update: { title?: string; body?: string | null; status?: "pendente" | "em_curso" | "concluido"; priority?: "normal" | "urgente"; assigned_to?: string | null; due_date?: string | null; completed_at?: string | null; updated_at?: string };
        Relationships: [];
      };
    };
    Views: {
      services_full: {
        Row: { id: string; company_id: string; reference_number: string; scheduled_start: string; scheduled_end: string; actual_start: string | null; actual_end: string | null; status: string; notes: string | null; calculated_value: number | null; manual_value: number | null; contract_id: string | null; is_exception: boolean; location_id: string; location_name: string; location_address: string; location_lat: number | null; location_lng: number | null; location_access_code: string | null; location_instructions: string | null; client_id: string; client_name: string; team_id: string | null; team_name: string | null; team_color: string | null };
        Relationships: [];
      };
      monthly_hours_summary: {
        Row: { collaborator_id: string; company_id: string; full_name: string; contracted_hours_month: number | null; month: string; services_count: number; worked_hours: number; location_warnings: number };
        Relationships: [];
      };
      teams_with_members: {
        Row: { id: string; company_id: string; name: string; color: string; active: boolean; leader_id: string | null; members: Array<{ id: string; full_name: string; avatar_url: string | null; phone: string | null }> };
        Relationships: [];
      };
    };
    Functions: {
      [fnName: string]: { Args: Record<string, unknown>; Returns: unknown };
    };
    Enums: Record<string, unknown>;
  };
};
