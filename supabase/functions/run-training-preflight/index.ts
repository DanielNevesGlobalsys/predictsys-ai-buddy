import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { evaluateTargetTrainabilityFromSSOT } from "../_shared/evaluate-target-trainability.ts";
import { resolveActiveTarget } from "../_shared/resolve-active-target.ts";
import { samplePlan, filterInvalidFeatures } from "../_shared/training-prepare-mvp-soft.ts";
import { recoverAllStaleStates } from "../_shared/stale-state-recovery.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[run-training-preflight] Starting for project ${project_id}`);

    // ── Auto-recovery: check for stale states ──
    try {
      const recoveries = await recoverAllStaleStates(supabase, project_id);
      if (recoveries.length > 0) {
        console.log(`[preflight] Recovered ${recoveries.length} stale state(s)`);
      }
    } catch (_) { /* best-effort */ }

    // Parallel fetch all needed data
    const [datasetStateRes, selectionRes, aiCtxRes, modelingDatasetRes, versionMatchedDatasetRes, contractRes, splitPolicyRes, settingsRes] = await Promise.all([
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("*").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      // Also fetch the best matching dataset for current selection version (belt-and-suspenders)
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle().then(async (selRes) => {
        const sv = (selRes.data as any)?.selection_version || 0;
        if (sv > 0) {
          return supabase.from("project_modeling_datasets").select("*")
            .eq("project_id", project_id)
            .eq("selection_version_used", sv)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        }
        return { data: null, error: null };
      }),
      supabase.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_split_policies").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_settings").select("target_source, problem_type, label_build_result, selected_template_id, target_quality_report, weak_label_config, weak_label_result, human_label_config, human_label_result, active_target_mode, active_target_column, active_target_ref, target_column, entity_key, time_anchor_column, industry, objective, target_state, target_intent_resolution").eq("project_id", project_id).maybeSingle(),
    ]);

    const datasetState = datasetStateRes.data;
    const selection = selectionRes.data;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const modelingDatasetIsCurrent = modelingDatasetRes.data;
    const versionMatchedDataset = versionMatchedDatasetRes.data;
    const contract = contractRes.data;
    const projectSettings = settingsRes.data as Record<string, any> | null;
    // Prefer version-matched dataset, then is_current, to avoid stale reads
    const modelingDataset = versionMatchedDataset || modelingDatasetIsCurrent;

    const gates: GateResult[] = [];
    let canBuild = true;
    let canTrain = true;
    let canDeploy = true;
    let canSchedule = true;
    let dashboardAllowed = true;

    // ===== 4.1 DATASET GATE (multi-fallback) =====
    if (datasetState && (datasetState as any).row_count > 0 && (datasetState as any).col_count > 0) {
      const isVirtual = (datasetState as any).virtual_manifest;
      gates.push({
        gate: "dataset",
        status: isVirtual ? "WARN" : "PASS",
        message: isVirtual
          ? `Dataset ativo (${(datasetState as any).row_count} linhas, virtual manifest)`
          : `Dataset ativo (${(datasetState as any).row_count} linhas, ${(datasetState as any).col_count} colunas)`,
        details: { row_count: (datasetState as any).row_count, col_count: (datasetState as any).col_count, virtual: isVirtual },
      });
    } else {
      // Fallback 1: project_settings SSOT (ingestion_rows/cols)
      const { data: ssotSettings } = await supabase
        .from("project_settings")
        .select("ingestion_rows_detected, ingestion_cols_detected, ingestion_state")
        .eq("project_id", project_id)
        .maybeSingle();
      
      const ssotRows = (ssotSettings as any)?.ingestion_rows_detected || 0;
      const ssotCols = (ssotSettings as any)?.ingestion_cols_detected || 0;

      if (ssotRows > 0 && ssotCols > 0 && (ssotSettings as any)?.ingestion_state === "done") {
        gates.push({
          gate: "dataset",
          status: "WARN",
          message: `Dataset via SSOT (${ssotRows} linhas, ${ssotCols} colunas). dataset_state ausente — auto-repair recomendado.`,
          details: { row_count: ssotRows, col_count: ssotCols, source: "project_settings" },
        });
      } else {
        // Fallback 2: import_manifests
        const { data: manifest } = await supabase
          .from("import_manifests")
          .select("rows_consolidated, columns_final")
          .eq("project_id", project_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (manifest && manifest.rows_consolidated > 0) {
          gates.push({
            gate: "dataset",
            status: "WARN",
            message: `Dataset via manifest (${manifest.rows_consolidated} linhas). SSOT não populado.`,
            details: { row_count: manifest.rows_consolidated, col_count: manifest.columns_final },
          });
        } else {
          // Fallback 3: projects table
          const { data: proj } = await supabase
            .from("projects")
            .select("dataset_rows, dataset_columns, total_rows")
            .eq("id", project_id)
            .maybeSingle();
          
          const projRows = (proj as any)?.total_rows || (proj as any)?.dataset_rows || 0;
          const projCols = (proj as any)?.dataset_columns || 0;

          if (projRows > 0 && projCols > 0) {
            gates.push({
              gate: "dataset",
              status: "WARN",
              message: `Dataset via projects (${projRows} linhas). Sem SSOT — auto-repair recomendado.`,
              details: { row_count: projRows, col_count: projCols, source: "projects" },
            });
          } else {
            gates.push({
              gate: "dataset",
              status: "BLOCK",
              message: "Nenhum dataset ativo. Importe dados ou conecte uma fonte.",
            });
            canBuild = false;
            canTrain = false;
          }
        }
      }
    }

    // ===== 4.2 INTENT/CONTRACT GATE =====
    // Check SSOT first (project_settings.industry + objective), then AI context
    const ssotIndustry = projectSettings?.industry || null;
    const ssotObjective = projectSettings?.objective || null;
    const intentObj = aiCtx?.intent || {};
    const intentContract = aiCtx?.intent_contract || {};
    const intentBase = intentContract?.intent_base || {};
    const intentDeclaredObj = ssotObjective || intentObj.declared_objective || intentBase.declared_objective || intentObj.objective || "";
    const hasIntent = !!intentDeclaredObj;
    gates.push({
      gate: "intent",
      status: hasIntent ? "PASS" : "WARN",
      message: hasIntent
        ? `Intent definido: ${intentDeclaredObj.substring(0, 60)}${ssotIndustry ? ` (${ssotIndustry})` : ""}`
        : "Intent Contract não definido. Recomendado: gere na Etapa 1.",
    });

    // ===== 4.3 SELECTION GATE (SSOT-consolidated) =====
    // Priority: project_model_selection > project_settings.target_column > project_settings.active_target_column
    const selectionTargetCol = (selection as any)?.target_column || null;
    const settingsTargetCol = projectSettings?.target_column || projectSettings?.active_target_column || null;
    const resolvedTargetCol = selectionTargetCol || settingsTargetCol;
    const resolvedTargetState = projectSettings?.target_state || null;

    if (resolvedTargetCol) {
      const sv = (selection as any)?.selection_version || 1;
      const feats = (selection as any)?.selected_features as string[] || [];
      const isLabelBuilder = resolvedTargetCol === "_label_" || resolvedTargetCol === "label";

      // If _label_, verify label builder exists and is ready
      let labelBuilderOk = true;
      if (isLabelBuilder) {
        const { data: lblBuilder } = await supabase
          .from("project_label_builders")
          .select("id, status, template_id")
          .eq("project_id", project_id)
          .eq("status", "ready")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!lblBuilder) {
          labelBuilderOk = false;
          gates.push({
            gate: "selection",
            status: "BLOCK",
            message: "Target derivado (_label_) selecionado, mas nenhum Label Builder com status 'ready' encontrado. Execute o Target Builder.",
            details: { target_column: resolvedTargetCol, label_builder_missing: true },
          });
          canBuild = false;
          canTrain = false;
        } else {
          gates.push({
            gate: "selection",
            status: feats.length === 0 ? "WARN" : "PASS",
            message: `Target derivado via template "${lblBuilder.template_id}" (v${sv}), ${feats.length} features`,
            details: { target_column: resolvedTargetCol, selection_version: sv, features_count: feats.length, label_builder_id: lblBuilder.id },
          });
        }
      }

      if (!isLabelBuilder || labelBuilderOk) {
        if (!isLabelBuilder) {
          // Determine source label for the gate message
          const sourceLabel = selectionTargetCol ? `model_selection v${sv}` : "project_settings SSOT";
          gates.push({
            gate: "selection",
            status: feats.length === 0 && !settingsTargetCol ? "WARN" : "PASS",
            message: `Target: "${resolvedTargetCol}" (via ${sourceLabel}), ${feats.length} features`,
            details: { target_column: resolvedTargetCol, selection_version: sv, features_count: feats.length, source: selectionTargetCol ? "model_selection" : "project_settings" },
          });
        }
      }
    } else {
      gates.push({
        gate: "selection",
        status: "BLOCK",
        message: "Nenhum target selecionado. Volte à Etapa 3 e selecione o target.",
      });
      canBuild = false;
      canTrain = false;
    }

    // Log SSOT divergence for diagnostics
    if (selectionTargetCol && settingsTargetCol && selectionTargetCol !== settingsTargetCol) {
      console.warn(`[preflight] SSOT divergence: model_selection.target="${selectionTargetCol}" vs settings.target="${settingsTargetCol}". Using model_selection.`);
      try {
        await supabase.from("platform_events").insert({
          event_type: "preflight_state_divergence",
          project_id,
          status: "warn",
          source: "edge",
          metadata: {
            model_selection_target: selectionTargetCol,
            settings_target: settingsTargetCol,
            resolved_to: resolvedTargetCol,
          },
        });
      } catch (_) { /* best-effort */ }
    }

    // ===== 4.3b MVP-SOFT FEATURE FILTER GATE =====
    {
      const selectedFeatures = (selection as any)?.selected_features as string[] || [];
      if (selectedFeatures.length > 0 && datasetState) {
        const dsAny = datasetState as any;
        let schemaCols = new Set<string>();
        if (dsAny.active_schema_json && typeof dsAny.active_schema_json === "object") {
          schemaCols = new Set(Object.keys(dsAny.active_schema_json).filter((k: string) => !k.startsWith("_")));
        }
        if (schemaCols.size > 0) {
          const filterResult = filterInvalidFeatures(selectedFeatures, schemaCols);
          if (filterResult.removed.length > 0) {
            gates.push({
              gate: "mvp_soft_features",
              status: filterResult.valid.length < 3 ? "BLOCK" : "WARN",
              message: filterResult.valid.length < 3
                ? `Apenas ${filterResult.valid.length} feature(s) válida(s) após filtro de leakage. Mínimo: 3.`
                : `${filterResult.removed.length} feature(s) removida(s) por leakage/schema: ${filterResult.removed.slice(0, 3).map(r => r.col).join(", ")}`,
              details: { valid_count: filterResult.valid.length, removed_count: filterResult.removed.length, removed: filterResult.removed.slice(0, 10) },
            });
            if (filterResult.valid.length < 3) canTrain = false;
          }
        }
      }
    }

    // ===== 4.3c SAMPLE PLAN GATE =====
    {
      const totalRows = (datasetState as any)?.row_count || 0;
      if (totalRows > 0) {
        const plan = samplePlan(totalRows, (selection as any)?.problem_type || "classification");
        if (plan.shouldSample) {
          gates.push({
            gate: "mvp_soft_sampling",
            status: "WARN",
            message: `Dataset grande (${totalRows.toLocaleString()} linhas). Amostra automática de ${plan.sampleSize.toLocaleString()} linhas será usada (${plan.strategy}).`,
            details: { total_rows: totalRows, sample_size: plan.sampleSize, strategy: plan.strategy },
          });
        }
      }
    }

    const selectionVersion = (selection as any)?.selection_version || 0;
    const diagnostics = (datasetState as any)?.diagnostics as Record<string, any> | null;
    const ssotBuilderDatasetId = diagnostics?.builder_dataset_id || null;
    const ssotSelVersionUsed = diagnostics?.selection_version_used || null;

    // Determine the canonical builder dataset:
    // 1. If SSOT has builder_dataset_id, cross-check it exists in project_modeling_datasets
    // 2. If project_modeling_datasets has is_current=true, use that
    // 3. Never use "latest by created_at" alone
    let canonicalDataset = modelingDataset;
    let builderSource = "modeling_datasets_is_current";

    if (ssotBuilderDatasetId && (!modelingDataset || (modelingDataset as any).id !== ssotBuilderDatasetId)) {
      // Cross-check: SSOT points to a different dataset than is_current query
      const { data: ssotDataset } = await supabase
        .from("project_modeling_datasets")
        .select("*")
        .eq("id", ssotBuilderDatasetId)
        .maybeSingle();
      if (ssotDataset) {
        canonicalDataset = ssotDataset;
        builderSource = "ssot_diagnostics";
      }
    }

    const builderSelVersion = canonicalDataset ? ((canonicalDataset as any).selection_version_used || 0) : null;
    const builderIsCurrent = canonicalDataset
      ? ((canonicalDataset as any).is_current !== false && builderSelVersion !== null && builderSelVersion >= selectionVersion)
      : false;

    // Also check SSOT version consistency
    const ssotVersionMatch = ssotSelVersionUsed !== null ? ssotSelVersionUsed >= selectionVersion : true;

    if (canonicalDataset) {
      const md = canonicalDataset as any;
      const isCurrent = md.is_current !== false;
      const isReady = md.status === "ready" || md.status === "warning";
      const versionMismatch = selectionVersion > 0 && (builderSelVersion || 0) < selectionVersion;

      if (!isCurrent || versionMismatch || !ssotVersionMatch) {
        // Builder outdated — BLOCK (never "não executado" since builder ran)
        gates.push({
          gate: "builder",
          status: "BLOCK",
          message: `Builder desatualizado (built v${builderSelVersion || 0}, current v${selectionVersion}). Regere o dataset modelável.`,
          details: {
            selection_version_used: builderSelVersion,
            current_version: selectionVersion,
            ssot_version_used: ssotSelVersionUsed,
            stale_reason: md.stale_reason || (versionMismatch ? "VERSION_MISMATCH" : "NOT_CURRENT"),
            builder_source: builderSource,
          },
        });
        canTrain = false;
      } else if (isCurrent && isReady) {
        gates.push({
          gate: "builder",
          status: md.status === "warning" ? "WARN" : "PASS",
          message: `Builder atual (v${builderSelVersion}). ${md.row_count} linhas, ${md.column_count} colunas.`,
          details: { selection_version_used: builderSelVersion, status: md.status, builder_source: builderSource },
        });
      } else if (isCurrent && !isReady) {
        gates.push({
          gate: "builder",
          status: "BLOCK",
          message: `Builder bloqueado: ${(md.blocked_reasons as string[] || []).join("; ")}`,
          details: { status: md.status, blocked_reasons: md.blocked_reasons },
        });
        canTrain = false;
      }
    } else if (ssotBuilderDatasetId) {
      // SSOT has a builder_dataset_id but dataset not found — data integrity issue
      gates.push({
        gate: "builder",
        status: "BLOCK",
        message: "Builder desatualizado: dataset referenciado não encontrado. Regere o dataset modelável.",
        details: { ssot_builder_dataset_id: ssotBuilderDatasetId, error: "DATASET_NOT_FOUND" },
      });
      canTrain = false;
    } else {
      // No builder dataset found — diagnose WHY
      const ssotBuilderState = projectSettings?.builder_state || null;
      const featCount = (selection as any)?.selected_features?.length || 0;
      const hasTarget = !!resolvedTargetCol;

      // Determine specific root cause for builder not running
      let builderRootCause = "UNKNOWN";
      let builderMessage = "Feature Builder ainda não foi executado.";
      const builderDetails: Record<string, unknown> = {
        builder_state_ssot: ssotBuilderState,
        has_target: hasTarget,
        features_count: featCount,
        selection_version: selectionVersion,
      };

      if (!hasTarget) {
        builderRootCause = "NO_TARGET";
        builderMessage = "Builder não pode executar: nenhum target definido. Selecione o alvo na Etapa 3.";
      } else if (featCount === 0) {
        builderRootCause = "NO_FEATURES";
        builderMessage = "Builder não pode executar: 0 features selecionadas. Selecione as variáveis preditivas ou use a resolução automática.";
      } else if (ssotBuilderState === "ready") {
        // SSOT says ready but no dataset row — likely stale
        gates.push({
          gate: "builder",
          status: "WARN",
          message: "Builder marcado como pronto no SSOT, mas dataset modelável não encontrado. Considere regerar.",
          details: { ...builderDetails, source: "project_settings_fallback" },
        });
        // Don't block — just warn
        builderRootCause = "SSOT_READY_NO_DATASET";
      } else if (ssotBuilderState === "building") {
        builderRootCause = "BUILDING_IN_PROGRESS";
        builderMessage = "Builder em execução. Aguarde a conclusão.";
      } else {
        builderRootCause = "NOT_EXECUTED";
        builderMessage = `Builder pendente (v${selectionVersion}, ${featCount} features). Gere o dataset modelável para desbloquear o treino.`;
      }

      builderDetails.root_cause = builderRootCause;

      if (builderRootCause !== "SSOT_READY_NO_DATASET") {
        gates.push({
          gate: "builder",
          status: builderRootCause === "BUILDING_IN_PROGRESS" ? "WARN" : "BLOCK",
          message: builderMessage,
          details: builderDetails,
        });
        if (builderRootCause !== "BUILDING_IN_PROGRESS") {
          canBuild = true;
          canTrain = false;
        }
      }
    }

    // ===== 4.5b LABEL BUILD RESULT GATE (from project_settings SSOT) =====
    // Only check label_build if target_source is ACTUALLY "label_builder" AND a label builder entry exists
    if (projectSettings?.target_source === "label_builder") {
      // First verify a real label builder entry exists
      const { data: realLabelBuilder } = await supabase
        .from("project_label_builders")
        .select("id, status")
        .eq("project_id", project_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (realLabelBuilder) {
        const lbr = projectSettings.label_build_result as Record<string, any> | null;
        if (lbr && lbr.gates && Array.isArray(lbr.gates)) {
          const hasBlock = (lbr.gates as any[]).some((g: any) => g.status === "BLOCK");
          const hasWarn = (lbr.gates as any[]).some((g: any) => g.status === "WARN");
          gates.push({
            gate: "label_build",
            status: hasBlock ? "BLOCK" : hasWarn ? "WARN" : "PASS",
            message: hasBlock
              ? `Label bloqueado: ${(lbr.gates as any[]).filter((g: any) => g.status === "BLOCK").map((g: any) => g.message).join("; ")}`
              : `Label OK: ${(lbr.positive_rate * 100).toFixed(1)}% positivos, ${lbr.eligible_entities} entidades, template "${lbr.template_id}"`,
            details: {
              template_id: lbr.template_id,
              positive_rate: lbr.positive_rate,
              classes: lbr.classes,
              dominant_rate: lbr.dominant_rate,
              eligible_entities: lbr.eligible_entities,
              gates: lbr.gates,
            },
          });
          if (hasBlock) canTrain = false;
        } else if (!lbr) {
          gates.push({
            gate: "label_build",
            status: "WARN",
            message: "Label builder ativo mas sem resultado de geração. Reconstrua o dataset modelável.",
            details: { label_build_result_missing: true },
          });
        }
      } else {
        // target_source says "label_builder" but no actual label builder exists
        // This is a stale/inconsistent state — auto-correct to "manual"
        console.warn(`[preflight] target_source=label_builder but no label_builder entry found. Stale state.`);
        // Don't add a blocking gate for this — it's a metadata inconsistency, not a real block
      }
    }

    if (modelingDataset) {
      const buildLog = (modelingDataset as any).build_log as Record<string, any> | null;
      const tg = buildLog?.training_gate;
      if (tg) {
        const tgStatus = tg.can_train ? (tg.status === "WARNING" ? "WARN" : "PASS") : "BLOCK";
        gates.push({
          gate: "training_gate",
          status: tgStatus,
          message: tg.can_train
            ? `Gates OK. ${tg.label_report?.n_rows || 0} linhas, split: ${tg.split_plan?.strategy}`
            : `Bloqueado: ${tg.blocked_reason_code || "Verifique o relatório"}`,
          details: { blocked_reason_code: tg.blocked_reason_code, dashboard_precheck: tg.dashboard_allowed_precheck },
        });
        if (!tg.can_train) canTrain = false;
        if (!tg.dashboard_allowed_precheck) dashboardAllowed = false;
      }
    }

    // ===== 4.6 SPLIT SANITY GATE =====
    const splitPolicy = splitPolicyRes.data;
    const splitIntentContract = aiCtx?.intent_contract || aiCtx?.intent || {};
    const splitIntentBase = splitIntentContract.intent_base || splitIntentContract;
    const requiresTime = splitIntentBase.requires_time_column ?? false;
    const contractHints = aiCtx?.contract_hints || {};
    const timeAnchorHint = contractHints.time_anchor_column || null;

    if (splitPolicy) {
      // Check policy drift: if selection_version changed since policy was created
      const policySelVersion = (splitPolicy as any).selection_version || 0;
      if (policySelVersion < selectionVersion) {
        gates.push({
          gate: "split_policy",
          status: "BLOCK",
          message: `Split policy desatualizada (v${policySelVersion}) — seleção atual é v${selectionVersion}. Regere a Split Policy.`,
          details: { policy_version: policySelVersion, current_version: selectionVersion, drift: true },
        });
        canTrain = false;
      } else if ((splitPolicy as any).status === "outdated") {
        gates.push({
          gate: "split_policy",
          status: "BLOCK",
          message: "Split policy marcada como desatualizada. Regere a Split Policy.",
          details: { status: "outdated" },
        });
        canTrain = false;
      } else if ((splitPolicy as any).status === "ready") {
        gates.push({
          gate: "split_policy",
          status: "PASS",
          message: `Split ${(splitPolicy as any).strategy}: treino/valid/teste configurado (v${policySelVersion}).`,
          details: { strategy: (splitPolicy as any).strategy, status: (splitPolicy as any).status, version: policySelVersion },
        });
      } else if ((splitPolicy as any).status === "blocked") {
        gates.push({
          gate: "split_policy",
          status: "BLOCK",
          message: "Split policy bloqueada. Revise a configuração de split.",
          details: { status: (splitPolicy as any).status },
        });
        canTrain = false;
      }
    } else if (requiresTime && !timeAnchorHint) {
      gates.push({
        gate: "split_policy",
        status: "WARN",
        message: "Split temporal recomendado, mas sem coluna de tempo detectada. O treino usará split aleatório.",
      });
    }

    // ===== 4.7 LEAKAGE GUARD GATE =====
    if (modelingDataset) {
      const buildLog = (modelingDataset as any).build_log as Record<string, any> | null;
      const leakageGuard = buildLog?.leakage_guard;
      if (leakageGuard && leakageGuard.removals_count > 0) {
        gates.push({
          gate: "leakage_guard",
          status: "PASS",
          message: `Leakage Guard: ${leakageGuard.removals_count} coluna(s) removida(s) por risco de vazamento.`,
          details: { removals_count: leakageGuard.removals_count },
        });
      }

      // Check if selected features contain leakage keywords
      const leakageReport = (modelingDataset as any).leakage_report as any[] || [];
      if (leakageReport.length > 0) {
        const criticalLeakage = leakageReport.filter((l: any) => l.reason?.includes("LEAKAGE") || l.reason?.includes("vazamento"));
        if (criticalLeakage.length > 0) {
          gates.push({
            gate: "leakage_guard",
            status: "WARN",
            message: `${criticalLeakage.length} coluna(s) com suspeita de leakage no dataset modelável.`,
            details: { leakage_columns: criticalLeakage.map((l: any) => l.column) },
          });
        }
      }
    }

    // ===== 4.8 CLASS BALANCE GATE =====
    const labelBuilder = aiCtx?.label_builder;
    if (labelBuilder?.preview_summary?.positive_rate) {
      const pr = labelBuilder.preview_summary.positive_rate;
      const topClassPct = Math.max(pr, 1 - pr);
      if (topClassPct > 0.90) {
        gates.push({
          gate: "class_balance",
          status: "WARN",
          message: `Desbalanceamento: classe dominante ${(topClassPct * 100).toFixed(1)}%. class_weight será aplicado automaticamente.`,
          details: { top_class_pct: topClassPct, auto_method: "class_weight" },
        });
      } else {
        gates.push({
          gate: "class_balance",
          status: "PASS",
          message: `Balanceamento OK (classe dominante: ${(topClassPct * 100).toFixed(1)}%).`,
        });
      }
    }

    // ===== 4.9.5 METRICS_PROFILE_RESOLVED GATE =====
    {
      // Check SSOT fields FIRST (project_settings.industry, objective), then AI context
      const ssotObjLower = String(ssotObjective || "").toLowerCase();
      const ssotIndLower = String(ssotIndustry || "").toLowerCase();
      const intentContract = aiCtx?.intent_contract || aiCtx?.intent || {};
      const intentBaseObj = intentContract.intent_base || intentContract;
      const domainAdapterObj = intentContract.domain_adapter || {};
      const aiObjective = String(intentBaseObj?.declared_objective || "").toLowerCase();
      const aiIndustry = String(domainAdapterObj?.industry || "").toLowerCase();
      const objective = ssotObjLower || aiObjective;
      const industry = ssotIndLower || aiIndustry;
      const problemType = String(projectSettings?.problem_type || (selection as any)?.problem_type || "").toLowerCase();
      const hasSpecificProfile = objective.includes("churn") || objective.includes("conversão") || objective.includes("conversion") || objective.includes("receita") || objective.includes("revenue") || objective.includes("no-show") || objective.includes("adesão") || objective.includes("inadimpl") || objective.includes("cancel") || objective.includes("evas") || objective.includes("propens") || objective.includes("propensity") || objective.includes("retenção") || objective.includes("retention") || objective.includes("engaj") || objective.includes("engag") || objective.includes("compra") || objective.includes("purchase") || objective.includes("inativ") || objective.includes("inactive") || industry.includes("saúde") || industry.includes("health") || industry.includes("food") || industry.includes("beverage") || industry.includes("retail") || industry.includes("varejo") || industry.includes("finance") || industry.includes("finanç") || industry.includes("bank") || industry.includes("educ") || industry.includes("telecom") || industry.includes("e-commerce") || industry.includes("ecommerce") || problemType === "regression";
      gates.push({
        gate: "metrics_profile",
        status: hasSpecificProfile ? "PASS" : "WARN",
        message: hasSpecificProfile
          ? `Perfil de métricas resolvido (${ssotIndustry ? ssotIndustry + " / " : ""}${ssotObjective ? ssotObjective.substring(0, 40) : problemType}).`
          : `Perfil de métricas genérico (fallback). Defina o objetivo do projeto para otimizar a métrica principal.`,
        details: { industry: ssotIndustry || aiIndustry, objective: ssotObjective || aiObjective, problem_type: problemType },
      });
    }

    // ===== 4.9.6 MIN_POSITIVES GATE =====
    {
      const lblBuilder = aiCtx?.label_builder;
      const pr = lblBuilder?.preview_summary?.positive_rate;
      if (pr != null) {
        const totalRows = (datasetState as any)?.row_count || 0;
        const positiveCount = Math.round(totalRows * pr);
        const negativeCount = totalRows - positiveCount;
        const minCount = Math.min(positiveCount, negativeCount);
        if (minCount < 30) {
          gates.push({
            gate: "min_positives",
            status: "BLOCK",
            message: `Classe minoritária com apenas ${minCount} exemplos. Mínimo recomendado: 30.`,
            details: { positive_count: positiveCount, negative_count: negativeCount },
          });
          canTrain = false;
        } else if (minCount < 100) {
          gates.push({
            gate: "min_positives",
            status: "WARN",
            message: `Classe minoritária com ${minCount} exemplos. Recomendado: >= 100 para boa generalização.`,
            details: { positive_count: positiveCount, negative_count: negativeCount },
          });
        }
      }
    }

    // ===== 4.9.7 CALIBRATION_READY GATE =====
    {
      const totalRows = (datasetState as any)?.row_count || 0;
      if (totalRows > 0 && totalRows < 500) {
        gates.push({
          gate: "calibration_ready",
          status: "WARN",
          message: `Dataset com ${totalRows} linhas — calibragem pode não ser confiável (recomendado: >= 500).`,
        });
      }
    }

    // ===== 4.9 TARGET QUALITY GATE (TDE Etapa D) =====
    if (projectSettings?.target_quality_report) {
      const tqr = projectSettings.target_quality_report as Record<string, any>;
      const qs = tqr.quality_score || 0;
      const leakSuspected = tqr.leakage_suspected || false;
      const hasBlock = (tqr.gates as any[] || []).some((g: any) => g.status === "BLOCK");
      const hasWarn = (tqr.gates as any[] || []).some((g: any) => g.status === "WARN");
      const stabilityNA = tqr.stability_na || false;
      const naDims = (tqr.na_dimensions as string[] || []);
      const naNote = naDims.length > 0 ? ` (${naDims.join(", ")} = N/A, pesos renormalizados)` : "";

      if (hasBlock || (leakSuspected && qs < 30)) {
        gates.push({
          gate: "target_quality",
          status: "BLOCK",
          message: `Qualidade do target insuficiente (${qs}/95). ${leakSuspected ? "Vazamento de dados detectado. " : ""}Corrija antes de treinar.${naNote}`,
          details: { quality_score: qs, leakage_suspected: leakSuspected, quality_label: tqr.quality_label, na_dimensions: naDims },
        });
        canTrain = false;
      } else if (hasWarn || qs < 60) {
        gates.push({
          gate: "target_quality",
          status: "WARN",
          message: `Qualidade do target ${tqr.quality_label || "regular"} (${qs}/95). Resultados podem ser limitados.${naNote}`,
          details: { quality_score: qs, quality_label: tqr.quality_label, stability_na: stabilityNA, na_dimensions: naDims },
        });
      } else {
        gates.push({
          gate: "target_quality",
          status: "PASS",
          message: `Qualidade do target ${tqr.quality_label || "boa"} (${qs}/95).${naNote}`,
          details: { quality_score: qs, na_dimensions: naDims },
        });
      }
    }

    // ===== 4.9.1 WEAK LABEL HEALTH GATE (TDE Etapa E) =====
    if (projectSettings?.target_source === "weak_supervision" && projectSettings?.weak_label_result) {
      const wlr = projectSettings.weak_label_result as Record<string, any>;
      const coverage = wlr.coverage || 0;
      const prevalence = wlr.prevalence || 0;
      const conflictRate = wlr.conflict_rate || 0;
      const avgConfidence = wlr.avg_confidence || 0;
      const agreementRate = wlr.agreement_rate || 0;

      if (coverage < 0.2) {
        gates.push({
          gate: "weak_label_health",
          status: "BLOCK",
          message: `Cobertura do target assistido muito baixa: ${(coverage * 100).toFixed(0)}%. Mínimo: 20%. Adicione mais dados ou ajuste as regras.`,
          details: { coverage, prevalence, conflict_rate: conflictRate },
        });
        canTrain = false;
      } else if (prevalence < 0.01 || prevalence > 0.99) {
        gates.push({
          gate: "weak_label_health",
          status: "BLOCK",
          message: `Prevalência extrema: ${(prevalence * 100).toFixed(1)}%. Target assistido degenerado — quase todos positivos ou negativos. Ajuste o limiar ou as regras.`,
          details: { prevalence, coverage },
        });
        canTrain = false;
      } else if (conflictRate > 0.6) {
        gates.push({
          gate: "weak_label_health",
          status: "BLOCK",
          message: `Conflito entre regras muito alto: ${(conflictRate * 100).toFixed(0)}%. Desative regras conflitantes antes de treinar.`,
          details: { conflict_rate: conflictRate, agreement_rate: agreementRate },
        });
        canTrain = false;
      } else if (avgConfidence < 0.3 || agreementRate < 0.5) {
        gates.push({
          gate: "weak_label_health",
          status: "WARN",
          message: `Target assistido com confiança ${avgConfidence < 0.3 ? "baixa" : "moderada"} (${(avgConfidence * 100).toFixed(0)}%). Resultados podem ser menos confiáveis.`,
          details: { avg_confidence: avgConfidence, agreement_rate: agreementRate },
        });
      } else {
        gates.push({
          gate: "weak_label_health",
          status: "PASS",
          message: `Target assistido OK: cobertura ${(coverage * 100).toFixed(0)}%, concordância ${(agreementRate * 100).toFixed(0)}%, confiança ${(avgConfidence * 100).toFixed(0)}%.`,
          details: { coverage, prevalence, agreement_rate: agreementRate, avg_confidence: avgConfidence },
        });
      }
    }

    // ===== 4.9.2 HUMAN LABEL HEALTH GATE (TDE Etapa F v2) =====
    if (projectSettings?.target_source === "human_labeling" && projectSettings?.human_label_result) {
      const hlr = projectSettings.human_label_result as Record<string, any>;
      const nLabeled = hlr.n_labeled || 0;
      const nPositive = hlr.n_positive || 0;
      const nNegative = hlr.n_negative || (nLabeled - nPositive);
      const minClass = Math.min(nPositive, nNegative);
      const seedMetrics = hlr.model_metrics as Record<string, any> | null;
      const seedAUC = seedMetrics?.auc || 0;

      // v2 thresholds: min_total = max(100, human_label_sample_size), min_per_class = 30
      const humanLabelConfig = projectSettings.human_label_config as Record<string, any> | null;
      const configuredSampleSize = humanLabelConfig?.human_label_sample_size || 200;
      const minTotalRequired = Math.max(100, configuredSampleSize);
      const MIN_PER_CLASS = 30;

      if (nLabeled < minTotalRequired) {
        gates.push({
          gate: "human_label_health",
          status: "BLOCK",
          message: `Apenas ${nLabeled} rótulos humanos. Mínimo: ${minTotalRequired}. Rotule mais entidades na Etapa 3.`,
          details: { n_labeled: nLabeled, min_required: minTotalRequired, n_positive: nPositive, n_negative: nNegative },
        });
        canTrain = false;
      } else if (nPositive === 0 || nNegative === 0) {
        const missingClass = nPositive === 0 ? "positivos" : "negativos";
        gates.push({
          gate: "human_label_health",
          status: "BLOCK",
          message: `Apenas uma classe rotulada (faltam ${missingClass}). Gere amostras direcionadas para encontrar exemplos.`,
          details: { n_positive: nPositive, n_negative: nNegative, reason_code: "ONLY_ONE_CLASS" },
        });
        canTrain = false;
      } else if (minClass < MIN_PER_CLASS) {
        const minorityClass = nPositive < nNegative ? "positivos" : "negativos";
        gates.push({
          gate: "human_label_health",
          status: "BLOCK",
          message: `Classe minoritária (${minorityClass}) com apenas ${minClass} exemplos. Mínimo: ${MIN_PER_CLASS}. Faltam ${MIN_PER_CLASS - minClass}.`,
          details: { n_positive: nPositive, n_negative: nNegative, min_class: minClass, reason_code: "MINORITY_CLASS_TOO_SMALL" },
        });
        canTrain = false;
      } else if (seedAUC < 0.6) {
        gates.push({
          gate: "human_label_health",
          status: "WARN",
          message: `Modelo seed com AUC baixo (${(seedAUC * 100).toFixed(0)}%). Resultados podem ser pouco confiáveis. Considere rotular mais casos.`,
          details: { auc: seedAUC, n_labeled: nLabeled },
        });
      } else {
        gates.push({
          gate: "human_label_health",
          status: "PASS",
          message: `Rotulagem OK: ${nLabeled} rótulos (${nPositive}+ / ${nNegative}−), AUC seed ${(seedAUC * 100).toFixed(0)}%.`,
          details: { n_labeled: nLabeled, n_positive: nPositive, n_negative: nNegative, auc: seedAUC, balance: hlr.balance },
        });
      }
    }

    // ===== 4.9.3 TARGET LIFECYCLE GATE (TDE Etapa G) =====
    {
      const { data: lifecycleSettings } = await supabase
        .from("project_settings")
        .select("target_lifecycle_state")
        .eq("project_id", project_id)
        .maybeSingle();
      const tls = (lifecycleSettings as any)?.target_lifecycle_state as Record<string, any> | null;
      if (tls && tls.target_health_score != null) {
        const tlsScore = tls.target_health_score || 0;
        const tlsStatus = tls.status || "ok";
        const hasLeakageReco = tls.recommendation?.type === "fix_leakage";
        if (tlsStatus === "alert" && hasLeakageReco) {
          gates.push({
            gate: "target_lifecycle",
            status: "BLOCK",
            message: `Ciclo de vida do target crítico (${tlsScore}/100). ${tls.recommendation?.message || "Corrija antes de treinar."}`,
            details: { score: tlsScore, status: tlsStatus, recommendation_type: tls.recommendation?.type },
          });
          canTrain = false;
        } else if (tlsStatus === "alert") {
          gates.push({
            gate: "target_lifecycle",
            status: "WARN",
            message: `Saúde do target em alerta (${tlsScore}/100). ${(tls.reasons as string[] || []).slice(0, 1).join(". ")}`,
            details: { score: tlsScore, status: tlsStatus },
          });
        } else if (tlsStatus === "warn") {
          gates.push({
            gate: "target_lifecycle",
            status: "WARN",
            message: `Saúde do target regular (${tlsScore}/100). ${(tls.reasons as string[] || []).slice(0, 1).join(". ")}`,
            details: { score: tlsScore, status: tlsStatus },
          });
        } else {
          gates.push({
            gate: "target_lifecycle",
            status: "PASS",
            message: `Ciclo de vida OK (${tlsScore}/100).`,
            details: { score: tlsScore },
          });
        }
      }
    }

    // ===== 4.9c TARGET_TRAINABLE GATE (unified via evaluateTargetTrainabilityFromSSOT) =====
    {
      const activeTarget = resolveActiveTarget(projectSettings || {});
      const targetCol = (selection as any)?.target_column || activeTarget.column || null;

      // Load full project_settings for the SSOT wrapper
      const { data: fullSettings } = await supabase
        .from("project_settings")
        .select("*")
        .eq("project_id", project_id)
        .maybeSingle();

      const problemType = (selection as any)?.problem_type || (projectSettings as any)?.problem_type || "classification";

      const ssotReport = await evaluateTargetTrainabilityFromSSOT({
        supabase,
        projectId: project_id,
        activeTargetMode: activeTarget.mode,
        targetColumn: targetCol,
        problemType,
        projectSettings: (fullSettings as any) || {},
      });

      // Persist report to SSOT
      await supabase.from("project_settings")
        .update({ target_trainability_report: ssotReport })
        .eq("project_id", project_id);

      if (!ssotReport.trainable) {
        gates.push({
          gate: "target_trainable",
          status: "BLOCK",
          message: ssotReport.message_user,
          details: {
            reason_code: ssotReport.reason_code,
            active_target_mode: ssotReport.details.mode,
            join_rows: ssotReport.details.join_rows,
            distinct_y: ssotReport.details.distinct_y,
            pos: ssotReport.details.pos,
            neg: ssotReport.details.neg,
            fix_suggestions: ssotReport.fix_suggestions,
          },
        });
        canTrain = false;
      } else if (ssotReport.warnings.length > 0) {
        gates.push({
          gate: "target_trainable",
          status: "WARN",
          message: ssotReport.warnings[0],
          details: {
            active_target_mode: ssotReport.details.mode,
            join_rows: ssotReport.details.join_rows,
            pos: ssotReport.details.pos,
            neg: ssotReport.details.neg,
          },
        });
      } else {
        gates.push({
          gate: "target_trainable",
          status: "PASS",
          message: `Target treinável (${ssotReport.details.join_rows} registros, ${ssotReport.details.distinct_y} classes, modo: ${ssotReport.details.mode}).`,
          details: {
            active_target_mode: ssotReport.details.mode,
            join_rows: ssotReport.details.join_rows,
            distinct_y: ssotReport.details.distinct_y,
            pos: ssotReport.details.pos,
            neg: ssotReport.details.neg,
          },
        });
      }
    }

    // ===== 4.9b AUDIT CONTRACT GATE =====
    const { data: latestAudit } = await supabase
      .from("project_contract_audits")
      .select("status, predictability_score, gates, summary")
      .eq("project_id", project_id)
      .eq("selection_version", selectionVersion)
      .order("audit_version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestAudit) {
      const auditStatus = latestAudit.status === "block" ? "BLOCK" : latestAudit.status === "warn" ? "WARN" : "PASS";
      gates.push({
        gate: "audit_contract",
        status: auditStatus,
        message: `Auditoria: score=${latestAudit.predictability_score}/100, status=${latestAudit.status}`,
        details: { predictability_score: latestAudit.predictability_score },
      });
      if (latestAudit.status === "block") canTrain = false;
    }

    // Derive final flags
    canDeploy = canTrain;
    canSchedule = canTrain;

    // Find first block for CTA
    const firstBlock = gates.find(g => g.status === "BLOCK");
    // Use explicit BUILDER_OUTDATED code when builder version mismatch is the issue
    let blockedReasonCode: string | null = null;
    if (firstBlock) {
      if (firstBlock.gate === "builder" && firstBlock.details?.stale_reason) {
        blockedReasonCode = "BUILDER_OUTDATED";
      } else {
        blockedReasonCode = firstBlock.gate?.toUpperCase() + "_BLOCK";
      }
    }

    const ctaMap: Record<string, string> = {
      dataset: "Voltar e importar dados",
      intent: "Gerar Intent Contract",
      selection: "Voltar e selecionar target",
      builder: "Voltar para Etapa 4 e Regerar Dataset Modelável",
      training_gate: "Revisar configuração do modelo",
      split_policy: "Configurar Split Policy na Etapa 4",
      leakage_guard: "Revisar colunas removidas por leakage",
      class_balance: "Configurar balanceamento de classes",
      audit_contract: "Rodar Auditoria do Contrato",
      target_quality: "Avaliar e corrigir qualidade do target na Etapa 3",
      target_trainable: "Voltar para Variável Alvo e Ajustar (Etapa 3)",
      weak_label_health: "Ajustar regras do Modo Assistido na Etapa 3",
      human_label_health: "Rotular mais entidades na Etapa 3",
      target_lifecycle: "Verificar Ciclo de Vida do Target na Etapa 3",
    };

    // ── Read SSOT staleness flags ──
    const { data: ssotPipelineData } = await supabase
      .from("project_settings")
      .select("staleness_flags, ingestion_state, eda_state, target_state, split_state, builder_state, training_state, scoring_state, dashboard_state, selection_version, dataset_version, training_version, scoring_version, dashboard_version")
      .eq("project_id", project_id)
      .maybeSingle();

    const ssotFlags = (ssotPipelineData as any)?.staleness_flags || {};
    const pipelineStates = ssotPipelineData ? {
      ingestion: (ssotPipelineData as any).ingestion_state,
      eda: (ssotPipelineData as any).eda_state,
      target: (ssotPipelineData as any).target_state,
      split: (ssotPipelineData as any).split_state,
      builder: (ssotPipelineData as any).builder_state,
      training: (ssotPipelineData as any).training_state,
      scoring: (ssotPipelineData as any).scoring_state,
      dashboard: (ssotPipelineData as any).dashboard_state,
    } : null;

    const versionTracking = ssotPipelineData ? {
      selection_version: (ssotPipelineData as any).selection_version,
      dataset_version: (ssotPipelineData as any).dataset_version,
      training_version: (ssotPipelineData as any).training_version,
      scoring_version: (ssotPipelineData as any).scoring_version,
      dashboard_version: (ssotPipelineData as any).dashboard_version,
    } : null;

    const result = {
      can_build: canBuild,
      can_train: canTrain,
      can_deploy: canDeploy,
      can_schedule: canSchedule,
      dashboard_allowed_precheck: dashboardAllowed,
      gates,
      blocked_reason_code: firstBlock ? blockedReasonCode : null,
      human_message: firstBlock?.message || "Tudo pronto para treinar.",
      action_cta: firstBlock ? ctaMap[firstBlock.gate] || "Corrigir problema" : null,
      selection_version: selectionVersion,
      selection_version_current: selectionVersion,
      selection_version_used_by_builder: builderSelVersion,
      builder_is_current: builderIsCurrent,
      builder_version: (modelingDataset as any)?.selection_version_used || 0,
      // ── SSOT State Machine ──
      pipeline_states: pipelineStates,
      staleness_flags: ssotFlags,
      version_tracking: versionTracking,
    };

    console.log(`[run-training-preflight] Result: can_train=${canTrain}, gates=${gates.length}`);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[run-training-preflight] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
