import { createClient } from "https://esm.sh/@supabase/supabase-js@2.86.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const { project_id, organization_id, mode = "assisted" } = body;

    if (!project_id || !organization_id) {
      return new Response(JSON.stringify({ error: "project_id e organization_id obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[PRE] Starting resolution for project=${project_id} mode=${mode}`);

    // ── Gather all inputs in parallel ──────────────────────────
    const [
      settingsRes, columnsRes, selectionRes, datasetStateRes, sampleRes,
    ] = await Promise.all([
      sb.from("project_settings").select("*").eq("project_id", project_id).maybeSingle(),
      sb.from("project_columns").select("column_name, inferred_type, is_target, is_entity_key, is_time_anchor, distinct_count, null_percent, sample_values").eq("project_id", project_id),
      sb.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      sb.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      sb.from("project_dataset_sample").select("sample_json").eq("project_id", project_id).maybeSingle(),
    ]);

    const settings = settingsRes.data as Record<string, any> | null;
    const columns = (columnsRes.data || []) as Array<{ column_name: string; inferred_type: string; [k: string]: any }>;
    const modelSelection = selectionRes.data as Record<string, any> | null;
    const datasetState = datasetStateRes.data as Record<string, any> | null;

    const intentContractV3 = settings?.intent_contract_v3 || null;
    const edaProfile = settings?.eda_profile_json || null;
    const tdeProfile = settings?.tde_profile || null;
    const businessIntent = settings?.business_intent_contract || null;
    const targetIntentResolution = settings?.target_intent_resolution || null;

    // ── Resolve problem type ───────────────────────────────────
    const CLASSIFICATION_OBJ = ["churn", "turnover", "no_show", "default_risk", "inadimplencia", "propensity", "anomaly", "risk_scoring"];
    const REGRESSION_OBJ = ["demand_forecast", "revenue", "ticket", "value_forecast", "lifetime_value", "price_optimization"];

    const objective = intentContractV3?.prediction_request?.objective
      || businessIntent?.objective || "generic_prediction";

    const objLower = (objective || "").toLowerCase();
    const problemType = REGRESSION_OBJ.some((r: string) => objLower.includes(r)) ? "regression" : "classification";

    // ── Resolve entity key ─────────────────────────────────────
    const ENTITY_PATTERNS = ["id_cliente", "customer_id", "client_id", "cpf", "cnpj", "patient_id", "id_paciente", "student_id", "employee_id", "matricula", "account_id", "user_id", "id_conta", "contract_id"];
    const BLOCKED_ENTITY = ["nome", "name", "email", "telefone", "phone", "endereco", "address", "descricao"];

    let entityKey: string | null = null;
    let entityConfidence = 0;
    let entityReasoning = "Não detectado.";

    if (modelSelection?.entity_key) {
      entityKey = modelSelection.entity_key;
      entityConfidence = 0.9;
      entityReasoning = "Herdado da seleção existente.";
    } else if (tdeProfile?.entity_key_candidates?.length) {
      const top = tdeProfile.entity_key_candidates[0];
      entityKey = typeof top === "string" ? top : top?.column;
      entityConfidence = 0.8;
      entityReasoning = "Sugerido pelo TDE.";
    } else {
      for (const pattern of ENTITY_PATTERNS) {
        const match = columns.find((c: any) => c.column_name.toLowerCase().includes(pattern));
        if (match) {
          entityKey = match.column_name;
          entityConfidence = 0.7;
          entityReasoning = `Padrão detectado: ${pattern}.`;
          break;
        }
      }
    }

    // ── Resolve time anchor ────────────────────────────────────
    const TIME_PATTERNS = ["data_ref", "dt_ref", "reference_date", "created_at", "data_criacao", "order_date", "data_compra", "data_pedido", "data_internacao", "admission_date", "hire_date"];
    const BLOCKED_TIME = ["data_cancelamento", "cancellation_date", "data_obito", "data_encerramento", "close_date", "data_saida"];

    let timeAnchor: string | null = null;
    let timeConfidence = 0;
    let timeReasoning = "Não detectado.";

    if (tdeProfile?.time_anchor_candidates?.length) {
      const top = tdeProfile.time_anchor_candidates[0];
      timeAnchor = typeof top === "string" ? top : top?.column;
      timeConfidence = 0.8;
      timeReasoning = "Sugerido pelo TDE.";
    } else {
      const dateCols = columns.filter((c: any) => ["date", "datetime", "timestamp", "temporal"].includes((c.inferred_type || "").toLowerCase()));
      for (const pattern of TIME_PATTERNS) {
        const match = dateCols.find((c: any) => c.column_name.toLowerCase().includes(pattern));
        if (match && !BLOCKED_TIME.some((b: string) => match.column_name.toLowerCase().includes(b))) {
          timeAnchor = match.column_name;
          timeConfidence = 0.7;
          timeReasoning = `Padrão detectado: ${pattern}.`;
          break;
        }
      }
      if (!timeAnchor && dateCols.length > 0) {
        const safe = dateCols.find((c: any) => !BLOCKED_TIME.some((b: string) => c.column_name.toLowerCase().includes(b)));
        if (safe) {
          timeAnchor = safe.column_name;
          timeConfidence = 0.5;
          timeReasoning = `Primeira coluna temporal: ${safe.column_name}.`;
        }
      }
    }

    // ── Resolve target ─────────────────────────────────────────
    const LEAKAGE_TOKENS = ["status_final", "resultado", "outcome", "target", "label", "churn", "churned", "cancelled", "cancelado", "inadimplente", "defaulted", "saiu", "obito"];

    interface TargetCandidate {
      column: string; score: number; mode: string; reasoning: string;
      business_fit: number; semantic_fit: number; temporal_fit: number; trainability_fit: number; leakage_penalty: number;
    }
    const candidates: TargetCandidate[] = [];

    // From contract
    const dataExp = intentContractV3?.data_expectations;
    if (dataExp?.has_outcome_column === true && dataExp?.outcome_column_name) {
      const col = columns.find((c: any) => c.column_name.toLowerCase() === dataExp.outcome_column_name.toLowerCase());
      if (col) {
        candidates.push({ column: col.column_name, score: 0.95, mode: "explicit",
          reasoning: "Declarado no contrato.", business_fit: 1, semantic_fit: 0.9, temporal_fit: 0.9, trainability_fit: 0.9, leakage_penalty: 0 });
      }
    }

    // From model selection
    if (modelSelection?.target_column) {
      const col = columns.find((c: any) => c.column_name === modelSelection.target_column);
      if (col && !candidates.some((c: TargetCandidate) => c.column === col.column_name)) {
        candidates.push({ column: col.column_name, score: 0.9, mode: "explicit",
          reasoning: "Herdado da seleção.", business_fit: 0.8, semantic_fit: 0.9, temporal_fit: 0.8, trainability_fit: 0.9, leakage_penalty: 0 });
      }
    }

    // From TDE
    if (tdeProfile?.target_candidates?.length) {
      for (const tc of tdeProfile.target_candidates.slice(0, 5)) {
        const colName = typeof tc === "string" ? tc : tc?.column || tc?.name;
        if (!colName || candidates.some((c: TargetCandidate) => c.column === colName)) continue;
        if (!columns.find((c: any) => c.column_name === colName)) continue;
        const leak = LEAKAGE_TOKENS.some((t: string) => colName.toLowerCase().includes(t)) ? 0.3 : 0;
        candidates.push({ column: colName, score: (tc?.score || 0.6) - leak, mode: "explicit",
          reasoning: `TDE: ${tc?.reason || "candidato"}.`, business_fit: 0.6, semantic_fit: 0.6, temporal_fit: 0.5, trainability_fit: 0.6, leakage_penalty: leak });
      }
    }

    // Binary heuristic
    if (problemType === "classification" && candidates.length < 3) {
      for (const col of columns) {
        if (candidates.some((c: TargetCandidate) => c.column === col.column_name)) continue;
        const n = col.column_name.toLowerCase();
        const t = (col.inferred_type || "").toLowerCase();
        if (t === "boolean" || n.includes("flag") || n.includes("is_")) {
          const leak = LEAKAGE_TOKENS.some((tk: string) => n.includes(tk)) ? 0.4 : 0;
          candidates.push({ column: col.column_name, score: 0.5 - leak, mode: "explicit",
            reasoning: "Coluna binária por heurística.", business_fit: 0.4, semantic_fit: 0.5, temporal_fit: 0.3, trainability_fit: 0.6, leakage_penalty: leak });
        }
      }
    }

    candidates.sort((a: TargetCandidate, b: TargetCandidate) => b.score - a.score);
    const best = candidates[0];
    const THRESHOLD = 0.6;

    const targetDef = (!best || best.score < THRESHOLD)
      ? { mode: "blocked", target_name: null, target_source_column: null, target_rule: null, target_kind: "unknown", target_confidence: 0,
          target_reasoning: "Nenhum target com confiança suficiente.", alternatives: candidates }
      : { mode: best.mode, target_name: best.column, target_source_column: best.column, target_rule: best.reasoning,
          target_kind: problemType === "regression" ? "continuous" : "binary", target_confidence: best.score,
          target_reasoning: best.reasoning, alternatives: candidates.slice(1) };

    // ── Grain ──────────────────────────────────────────────────
    let grain = "original_row";
    let grainReasoning = "Grain padrão.";

    if (["churn", "turnover", "no_show", "default_risk", "inadimplencia"].some((o: string) => objLower.includes(o))) {
      grain = "entity_time";
      grainReasoning = "Evento futuro por entidade.";
    } else if (["demand_forecast", "revenue", "value_forecast"].some((o: string) => objLower.includes(o))) {
      grain = entityKey ? "entity_product_time" : "entity_time";
      grainReasoning = "Forecast temporal.";
    }

    const dataShape = intentContractV3?.data_expectations?.expected_data_shape || "unknown";

    // ── Dataset strategy ───────────────────────────────────────
    const needsAgg = grain === "aggregated" || grain === "entity_product_time";
    const snapshotReq = grain === "entity_time" && !!timeAnchor && dataShape === "multiple_rows_per_entity";

    const datasetStrategy = {
      needs_aggregation: needsAgg,
      aggregation_level: needsAgg ? "entity" : null,
      snapshot_required: snapshotReq,
      temporal_strategy: snapshotReq ? "multi_period" : (timeAnchor ? "snapshot" : "none"),
      multi_table_strategy: null,
      split_suggestion: timeAnchor ? "temporal" : "stratified",
    };

    // ── Feature plan ───────────────────────────────────────────
    const forbidden = new Set(intentContractV3?.business_rules?.forbidden_features || []);
    const knownLeak = new Set(intentContractV3?.business_rules?.known_leakage_columns || []);
    const includeFeatures: string[] = [];
    const excludeFeatures: string[] = [];
    const blockedFeatures: string[] = [];
    const leakageFlags: string[] = [];

    for (const col of columns) {
      const nm = col.column_name;
      const lo = nm.toLowerCase();
      if (nm === (targetDef.target_name || "") || nm === entityKey || nm === timeAnchor) { excludeFeatures.push(nm); continue; }
      if (forbidden.has(nm)) { blockedFeatures.push(nm); continue; }
      if (knownLeak.has(nm)) { leakageFlags.push(nm); blockedFeatures.push(nm); continue; }
      if (LEAKAGE_TOKENS.some((t: string) => lo.includes(t)) && nm !== targetDef.target_name) { leakageFlags.push(nm); excludeFeatures.push(nm); continue; }
      if (BLOCKED_ENTITY.some((p: string) => lo.includes(p))) { excludeFeatures.push(nm); continue; }
      includeFeatures.push(nm);
    }

    // ── Horizon ────────────────────────────────────────────────
    let horizonDays = 30;
    if (intentContractV3?.prediction_request?.horizon?.value) {
      const h = intentContractV3.prediction_request.horizon;
      horizonDays = h.unit === "weeks" ? h.value * 7 : h.unit === "months" ? h.value * 30 : h.value;
    }

    // ── Validation ─────────────────────────────────────────────
    const issues: Array<{ code: string; severity: string; message: string; suggestion?: string }> = [];
    const blocking: string[] = [];

    if (!entityKey) issues.push({ code: "NO_ENTITY_KEY", severity: "warn", message: "Sem entity_key detectado.", suggestion: "Selecione manualmente." });
    if (targetDef.mode === "blocked") { issues.push({ code: "NO_TARGET", severity: "block", message: "Sem target válido.", suggestion: "Defina manualmente." }); blocking.push("NO_TARGET"); }
    if (["entity_time", "entity_product_time"].includes(grain) && !timeAnchor) { issues.push({ code: "NO_TIME_ANCHOR", severity: "block", message: "Problema temporal sem âncora.", suggestion: "Selecione coluna temporal." }); blocking.push("NO_TIME_ANCHOR"); }

    // ── Confidence ─────────────────────────────────────────────
    let problemFit = intentContractV3 ? 0.8 : 0.5;
    const targetFit = targetDef.target_confidence || 0;
    let grainFit = (entityKey && timeAnchor) ? 0.9 : entityKey ? 0.7 : 0.5;
    let timeFit = timeAnchor ? 0.9 : 0.5;
    const overall = Math.round((problemFit * 0.2 + targetFit * 0.4 + grainFit * 0.2 + timeFit * 0.2) * 100) / 100;

    // ── Build resolution ───────────────────────────────────────
    const resolution = {
      version: 1,
      mode,
      problem_definition: {
        problem_type: problemType,
        business_mode: objective,
        entity: { entity_key: entityKey, grain, entity_label: intentContractV3?.prediction_request?.entity_label || "entidade" },
        dataset_shape_detected: dataShape,
        time_anchor: timeAnchor,
        horizon_days: horizonDays,
      },
      target_definition: targetDef,
      dataset_strategy: datasetStrategy,
      feature_plan: {
        include_features: includeFeatures,
        exclude_features: excludeFeatures,
        blocked_features: blockedFeatures,
        leakage_flags: leakageFlags,
        feature_reasoning: `${includeFeatures.length} incluídas, ${excludeFeatures.length} excluídas, ${blockedFeatures.length} bloqueadas.`,
      },
      validation: { training_ready: blocking.length === 0, issues_detected: issues, blocking_errors: blocking },
      explanation: {
        why_this_problem: problemType === "classification"
          ? `Objetivo "${objective}" = evento (sim/não) → classificação.`
          : `Objetivo "${objective}" = valor numérico → regressão.`,
        why_this_target: targetDef.target_reasoning,
        why_this_grain: grainReasoning,
        main_risks: [
          ...(targetDef.mode === "blocked" ? ["Sem target — bloqueado."] : []),
          ...(!timeAnchor ? ["Sem âncora temporal."] : []),
          ...(!entityKey ? ["Sem entity_key."] : []),
        ],
      },
      confidence: {
        overall,
        scores: { problem_fit: problemFit, target_fit: targetFit, grain_fit: grainFit, time_fit: timeFit },
      },
      inputs_used: [
        intentContractV3 && "intent_contract_v3",
        businessIntent && "business_intent_contract",
        edaProfile && "eda_profile_json",
        tdeProfile && "tde_profile",
        modelSelection && "model_selection",
        columns.length > 0 && "project_columns",
      ].filter(Boolean),
      rules_triggered: [
        `PROBLEM_TYPE_${problemType.toUpperCase()}`,
        entityKey && "ENTITY_KEY_RESOLVED",
        timeAnchor && "TIME_ANCHOR_RESOLVED",
        `TARGET_MODE_${targetDef.mode.toUpperCase()}`,
        `GRAIN_${grain.toUpperCase()}`,
      ].filter(Boolean),
      created_at: new Date().toISOString(),
    };

    // ── Persist ────────────────────────────────────────────────
    const selectionVersion = modelSelection?.selection_version || 0;

    const { data: inserted, error: insertErr } = await sb
      .from("project_predictive_resolutions")
      .insert({
        project_id,
        organization_id,
        resolution_version: 1,
        intent_contract_version: 3,
        selection_version: selectionVersion,
        mode,
        resolution_json: resolution,
        overall_confidence: overall,
        status: "resolved",
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[PRE] Insert error:", insertErr);
      return new Response(JSON.stringify({ success: false, error: insertErr.message }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update SSOT
    await sb.from("project_settings").update({
      predictive_resolution_state: "resolved",
      active_predictive_resolution_id: inserted.id,
      predictive_resolution_mode: mode,
      predictive_resolution_confidence: overall,
      predictive_resolution_summary: {
        problem_type: problemType,
        target: targetDef.target_name,
        entity_key: entityKey,
        time_anchor: timeAnchor,
        grain,
        confidence: overall,
        training_ready: blocking.length === 0,
      },
    }).eq("project_id", project_id);

    console.log(`[PRE] Resolution created: id=${inserted.id} confidence=${overall} target=${targetDef.target_name}`);

    return new Response(JSON.stringify({
      success: true,
      resolution_id: inserted.id,
      resolution,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[PRE] Error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
