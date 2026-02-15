import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    // Parallel fetch all needed data
    const [datasetStateRes, selectionRes, aiCtxRes, modelingDatasetRes, versionMatchedDatasetRes, contractRes, splitPolicyRes] = await Promise.all([
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
    ]);

    const datasetState = datasetStateRes.data;
    const selection = selectionRes.data;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const modelingDatasetIsCurrent = modelingDatasetRes.data;
    const versionMatchedDataset = versionMatchedDatasetRes.data;
    const contract = contractRes.data;
    // Prefer version-matched dataset, then is_current, to avoid stale reads
    const modelingDataset = versionMatchedDataset || modelingDatasetIsCurrent;

    const gates: GateResult[] = [];
    let canBuild = true;
    let canTrain = true;
    let canDeploy = true;
    let canSchedule = true;
    let dashboardAllowed = true;

    // ===== 4.1 DATASET GATE =====
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
      // Fallback: check import_manifests
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
        gates.push({
          gate: "dataset",
          status: "BLOCK",
          message: "Nenhum dataset ativo. Importe dados ou conecte uma fonte.",
        });
        canBuild = false;
        canTrain = false;
      }
    }

    // ===== 4.2 INTENT/CONTRACT GATE =====
    const hasIntent = !!(aiCtx?.intent?.objective);
    gates.push({
      gate: "intent",
      status: hasIntent ? "PASS" : "WARN",
      message: hasIntent
        ? `Intent definido: ${aiCtx.intent.objective?.substring(0, 60)}`
        : "Intent Contract não definido. Recomendado: gere na Etapa 1.",
    });

    // ===== 4.3 SELECTION GATE =====
    if (selection && (selection as any).target_column) {
      const sv = (selection as any).selection_version || 1;
      const feats = (selection as any).selected_features as string[] || [];
      const targetCol = (selection as any).target_column as string;
      const isLabelBuilder = targetCol === "_label_";

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
            details: { target_column: targetCol, label_builder_missing: true },
          });
          canBuild = false;
          canTrain = false;
        } else {
          gates.push({
            gate: "selection",
            status: feats.length === 0 ? "WARN" : "PASS",
            message: `Target derivado via template "${lblBuilder.template_id}" (v${sv}), ${feats.length} features`,
            details: { target_column: targetCol, selection_version: sv, features_count: feats.length, label_builder_id: lblBuilder.id },
          });
        }
      }

      if (!isLabelBuilder || labelBuilderOk) {
        if (!isLabelBuilder) {
          gates.push({
            gate: "selection",
            status: feats.length === 0 ? "WARN" : "PASS",
            message: `Target: "${targetCol}" (v${sv}), ${feats.length} features`,
            details: { target_column: targetCol, selection_version: sv, features_count: feats.length },
          });
        }
      }
    } else {
      // Fallback: check project_settings
      const { data: settings } = await supabase
        .from("project_settings")
        .select("target_column, feature_columns")
        .eq("project_id", project_id)
        .maybeSingle();

      if (settings?.target_column) {
        gates.push({
          gate: "selection",
          status: "WARN",
          message: `Target via settings: "${settings.target_column}" (sem versionamento)`,
          details: { target_column: settings.target_column, legacy: true },
        });
      } else {
        gates.push({
          gate: "selection",
          status: "BLOCK",
          message: "Nenhum target selecionado. Volte à Etapa 3 e selecione o target.",
        });
        canBuild = false;
        canTrain = false;
      }
    }

    // ===== 4.4 BUILDER GATE (SSOT cross-validation) =====
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
      gates.push({
        gate: "builder",
        status: "BLOCK",
        message: "Feature Builder ainda não foi executado. Gere o dataset modelável.",
      });
      canBuild = true;
      canTrain = false;
    }

    // ===== 4.5 TRAINING GATE (from builder's gate report) =====
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
    const intentContract = aiCtx?.intent_contract || aiCtx?.intent || {};
    const intentBase = intentContract.intent_base || intentContract;
    const requiresTime = intentBase.requires_time_column ?? false;
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
    };

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
