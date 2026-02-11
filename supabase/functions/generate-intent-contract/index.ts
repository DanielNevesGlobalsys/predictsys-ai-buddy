import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface IntentContract {
  declared_objective: string;
  industry_hint: "retail" | "health" | "logistics" | "education" | "finance" | "generic";
  problem_type: "classification" | "regression" | "timeseries" | "segmentation";
  target_expected: "event" | "value" | "state_to_event";
  requires_time_column: boolean;
  default_window_days: number;
  label_builder_required: boolean;
  recommended_entity_key: string | null;
  recommended_metrics: string[];
  disallowed_metrics: string[];
  guardrails: {
    block_id_targets: boolean;
    block_leakage: boolean;
    block_constant_target: boolean;
  };
  version: number;
  created_at: string;
}

const SYSTEM_PROMPT = `Você é o motor de inferência de intenção do PredictSys. Dado o nome do projeto, descrição e objetivo declarado pelo usuário, gere um IntentContract JSON estruturado.

REGRAS:
1. Infira o industry_hint a partir do contexto (retail, health, logistics, education, finance, generic).
2. Determine o problem_type mais provável (classification, regression, timeseries, segmentation).
3. Defina target_expected: "event" para churn/conversão/inadimplência, "value" para receita/ticket/ltv, "state_to_event" para transições de estado.
4. requires_time_column = true se o problema envolver horizonte temporal (churn, inadimplência, previsão).
5. default_window_days: 30 para problemas de curto prazo, 60 para médio, 90 para longo.
6. label_builder_required = true se precisar construir a variável target a partir dos dados (ex: churn precisa definir "quem churnou").
7. recommended_entity_key: sugira "customer_id", "client_id", "user_id" etc. ou null se não souber.
8. recommended_metrics: liste métricas relevantes (ex: ["auc", "precision", "recall"] para classificação, ["rmse", "mae", "r2"] para regressão).
9. disallowed_metrics: métricas que não fazem sentido para o problema.
10. guardrails sempre devem ter block_id_targets=true, block_leakage=true, block_constant_target=true.

RESPONDA APENAS com JSON válido, sem markdown, sem explicações.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { project_id, project_name, project_description, declared_objective, organization_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!declared_objective || !declared_objective.trim()) {
      return new Response(
        JSON.stringify({ error: "declared_objective é obrigatório. Defina o objetivo do projeto para continuar." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[generate-intent-contract] project=${project_id} objective="${declared_objective}"`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Call Lovable AI to generate the contract
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    const userPrompt = `Projeto: "${project_name || 'Sem nome'}"
Descrição: "${project_description || 'Sem descrição'}"
Objetivo declarado: "${declared_objective}"

Gere o IntentContract JSON.`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${lovableApiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("[generate-intent-contract] AI error:", errText);
      throw new Error("Erro ao chamar IA para gerar contrato de intenção");
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";
    
    // Parse JSON from response (handle potential markdown wrapping)
    let contractJson: any;
    try {
      const cleanContent = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      contractJson = JSON.parse(cleanContent);
    } catch (parseErr) {
      console.error("[generate-intent-contract] Failed to parse AI response:", rawContent);
      throw new Error("IA retornou formato inválido para o contrato");
    }

    // Check existing context to determine version
    const { data: existing } = await supabase
      .from("project_ai_context")
      .select("id, context")
      .eq("project_id", project_id)
      .maybeSingle();

    const currentContext = (existing?.context as Record<string, any>) || {};
    const previousIntent = currentContext.intent;
    const previousVersion = previousIntent?.version || 0;

    // Build the final contract
    const intentContract: IntentContract = {
      declared_objective: declared_objective,
      industry_hint: contractJson.industry_hint || "generic",
      problem_type: contractJson.problem_type || "classification",
      target_expected: contractJson.target_expected || "event",
      requires_time_column: contractJson.requires_time_column ?? true,
      default_window_days: contractJson.default_window_days || 30,
      label_builder_required: contractJson.label_builder_required ?? false,
      recommended_entity_key: contractJson.recommended_entity_key || null,
      recommended_metrics: contractJson.recommended_metrics || [],
      disallowed_metrics: contractJson.disallowed_metrics || [],
      guardrails: {
        block_id_targets: true,
        block_leakage: true,
        block_constant_target: true,
      },
      version: previousVersion + 1,
      created_at: new Date().toISOString(),
    };

    // Save history if updating
    const intentHistory = currentContext.intent_history || [];
    if (previousIntent) {
      intentHistory.unshift({ ...previousIntent, _saved_at: new Date().toISOString() });
      if (intentHistory.length > 5) intentHistory.length = 5;
    }

    const updatedContext = {
      ...currentContext,
      intent: intentContract,
      intent_history: intentHistory,
    };

    // Resolve org_id
    let orgId = organization_id;
    if (!orgId) {
      const { data: proj } = await supabase
        .from("projects")
        .select("organization_id")
        .eq("id", project_id)
        .single();
      orgId = proj?.organization_id;
    }

    if (existing) {
      const { error: updateErr } = await supabase
        .from("project_ai_context")
        .update({
          context: updatedContext,
          last_updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (updateErr) throw new Error("Erro ao atualizar contexto: " + updateErr.message);
    } else {
      if (!orgId) {
        throw new Error("organization_id não encontrado para o projeto");
      }
      const { error: insertErr } = await supabase
        .from("project_ai_context")
        .insert({
          organization_id: orgId,
          project_id,
          context: updatedContext,
          status: "intent_defined",
        });

      if (insertErr) throw new Error("Erro ao criar contexto: " + insertErr.message);
    }

    // Audit log
    try {
      await supabase.from("audit_logs").insert({
        action: "config_updated",
        resource_type: "project",
        resource_name: `intent_contract_v${intentContract.version}`,
        project_id,
        organization_id: orgId,
        metadata: {
          event: "intent_contract_created",
          version: intentContract.version,
          declared_objective,
          problem_type: intentContract.problem_type,
        },
      });
    } catch (auditErr) {
      console.warn("[generate-intent-contract] Audit log failed:", auditErr);
    }

    console.log(`[generate-intent-contract] Contract v${intentContract.version} saved for project=${project_id}`);

    return new Response(
      JSON.stringify({
        success: true,
        intent_contract: intentContract,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[generate-intent-contract] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
