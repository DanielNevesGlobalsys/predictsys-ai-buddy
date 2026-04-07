/**
 * LIS AI OS — Agent contract types (frontend + shared)
 */

// ─── Agent Names ───
export const LIS_AGENT_NAMES = [
  "governance_agent",
  "data_scientist_agent",
  "data_engineer_agent",
  "ml_engineer_agent",
  "business_analyst_agent",
] as const;

export type LisAgentName = (typeof LIS_AGENT_NAMES)[number];

// ─── Pipeline Stages ───
export const LIS_STAGES = [
  "ingestion", "eda", "targeting", "features",
  "builder", "training", "scoring", "dashboard",
  "governance", "general",
] as const;

export type LisStage = (typeof LIS_STAGES)[number];

// ─── Execution Modes ───
export type LisExecutionMode = "auto" | "assisted" | "shadow";

// ─── Request Contract ───
export interface LisAgentRequest {
  agent_name: LisAgentName;
  stage: LisStage;
  project_id: string;
  organization_id: string;
  context_version: string;
  project_context: Record<string, unknown>;
  input_contract: Record<string, unknown>;
  expected_output_schema?: Record<string, unknown>;
  execution_mode: LisExecutionMode;
}

// ─── Response Contract ───
export interface LisAgentResponse {
  agent_name: LisAgentName;
  stage: LisStage;
  status: "success" | "warning" | "blocked" | "failed";
  confidence: number;
  decision: Record<string, unknown>;
  reasoning_summary: string[];
  warnings: string[];
  blocking_issues: string[];
  actions_recommended: LisAction[];
  audit_metadata: {
    input_hash: string;
    context_version: string;
    executed_at: string;
    model_used: string;
    duration_ms: number;
  };
}

export interface LisAction {
  action: string;
  target: string;
  priority: "critical" | "high" | "medium" | "low";
  auto_applicable: boolean;
}

// ─── Persisted Execution Record ───
export interface LisAgentExecution {
  id: string;
  project_id: string;
  organization_id: string;
  agent_name: LisAgentName;
  stage: LisStage;
  execution_mode: LisExecutionMode;
  status: string;
  confidence: number | null;
  context_version: string | null;
  decision: Record<string, unknown>;
  reasoning_summary: string[];
  warnings: string[];
  blocking_issues: string[];
  actions_recommended: LisAction[];
  model_used: string | null;
  duration_ms: number | null;
  triggered_by: string;
  created_at: string;
  finished_at: string | null;
}

// ─── Agent Capability Metadata (for UI) ───
export interface LisAgentMeta {
  name: LisAgentName;
  label: string;
  description: string;
  icon: string;
  stages: LisStage[];
  color: string;
}

export const LIS_AGENTS_META: LisAgentMeta[] = [
  {
    name: "governance_agent",
    label: "Governança",
    description: "Valida conformidade, LGPD, políticas de dados e controle de acesso.",
    icon: "Shield",
    stages: ["ingestion", "targeting", "training", "scoring", "governance"],
    color: "hsl(var(--primary))",
  },
  {
    name: "data_scientist_agent",
    label: "Cientista de Dados",
    description: "Analisa dados, sugere targets, features e estratégias de modelagem.",
    icon: "FlaskConical",
    stages: ["eda", "targeting", "features", "training"],
    color: "hsl(220, 80%, 60%)",
  },
  {
    name: "data_engineer_agent",
    label: "Engenheiro de Dados",
    description: "Avalia qualidade dos dados, schema, grain e integridade do pipeline.",
    icon: "Database",
    stages: ["ingestion", "eda", "builder"],
    color: "hsl(150, 60%, 45%)",
  },
  {
    name: "ml_engineer_agent",
    label: "Engenheiro de ML",
    description: "Configura treino, valida modelos, otimiza hiperparâmetros e deploy.",
    icon: "Cpu",
    stages: ["builder", "training", "scoring"],
    color: "hsl(280, 65%, 55%)",
  },
  {
    name: "business_analyst_agent",
    label: "Analista de Negócios",
    description: "Traduz resultados em insights, ROI e recomendações acionáveis.",
    icon: "TrendingUp",
    stages: ["scoring", "dashboard", "general"],
    color: "hsl(35, 90%, 55%)",
  },
];
