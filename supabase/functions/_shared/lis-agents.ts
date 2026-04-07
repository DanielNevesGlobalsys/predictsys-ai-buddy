/**
 * LIS AI OS — Agent definitions, prompts, validation
 * Shared between edge functions
 */

// ─── Agent System Prompts ───

export const AGENT_SYSTEM_PROMPTS: Record<string, string> = {
  governance_agent: `Você é o Agente de Governança da plataforma PredictSys.
Seu papel é garantir conformidade, qualidade e segurança em cada etapa do pipeline de ML.

Responsabilidades:
- Validar se dados sensíveis (PII) estão protegidos
- Verificar conformidade com LGPD
- Avaliar políticas de retenção de dados
- Detectar vazamento de dados entre treino e scoring
- Verificar se o target é adequado (não discriminatório)
- Auditar configurações de split e leakage

Responda SEMPRE em JSON estruturado conforme o schema fornecido.
Seja objetivo, técnico e assertivo. Nunca invente dados.`,

  data_scientist_agent: `Você é o Agente Cientista de Dados da plataforma PredictSys.
Seu papel é analisar dados, sugerir targets, features e estratégias de modelagem.

Responsabilidades:
- Analisar perfil estatístico dos dados (EDA)
- Sugerir variáveis alvo com base no contexto de negócio
- Recomendar features relevantes e excluir features problemáticas
- Identificar leakage potencial
- Avaliar qualidade do dataset para modelagem
- Sugerir tipo de problema (classificação vs regressão)
- Avaliar correlações e colinearidade

Responda SEMPRE em JSON estruturado conforme o schema fornecido.
Base suas recomendações nos dados reais fornecidos no contexto.`,

  data_engineer_agent: `Você é o Agente Engenheiro de Dados da plataforma PredictSys.
Seu papel é garantir a integridade, qualidade e estrutura do pipeline de dados.

Responsabilidades:
- Avaliar qualidade do schema (tipos, nulos, cardinalidade)
- Detectar problemas de grain (granularidade dos dados)
- Validar integridade referencial entre entity, time e target
- Avaliar estratégia temporal (time column, split)
- Verificar qualidade do builder e dataset de modelagem
- Detectar dados duplicados ou inconsistentes

Responda SEMPRE em JSON estruturado conforme o schema fornecido.
Seja preciso e técnico. Indique ações corretivas claras.`,

  ml_engineer_agent: `Você é o Agente Engenheiro de ML da plataforma PredictSys.
Seu papel é configurar, validar e otimizar o pipeline de treino e deploy de modelos.

Responsabilidades:
- Validar configuração de treino (features, target, split)
- Avaliar métricas do modelo treinado
- Detectar overfitting ou underfitting
- Recomendar ajustes de hiperparâmetros
- Validar compatibilidade entre treino e scoring
- Avaliar deploy readiness
- Verificar feature importance e interpretabilidade

Responda SEMPRE em JSON estruturado conforme o schema fornecido.
Use métricas quantitativas. Nunca aprove um modelo sem evidências.`,

  business_analyst_agent: `Você é o Agente Analista de Negócios da plataforma PredictSys.
Seu papel é traduzir resultados técnicos em insights de negócio acionáveis.

Responsabilidades:
- Interpretar métricas do modelo em linguagem de negócio
- Calcular impacto financeiro (ROI, receita em risco, LTV)
- Identificar segmentos prioritários para ação
- Recomendar campanhas e ações baseadas nas previsões
- Criar narrativa executiva dos resultados
- Avaliar riscos e oportunidades de negócio

Responda SEMPRE em JSON estruturado conforme o schema fornecido.
Foque em valor de negócio. Use linguagem acessível para executivos.`,
};

// ─── Stage-to-Agent Routing ───

export const STAGE_AGENT_MAP: Record<string, string[]> = {
  ingestion: ["data_engineer_agent", "governance_agent"],
  eda: ["data_scientist_agent", "data_engineer_agent"],
  targeting: ["data_scientist_agent", "governance_agent"],
  features: ["data_scientist_agent", "ml_engineer_agent"],
  builder: ["data_engineer_agent", "ml_engineer_agent"],
  training: ["ml_engineer_agent", "data_scientist_agent"],
  scoring: ["ml_engineer_agent", "governance_agent"],
  dashboard: ["business_analyst_agent"],
  governance: ["governance_agent"],
  general: ["business_analyst_agent", "data_scientist_agent"],
};

// ─── Output schema for tool calling ───

export const AGENT_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "agent_decision",
    description: "Structured agent decision output",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["success", "warning", "blocked", "failed"],
          description: "Overall status of the agent analysis",
        },
        confidence: {
          type: "number",
          description: "Confidence level 0.0 to 1.0",
        },
        decision: {
          type: "object",
          description: "Key decisions made by the agent",
          additionalProperties: true,
        },
        reasoning_summary: {
          type: "array",
          items: { type: "string" },
          description: "Step-by-step reasoning",
        },
        warnings: {
          type: "array",
          items: { type: "string" },
          description: "Non-blocking warnings",
        },
        blocking_issues: {
          type: "array",
          items: { type: "string" },
          description: "Issues that block pipeline progression",
        },
        actions_recommended: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              target: { type: "string" },
              priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
              auto_applicable: { type: "boolean" },
            },
            required: ["action", "target", "priority", "auto_applicable"],
          },
          description: "Recommended next actions",
        },
      },
      required: ["status", "confidence", "decision", "reasoning_summary", "warnings", "blocking_issues", "actions_recommended"],
      additionalProperties: false,
    },
  },
};

// ─── Response Validation ───

export interface ValidatedAgentResponse {
  status: string;
  confidence: number;
  decision: Record<string, unknown>;
  reasoning_summary: string[];
  warnings: string[];
  blocking_issues: string[];
  actions_recommended: Array<{
    action: string;
    target: string;
    priority: string;
    auto_applicable: boolean;
  }>;
}

export function validateAgentResponse(raw: unknown): ValidatedAgentResponse {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") {
    return fallbackResponse("Invalid response object");
  }

  const validStatuses = ["success", "warning", "blocked", "failed"];
  const status = validStatuses.includes(r.status as string)
    ? (r.status as string)
    : "failed";

  const confidence = typeof r.confidence === "number"
    ? Math.max(0, Math.min(1, r.confidence))
    : 0;

  return {
    status,
    confidence,
    decision: (typeof r.decision === "object" && r.decision !== null ? r.decision : {}) as Record<string, unknown>,
    reasoning_summary: asStringArray(r.reasoning_summary),
    warnings: asStringArray(r.warnings),
    blocking_issues: asStringArray(r.blocking_issues),
    actions_recommended: asActionArray(r.actions_recommended),
  };
}

function fallbackResponse(reason: string): ValidatedAgentResponse {
  return {
    status: "failed",
    confidence: 0,
    decision: { error: reason },
    reasoning_summary: [reason],
    warnings: [],
    blocking_issues: [reason],
    actions_recommended: [],
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}

function asActionArray(v: unknown): ValidatedAgentResponse["actions_recommended"] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && x.action && x.target)
    .map((x: any) => ({
      action: String(x.action),
      target: String(x.target),
      priority: ["critical", "high", "medium", "low"].includes(x.priority) ? x.priority : "medium",
      auto_applicable: Boolean(x.auto_applicable),
    }));
}

// ─── Context Builder ───

export function buildAgentPrompt(
  agentName: string,
  stage: string,
  projectContext: Record<string, unknown>,
  inputContract: Record<string, unknown>,
): string {
  return `## Contexto do Projeto
\`\`\`json
${JSON.stringify(projectContext, null, 2)}
\`\`\`

## Etapa Atual: ${stage}

## Dados de Entrada
\`\`\`json
${JSON.stringify(inputContract, null, 2)}
\`\`\`

Analise o contexto acima e produza sua decisão estruturada usando a função agent_decision.`;
}

// ─── Input Hash (simple deterministic hash) ───

export async function computeInputHash(input: Record<string, unknown>): Promise<string> {
  const text = JSON.stringify(input);
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

// ─── Select Primary Agent for Stage ───

export function selectAgent(stage: string, preferredAgent?: string): string {
  if (preferredAgent && AGENT_SYSTEM_PROMPTS[preferredAgent]) {
    return preferredAgent;
  }
  const agents = STAGE_AGENT_MAP[stage];
  if (!agents || agents.length === 0) return "data_scientist_agent";
  return agents[0];
}
