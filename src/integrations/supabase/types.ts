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
      profiles: {
        Row: {
          created_at: string
          full_name: string
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
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
      projects: {
        Row: {
          business_objective: string | null
          created_at: string
          dataset_columns: number | null
          dataset_filename: string | null
          dataset_rows: number | null
          description: string | null
          detected_problem_type: string | null
          id: string
          name: string
          problem_type: string
          status: string
          target_column: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          business_objective?: string | null
          created_at?: string
          dataset_columns?: number | null
          dataset_filename?: string | null
          dataset_rows?: number | null
          description?: string | null
          detected_problem_type?: string | null
          id?: string
          name: string
          problem_type: string
          status?: string
          target_column?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          business_objective?: string | null
          created_at?: string
          dataset_columns?: number | null
          dataset_filename?: string | null
          dataset_rows?: number | null
          description?: string | null
          detected_problem_type?: string | null
          id?: string
          name?: string
          problem_type?: string
          status?: string
          target_column?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
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
