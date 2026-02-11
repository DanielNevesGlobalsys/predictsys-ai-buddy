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
    const [datasetStateRes, selectionRes, aiCtxRes, modelingDatasetRes, contractRes] = await Promise.all([
      supabase.from("project_dataset_state").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("*").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_ai_context").select("context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_modeling_datasets").select("*").eq("project_id", project_id).eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("project_modeling_contracts").select("*").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const datasetState = datasetStateRes.data;
    const selection = selectionRes.data;
    const aiCtx = (aiCtxRes.data?.context as Record<string, any>) || {};
    const modelingDataset = modelingDatasetRes.data;
    const contract = contractRes.data;

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
      gates.push({
        gate: "selection",
        status: feats.length === 0 ? "WARN" : "PASS",
        message: `Target: "${(selection as any).target_column}" (v${sv}), ${feats.length} features`,
        details: { target_column: (selection as any).target_column, selection_version: sv, features_count: feats.length },
      });
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

    // ===== 4.4 BUILDER GATE =====
    const selectionVersion = (selection as any)?.selection_version || 0;
    const builderSelVersion = modelingDataset ? ((modelingDataset as any).selection_version_used || 0) : null;
    const builderIsCurrent = modelingDataset
      ? ((modelingDataset as any).is_current !== false && builderSelVersion !== null && builderSelVersion >= selectionVersion)
      : false;

    if (modelingDataset) {
      const md = modelingDataset as any;
      const isCurrent = md.is_current !== false;
      const isReady = md.status === "ready" || md.status === "warning";

      if (!isCurrent || (selectionVersion > 0 && (builderSelVersion || 0) < selectionVersion)) {
        // Builder outdated — BLOCK
        gates.push({
          gate: "builder",
          status: "BLOCK",
          message: `Builder desatualizado (built v${builderSelVersion || 0}, current v${selectionVersion}). Regere o dataset modelável.`,
          details: { selection_version_used: builderSelVersion, current_version: selectionVersion, stale_reason: md.stale_reason },
        });
        canTrain = false;
      } else if (isCurrent && isReady) {
        gates.push({
          gate: "builder",
          status: md.status === "warning" ? "WARN" : "PASS",
          message: `Builder atual (v${builderSelVersion}). ${md.row_count} linhas, ${md.column_count} colunas.`,
          details: { selection_version_used: builderSelVersion, status: md.status },
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

    // Derive final flags
    canDeploy = canTrain;
    canSchedule = canTrain;

    // Find first block for CTA
    const firstBlock = gates.find(g => g.status === "BLOCK");
    const blockedReasonCode = firstBlock?.gate?.toUpperCase() + "_BLOCK" || null;

    const ctaMap: Record<string, string> = {
      dataset: "Voltar e importar dados",
      intent: "Gerar Intent Contract",
      selection: "Voltar e selecionar target",
      builder: "Gerar Dataset Modelável",
      training_gate: "Revisar configuração do modelo",
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
