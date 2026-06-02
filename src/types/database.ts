// Tipos manuais — serão substituídos pelos gerados automaticamente após as migrations:
// npx supabase gen types typescript --project-id <project-id> > src/types/database.ts

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
        Row: { id: string; company_id: string; hourly_rate: number; meal_allowance_daily: number; overtime_multiplier: number; vat_rate: number; gps_radius_meters: number; logo_url: string | null; timezone: string; created_at: string; updated_at: string };
        Insert: { company_id: string; hourly_rate?: number; meal_allowance_daily?: number };
        Update: { hourly_rate?: number; meal_allowance_daily?: number; overtime_multiplier?: number; vat_rate?: number; gps_radius_meters?: number; logo_url?: string | null };
        Relationships: [];
      };
      profiles: {
        Row: { id: string; company_id: string; full_name: string; phone: string | null; email: string | null; nif: string | null; iban: string | null; avatar_url: string | null; role: string; contracted_hours_month: number | null; contract_start: string | null; contract_end: string | null; vacation_balance: number | null; skills: string[]; availability: Record<string, boolean>; status: string; invited_at: string | null; invite_accepted_at: string | null; created_at: string; updated_at: string };
        Insert: { id?: string; company_id: string; full_name: string; email?: string | null; phone?: string | null; role?: string; status?: string; skills?: string[]; contracted_hours_month?: number | null; avatar_url?: string | null };
        Update: { full_name?: string; phone?: string | null; email?: string | null; nif?: string | null; iban?: string | null; avatar_url?: string | null; role?: string; contracted_hours_month?: number | null; contract_start?: string | null; contract_end?: string | null; vacation_balance?: number | null; skills?: string[]; availability?: Record<string, boolean>; status?: string; invited_at?: string | null; invite_accepted_at?: string | null; company_id?: string };
        Relationships: [];
      };
      clients: {
        Row: { id: string; company_id: string; name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null; nif: string | null; notes: string | null; active: boolean; created_at: string; updated_at: string };
        Insert: { company_id: string; name: string; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null };
        Update: { name?: string; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null; nif?: string | null; notes?: string | null; active?: boolean };
        Relationships: [];
      };
      locations: {
        Row: { id: string; company_id: string; client_id: string; name: string; address: string; lat: number | null; lng: number | null; access_code: string | null; instructions: string | null; hourly_rate: number | null; active: boolean; created_at: string; updated_at: string };
        Insert: { company_id: string; client_id: string; name: string; address: string; lat?: number | null; lng?: number | null; access_code?: string | null; instructions?: string | null; hourly_rate?: number | null };
        Update: { name?: string; address?: string; lat?: number | null; lng?: number | null; access_code?: string | null; instructions?: string | null; hourly_rate?: number | null; active?: boolean };
        Relationships: [];
      };
      teams: {
        Row: { id: string; company_id: string; name: string; color: string; leader_id: string | null; active: boolean; created_at: string; updated_at: string };
        Insert: { company_id: string; name: string; color?: string; leader_id?: string | null };
        Update: { name?: string; color?: string; leader_id?: string | null; active?: boolean };
        Relationships: [];
      };
      team_members: {
        Row: { id: string; team_id: string; collaborator_id: string; joined_at: string; left_at: string | null };
        Insert: { team_id: string; collaborator_id: string; joined_at?: string; left_at?: string | null };
        Update: { left_at?: string | null };
        Relationships: [];
      };
      contracts: {
        Row: { id: string; company_id: string; client_id: string; location_id: string; name: string | null; schedule_days: Record<string, unknown>[]; start_date: string; end_date: string | null; status: string; notes: string | null; created_by: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; client_id: string; location_id: string; schedule_days: Record<string, unknown>[]; start_date: string; status?: string };
        Update: { schedule_days?: Record<string, unknown>[]; end_date?: string | null; status?: string; notes?: string | null };
        Relationships: [];
      };
      services: {
        Row: { id: string; company_id: string; location_id: string; team_id: string | null; contract_id: string | null; reference_number: string; scheduled_start: string; scheduled_end: string; hourly_rate: number | null; calculated_value: number | null; manual_value: number | null; discount_pct: number; status: string; actual_start: string | null; actual_end: string | null; is_exception: boolean; original_date: string | null; notes: string | null; created_by: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; location_id: string; reference_number: string; scheduled_start: string; scheduled_end: string; team_id?: string | null; contract_id?: string | null; status?: string };
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
        Insert: { service_id: string; collaborator_id: string; company_id: string; clock_in_at?: string | null };
        Update: { clock_out_at?: string | null; clock_out_lat?: number | null; clock_out_lng?: number | null; location_warning?: boolean; duration_minutes?: number | null; notes?: string | null };
        Relationships: [];
      };
      absences: {
        Row: { id: string; company_id: string; collaborator_id: string; service_id: string | null; absence_date: string; type: string; notes: string | null; approved_by: string | null; created_at: string };
        Insert: { company_id: string; collaborator_id: string; absence_date: string; type: string; notes?: string | null; service_id?: string | null };
        Update: { type?: string; notes?: string | null; approved_by?: string | null };
        Relationships: [];
      };
      vacation_requests: {
        Row: { id: string; company_id: string; collaborator_id: string; start_date: string; end_date: string; days_count: number; status: string; notes: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string };
        Insert: { company_id: string; collaborator_id: string; start_date: string; end_date: string; days_count: number; status?: string; notes?: string | null };
        Update: { status?: string; reviewed_by?: string | null; reviewed_at?: string | null };
        Relationships: [];
      };
      invoices: {
        Row: { id: string; company_id: string; client_id: string; reference_number: string; issue_date: string; due_date: string | null; subtotal: number; vat_amount: number; total: number; status: string; notes: string | null; created_by: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; client_id: string; reference_number: string; issue_date: string; subtotal: number; vat_amount: number; total: number; status?: string };
        Update: { status?: string; due_date?: string | null; notes?: string | null };
        Relationships: [];
      };
      invoice_items: {
        Row: { id: string; invoice_id: string; service_id: string | null; description: string; quantity: number; unit_price: number; total: number };
        Insert: { invoice_id: string; description: string; quantity: number; unit_price: number; total: number; service_id?: string | null };
        Update: { description?: string; quantity?: number; unit_price?: number; total?: number };
        Relationships: [];
      };
      payroll_records: {
        Row: { id: string; company_id: string; collaborator_id: string; period_month: string; base_hours: number; worked_hours: number; overtime_hours: number; hourly_rate: number; meal_allowance_days: number; meal_allowance_daily: number; gross_pay: number; deductions: number; net_pay: number; adjustments: number; status: string; notes: string | null; created_by: string | null; created_at: string; updated_at: string };
        Insert: { company_id: string; collaborator_id: string; period_month: string; base_hours: number; worked_hours: number; hourly_rate: number; gross_pay: number; net_pay: number; status?: string };
        Update: { adjustments?: number; status?: string; notes?: string | null };
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
