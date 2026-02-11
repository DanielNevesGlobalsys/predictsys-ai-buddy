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
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          id: string
          ip_address: string | null
          metadata: Json | null
          organization_id: string
          project_id: string | null
          resource_name: string | null
          resource_type: string
          timestamp: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          organization_id: string
          project_id?: string | null
          resource_name?: string | null
          resource_type: string
          timestamp?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          organization_id?: string
          project_id?: string | null
          resource_name?: string | null
          resource_type?: string
          timestamp?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      data_sources: {
        Row: {
          connection_config: Json
          connector_type: string
          created_at: string
          id: string
          incremental_key: string | null
          is_continuous: boolean
          last_sync_at: string | null
          name: string
          organization_id: string | null
          source_mode: string | null
          source_sql: string | null
          source_sql_hash: string | null
          source_table_full_name: string | null
          source_type: string
          sync_message: string | null
          sync_status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          connection_config?: Json
          connector_type: string
          created_at?: string
          id?: string
          incremental_key?: string | null
          is_continuous?: boolean
          last_sync_at?: string | null
          name: string
          organization_id?: string | null
          source_mode?: string | null
          source_sql?: string | null
          source_sql_hash?: string | null
          source_table_full_name?: string | null
          source_type: string
          sync_message?: string | null
          sync_status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          connection_config?: Json
          connector_type?: string
          created_at?: string
          id?: string
          incremental_key?: string | null
          is_continuous?: boolean
          last_sync_at?: string | null
          name?: string
          organization_id?: string | null
          source_mode?: string | null
          source_sql?: string | null
          source_sql_hash?: string | null
          source_table_full_name?: string | null
          source_type?: string
          sync_message?: string | null
          sync_status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      export_jobs: {
        Row: {
          created_at: string
          error_message: string | null
          export_type: string
          file_size_bytes: number | null
          file_url: string | null
          finished_at: string | null
          id: string
          parameters: Json | null
          project_id: string
          rows_exported: number | null
          started_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          export_type: string
          file_size_bytes?: number | null
          file_url?: string | null
          finished_at?: string | null
          id?: string
          parameters?: Json | null
          project_id: string
          rows_exported?: number | null
          started_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          export_type?: string
          file_size_bytes?: number | null
          file_url?: string | null
          finished_at?: string | null
          id?: string
          parameters?: Json | null
          project_id?: string
          rows_exported?: number | null
          started_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "export_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      global_chat_messages: {
        Row: {
          created_at: string
          id: string
          message_text: string
          sender_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_text: string
          sender_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message_text?: string
          sender_type?: string
          user_id?: string
        }
        Relationships: []
      }
      import_jobs: {
        Row: {
          batch_id: string | null
          batch_sequence: number | null
          created_at: string
          dataset_id: string | null
          delimiter: string
          encoding: string
          error_message: string | null
          file_name: string
          file_size_bytes: number
          finished_at: string | null
          headers_hash: string | null
          headers_json: Json | null
          id: string
          is_batch_primary: boolean | null
          progress: number | null
          project_id: string
          rows_processed: number | null
          status: string
          storage_path: string
          updated_at: string
          user_id: string
        }
        Insert: {
          batch_id?: string | null
          batch_sequence?: number | null
          created_at?: string
          dataset_id?: string | null
          delimiter?: string
          encoding?: string
          error_message?: string | null
          file_name: string
          file_size_bytes: number
          finished_at?: string | null
          headers_hash?: string | null
          headers_json?: Json | null
          id?: string
          is_batch_primary?: boolean | null
          progress?: number | null
          project_id: string
          rows_processed?: number | null
          status?: string
          storage_path: string
          updated_at?: string
          user_id: string
        }
        Update: {
          batch_id?: string | null
          batch_sequence?: number | null
          created_at?: string
          dataset_id?: string | null
          delimiter?: string
          encoding?: string
          error_message?: string | null
          file_name?: string
          file_size_bytes?: number
          finished_at?: string | null
          headers_hash?: string | null
          headers_json?: Json | null
          id?: string
          is_batch_primary?: boolean | null
          progress?: number | null
          project_id?: string
          rows_processed?: number | null
          status?: string
          storage_path?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_jobs_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "project_datasets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      import_manifests: {
        Row: {
          batch_id: string | null
          blocked_reason_eda: string | null
          blocked_reason_model: string | null
          canonical_schema: Json | null
          column_mapping_report: Json | null
          columns_final: number
          created_at: string
          dataset_id: string | null
          eda_dataset_id: string | null
          eda_ready: boolean | null
          eda_scope: string | null
          eda_strategy: string | null
          files: Json
          files_fail: number
          files_ok: number
          files_warn: number
          id: string
          model_dataset_id: string | null
          model_ready: boolean | null
          null_diagnostic: Json | null
          project_id: string
          rows_consolidated: number
          rows_difference: number
          rows_sum: number
          status: string
          status_reason: string | null
          total_files: number
          user_id: string
        }
        Insert: {
          batch_id?: string | null
          blocked_reason_eda?: string | null
          blocked_reason_model?: string | null
          canonical_schema?: Json | null
          column_mapping_report?: Json | null
          columns_final?: number
          created_at?: string
          dataset_id?: string | null
          eda_dataset_id?: string | null
          eda_ready?: boolean | null
          eda_scope?: string | null
          eda_strategy?: string | null
          files?: Json
          files_fail?: number
          files_ok?: number
          files_warn?: number
          id?: string
          model_dataset_id?: string | null
          model_ready?: boolean | null
          null_diagnostic?: Json | null
          project_id: string
          rows_consolidated?: number
          rows_difference?: number
          rows_sum?: number
          status?: string
          status_reason?: string | null
          total_files?: number
          user_id: string
        }
        Update: {
          batch_id?: string | null
          blocked_reason_eda?: string | null
          blocked_reason_model?: string | null
          canonical_schema?: Json | null
          column_mapping_report?: Json | null
          columns_final?: number
          created_at?: string
          dataset_id?: string | null
          eda_dataset_id?: string | null
          eda_ready?: boolean | null
          eda_scope?: string | null
          eda_strategy?: string | null
          files?: Json
          files_fail?: number
          files_ok?: number
          files_warn?: number
          id?: string
          model_dataset_id?: string | null
          model_ready?: boolean | null
          null_diagnostic?: Json | null
          project_id?: string
          rows_consolidated?: number
          rows_difference?: number
          rows_sum?: number
          status?: string
          status_reason?: string | null
          total_files?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_manifests_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "project_datasets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_manifests_eda_dataset_id_fkey"
            columns: ["eda_dataset_id"]
            isOneToOne: false
            referencedRelation: "project_datasets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_manifests_model_dataset_id_fkey"
            columns: ["model_dataset_id"]
            isOneToOne: false
            referencedRelation: "project_datasets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_manifests_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_data_policy: {
        Row: {
          allow_data_export: boolean
          anonymize_ids: boolean
          created_at: string
          data_retention_months: number
          id: string
          log_retention_months: number
          organization_id: string
          updated_at: string
        }
        Insert: {
          allow_data_export?: boolean
          anonymize_ids?: boolean
          created_at?: string
          data_retention_months?: number
          id?: string
          log_retention_months?: number
          organization_id: string
          updated_at?: string
        }
        Update: {
          allow_data_export?: boolean
          anonymize_ids?: boolean
          created_at?: string
          data_retention_months?: number
          id?: string
          log_retention_months?: number
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_data_policy_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_users: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_users_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          document: string | null
          id: string
          logo_url: string | null
          max_projects: number | null
          max_rows: number | null
          max_storage_mb: number | null
          name: string
          plan: Database["public"]["Enums"]["org_plan"]
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          document?: string | null
          id?: string
          logo_url?: string | null
          max_projects?: number | null
          max_rows?: number | null
          max_storage_mb?: number | null
          name: string
          plan?: Database["public"]["Enums"]["org_plan"]
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          document?: string | null
          id?: string
          logo_url?: string | null
          max_projects?: number | null
          max_rows?: number | null
          max_storage_mb?: number | null
          name?: string
          plan?: Database["public"]["Enums"]["org_plan"]
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_events: {
        Row: {
          created_at: string
          duration_ms: number | null
          event_type: string
          id: string
          metadata: Json | null
          organization_id: string | null
          project_id: string | null
          source: string
          status: string
          timestamp: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          event_type: string
          id?: string
          metadata?: Json | null
          organization_id?: string | null
          project_id?: string | null
          source?: string
          status?: string
          timestamp?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          event_type?: string
          id?: string
          metadata?: Json | null
          organization_id?: string | null
          project_id?: string | null
          source?: string
          status?: string
          timestamp?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_metrics_daily: {
        Row: {
          active_users_1d: number
          active_users_30d: number
          active_users_7d: number
          avg_eda_ms: number | null
          avg_import_ms: number | null
          avg_predict_ms: number | null
          avg_train_ms: number | null
          created_at: string
          datasets_connected: number
          day: string
          id: string
          jobs_error_count: number
          models_trained: number
          organization_id: string | null
          predictions_run: number
          projects_created: number
          segments_exported: number
          updated_at: string
        }
        Insert: {
          active_users_1d?: number
          active_users_30d?: number
          active_users_7d?: number
          avg_eda_ms?: number | null
          avg_import_ms?: number | null
          avg_predict_ms?: number | null
          avg_train_ms?: number | null
          created_at?: string
          datasets_connected?: number
          day: string
          id?: string
          jobs_error_count?: number
          models_trained?: number
          organization_id?: string | null
          predictions_run?: number
          projects_created?: number
          segments_exported?: number
          updated_at?: string
        }
        Update: {
          active_users_1d?: number
          active_users_30d?: number
          active_users_7d?: number
          avg_eda_ms?: number | null
          avg_import_ms?: number | null
          avg_predict_ms?: number | null
          avg_train_ms?: number | null
          created_at?: string
          datasets_connected?: number
          day?: string
          id?: string
          jobs_error_count?: number
          models_trained?: number
          organization_id?: string | null
          predictions_run?: number
          projects_created?: number
          segments_exported?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_metrics_daily_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      predictions: {
        Row: {
          age_group: string | null
          average_ticket: number | null
          batch_id: string | null
          campaign: string | null
          channel: string | null
          city: string | null
          cohort: string | null
          created_at: string
          entity_id: string
          entity_type: string | null
          horizon_days: number | null
          id: string
          is_latest: boolean | null
          lifetime_value: number | null
          metadata: Json | null
          potential_value: number | null
          predicted_class: string | null
          predicted_value: number | null
          prediction_date: string
          probability_event: number | null
          problem_context: string | null
          problem_type: string
          product_category: string | null
          project_id: string
          reference_date: string
          region: string | null
          segment: string | null
          state: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          age_group?: string | null
          average_ticket?: number | null
          batch_id?: string | null
          campaign?: string | null
          channel?: string | null
          city?: string | null
          cohort?: string | null
          created_at?: string
          entity_id: string
          entity_type?: string | null
          horizon_days?: number | null
          id?: string
          is_latest?: boolean | null
          lifetime_value?: number | null
          metadata?: Json | null
          potential_value?: number | null
          predicted_class?: string | null
          predicted_value?: number | null
          prediction_date?: string
          probability_event?: number | null
          problem_context?: string | null
          problem_type?: string
          product_category?: string | null
          project_id: string
          reference_date?: string
          region?: string | null
          segment?: string | null
          state?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          age_group?: string | null
          average_ticket?: number | null
          batch_id?: string | null
          campaign?: string | null
          channel?: string | null
          city?: string | null
          cohort?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string | null
          horizon_days?: number | null
          id?: string
          is_latest?: boolean | null
          lifetime_value?: number | null
          metadata?: Json | null
          potential_value?: number | null
          predicted_class?: string | null
          predicted_value?: number | null
          prediction_date?: string
          probability_event?: number | null
          problem_context?: string | null
          problem_type?: string
          product_category?: string | null
          project_id?: string
          reference_date?: string
          region?: string | null
          segment?: string | null
          state?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "predictions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string
          id: string
          onboarding_done: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id: string
          onboarding_done?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          onboarding_done?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      project_actions: {
        Row: {
          action_name: string
          action_type: string
          created_at: string
          end_date: string | null
          expected_conversion_percent: number | null
          id: string
          notes: string | null
          observed_conversion_percent: number | null
          project_id: string
          segment_used: string | null
          start_date: string
          status: string
          success_metric: string | null
          target_customers: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          action_name: string
          action_type: string
          created_at?: string
          end_date?: string | null
          expected_conversion_percent?: number | null
          id?: string
          notes?: string | null
          observed_conversion_percent?: number | null
          project_id: string
          segment_used?: string | null
          start_date: string
          status?: string
          success_metric?: string | null
          target_customers?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          action_name?: string
          action_type?: string
          created_at?: string
          end_date?: string | null
          expected_conversion_percent?: number | null
          id?: string
          notes?: string | null
          observed_conversion_percent?: number | null
          project_id?: string
          segment_used?: string | null
          start_date?: string
          status?: string
          success_metric?: string | null
          target_customers?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_actions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_ai_context: {
        Row: {
          context: Json
          created_at: string | null
          id: string
          last_updated_at: string | null
          organization_id: string
          project_id: string
          status: string
        }
        Insert: {
          context?: Json
          created_at?: string | null
          id?: string
          last_updated_at?: string | null
          organization_id: string
          project_id: string
          status?: string
        }
        Update: {
          context?: Json
          created_at?: string | null
          id?: string
          last_updated_at?: string | null
          organization_id?: string
          project_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_ai_context_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_ai_context_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_ai_memory: {
        Row: {
          eda_snapshot_id: string | null
          id: string
          memory_json: Json
          organization_id: string
          project_id: string
          updated_at: string
        }
        Insert: {
          eda_snapshot_id?: string | null
          id?: string
          memory_json?: Json
          organization_id: string
          project_id: string
          updated_at?: string
        }
        Update: {
          eda_snapshot_id?: string | null
          id?: string
          memory_json?: Json
          organization_id?: string
          project_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_ai_memory_eda_snapshot_id_fkey"
            columns: ["eda_snapshot_id"]
            isOneToOne: false
            referencedRelation: "project_eda_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_ai_memory_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_ai_memory_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_business_config: {
        Row: {
          average_margin_percent: number | null
          average_sale_value: number | null
          baseline_conversion_percent: number | null
          cost_per_contact: number | null
          created_at: string
          id: string
          impact_window_days: number | null
          project_id: string
          updated_at: string
        }
        Insert: {
          average_margin_percent?: number | null
          average_sale_value?: number | null
          baseline_conversion_percent?: number | null
          cost_per_contact?: number | null
          created_at?: string
          id?: string
          impact_window_days?: number | null
          project_id: string
          updated_at?: string
        }
        Update: {
          average_margin_percent?: number | null
          average_sale_value?: number | null
          baseline_conversion_percent?: number | null
          cost_per_contact?: number | null
          created_at?: string
          id?: string
          impact_window_days?: number | null
          project_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_business_config_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_categorical_stats: {
        Row: {
          column_name: string
          created_at: string
          distinct_count: number | null
          id: string
          project_id: string
          top_categories: Json | null
        }
        Insert: {
          column_name: string
          created_at?: string
          distinct_count?: number | null
          id?: string
          project_id: string
          top_categories?: Json | null
        }
        Update: {
          column_name?: string
          created_at?: string
          distinct_count?: number | null
          id?: string
          project_id?: string
          top_categories?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "project_categorical_stats_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_chat_messages: {
        Row: {
          created_at: string
          id: string
          message_text: string
          project_id: string
          sender_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_text: string
          project_id: string
          sender_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message_text?: string
          project_id?: string
          sender_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_chat_messages_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_column_inference: {
        Row: {
          block_reasons: string[]
          can_be_feature: boolean
          can_be_target: boolean
          classification_reasons: string[]
          column_name: string
          confidence_score: number
          created_at: string
          id: string
          inferred_type: string
          project_id: string
          semantic_role: string
          temporal_role: string
        }
        Insert: {
          block_reasons?: string[]
          can_be_feature?: boolean
          can_be_target?: boolean
          classification_reasons?: string[]
          column_name: string
          confidence_score?: number
          created_at?: string
          id?: string
          inferred_type?: string
          project_id: string
          semantic_role?: string
          temporal_role?: string
        }
        Update: {
          block_reasons?: string[]
          can_be_feature?: boolean
          can_be_target?: boolean
          classification_reasons?: string[]
          column_name?: string
          confidence_score?: number
          created_at?: string
          id?: string
          inferred_type?: string
          project_id?: string
          semantic_role?: string
          temporal_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_column_inference_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_columns: {
        Row: {
          column_index: number
          column_name: string
          created_at: string
          id: string
          inferred_type: string
          project_id: string
        }
        Insert: {
          column_index: number
          column_name: string
          created_at?: string
          id?: string
          inferred_type?: string
          project_id: string
        }
        Update: {
          column_index?: number
          column_name?: string
          created_at?: string
          id?: string
          inferred_type?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_columns_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_data_contract: {
        Row: {
          created_at: string
          data_source_id: string | null
          id: string
          locked: boolean
          locked_at: string | null
          locked_reason: string | null
          project_id: string
          row_count_estimate: number | null
          schema_snapshot: Json | null
          source_definition: string
          source_definition_hash: string | null
          source_mode: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          data_source_id?: string | null
          id?: string
          locked?: boolean
          locked_at?: string | null
          locked_reason?: string | null
          project_id: string
          row_count_estimate?: number | null
          schema_snapshot?: Json | null
          source_definition: string
          source_definition_hash?: string | null
          source_mode?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          data_source_id?: string | null
          id?: string
          locked?: boolean
          locked_at?: string | null
          locked_reason?: string | null
          project_id?: string
          row_count_estimate?: number | null
          schema_snapshot?: Json | null
          source_definition?: string
          source_definition_hash?: string | null
          source_mode?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_data_contract_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_data_contract_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_data_ingestion_logs: {
        Row: {
          completed_at: string | null
          data_source_id: string | null
          error_message: string | null
          id: string
          metadata: Json | null
          project_id: string
          rows_read: number | null
          rows_sampled: number | null
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          data_source_id?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          project_id: string
          rows_read?: number | null
          rows_sampled?: number | null
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          data_source_id?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          project_id?: string
          rows_read?: number | null
          rows_sampled?: number | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_data_ingestion_logs_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_data_ingestion_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_dataset_state: {
        Row: {
          active_dataset_ref: string | null
          active_schema_json: Json | null
          col_count: number
          diagnostics: Json | null
          eda_ready: boolean
          last_job_id: string | null
          last_success_at: string | null
          manifest_id: string | null
          model_ready: boolean
          organization_id: string
          project_id: string
          row_count: number
          source_type: string
          updated_at: string
          virtual_manifest: boolean
        }
        Insert: {
          active_dataset_ref?: string | null
          active_schema_json?: Json | null
          col_count?: number
          diagnostics?: Json | null
          eda_ready?: boolean
          last_job_id?: string | null
          last_success_at?: string | null
          manifest_id?: string | null
          model_ready?: boolean
          organization_id: string
          project_id: string
          row_count?: number
          source_type?: string
          updated_at?: string
          virtual_manifest?: boolean
        }
        Update: {
          active_dataset_ref?: string | null
          active_schema_json?: Json | null
          col_count?: number
          diagnostics?: Json | null
          eda_ready?: boolean
          last_job_id?: string | null
          last_success_at?: string | null
          manifest_id?: string | null
          model_ready?: boolean
          organization_id?: string
          project_id?: string
          row_count?: number
          source_type?: string
          updated_at?: string
          virtual_manifest?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "project_dataset_state_manifest_id_fkey"
            columns: ["manifest_id"]
            isOneToOne: false
            referencedRelation: "import_manifests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_dataset_state_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_dataset_state_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_datasets: {
        Row: {
          columns_count: number | null
          created_at: string
          file_size_bytes: number | null
          id: string
          is_active: boolean
          name: string
          project_id: string
          sample_rows: number | null
          source_metadata: Json | null
          source_type: string
          storage_path: string
          total_rows: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          columns_count?: number | null
          created_at?: string
          file_size_bytes?: number | null
          id?: string
          is_active?: boolean
          name: string
          project_id: string
          sample_rows?: number | null
          source_metadata?: Json | null
          source_type?: string
          storage_path: string
          total_rows?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          columns_count?: number | null
          created_at?: string
          file_size_bytes?: number | null
          id?: string
          is_active?: boolean
          name?: string
          project_id?: string
          sample_rows?: number | null
          source_metadata?: Json | null
          source_type?: string
          storage_path?: string
          total_rows?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_datasets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_eda_insights: {
        Row: {
          created_at: string
          id: string
          insights: Json
          language: string
          project_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          insights?: Json
          language?: string
          project_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          insights?: Json
          language?: string
          project_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_eda_insights_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_eda_snapshots: {
        Row: {
          created_at: string
          eda_json: Json
          id: string
          org_id: string | null
          project_id: string
        }
        Insert: {
          created_at?: string
          eda_json: Json
          id?: string
          org_id?: string | null
          project_id: string
        }
        Update: {
          created_at?: string
          eda_json?: Json
          id?: string
          org_id?: string | null
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_eda_snapshots_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_eda_snapshots_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_feature_importances: {
        Row: {
          created_at: string
          feature_name: string
          id: string
          importance_value: number
          project_model_id: string
        }
        Insert: {
          created_at?: string
          feature_name: string
          id?: string
          importance_value: number
          project_model_id: string
        }
        Update: {
          created_at?: string
          feature_name?: string
          id?: string
          importance_value?: number
          project_model_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_feature_importances_project_model_id_fkey"
            columns: ["project_model_id"]
            isOneToOne: false
            referencedRelation: "project_models"
            referencedColumns: ["id"]
          },
        ]
      }
      project_features: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          expression: Json
          id: string
          label: string
          name: string
          project_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          expression?: Json
          id?: string
          label: string
          name: string
          project_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          expression?: Json
          id?: string
          label?: string
          name?: string
          project_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_features_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_model_insights: {
        Row: {
          created_at: string
          id: string
          insight_type: string
          insights: Json
          language: string
          model_id: string | null
          project_id: string
          recommendation_text: string | null
          shap_insights: Json | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          insight_type?: string
          insights?: Json
          language?: string
          model_id?: string | null
          project_id: string
          recommendation_text?: string | null
          shap_insights?: Json | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          insight_type?: string
          insights?: Json
          language?: string
          model_id?: string | null
          project_id?: string
          recommendation_text?: string | null
          shap_insights?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_model_insights_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "project_models"
            referencedColumns: ["id"]
          },
        ]
      }
      project_model_metrics: {
        Row: {
          created_at: string
          id: string
          metric_name: string
          metric_value: number
          project_model_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          metric_name: string
          metric_value: number
          project_model_id: string
        }
        Update: {
          created_at?: string
          id?: string
          metric_name?: string
          metric_value?: number
          project_model_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_model_metrics_project_model_id_fkey"
            columns: ["project_model_id"]
            isOneToOne: false
            referencedRelation: "project_models"
            referencedColumns: ["id"]
          },
        ]
      }
      project_modeling_contracts: {
        Row: {
          anchor_time_col: string | null
          blocked_reasons: Json | null
          column_roles: Json
          contract_version: string
          created_at: string
          dashboard_gold_schema: Json
          dataset_id: string | null
          entity_key: Json | null
          features_blocked: Json
          features_final: Json
          full_contract: Json
          id: string
          justification: string[] | null
          leakage_flags: Json
          organization_id: string
          project_id: string
          split_strategy: string
          status: string
          target_definition: Json
          updated_at: string
        }
        Insert: {
          anchor_time_col?: string | null
          blocked_reasons?: Json | null
          column_roles?: Json
          contract_version?: string
          created_at?: string
          dashboard_gold_schema?: Json
          dataset_id?: string | null
          entity_key?: Json | null
          features_blocked?: Json
          features_final?: Json
          full_contract: Json
          id?: string
          justification?: string[] | null
          leakage_flags?: Json
          organization_id: string
          project_id: string
          split_strategy?: string
          status?: string
          target_definition: Json
          updated_at?: string
        }
        Update: {
          anchor_time_col?: string | null
          blocked_reasons?: Json | null
          column_roles?: Json
          contract_version?: string
          created_at?: string
          dashboard_gold_schema?: Json
          dataset_id?: string | null
          entity_key?: Json | null
          features_blocked?: Json
          features_final?: Json
          full_contract?: Json
          id?: string
          justification?: string[] | null
          leakage_flags?: Json
          organization_id?: string
          project_id?: string
          split_strategy?: string
          status?: string
          target_definition?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_modeling_contracts_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "project_datasets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_modeling_contracts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_modeling_contracts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_modeling_datasets: {
        Row: {
          anchor_time_col: string | null
          blocked_reasons: Json | null
          build_log: Json | null
          column_count: number | null
          coverage_pct: number | null
          created_at: string
          dataset_id: string | null
          entity_key: string | null
          error_message: string | null
          features_blocked: Json | null
          features_final: Json
          features_generated: Json | null
          id: string
          intent_version: string | null
          label_plan: Json | null
          leakage_report: Json | null
          manifest_version: string | null
          organization_id: string
          project_id: string
          row_count: number | null
          split_strategy: string | null
          status: string
          target_column: string
          target_source: string
          target_type: string
          updated_at: string
          window_days: number | null
        }
        Insert: {
          anchor_time_col?: string | null
          blocked_reasons?: Json | null
          build_log?: Json | null
          column_count?: number | null
          coverage_pct?: number | null
          created_at?: string
          dataset_id?: string | null
          entity_key?: string | null
          error_message?: string | null
          features_blocked?: Json | null
          features_final?: Json
          features_generated?: Json | null
          id?: string
          intent_version?: string | null
          label_plan?: Json | null
          leakage_report?: Json | null
          manifest_version?: string | null
          organization_id: string
          project_id: string
          row_count?: number | null
          split_strategy?: string | null
          status?: string
          target_column: string
          target_source?: string
          target_type?: string
          updated_at?: string
          window_days?: number | null
        }
        Update: {
          anchor_time_col?: string | null
          blocked_reasons?: Json | null
          build_log?: Json | null
          column_count?: number | null
          coverage_pct?: number | null
          created_at?: string
          dataset_id?: string | null
          entity_key?: string | null
          error_message?: string | null
          features_blocked?: Json | null
          features_final?: Json
          features_generated?: Json | null
          id?: string
          intent_version?: string | null
          label_plan?: Json | null
          leakage_report?: Json | null
          manifest_version?: string | null
          organization_id?: string
          project_id?: string
          row_count?: number | null
          split_strategy?: string | null
          status?: string
          target_column?: string
          target_source?: string
          target_type?: string
          updated_at?: string
          window_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "project_modeling_datasets_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "project_datasets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_modeling_datasets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_modeling_datasets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_models: {
        Row: {
          algorithm_name: string
          created_at: string
          hyperparameters: Json | null
          id: string
          is_production: boolean
          model_location: string | null
          problem_type: string
          project_id: string
          status: string
          trained_at: string | null
        }
        Insert: {
          algorithm_name: string
          created_at?: string
          hyperparameters?: Json | null
          id?: string
          is_production?: boolean
          model_location?: string | null
          problem_type: string
          project_id: string
          status?: string
          trained_at?: string | null
        }
        Update: {
          algorithm_name?: string
          created_at?: string
          hyperparameters?: Json | null
          id?: string
          is_production?: boolean
          model_location?: string | null
          problem_type?: string
          project_id?: string
          status?: string
          trained_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_models_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_numeric_stats: {
        Row: {
          column_name: string
          created_at: string
          id: string
          max_value: number | null
          mean_value: number | null
          median_value: number | null
          min_value: number | null
          null_count: number | null
          project_id: string
          std_value: number | null
        }
        Insert: {
          column_name: string
          created_at?: string
          id?: string
          max_value?: number | null
          mean_value?: number | null
          median_value?: number | null
          min_value?: number | null
          null_count?: number | null
          project_id: string
          std_value?: number | null
        }
        Update: {
          column_name?: string
          created_at?: string
          id?: string
          max_value?: number | null
          mean_value?: number | null
          median_value?: number | null
          min_value?: number | null
          null_count?: number | null
          project_id?: string
          std_value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "project_numeric_stats_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_prediction_schedules: {
        Row: {
          created_at: string
          cron_expression: string | null
          day_of_month: number | null
          day_of_week: number | null
          enabled: boolean
          frequency: Database["public"]["Enums"]["schedule_frequency"]
          id: string
          last_run_at: string | null
          last_run_message: string | null
          last_run_status: string | null
          model_id: string | null
          next_run_at: string
          project_id: string
          run_predictions: boolean
          run_retraining: boolean
          send_email_to: string
          start_at: string
          time_of_day: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          cron_expression?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          frequency?: Database["public"]["Enums"]["schedule_frequency"]
          id?: string
          last_run_at?: string | null
          last_run_message?: string | null
          last_run_status?: string | null
          model_id?: string | null
          next_run_at?: string
          project_id: string
          run_predictions?: boolean
          run_retraining?: boolean
          send_email_to: string
          start_at?: string
          time_of_day?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          cron_expression?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          frequency?: Database["public"]["Enums"]["schedule_frequency"]
          id?: string
          last_run_at?: string | null
          last_run_message?: string | null
          last_run_status?: string | null
          model_id?: string | null
          next_run_at?: string
          project_id?: string
          run_predictions?: boolean
          run_retraining?: boolean
          send_email_to?: string
          start_at?: string
          time_of_day?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_prediction_schedules_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "project_models"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_prediction_schedules_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_problem_inference: {
        Row: {
          confidence: number
          created_at: string
          dataset_id: string | null
          id: string
          inference_version: string
          narrative: string
          organization_id: string
          problem_type: string
          project_id: string
          suggested_predictors: Json
          suggested_problem_labels: Json
          suggested_targets: Json
          updated_at: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          dataset_id?: string | null
          id?: string
          inference_version?: string
          narrative?: string
          organization_id: string
          problem_type?: string
          project_id: string
          suggested_predictors?: Json
          suggested_problem_labels?: Json
          suggested_targets?: Json
          updated_at?: string
        }
        Update: {
          confidence?: number
          created_at?: string
          dataset_id?: string | null
          id?: string
          inference_version?: string
          narrative?: string
          organization_id?: string
          problem_type?: string
          project_id?: string
          suggested_predictors?: Json
          suggested_problem_labels?: Json
          suggested_targets?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_problem_inference_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "project_datasets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_problem_inference_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_problem_inference_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_settings: {
        Row: {
          excluded_columns: Json | null
          feature_columns: Json | null
          org_id: string | null
          problem_type: string | null
          project_id: string
          target_column: string | null
          target_suggestion_meta: Json | null
          updated_at: string
        }
        Insert: {
          excluded_columns?: Json | null
          feature_columns?: Json | null
          org_id?: string | null
          problem_type?: string | null
          project_id: string
          target_column?: string | null
          target_suggestion_meta?: Json | null
          updated_at?: string
        }
        Update: {
          excluded_columns?: Json | null
          feature_columns?: Json | null
          org_id?: string | null
          problem_type?: string | null
          project_id?: string
          target_column?: string | null
          target_suggestion_meta?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_settings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          business_objective: string | null
          created_at: string
          data_source_id: string | null
          dataset_blocked_reason: string | null
          dataset_columns: number | null
          dataset_filename: string | null
          dataset_ready_for_modeling: boolean | null
          dataset_rows: number | null
          description: string | null
          detected_problem_type: string | null
          id: string
          name: string
          organization_id: string | null
          problem_type: string
          sample_rows: number | null
          status: string
          target_column: string | null
          total_rows: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          business_objective?: string | null
          created_at?: string
          data_source_id?: string | null
          dataset_blocked_reason?: string | null
          dataset_columns?: number | null
          dataset_filename?: string | null
          dataset_ready_for_modeling?: boolean | null
          dataset_rows?: number | null
          description?: string | null
          detected_problem_type?: string | null
          id?: string
          name: string
          organization_id?: string | null
          problem_type: string
          sample_rows?: number | null
          status?: string
          target_column?: string | null
          total_rows?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          business_objective?: string | null
          created_at?: string
          data_source_id?: string | null
          dataset_blocked_reason?: string | null
          dataset_columns?: number | null
          dataset_filename?: string | null
          dataset_ready_for_modeling?: boolean | null
          dataset_rows?: number | null
          description?: string | null
          detected_problem_type?: string | null
          id?: string
          name?: string
          organization_id?: string | null
          problem_type?: string
          sample_rows?: number | null
          status?: string
          target_column?: string | null
          total_rows?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      calculate_dashboard_kpis: {
        Args: { p_horizon?: number; p_project_id: string }
        Returns: Json
      }
      calculate_time_to_value: {
        Args: {
          p_date_from?: string
          p_date_to?: string
          p_organization_id?: string
        }
        Returns: {
          avg_dataset_to_training_hours: number
          avg_prediction_to_export_hours: number
          avg_project_to_dataset_hours: number
          avg_total_time_to_value_hours: number
          avg_training_to_prediction_hours: number
          organization_id: string
          organization_name: string
          projects_with_dataset_pct: number
          projects_with_export_pct: number
          projects_with_prediction_pct: number
          projects_with_training_pct: number
          total_projects: number
        }[]
      }
      delete_project_cascade: { Args: { p_project_id: string }; Returns: Json }
      get_user_organizations: { Args: { _user_id: string }; Returns: string[] }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_org_admin_for_org: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      user_belongs_to_org: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      user_has_active_org: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "super_admin" | "org_admin" | "analyst" | "viewer"
      org_plan: "trial" | "standard" | "enterprise"
      schedule_frequency:
        | "daily"
        | "weekly"
        | "biweekly"
        | "monthly"
        | "quarterly"
        | "semiannual"
        | "yearly"
        | "specific_date"
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
    Enums: {
      app_role: ["super_admin", "org_admin", "analyst", "viewer"],
      org_plan: ["trial", "standard", "enterprise"],
      schedule_frequency: [
        "daily",
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "semiannual",
        "yearly",
        "specific_date",
      ],
    },
  },
} as const
