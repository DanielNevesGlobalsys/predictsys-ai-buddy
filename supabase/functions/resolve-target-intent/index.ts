import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOpenAI } from "../_shared/openai-client.ts";
import { buildProjectContext, contextToPromptBlock } from "../_shared/build-project-context.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ═══ Problem type taxonomy ═══════════════════════════════════════
const PROBLEM_CATEGORIES = {
  binary_classification: {
    label: "Classificação binária",
    examples: ["churn", "inadimplência", "cancelamento", "conversão", "fraude", "recompra"],
  },
  multiclass_classification: {
    label: "Classificação multiclasse",
    examples: ["segmento", "categoria", "tipo de comportamento", "status final"],
  },
  regression: {
    label: "Regressão",
    examples: ["valor gasto", "demanda", "ticket médio", "receita", "score contínuo"],
  },
  ranking: {
    label: "Ranking / priorização",
    examples: ["propensão", "score de risco", "priorização de carteira"],
  },
  segmentation: {
    label: "Segmentação / agrupamento",
    examples: ["agrupamento de clientes", "perfis de consumo", "clusters"],
  },
};

// ═══ Industry target patterns (extended) ═════════════════════════
const INDUSTRY_TARGET_HINTS: Record<string, Record<string, string[]>> = {
  retail: {
    churn: ["churn", "cancel", "inativ", "abandono", "evasao", "sem_compra"],
    propensity: ["comprou", "converteu", "recompra", "aderiu"],
    demand_forecast: ["vendas", "receita", "volume", "demanda", "faturamento"],
    segmentation: ["segmento", "cluster", "perfil", "grupo"],
    generic_prediction: [],
  },
  finance: {
    churn: ["churn", "cancel", "encerr"],
    propensity: ["inadimpl", "default", "atraso", "pagou", "quitou"],
    anomaly: ["fraude", "suspeita", "anomalia", "atipic"],
    demand_forecast: ["receita", "faturamento", "fluxo"],
    segmentation: ["segmento", "perfil_risco", "rating"],
    generic_prediction: [],
  },
  health: {
    churn: ["evasao", "abandono", "sem_retorno", "cancelamento_plano"],
    propensity: ["no_show", "faltou", "ausente", "risco"],
    anomaly: ["anomalia", "atipic", "sinistro"],
    demand_forecast: ["atendimentos", "internacoes", "volume"],
    generic_prediction: [],
  },
  education: {
    churn: ["evasao", "abandono", "desistencia", "trancamento"],
    propensity: ["matricula", "inscricao", "aprovacao"],
    demand_forecast: ["matriculas", "vagas", "demanda"],
    generic_prediction: [],
  },
  logistics: {
    propensity: ["atraso", "falha", "extravio"],
    demand_forecast: ["pedidos", "entregas", "volume"],
    anomaly: ["anomalia", "desvio", "perda"],
    generic_prediction: [],
  },
  generic: {},
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Auth required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: "Not authenticated" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ success: false, error: "project_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[resolve-target-intent] Starting for project=${project_id}`);

    // ── 1. Gather all SSOT data ──
    const [settingsRes, contextRes, schemaRes, tdeRes, selectionRes] = await Promise.all([
      serviceClient.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      serviceClient.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      serviceClient.from("project_columns").select("column_name, inferred_type").eq("project_id", project_id).limit(200),
      serviceClient.from("project_model_insights").select("insights").eq("project_id", project_id).eq("insight_type", "eda_synthesis").limit(1).maybeSingle(),
      serviceClient.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
    ]);

    const settings = (settingsRes.data || {}) as Record<string, any>;
    const aiContext = (contextRes.data?.context || {}) as Record<string, any>;
    const schemaColumns = (schemaRes.data || []).map((c: any) => ({ name: c.column_name, type: c.inferred_type }));
    const tdeProfile = aiContext.tde_profile || {};
    const candidates = tdeProfile.candidates || {};
    const intentContract = aiContext.intent_contract || aiContext.intent || {};
    const intentBase = intentContract.intent_base || intentContract;
    const domainAdapter = intentContract.domain_adapter || {};
    const lysRecommendation = settings.lys_recommendation_json || aiContext.lys_synthesis || {};

    // ── 2. Extract key project metadata ──
    const industry = (settings.industry || domainAdapter.industry || "generic") as string;
    const objective = (settings.objective || "") as string;
    const businessProblem = (settings.business_problem || settings.objective || intentBase.declared_objective || "") as string;
    const problemTypeExpected = (intentBase.problem_type || settings.problem_type || "") as string;
    const entityKey = settings.entity_key || null;
    const timeAnchor = settings.time_anchor_column || null;
    const activeSchema = schemaColumns.map((c: any) => c.name);

    // ── 3. Deterministic signal extraction ──
    const entityCandidates = (candidates.entity_candidates || []) as any[];
    const timeCandidates = (candidates.time_candidates || []) as any[];
    const valueCandidates = (candidates.value_candidates || []) as any[];
    const statusCandidates = (candidates.status_candidates || []) as any[];

    const signals = {
      entity_ok: entityCandidates.length > 0 && (entityCandidates[0]?.score || 0) >= 5,
      time_ok: timeCandidates.length > 0 && (timeCandidates[0]?.score || 0) >= 5,
      value_ok: valueCandidates.length > 0 && (valueCandidates[0]?.score || 0) >= 5,
      status_ok: statusCandidates.length > 0 && (statusCandidates[0]?.score || 0) >= 5,
      dataset_shape: (tdeProfile.dataset_shape || "snapshot") as string,
    };

    // ── 4. Deterministic target candidates ──
    const deterministicCandidates = buildDeterministicCandidates({
      industry, objective, businessProblem, problemTypeExpected,
      schemaColumns, signals, entityCandidates, timeCandidates, valueCandidates, statusCandidates,
      entityKey, timeAnchor, intentBase, lysRecommendation,
    });

    // ── 5. Call OpenAI for contextual ranking ──
    let aiEnriched = null;
    try {
      const projectContext = await buildProjectContext(serviceClient, project_id);
      const contextBlock = contextToPromptBlock(projectContext);

      aiEnriched = await callLysForTargetRecommendation(
        contextBlock, industry, objective, businessProblem, problemTypeExpected,
        deterministicCandidates, signals, activeSchema
      );
    } catch (e) {
      console.warn("[resolve-target-intent] AI enrichment failed (non-blocking):", e);
    }

    // ── 6. Merge deterministic + AI results ──
    const finalResult = mergeResults(deterministicCandidates, aiEnriched, industry, objective, problemTypeExpected);

    // ── 7. Persist to SSOT ──
    const ssotPayload = {
      target_intent_resolution: {
        target_strategy_used: finalResult.target_strategy_used,
        target_main_candidate: finalResult.main_candidate,
        target_alternatives: finalResult.alternatives,
        target_is_explicit: finalResult.is_explicit,
        target_is_derived: finalResult.is_derived,
        target_derivation_formula: finalResult.derivation_formula,
        target_confidence_score: finalResult.confidence_score,
        suggested_entity_key: finalResult.suggested_entity_key,
        suggested_time_anchor: finalResult.suggested_time_anchor,
        problem_type_inferred: finalResult.problem_type_inferred,
        business_fit_assessment: finalResult.business_fit_assessment,
        blocked_targets: finalResult.blocked_targets,
        blocked_target_reasons: finalResult.blocked_target_reasons,
        suggested_features: finalResult.suggested_features,
        blocked_features: finalResult.blocked_features,
        target_reasoning_summary: finalResult.reasoning_summary,
        lys_target_recommendation_json: aiEnriched,
        resolved_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    };

    await serviceClient.from("project_settings").update(ssotPayload as any).eq("project_id", project_id);

    // Also update AI context
    try {
      const existingCtx = aiContext;
      await serviceClient.from("project_ai_context").upsert({
        project_id,
        context: {
          ...existingCtx,
          target_intent_resolution: ssotPayload.target_intent_resolution,
        },
        status: "active",
        last_updated_at: new Date().toISOString(),
      } as any, { onConflict: "project_id" });
    } catch (e) {
      console.warn("[resolve-target-intent] AI context update failed:", e);
    }

    // Log event
    serviceClient.from("platform_events").insert({
      event_type: "target_intent_resolved",
      project_id,
      status: "success",
      source: "edge",
      metadata: {
        main_candidate: finalResult.main_candidate?.column || null,
        strategy: finalResult.target_strategy_used,
        confidence: finalResult.confidence_score,
        is_explicit: finalResult.is_explicit,
        is_derived: finalResult.is_derived,
        ai_used: !!aiEnriched,
      },
    }).catch(() => {});

    return new Response(JSON.stringify({ success: true, ...finalResult }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[resolve-target-intent] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Internal error",
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ═══ Deterministic Candidate Builder ═════════════════════════════

interface CandidateInput {
  industry: string;
  objective: string;
  businessProblem: string;
  problemTypeExpected: string;
  schemaColumns: { name: string; type: string }[];
  signals: Record<string, any>;
  entityCandidates: any[];
  timeCandidates: any[];
  valueCandidates: any[];
  statusCandidates: any[];
  entityKey: string | null;
  timeAnchor: string | null;
  intentBase: Record<string, any>;
  lysRecommendation: Record<string, any>;
}

interface TargetCandidate {
  column: string;
  problem_type: string;
  strategy: "explicit" | "derived" | "insufficient";
  confidence: number;
  reasons: string[];
  derivation_formula?: string;
  risk_notes: string[];
}

function buildDeterministicCandidates(input: CandidateInput): TargetCandidate[] {
  const candidates: TargetCandidate[] = [];
  const colNames = input.schemaColumns.map(c => c.name);
  const lowerCols = colNames.map(c => c.toLowerCase());
  const colTypeMap = new Map(input.schemaColumns.map(c => [c.name.toLowerCase(), c.type || ""]));

  // Get industry-specific target hints
  const industryHints = INDUSTRY_TARGET_HINTS[input.industry] || {};
  const objectivePatterns = industryHints[input.objective] || [];
  const allObjectivePatterns = [
    ...objectivePatterns,
    ...(input.intentBase.recommended_target_patterns || []),
  ];

  // Lys previously recommended target
  const lysTarget = input.lysRecommendation.suggested_target || null;

  // ── A. Explicit targets (columns matching intent contract) ──
  for (const col of input.schemaColumns) {
    const lower = col.name.toLowerCase();
    const type = (col.type || "").toLowerCase();

    // Skip structural columns
    if (isStructuralColumn(lower)) continue;

    let score = 0;
    const reasons: string[] = [];
    const risks: string[] = [];

    // Pattern match against objective
    for (const pattern of allObjectivePatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        score += 35;
        reasons.push(`Nome compatível com o objetivo "${input.objective}" (padrão: ${pattern})`);
        break;
      }
    }

    // Status candidates from TDE
    const statusMatch = input.statusCandidates.find((s: any) => s.column === col.name);
    if (statusMatch) {
      score += 15;
      reasons.push(`Identificado como coluna de status/evento pelo Target Discovery (score: ${statusMatch.score})`);
    }

    // Binary/low cardinality → classification fit
    if (type.includes("categor") || type.includes("text")) {
      // Could be classification
      score += 5;
    }

    // Lys recommended this
    if (lysTarget === col.name) {
      score += 20;
      reasons.push("Recomendado pela Lys na síntese anterior");
    }

    // Problem type compatibility
    const expectedType = input.problemTypeExpected || "classification";
    if (expectedType === "regression" && (type.includes("numer") || type.includes("float") || type.includes("int"))) {
      score += 10;
      reasons.push("Tipo numérico compatível com regressão");
    } else if (expectedType === "classification" && score > 0) {
      score += 5;
    }

    // Leakage check
    if (isLeakageCandidate(lower)) {
      risks.push("Possível vazamento de informação (nome sugere resultado final)");
      score -= 20;
    }

    if (score >= 15 && reasons.length > 0) {
      candidates.push({
        column: col.name,
        problem_type: expectedType || "classification",
        strategy: "explicit",
        confidence: Math.min(Math.max(score / 100, 0.1), 0.95),
        reasons,
        risk_notes: risks,
      });
    }
  }

  // ── B. Derived targets (when no good explicit match) ──
  if (candidates.filter(c => c.confidence >= 0.4).length === 0 && input.signals.entity_ok && input.signals.time_ok) {
    const entityCol = input.entityKey || input.entityCandidates[0]?.column;
    const timeCol = input.timeAnchor || input.timeCandidates[0]?.column;

    if (entityCol && timeCol) {
      // Inactivity-based derived target
      const windowDays = input.intentBase.default_window_days || 90;
      candidates.push({
        column: `inatividade_${windowDays}d`,
        problem_type: "classification",
        strategy: "derived",
        confidence: 0.65,
        reasons: [
          `Entidade detectada (${entityCol}) + tempo (${timeCol}) permitem criar alvo derivado`,
          `Marca como 1 entidades sem atividade nos últimos ${windowDays} dias`,
          `Compatível com o objetivo: ${input.businessProblem || input.objective}`,
        ],
        derivation_formula: `CASE WHEN MAX(${timeCol}) < NOW() - INTERVAL '${windowDays} days' THEN 1 ELSE 0 END GROUP BY ${entityCol}`,
        risk_notes: [],
      });

      // Value-based derived target (if value signal exists)
      if (input.signals.value_ok) {
        const valueCol = input.valueCandidates[0]?.column;
        if (valueCol) {
          candidates.push({
            column: `valor_futuro_${windowDays}d`,
            problem_type: "regression",
            strategy: "derived",
            confidence: 0.55,
            reasons: [
              `Valor detectado (${valueCol}) pode ser somado/agregado no período futuro`,
              `Previsão de valor acumulado nos próximos ${windowDays} dias`,
            ],
            derivation_formula: `SUM(${valueCol}) WHERE ${timeCol} BETWEEN ref_date AND ref_date + ${windowDays}d GROUP BY ${entityCol}`,
            risk_notes: [],
          });
        }
      }

      // Status-change derived target
      if (input.signals.status_ok) {
        const statusCol = input.statusCandidates[0]?.column;
        if (statusCol) {
          candidates.push({
            column: `mudanca_${statusCol}_${windowDays}d`,
            problem_type: "classification",
            strategy: "derived",
            confidence: 0.60,
            reasons: [
              `Coluna de status (${statusCol}) pode ser convertida em evento temporal`,
              `Marca como 1 entidades que mudaram de status nos próximos ${windowDays} dias`,
            ],
            derivation_formula: `CASE WHEN status_changed(${statusCol}, ${windowDays}d) THEN 1 ELSE 0 END`,
            risk_notes: [],
          });
        }
      }
    }
  }

  // Sort by confidence
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, 8);
}

function isStructuralColumn(lower: string): boolean {
  const patterns = ["^id$", "^_id$", "uuid", "^index$", "^key$", "created_at", "updated_at", "deleted_at", "row_num"];
  return patterns.some(p => new RegExp(p).test(lower));
}

function isLeakageCandidate(lower: string): boolean {
  const patterns = ["target", "label", "resultado", "result", "status_final", "outcome", "predicted", "prediction", "y_true", "y_pred"];
  return patterns.some(p => lower === p || lower.includes(p));
}

// ═══ AI Enrichment via OpenAI ════════════════════════════════════

async function callLysForTargetRecommendation(
  contextBlock: string,
  industry: string,
  objective: string,
  businessProblem: string,
  problemTypeExpected: string,
  deterministicCandidates: TargetCandidate[],
  signals: Record<string, any>,
  activeSchema: string[],
): Promise<Record<string, any> | null> {
  const systemPrompt = `You are Lys, the AI analyst for PredictSys. Your task is to recommend the best target variable for a predictive project.

CONTEXT:
- Industry: ${industry}
- Business Objective: ${objective || businessProblem}
- Expected Problem Type: ${problemTypeExpected || "to be determined"}
- Dataset signals: entity=${signals.entity_ok}, time=${signals.time_ok}, value=${signals.value_ok}, status=${signals.status_ok}, shape=${signals.dataset_shape}

RULES:
1. The Intent Contract is the PRIMARY source. The target MUST serve the declared business objective.
2. Consider ALL problem types: binary classification, multiclass, regression, ranking, segmentation.
3. An EXPLICIT target uses an existing column directly.
4. A DERIVED target is created from combining entity + time + value/status columns.
5. If no target can be confidently recommended, say "insufficient" — do NOT invent one.
6. Evaluate leakage risks for each candidate.
7. Respond in Brazilian Portuguese.
8. NEVER recommend ID columns as targets.`;

  const candidatesDesc = deterministicCandidates.map(c =>
    `- ${c.column} (${c.strategy}, ${c.problem_type}, confidence=${(c.confidence * 100).toFixed(0)}%): ${c.reasons.join("; ")}`
  ).join("\n");

  const userPrompt = `${contextBlock}

== CANDIDATOS DETERMINÍSTICOS ==
${candidatesDesc || "Nenhum candidato determinístico identificado."}

== SCHEMA COMPLETO ==
${activeSchema.slice(0, 60).join(", ")}

Analise o contexto completo e recomende o melhor target.`;

  const tools = [{
    type: "function",
    function: {
      name: "recommend_target",
      description: "Recomendação estruturada de variável alvo baseada no contrato de intenção",
      parameters: {
        type: "object",
        properties: {
          recommended_target: {
            type: "object",
            properties: {
              column: { type: "string" },
              problem_type: { type: "string", enum: ["classification", "regression", "multiclass", "ranking", "segmentation"] },
              strategy: { type: "string", enum: ["explicit", "derived", "insufficient"] },
              confidence: { type: "number" },
              reasoning: { type: "string", description: "Business reasoning in Portuguese" },
              derivation_formula: { type: "string", description: "If derived, the formula/logic" },
            },
            required: ["column", "problem_type", "strategy", "confidence", "reasoning"],
          },
          alternatives: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                problem_type: { type: "string" },
                strategy: { type: "string" },
                confidence: { type: "number" },
                reasoning: { type: "string" },
              },
              required: ["column", "problem_type", "reasoning"],
            },
          },
          suggested_entity_key: { type: "string" },
          suggested_time_anchor: { type: "string" },
          suggested_features: { type: "array", items: { type: "string" } },
          blocked_features: {
            type: "array",
            items: {
              type: "object",
              properties: { column: { type: "string" }, reason: { type: "string" } },
              required: ["column", "reason"],
            },
          },
          blocked_targets: {
            type: "array",
            items: {
              type: "object",
              properties: { column: { type: "string" }, reason: { type: "string" } },
              required: ["column", "reason"],
            },
          },
          business_fit_assessment: { type: "string", description: "Overall assessment of how well this target serves the business goal" },
          reasoning_summary: { type: "string", description: "Summary of the decision process in Portuguese" },
        },
        required: ["recommended_target", "alternatives", "business_fit_assessment", "reasoning_summary"],
        additionalProperties: false,
      },
    },
  }];

  const response = await callOpenAI({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    tools,
    tool_choice: { type: "function", function: { name: "recommend_target" } },
    max_tokens: 3000,
    temperature: 0.3,
  });

  if (!response.ok) {
    console.error(`[resolve-target-intent] OpenAI error: ${response.status}`);
    return null;
  }

  const data = await response.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) return null;

  try {
    return JSON.parse(toolCall.function.arguments);
  } catch {
    return null;
  }
}

// ═══ Merge deterministic + AI ════════════════════════════════════

function mergeResults(
  deterministic: TargetCandidate[],
  ai: Record<string, any> | null,
  industry: string,
  objective: string,
  problemTypeExpected: string,
) {
  const mainCandidate = ai?.recommended_target || (deterministic.length > 0 ? {
    column: deterministic[0].column,
    problem_type: deterministic[0].problem_type,
    strategy: deterministic[0].strategy,
    confidence: deterministic[0].confidence,
    reasoning: deterministic[0].reasons.join(". "),
    derivation_formula: deterministic[0].derivation_formula || null,
  } : null);

  const alternatives = (ai?.alternatives || deterministic.slice(1, 4).map(c => ({
    column: c.column,
    problem_type: c.problem_type,
    strategy: c.strategy,
    confidence: c.confidence,
    reasoning: c.reasons.join(". "),
  }))).slice(0, 4);

  const isExplicit = mainCandidate?.strategy === "explicit";
  const isDerived = mainCandidate?.strategy === "derived";
  const isInsufficient = !mainCandidate || mainCandidate.strategy === "insufficient";

  return {
    target_strategy_used: isInsufficient ? "insufficient" : mainCandidate.strategy,
    main_candidate: isInsufficient ? null : mainCandidate,
    alternatives,
    is_explicit: isExplicit,
    is_derived: isDerived,
    is_insufficient: isInsufficient,
    derivation_formula: isDerived ? mainCandidate?.derivation_formula : null,
    confidence_score: mainCandidate?.confidence || 0,
    suggested_entity_key: ai?.suggested_entity_key || null,
    suggested_time_anchor: ai?.suggested_time_anchor || null,
    problem_type_inferred: mainCandidate?.problem_type || problemTypeExpected || "classification",
    business_fit_assessment: ai?.business_fit_assessment || "Avaliação pendente",
    blocked_targets: (ai?.blocked_targets || []).map((b: any) => b.column),
    blocked_target_reasons: ai?.blocked_targets || [],
    suggested_features: ai?.suggested_features || [],
    blocked_features: ai?.blocked_features || [],
    target_reasoning_summary: ai?.reasoning_summary || mainCandidate?.reasoning || "Resolução determinística aplicada.",
    signals: {
      industry, objective, problemTypeExpected,
      ...({} as Record<string, any>),
    },
  };
}
