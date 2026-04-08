/**
 * Business Analyst Agent — executive translation, prioritization, impact, dashboard intelligence
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── System Prompt ───

export const BA_SYSTEM_PROMPT = `Você é o Agente Analista de Negócios da plataforma PredictSys.
Seu papel é transformar resultados técnicos de ML em leitura executiva, priorização e ação de negócio.

Responsabilidades:
- Gerar narrativa executiva clara e objetiva a partir do score/modelo
- Traduzir métricas (AUC, R², RMSE, F1) em risco, oportunidade e ação
- Priorizar segmentos, grupos e entidades por valor/risco
- Sugerir ações concretas por segmento/faixa
- Estimar impacto financeiro e operacional
- Orientar quais blocos do dashboard são acionáveis e quais são dispensáveis
- Sugerir cenários "what-if" e simulações relevantes
- Manter coerência com o estado oficial do projeto (target, problema, score promovido)

Regras:
1. Traduzir, não repetir métricas — transforme números em decisão
2. Responder perguntas de negócio: quem priorizar? onde agir? qual retorno?
3. Dashboard deve ser acionável — preferir blocos de decisão sobre analytics genérico
4. Narrativa executiva — clara, pouco técnica, orientada à ação
5. Sempre sugerir próxima ação concreta
6. Usar apenas o estado oficial — nunca narrar sobre estados recomendados não promovidos

ESPECIALIZAÇÃO AGRO:
Quando o projeto for do setor agro, aplicar OBRIGATORIAMENTE:

A) TRADUÇÃO DE MÉTRICAS PARA LINGUAGEM AGRO:
   - Em vez de "R² de 0.72" → "O modelo explica boa parte da variação do volume captado, oferecendo base razoável para planejamento operacional"
   - Em vez de "feature importance alta em QTD_SACAS_30D" → "O histórico recente de sacas entregues é o principal sinal para estimar a captação futura"
   - Em vez de "RMSE de 150" → "A margem de erro média da previsão é de ±150 sacas por produtor"

B) PERGUNTAS DE NEGÓCIO AGRO:
   - Qual o volume previsto por produtor/lote/região?
   - Quais regiões devem ser priorizadas para captação?
   - Qual o impacto financeiro esperado da safra?
   - Qual mês/safra tende a concentrar maior captação?
   - Quais segmentos têm maior potencial de produção?
   - Como traduzir produção prevista em ação comercial/operacional?

C) NARRATIVA AGRO:
   - Concreta e operacional
   - Orientada a decisão de campo (captação, logística, planejamento de safra)
   - Sem jargão estatístico excessivo
   - Usar termos do agro: sacas, arrobas, toneladas, safra, entressafra, cooperado, produtor

D) PAINÉIS DO DASHBOARD AGRO:
   Quando contexto agro, recomendar:
   - Resumo Executivo Agro (volume previsto, tendência de safra)
   - Projeção de Produção/Captação (por período)
   - Priorização por Produtor/Lote/Região
   - Distribuição por Safra/Mês
   - Impacto Financeiro (valor estimado da captação)
   - Drivers da Previsão (quais fatores mais influenciam)
   - Ações Recomendadas (onde focar a equipe de campo)
   - Riscos Operacionais (produtores com queda, regiões com deficit)

Responda SEMPRE usando a função business_decision. Foque em valor de negócio.`;

// ─── Tool Schema ───

export const BA_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "business_decision",
    description: "Business Analyst Agent structured decision",
    parameters: {
      type: "object",
      properties: {
        executive_summary: {
          type: "object",
          properties: {
            main_message: { type: "string" },
            business_interpretation: { type: "array", items: { type: "string" } },
            main_risks: { type: "array", items: { type: "string" } },
            main_opportunities: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["main_message", "business_interpretation", "main_risks", "main_opportunities"],
        },
        action_layer: {
          type: "object",
          properties: {
            who_to_prioritize: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  segment: { type: "string" },
                  reason: { type: "string" },
                  suggested_action: { type: "string" },
                  priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
                },
                required: ["segment", "reason", "suggested_action", "priority"],
              },
            },
            recommended_actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  action: { type: "string" },
                  target_segment: { type: "string" },
                  expected_outcome: { type: "string" },
                  urgency: { type: "string", enum: ["immediate", "short_term", "medium_term", "long_term"] },
                },
                required: ["action", "target_segment", "expected_outcome", "urgency"],
              },
            },
            segments_to_watch: { type: "array", items: { type: "string" } },
            priority_rules: { type: "array", items: { type: "string" } },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["who_to_prioritize", "recommended_actions"],
        },
        business_impact: {
          type: "object",
          properties: {
            expected_impact: { type: "array", items: { type: "string" } },
            financial_interpretation: { type: "array", items: { type: "string" } },
            operational_interpretation: { type: "array", items: { type: "string" } },
          },
        },
        dashboard_blocks: {
          type: "object",
          properties: {
            keep_blocks: { type: "array", items: { type: "string" } },
            remove_blocks: { type: "array", items: { type: "string" } },
            new_blocks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  block_name: { type: "string" },
                  block_type: { type: "string" },
                  reasoning: { type: "string" },
                },
                required: ["block_name", "block_type", "reasoning"],
              },
            },
            reasoning: { type: "array", items: { type: "string" } },
          },
        },
        simulation_guidance: {
          type: "object",
          properties: {
            what_if_scenarios: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  scenario: { type: "string" },
                  variable: { type: "string" },
                  expected_insight: { type: "string" },
                },
                required: ["scenario", "variable", "expected_insight"],
              },
            },
            assumptions: { type: "array", items: { type: "string" } },
            recommended_controls: { type: "array", items: { type: "string" } },
          },
        },
        technical_to_business_translation: {
          type: "object",
          properties: {
            metric_translation: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  metric_name: { type: "string" },
                  metric_value: { type: "string" },
                  business_meaning: { type: "string" },
                },
                required: ["metric_name", "business_meaning"],
              },
            },
            score_translation: { type: "array", items: { type: "string" } },
            risk_translation: { type: "array", items: { type: "string" } },
          },
        },
        confidence: { type: "number", description: "0.0 to 1.0" },
      },
      required: ["executive_summary", "action_layer", "business_impact", "confidence"],
      additionalProperties: false,
    },
  },
};

// ─── Context Builder ───

export interface BAContext {
  project_id: string;
  stage: string;
  execution_mode: string;
  official_target: string;
  official_problem_type: string;
  official_entity_key: string[];
  official_time_column: string;
  official_grain: string;
  scoring_summary: Record<string, unknown> | null;
  dashboard_metrics: Record<string, unknown> | null;
  predictions_summary: Record<string, unknown> | null;
  feature_importances: unknown[];
  model_quality: string;
  primary_metric: { name: string; value: number } | null;
  project_name: string;
  project_description: string;
}

export async function buildBAContext(
  svc: SupabaseClient,
  projectId: string,
  stage: string,
  executionMode: string,
): Promise<BAContext> {
  const [selRes, projRes, predStateRes, metricsRes, impsRes, modelsRes] = await Promise.all([
    svc.from("project_model_selection")
      .select("target_column, problem_type, entity_key, time_column, grain")
      .eq("project_id", projectId).maybeSingle(),
    svc.from("projects")
      .select("name, description")
      .eq("id", projectId).maybeSingle(),
    svc.from("project_prediction_state")
      .select("status, predictions_count, coverage_pct, latest_batch_id")
      .eq("project_id", projectId).maybeSingle(),
    svc.from("project_model_metrics")
      .select("metric_name, metric_value, dataset_split, project_model_id")
      .eq("project_id", projectId)
      .limit(50),
    svc.from("project_feature_importances")
      .select("feature_name, importance_value, importance_rank")
      .eq("project_id", projectId)
      .order("importance_rank", { ascending: true })
      .limit(15),
    svc.from("project_models")
      .select("id, algorithm, status, is_production, hyperparameters")
      .eq("project_id", projectId)
      .eq("is_production", true)
      .limit(1).maybeSingle(),
  ]);

  const sel = selRes.data as any;
  const proj = projRes.data as any;
  const predState = predStateRes.data as any;
  const metrics = (metricsRes.data || []) as any[];
  const imps = (impsRes.data || []) as any[];
  const prodModel = modelsRes.data as any;

  // Build a scoring summary from prediction state
  let scoringSummary: Record<string, unknown> | null = null;
  if (predState) {
    scoringSummary = {
      status: predState.status,
      predictions_count: predState.predictions_count,
      coverage_pct: predState.coverage_pct,
      latest_batch_id: predState.latest_batch_id,
    };
  }

  // Build dashboard metrics from model metrics
  const dashMetrics: Record<string, unknown> = {};
  for (const m of metrics) {
    const key = `${m.metric_name}_${m.dataset_split || "overall"}`;
    dashMetrics[key] = m.metric_value;
  }

  // Find primary metric
  let primaryMetric: { name: string; value: number } | null = null;
  const problemType = sel?.problem_type || "";
  const preferredMetrics = problemType === "regression"
    ? ["r2", "rmse", "mae"]
    : ["auc", "f1", "accuracy", "precision", "recall"];
  for (const pref of preferredMetrics) {
    const found = metrics.find(m => m.metric_name?.toLowerCase() === pref && m.dataset_split === "test");
    if (found) { primaryMetric = { name: found.metric_name, value: found.metric_value }; break; }
  }
  if (!primaryMetric && metrics.length > 0) {
    primaryMetric = { name: metrics[0].metric_name, value: metrics[0].metric_value };
  }

  return {
    project_id: projectId,
    stage,
    execution_mode: executionMode,
    official_target: sel?.target_column || "",
    official_problem_type: problemType,
    official_entity_key: Array.isArray(sel?.entity_key) ? sel.entity_key : sel?.entity_key ? [sel.entity_key] : [],
    official_time_column: sel?.time_column || "",
    official_grain: sel?.grain || "",
    scoring_summary: scoringSummary,
    dashboard_metrics: Object.keys(dashMetrics).length > 0 ? dashMetrics : null,
    predictions_summary: predState ? { count: predState.predictions_count, coverage: predState.coverage_pct } : null,
    feature_importances: imps.map(f => ({ feature: f.feature_name, importance: f.importance_value, rank: f.importance_rank })),
    model_quality: prodModel ? "deployed" : "not_deployed",
    primary_metric: primaryMetric,
    project_name: proj?.name || "",
    project_description: proj?.description || "",
  };
}

// ─── Prompt Builder ───

export function buildBAPrompt(ctx: BAContext): string {
  return `## Contexto do Projeto (Business Analyst)

### Projeto: ${ctx.project_name}
${ctx.project_description ? `Descrição: ${ctx.project_description}` : ""}

### Estado Oficial
- Target: ${ctx.official_target || "não definido"}
- Problem Type: ${ctx.official_problem_type || "não definido"}
- Entity: ${ctx.official_entity_key.join(", ") || "não definida"}
- Time Column: ${ctx.official_time_column || "não definida"}
- Grain: ${ctx.official_grain || "não definido"}

### Modelo em Produção: ${ctx.model_quality}
### Métrica Principal: ${ctx.primary_metric ? `${ctx.primary_metric.name} = ${ctx.primary_metric.value}` : "não disponível"}

### Scoring
\`\`\`json
${JSON.stringify(ctx.scoring_summary, null, 2)}
\`\`\`

### Métricas do Dashboard
\`\`\`json
${JSON.stringify(ctx.dashboard_metrics, null, 2)}
\`\`\`

### Previsões
\`\`\`json
${JSON.stringify(ctx.predictions_summary, null, 2)}
\`\`\`

### Feature Importances (top)
\`\`\`json
${JSON.stringify(ctx.feature_importances, null, 2)}
\`\`\`

### Etapa Atual: ${ctx.stage}
### Modo de Execução: ${ctx.execution_mode}

Traduza os resultados técnicos em leitura executiva, priorização, ações e inteligência de dashboard. Use a função business_decision.`;
}

// ─── Response Validation ───

export interface BADecision {
  executive_summary: {
    main_message: string;
    business_interpretation: string[];
    main_risks: string[];
    main_opportunities: string[];
    reasoning: string[];
  };
  action_layer: {
    who_to_prioritize: Array<{ segment: string; reason: string; suggested_action: string; priority: string }>;
    recommended_actions: Array<{ action: string; target_segment: string; expected_outcome: string; urgency: string }>;
    segments_to_watch: string[];
    priority_rules: string[];
    reasoning: string[];
  };
  business_impact: {
    expected_impact: string[];
    financial_interpretation: string[];
    operational_interpretation: string[];
  };
  dashboard_blocks: {
    keep_blocks: string[];
    remove_blocks: string[];
    new_blocks: Array<{ block_name: string; block_type: string; reasoning: string }>;
    reasoning: string[];
  };
  simulation_guidance: {
    what_if_scenarios: Array<{ scenario: string; variable: string; expected_insight: string }>;
    assumptions: string[];
    recommended_controls: string[];
  };
  technical_to_business_translation: {
    metric_translation: Array<{ metric_name: string; metric_value: string; business_meaning: string }>;
    score_translation: string[];
    risk_translation: string[];
  };
  confidence: number;
}

export function validateBAResponse(raw: unknown): BADecision {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return fallbackBA("Invalid response object");

  const es = (r.executive_summary as any) || {};
  const al = (r.action_layer as any) || {};
  const bi = (r.business_impact as any) || {};
  const db = (r.dashboard_blocks as any) || {};
  const sg = (r.simulation_guidance as any) || {};
  const tb = (r.technical_to_business_translation as any) || {};

  return {
    executive_summary: {
      main_message: es.main_message || "",
      business_interpretation: asArr(es.business_interpretation),
      main_risks: asArr(es.main_risks),
      main_opportunities: asArr(es.main_opportunities),
      reasoning: asArr(es.reasoning),
    },
    action_layer: {
      who_to_prioritize: Array.isArray(al.who_to_prioritize)
        ? al.who_to_prioritize.map((p: any) => ({
            segment: String(p.segment || ""),
            reason: String(p.reason || ""),
            suggested_action: String(p.suggested_action || ""),
            priority: ["critical", "high", "medium", "low"].includes(p.priority) ? p.priority : "medium",
          }))
        : [],
      recommended_actions: Array.isArray(al.recommended_actions)
        ? al.recommended_actions.map((a: any) => ({
            action: String(a.action || ""),
            target_segment: String(a.target_segment || ""),
            expected_outcome: String(a.expected_outcome || ""),
            urgency: ["immediate", "short_term", "medium_term", "long_term"].includes(a.urgency) ? a.urgency : "short_term",
          }))
        : [],
      segments_to_watch: asArr(al.segments_to_watch),
      priority_rules: asArr(al.priority_rules),
      reasoning: asArr(al.reasoning),
    },
    business_impact: {
      expected_impact: asArr(bi.expected_impact),
      financial_interpretation: asArr(bi.financial_interpretation),
      operational_interpretation: asArr(bi.operational_interpretation),
    },
    dashboard_blocks: {
      keep_blocks: asArr(db.keep_blocks),
      remove_blocks: asArr(db.remove_blocks),
      new_blocks: Array.isArray(db.new_blocks)
        ? db.new_blocks.map((b: any) => ({
            block_name: String(b.block_name || ""),
            block_type: String(b.block_type || ""),
            reasoning: String(b.reasoning || ""),
          }))
        : [],
      reasoning: asArr(db.reasoning),
    },
    simulation_guidance: {
      what_if_scenarios: Array.isArray(sg.what_if_scenarios)
        ? sg.what_if_scenarios.map((s: any) => ({
            scenario: String(s.scenario || ""),
            variable: String(s.variable || ""),
            expected_insight: String(s.expected_insight || ""),
          }))
        : [],
      assumptions: asArr(sg.assumptions),
      recommended_controls: asArr(sg.recommended_controls),
    },
    technical_to_business_translation: {
      metric_translation: Array.isArray(tb.metric_translation)
        ? tb.metric_translation.map((m: any) => ({
            metric_name: String(m.metric_name || ""),
            metric_value: String(m.metric_value || ""),
            business_meaning: String(m.business_meaning || ""),
          }))
        : [],
      score_translation: asArr(tb.score_translation),
      risk_translation: asArr(tb.risk_translation),
    },
    confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0,
  };
}

function fallbackBA(reason: string): BADecision {
  return {
    executive_summary: { main_message: reason, business_interpretation: [], main_risks: [reason], main_opportunities: [], reasoning: [] },
    action_layer: { who_to_prioritize: [], recommended_actions: [], segments_to_watch: [], priority_rules: [], reasoning: [] },
    business_impact: { expected_impact: [], financial_interpretation: [], operational_interpretation: [] },
    dashboard_blocks: { keep_blocks: [], remove_blocks: [], new_blocks: [], reasoning: [] },
    simulation_guidance: { what_if_scenarios: [], assumptions: [], recommended_controls: [] },
    technical_to_business_translation: { metric_translation: [], score_translation: [], risk_translation: [] },
    confidence: 0,
  };
}

function asArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}
