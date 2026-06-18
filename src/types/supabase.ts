export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      absences: {
        Row: {
          absence_type: string
          approved_by: string | null
          collaborator_id: string
          company_id: string
          created_at: string | null
          created_by: string | null
          document_url: string | null
          ends_on: string
          id: string
          notes: string | null
          replaced_by: string | null
          starts_on: string
        }
        Insert: {
          absence_type: string
          approved_by?: string | null
          collaborator_id: string
          company_id: string
          created_at?: string | null
          created_by?: string | null
          document_url?: string | null
          ends_on: string
          id?: string
          notes?: string | null
          replaced_by?: string | null
          starts_on: string
        }
        Update: {
          absence_type?: string
          approved_by?: string | null
          collaborator_id?: string
          company_id?: string
          created_at?: string | null
          created_by?: string | null
          document_url?: string | null
          ends_on?: string
          id?: string
          notes?: string | null
          replaced_by?: string | null
          starts_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "absences_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "absences_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absences_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "absences_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absences_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absences_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "absences_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absences_replaced_by_fkey"
            columns: ["replaced_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "absences_replaced_by_fkey"
            columns: ["replaced_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string
          company_id: string
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          meta: Json
        }
        Insert: {
          action: string
          actor_id: string
          company_id: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          meta?: Json
        }
        Update: {
          action?: string
          actor_id?: string
          company_id?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          meta?: Json
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_flow_entries: {
        Row: {
          amount: number
          category: string | null
          company_id: string
          created_at: string | null
          created_by: string | null
          date: string
          description: string
          id: string
          notes: string | null
          reference_id: string | null
          reference_type: string | null
          status: string
          type: string
        }
        Insert: {
          amount: number
          category?: string | null
          company_id: string
          created_at?: string | null
          created_by?: string | null
          date: string
          description: string
          id?: string
          notes?: string | null
          reference_id?: string | null
          reference_type?: string | null
          status?: string
          type: string
        }
        Update: {
          amount?: number
          category?: string | null
          company_id?: string
          created_at?: string | null
          created_by?: string | null
          date?: string
          description?: string
          id?: string
          notes?: string | null
          reference_id?: string | null
          reference_type?: string | null
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_flow_entries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_flow_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "cash_flow_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_notifications: {
        Row: {
          client_id: string
          company_id: string
          contact_used: string | null
          created_at: string | null
          created_by: string | null
          id: string
          message_body: string | null
          method: string
          sent_at: string | null
          service_id: string | null
          status: string
        }
        Insert: {
          client_id: string
          company_id: string
          contact_used?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          message_body?: string | null
          method?: string
          sent_at?: string | null
          service_id?: string | null
          status?: string
        }
        Update: {
          client_id?: string
          company_id?: string
          contact_used?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          message_body?: string | null
          method?: string
          sent_at?: string | null
          service_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_notifications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notifications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_notifications_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notifications_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "client_notifications_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notifications_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notifications_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address: string | null
          company_id: string
          created_at: string | null
          email: string | null
          id: string
          name: string
          nif: string | null
          notes: string | null
          notification_email: string | null
          notification_enabled: boolean | null
          notification_method: string | null
          notification_phone: string | null
          phone: string | null
          status: string | null
          type: string | null
          updated_at: string | null
          vat_exempt: boolean
        }
        Insert: {
          address?: string | null
          company_id: string
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          nif?: string | null
          notes?: string | null
          notification_email?: string | null
          notification_enabled?: boolean | null
          notification_method?: string | null
          notification_phone?: string | null
          phone?: string | null
          status?: string | null
          type?: string | null
          updated_at?: string | null
          vat_exempt?: boolean
        }
        Update: {
          address?: string | null
          company_id?: string
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          nif?: string | null
          notes?: string | null
          notification_email?: string | null
          notification_enabled?: boolean | null
          notification_method?: string | null
          notification_phone?: string | null
          phone?: string | null
          status?: string | null
          type?: string | null
          updated_at?: string | null
          vat_exempt?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "clients_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      collaborator_documents: {
        Row: {
          archived_at: string | null
          category: string
          collaborator_id: string
          company_id: string
          created_at: string | null
          expires_at: string | null
          file_name: string
          file_size: number | null
          file_url: string
          id: string
          mime_type: string | null
          notes: string | null
          uploaded_by: string | null
          uploaded_by_role: string | null
          visible_to_collaborator: boolean
        }
        Insert: {
          archived_at?: string | null
          category?: string
          collaborator_id: string
          company_id: string
          created_at?: string | null
          expires_at?: string | null
          file_name: string
          file_size?: number | null
          file_url: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          uploaded_by?: string | null
          uploaded_by_role?: string | null
          visible_to_collaborator?: boolean
        }
        Update: {
          archived_at?: string | null
          category?: string
          collaborator_id?: string
          company_id?: string
          created_at?: string | null
          expires_at?: string | null
          file_name?: string
          file_size?: number | null
          file_url?: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          uploaded_by?: string | null
          uploaded_by_role?: string | null
          visible_to_collaborator?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "collaborator_documents_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "collaborator_documents_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collaborator_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collaborator_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "collaborator_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          active: boolean | null
          created_at: string | null
          id: string
          logo_url: string | null
          name: string
          slug: string
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          id?: string
          logo_url?: string | null
          name: string
          slug: string
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          slug?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      company_settings: {
        Row: {
          checkin_before_minutes: number
          checkout_after_minutes: number
          company_id: string
          created_at: string | null
          currency: string | null
          gps_radius_meters: number | null
          hourly_rate: number | null
          id: string
          invoice_prefix: string | null
          kanban_columns: Json | null
          meal_allowance_day: number | null
          overtime_rate_pct: number | null
          primary_color: string | null
          timezone: string | null
          updated_at: string | null
          vacation_days_year: number | null
          vat_rate: number | null
        }
        Insert: {
          checkin_before_minutes?: number
          checkout_after_minutes?: number
          company_id: string
          created_at?: string | null
          currency?: string | null
          gps_radius_meters?: number | null
          hourly_rate?: number | null
          id?: string
          invoice_prefix?: string | null
          kanban_columns?: Json | null
          meal_allowance_day?: number | null
          overtime_rate_pct?: number | null
          primary_color?: string | null
          timezone?: string | null
          updated_at?: string | null
          vacation_days_year?: number | null
          vat_rate?: number | null
        }
        Update: {
          checkin_before_minutes?: number
          checkout_after_minutes?: number
          company_id?: string
          created_at?: string | null
          currency?: string | null
          gps_radius_meters?: number | null
          hourly_rate?: number | null
          id?: string
          invoice_prefix?: string | null
          kanban_columns?: Json | null
          meal_allowance_day?: number | null
          overtime_rate_pct?: number | null
          primary_color?: string | null
          timezone?: string | null
          updated_at?: string | null
          vacation_days_year?: number | null
          vat_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "company_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      contracts: {
        Row: {
          company_id: string
          created_at: string | null
          created_by: string | null
          ends_on: string | null
          frequency: string
          id: string
          interval_days: number | null
          location_id: string
          month_day: number | null
          month_week: number | null
          month_weekday: number | null
          name: string | null
          notes: string | null
          schedule_days: Json
          starts_on: string
          status: string | null
          updated_at: string | null
          weekdays: number[] | null
        }
        Insert: {
          company_id: string
          created_at?: string | null
          created_by?: string | null
          ends_on?: string | null
          frequency: string
          id?: string
          interval_days?: number | null
          location_id: string
          month_day?: number | null
          month_week?: number | null
          month_weekday?: number | null
          name?: string | null
          notes?: string | null
          schedule_days?: Json
          starts_on: string
          status?: string | null
          updated_at?: string | null
          weekdays?: number[] | null
        }
        Update: {
          company_id?: string
          created_at?: string | null
          created_by?: string | null
          ends_on?: string | null
          frequency?: string
          id?: string
          interval_days?: number | null
          location_id?: string
          month_day?: number | null
          month_week?: number | null
          month_weekday?: number | null
          name?: string | null
          notes?: string | null
          schedule_days?: Json
          starts_on?: string
          status?: string | null
          updated_at?: string | null
          weekdays?: number[] | null
        }
        Relationships: [
          {
            foreignKeyName: "contracts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "contracts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["location_id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          description: string
          id: string
          invoice_id: string
          quantity: number
          service_id: string | null
          sort_order: number | null
          total: number
          unit_price: number
        }
        Insert: {
          description: string
          id?: string
          invoice_id: string
          quantity?: number
          service_id?: string | null
          sort_order?: number | null
          total?: number
          unit_price?: number
        }
        Update: {
          description?: string
          id?: string
          invoice_id?: string
          quantity?: number
          service_id?: string | null
          sort_order?: number | null
          total?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          client_id: string
          company_id: string
          created_at: string | null
          created_by: string | null
          due_date: string | null
          id: string
          invoice_date: string
          invoice_number: string
          notes: string | null
          paid_at: string | null
          payment_method: string | null
          period_end: string | null
          period_start: string | null
          status: string | null
          subtotal: number
          total: number
          updated_at: string | null
          vat_amount: number | null
          vat_rate: number | null
        }
        Insert: {
          client_id: string
          company_id: string
          created_at?: string | null
          created_by?: string | null
          due_date?: string | null
          id?: string
          invoice_date?: string
          invoice_number: string
          notes?: string | null
          paid_at?: string | null
          payment_method?: string | null
          period_end?: string | null
          period_start?: string | null
          status?: string | null
          subtotal?: number
          total?: number
          updated_at?: string | null
          vat_amount?: number | null
          vat_rate?: number | null
        }
        Update: {
          client_id?: string
          company_id?: string
          created_at?: string | null
          created_by?: string | null
          due_date?: string | null
          id?: string
          invoice_date?: string
          invoice_number?: string
          notes?: string | null
          paid_at?: string | null
          payment_method?: string | null
          period_end?: string | null
          period_start?: string | null
          status?: string | null
          subtotal?: number
          total?: number
          updated_at?: string | null
          vat_amount?: number | null
          vat_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "invoices_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          access_code: string | null
          active: boolean | null
          address: string
          area_sqm: number | null
          client_id: string
          company_id: string
          created_at: string | null
          fixed_price: number | null
          gps_radius_m: number | null
          hourly_rate: number | null
          id: string
          instructions: string | null
          lat: number | null
          lng: number | null
          name: string
          pricing_type: string
          service_type: string | null
          updated_at: string | null
        }
        Insert: {
          access_code?: string | null
          active?: boolean | null
          address: string
          area_sqm?: number | null
          client_id: string
          company_id: string
          created_at?: string | null
          fixed_price?: number | null
          gps_radius_m?: number | null
          hourly_rate?: number | null
          id?: string
          instructions?: string | null
          lat?: number | null
          lng?: number | null
          name: string
          pricing_type?: string
          service_type?: string | null
          updated_at?: string | null
        }
        Update: {
          access_code?: string | null
          active?: boolean | null
          address?: string
          area_sqm?: number | null
          client_id?: string
          company_id?: string
          created_at?: string | null
          fixed_price?: number | null
          gps_radius_m?: number | null
          hourly_rate?: number | null
          id?: string
          instructions?: string | null
          lat?: number | null
          lng?: number | null
          name?: string
          pricing_type?: string
          service_type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "locations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "locations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      management_tasks: {
        Row: {
          assigned_to: string | null
          body: string | null
          company_id: string
          completed_at: string | null
          created_at: string | null
          created_by: string | null
          due_date: string | null
          id: string
          priority: string
          status: string
          title: string
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          body?: string | null
          company_id: string
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          due_date?: string | null
          id?: string
          priority?: string
          status?: string
          title: string
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          body?: string | null
          company_id?: string
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          due_date?: string | null
          id?: string
          priority?: string
          status?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "management_tasks_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "management_tasks_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "management_tasks_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "management_tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "management_tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          company_id: string
          created_at: string | null
          data: Json | null
          id: string
          read_at: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          company_id: string
          created_at?: string | null
          data?: Json | null
          id?: string
          read_at?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string | null
          company_id?: string
          created_at?: string | null
          data?: Json | null
          id?: string
          read_at?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_records: {
        Row: {
          absence_deductions: number | null
          absence_hours: number | null
          approved_by: string | null
          collaborator_id: string
          company_id: string
          contracted_hours: number | null
          created_at: string | null
          days_worked: number | null
          gross_salary: number | null
          hourly_rate: number | null
          id: string
          meal_allowance: number | null
          net_salary: number | null
          notes: string | null
          other_additions: number | null
          other_deductions: number | null
          overtime_bonus: number | null
          overtime_hours: number | null
          paid_at: string | null
          period_month: number
          period_year: number
          status: string | null
          updated_at: string | null
          worked_hours: number | null
        }
        Insert: {
          absence_deductions?: number | null
          absence_hours?: number | null
          approved_by?: string | null
          collaborator_id: string
          company_id: string
          contracted_hours?: number | null
          created_at?: string | null
          days_worked?: number | null
          gross_salary?: number | null
          hourly_rate?: number | null
          id?: string
          meal_allowance?: number | null
          net_salary?: number | null
          notes?: string | null
          other_additions?: number | null
          other_deductions?: number | null
          overtime_bonus?: number | null
          overtime_hours?: number | null
          paid_at?: string | null
          period_month: number
          period_year: number
          status?: string | null
          updated_at?: string | null
          worked_hours?: number | null
        }
        Update: {
          absence_deductions?: number | null
          absence_hours?: number | null
          approved_by?: string | null
          collaborator_id?: string
          company_id?: string
          contracted_hours?: number | null
          created_at?: string | null
          days_worked?: number | null
          gross_salary?: number | null
          hourly_rate?: number | null
          id?: string
          meal_allowance?: number | null
          net_salary?: number | null
          notes?: string | null
          other_additions?: number | null
          other_deductions?: number | null
          overtime_bonus?: number | null
          overtime_hours?: number | null
          paid_at?: string | null
          period_month?: number
          period_year?: number
          status?: string | null
          updated_at?: string | null
          worked_hours?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "payroll_records_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "payroll_records_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_records_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "payroll_records_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_records_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          availability: Json | null
          avatar_url: string | null
          company_id: string
          contract_end: string | null
          contract_start: string | null
          contracted_hours_month: number | null
          created_at: string | null
          email: string | null
          full_name: string
          hourly_rate: number | null
          iban: string | null
          id: string
          invite_accepted_at: string | null
          invited_at: string | null
          nif: string | null
          phone: string | null
          role: string
          skills: string[] | null
          status: string | null
          updated_at: string | null
          vacation_balance: number | null
        }
        Insert: {
          availability?: Json | null
          avatar_url?: string | null
          company_id: string
          contract_end?: string | null
          contract_start?: string | null
          contracted_hours_month?: number | null
          created_at?: string | null
          email?: string | null
          full_name: string
          hourly_rate?: number | null
          iban?: string | null
          id: string
          invite_accepted_at?: string | null
          invited_at?: string | null
          nif?: string | null
          phone?: string | null
          role?: string
          skills?: string[] | null
          status?: string | null
          updated_at?: string | null
          vacation_balance?: number | null
        }
        Update: {
          availability?: Json | null
          avatar_url?: string | null
          company_id?: string
          contract_end?: string | null
          contract_start?: string | null
          contracted_hours_month?: number | null
          created_at?: string | null
          email?: string | null
          full_name?: string
          hourly_rate?: number | null
          iban?: string | null
          id?: string
          invite_accepted_at?: string | null
          invited_at?: string | null
          nif?: string | null
          phone?: string | null
          role?: string
          skills?: string[] | null
          status?: string | null
          updated_at?: string | null
          vacation_balance?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth_key: string
          company_id: string
          created_at: string | null
          endpoint: string
          id: string
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth_key: string
          company_id: string
          created_at?: string | null
          endpoint: string
          id?: string
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth_key?: string
          company_id?: string
          created_at?: string | null
          endpoint?: string
          id?: string
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      service_price_audit: {
        Row: {
          changed_by: string | null
          created_at: string | null
          id: string
          new_value: number | null
          old_value: number | null
          reason: string | null
          service_id: string
        }
        Insert: {
          changed_by?: string | null
          created_at?: string | null
          id?: string
          new_value?: number | null
          old_value?: number | null
          reason?: string | null
          service_id: string
        }
        Update: {
          changed_by?: string | null
          created_at?: string | null
          id?: string
          new_value?: number | null
          old_value?: number | null
          reason?: string | null
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_price_audit_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "service_price_audit_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_price_audit_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_price_audit_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["id"]
          },
        ]
      }
      service_reinforcements: {
        Row: {
          collaborator_id: string
          id: string
          service_id: string
        }
        Insert: {
          collaborator_id: string
          id?: string
          service_id: string
        }
        Update: {
          collaborator_id?: string
          id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_reinforcements_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "service_reinforcements_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_reinforcements_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_reinforcements_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          calculated_value: number | null
          cancel_reason: string | null
          cancel_type: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          company_id: string
          contract_id: string | null
          created_at: string | null
          created_by: string | null
          discount_pct: number | null
          hourly_rate: number | null
          id: string
          is_exception: boolean | null
          is_late_cancel: boolean | null
          location_id: string
          manual_value: number | null
          notes: string | null
          original_date: string | null
          reference_number: string
          scheduled_end: string
          scheduled_start: string
          status: string | null
          team_id: string | null
          updated_at: string | null
        }
        Insert: {
          actual_end?: string | null
          actual_start?: string | null
          calculated_value?: number | null
          cancel_reason?: string | null
          cancel_type?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id: string
          contract_id?: string | null
          created_at?: string | null
          created_by?: string | null
          discount_pct?: number | null
          hourly_rate?: number | null
          id?: string
          is_exception?: boolean | null
          is_late_cancel?: boolean | null
          location_id: string
          manual_value?: number | null
          notes?: string | null
          original_date?: string | null
          reference_number: string
          scheduled_end: string
          scheduled_start: string
          status?: string | null
          team_id?: string | null
          updated_at?: string | null
        }
        Update: {
          actual_end?: string | null
          actual_start?: string | null
          calculated_value?: number | null
          cancel_reason?: string | null
          cancel_type?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          company_id?: string
          contract_id?: string | null
          created_at?: string | null
          created_by?: string | null
          discount_pct?: number | null
          hourly_rate?: number | null
          id?: string
          is_exception?: boolean | null
          is_late_cancel?: boolean | null
          location_id?: string
          manual_value?: number | null
          notes?: string | null
          original_date?: string | null
          reference_number?: string
          scheduled_end?: string
          scheduled_start?: string
          status?: string | null
          team_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "services_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "services_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "services_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "services_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["team_id"]
          },
          {
            foreignKeyName: "services_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams_with_members"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          collaborator_id: string
          id: string
          joined_at: string | null
          left_at: string | null
          team_id: string
        }
        Insert: {
          collaborator_id: string
          id?: string
          joined_at?: string | null
          left_at?: string | null
          team_id: string
        }
        Update: {
          collaborator_id?: string
          id?: string
          joined_at?: string | null
          left_at?: string | null
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "team_members_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["team_id"]
          },
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams_with_members"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          active: boolean | null
          color: string | null
          company_id: string
          created_at: string | null
          id: string
          leader_id: string | null
          name: string
          updated_at: string | null
          vehicle: string | null
        }
        Insert: {
          active?: boolean | null
          color?: string | null
          company_id: string
          created_at?: string | null
          id?: string
          leader_id?: string | null
          name: string
          updated_at?: string | null
          vehicle?: string | null
        }
        Update: {
          active?: boolean | null
          color?: string | null
          company_id?: string
          created_at?: string | null
          id?: string
          leader_id?: string | null
          name?: string
          updated_at?: string | null
          vehicle?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "teams_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_leader_id_fkey"
            columns: ["leader_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "teams_leader_id_fkey"
            columns: ["leader_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      timesheets: {
        Row: {
          client_event_id: string | null
          clock_in_at: string | null
          clock_in_distance_m: number | null
          clock_in_lat: number | null
          clock_in_lng: number | null
          clock_out_at: string | null
          clock_out_lat: number | null
          clock_out_lng: number | null
          closed_by_manager: boolean | null
          collaborator_id: string
          company_id: string
          created_at: string | null
          duration_minutes: number | null
          gps_accuracy_m: number | null
          id: string
          location_warning: boolean | null
          manager_note: string | null
          manual_checkin: boolean
          service_id: string
          updated_at: string | null
        }
        Insert: {
          client_event_id?: string | null
          clock_in_at?: string | null
          clock_in_distance_m?: number | null
          clock_in_lat?: number | null
          clock_in_lng?: number | null
          clock_out_at?: string | null
          clock_out_lat?: number | null
          clock_out_lng?: number | null
          closed_by_manager?: boolean | null
          collaborator_id: string
          company_id: string
          created_at?: string | null
          duration_minutes?: number | null
          gps_accuracy_m?: number | null
          id?: string
          location_warning?: boolean | null
          manager_note?: string | null
          manual_checkin?: boolean
          service_id: string
          updated_at?: string | null
        }
        Update: {
          client_event_id?: string | null
          clock_in_at?: string | null
          clock_in_distance_m?: number | null
          clock_in_lat?: number | null
          clock_in_lng?: number | null
          clock_out_at?: string | null
          clock_out_lat?: number | null
          clock_out_lng?: number | null
          closed_by_manager?: boolean | null
          collaborator_id?: string
          company_id?: string
          created_at?: string | null
          duration_minutes?: number | null
          gps_accuracy_m?: number | null
          id?: string
          location_warning?: boolean | null
          manager_note?: string | null
          manual_checkin?: boolean
          service_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "timesheets_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "timesheets_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["id"]
          },
        ]
      }
      vacation_requests: {
        Row: {
          collaborator_id: string
          company_id: string
          created_at: string | null
          days_count: number | null
          ends_on: string
          id: string
          notes: string | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          starts_on: string
          status: string | null
        }
        Insert: {
          collaborator_id: string
          company_id: string
          created_at?: string | null
          days_count?: number | null
          ends_on: string
          id?: string
          notes?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          starts_on: string
          status?: string | null
        }
        Update: {
          collaborator_id?: string
          company_id?: string
          created_at?: string | null
          days_count?: number | null
          ends_on?: string
          id?: string
          notes?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          starts_on?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vacation_requests_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "vacation_requests_collaborator_id_fkey"
            columns: ["collaborator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vacation_requests_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vacation_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "vacation_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_allocations: {
        Row: {
          company_id: string
          created_at: string
          date: string
          driver_id: string | null
          id: string
          team_id: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          date: string
          driver_id?: string | null
          id?: string
          team_id: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          date?: string
          driver_id?: string | null
          id?: string
          team_id?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_allocations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_allocations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "vehicle_allocations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_allocations_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "services_full"
            referencedColumns: ["team_id"]
          },
          {
            foreignKeyName: "vehicle_allocations_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_allocations_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams_with_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_allocations_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          company_id: string
          created_at: string
          id: string
          model: string
          notes: string | null
          plate: string
          status: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          model: string
          notes?: string | null
          plate: string
          status?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          model?: string
          notes?: string | null
          plate?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      monthly_hours_summary: {
        Row: {
          collaborator_id: string | null
          company_id: string | null
          contracted_hours_month: number | null
          full_name: string | null
          location_warnings: number | null
          month: string | null
          services_count: number | null
          worked_hours: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      services_full: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          calculated_value: number | null
          client_email: string | null
          client_id: string | null
          client_name: string | null
          client_phone: string | null
          company_id: string | null
          contract_id: string | null
          id: string | null
          is_exception: boolean | null
          location_access_code: string | null
          location_address: string | null
          location_id: string | null
          location_instructions: string | null
          location_lat: number | null
          location_lng: number | null
          location_name: string | null
          manual_value: number | null
          notes: string | null
          reference_number: string | null
          scheduled_end: string | null
          scheduled_start: string | null
          status: string | null
          team_color: string | null
          team_id: string | null
          team_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "services_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      teams_with_members: {
        Row: {
          active: boolean | null
          color: string | null
          company_id: string | null
          id: string | null
          leader_id: string | null
          members: Json | null
          name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "teams_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_leader_id_fkey"
            columns: ["leader_id"]
            isOneToOne: false
            referencedRelation: "monthly_hours_summary"
            referencedColumns: ["collaborator_id"]
          },
          {
            foreignKeyName: "teams_leader_id_fkey"
            columns: ["leader_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      archive_expired_documents: {
        Args: { p_company_id: string }
        Returns: number
      }
      detect_schedule_conflicts: {
        Args: { p_end: string; p_start: string }
        Returns: {
          company_id: string
          service1_end: string
          service1_id: string
          service1_start: string
          service2_end: string
          service2_id: string
          service2_start: string
          team_id: string
        }[]
      }
      generate_reference_number: {
        Args: { p_company_id: string }
        Returns: string
      }
      get_documents_to_archive: {
        Args: { p_company_id: string }
        Returns: {
          category: string
          collaborator_id: string
          collaborator_name: string
          created_at: string
          expires_at: string
          file_name: string
          file_size: number
          file_url: string
          id: string
          mime_type: string
          notes: string
        }[]
      }
      get_my_company_id: { Args: never; Returns: string }
      get_my_role: { Args: never; Returns: string }
      get_service_company_id: {
        Args: { p_service_id: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const