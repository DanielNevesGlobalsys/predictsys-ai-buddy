import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ═══ Domain Adapter Definitions (server-side mirror) ═══════════

interface DomainAdapterTemplate {
  template_id: string;
  display_name: string;
  problem_type: string;
  description: string;
}

interface DomainAdapter {
  industry: string;
  display_name: string;
  entity_candidates: string[];
  time_candidates: string[];
  event_candidates: string[];
  value_candidates: string[];
  leakage_watchlist: string[];
  recommended_templates: DomainAdapterTemplate[];
  default_window_days: number;
  column_dictionary: Record<string, string>;
}

const DOMAIN_ADAPTERS: Record<string, DomainAdapter> = {
  retail: {
    industry: "retail",
    display_name: "Varejo",
    entity_candidates: ["customer_id", "client_id", "user_id", "cpf", "id_cliente"],
    time_candidates: ["purchase_date", "order_date", "dt_compra", "dt_pedido", "created_at"],
    event_candidates: ["churned", "converted", "cancelled", "returned", "is_active"],
    value_candidates: ["revenue", "ticket_medio", "total_gasto", "lifetime_value", "order_value"],
    leakage_watchlist: ["cancel_date", "churn_date", "last_purchase_date", "days_since_last_purchase"],
    recommended_templates: [
      { template_id: "churn_retail", display_name: "Churn de Clientes", problem_type: "classification", description: "Prevê quais clientes têm maior probabilidade de deixar de comprar." },
      { template_id: "conversao_lead", display_name: "Conversão de Leads", problem_type: "classification", description: "Prevê a probabilidade de um lead se tornar cliente." },
      { template_id: "ticket_medio", display_name: "Previsão de Ticket Médio", problem_type: "regression", description: "Estima o valor de compra esperado por cliente." },
    ],
    default_window_days: 90,
    column_dictionary: { customer_id: "Identificador único do cliente", purchase_date: "Data da compra", revenue: "Receita total" },
  },

  health: {
    industry: "health",
    display_name: "Saúde",
    entity_candidates: ["patient_id", "customer_id", "user_id", "cpf", "id_paciente", "prontuario"],
    time_candidates: ["appointment_date", "visit_date", "dt_consulta", "dt_evento", "dt_internacao", "admission_date"],
    event_candidates: ["missed_appointments", "no_show", "treatment_dropout", "cancelled_plan", "readmission", "abandono_tratamento", "falta_consulta"],
    value_candidates: ["cost", "custo_internacao", "valor_plano", "total_procedures"],
    leakage_watchlist: ["discharge_date", "outcome", "final_status", "death_date", "dt_alta", "dt_obito", "resultado_final", "desfecho"],
    recommended_templates: [
      { template_id: "adesao_tratamento", display_name: "Adesão ao Tratamento", problem_type: "classification", description: "Prevê a probabilidade de um paciente abandonar o tratamento prescrito." },
      { template_id: "no_show", display_name: "No-Show (Falta em Consulta)", problem_type: "classification", description: "Prevê quais pacientes têm maior probabilidade de faltar à consulta agendada." },
      { template_id: "demanda_consultas", display_name: "Demanda de Consultas", problem_type: "regression", description: "Estima o volume de consultas por período para planejamento de capacidade." },
    ],
    default_window_days: 60,
    column_dictionary: { patient_id: "Identificador único do paciente", appointment_date: "Data da consulta agendada", no_show: "Indicador de falta", discharge_date: "Data de alta (LEAKAGE)" },
  },

  logistics: {
    industry: "logistics",
    display_name: "Logística",
    entity_candidates: ["shipment_id", "order_id", "tracking_id", "id_entrega"],
    time_candidates: ["ship_date", "delivery_date", "dt_despacho", "dt_entrega"],
    event_candidates: ["delayed", "returned", "damaged", "lost", "atrasado"],
    value_candidates: ["shipping_cost", "lead_time_days", "distance_km"],
    leakage_watchlist: ["actual_delivery_date", "final_status", "resolution_date"],
    recommended_templates: [
      { template_id: "atraso_entrega", display_name: "Atraso na Entrega", problem_type: "classification", description: "Prevê a probabilidade de uma entrega atrasar." },
      { template_id: "lead_time", display_name: "Lead Time de Entrega", problem_type: "regression", description: "Estima o tempo de entrega em dias." },
    ],
    default_window_days: 30,
    column_dictionary: {},
  },

  education: {
    industry: "education",
    display_name: "Educação",
    entity_candidates: ["student_id", "aluno_id", "matricula", "user_id", "ra"],
    time_candidates: ["enrollment_date", "dt_matricula", "semester_start"],
    event_candidates: ["dropout", "evasao", "reprovado", "trancamento", "inativo"],
    value_candidates: ["gpa", "nota_media", "frequencia", "attendance_rate"],
    leakage_watchlist: ["final_grade", "graduation_date", "dt_conclusao", "resultado_final"],
    recommended_templates: [
      { template_id: "evasao_aluno", display_name: "Evasão Escolar", problem_type: "classification", description: "Prevê a probabilidade de um aluno abandonar o curso." },
      { template_id: "desempenho_academico", display_name: "Desempenho Acadêmico", problem_type: "regression", description: "Estima a nota/desempenho final do aluno." },
    ],
    default_window_days: 180,
    column_dictionary: {},
  },

  finance: {
    industry: "finance",
    display_name: "Finanças",
    entity_candidates: ["account_id", "customer_id", "cpf", "cnpj", "id_conta"],
    time_candidates: ["transaction_date", "due_date", "dt_vencimento", "dt_contrato"],
    event_candidates: ["defaulted", "inadimplente", "fraud", "churn", "atraso_pagamento"],
    value_candidates: ["loan_amount", "balance", "saldo", "valor_parcela"],
    leakage_watchlist: ["write_off_date", "collection_status", "final_status", "recovery_amount"],
    recommended_templates: [
      { template_id: "inadimplencia", display_name: "Inadimplência / Default", problem_type: "classification", description: "Prevê a probabilidade de inadimplência." },
      { template_id: "fraude", display_name: "Detecção de Fraude", problem_type: "classification", description: "Identifica transações com alta probabilidade de serem fraudulentas." },
    ],
    default_window_days: 90,
    column_dictionary: {},
  },

  generic: {
    industry: "generic",
    display_name: "Genérico",
    entity_candidates: ["id", "customer_id", "user_id", "entity_id"],
    time_candidates: ["created_at", "date", "timestamp", "dt_evento"],
    event_candidates: ["target", "label", "outcome", "event"],
    value_candidates: ["value", "amount", "score", "total"],
    leakage_watchlist: ["result", "final_status", "outcome_date"],
    recommended_templates: [
      { template_id: "classificacao_generica", display_name: "Classificação Genérica", problem_type: "classification", description: "Modelo de classificação genérico." },
      { template_id: "regressao_generica", display_name: "Regressão Genérica", problem_type: "regression", description: "Modelo de regressão genérico." },
    ],
    default_window_days: 30,
    column_dictionary: {},
  },
};

// ═══ AI System Prompt ══════════════════════════════════════════

const SYSTEM_PROMPT = `Você é o motor de inferência de intenção do PredictSys. Dado o nome do projeto, descrição, objetivo declarado e indústria selecionada pelo usuário, gere um IntentContract JSON estruturado.

REGRAS:
1. Use a industry fornecida. Se não fornecida, infira a partir do contexto.
2. Determine o problem_type mais provável (classification, regression, timeseries, segmentation).
3. Defina target_expected: "event" para churn/conversão/inadimplência/no-show, "value" para receita/ticket/ltv/demanda, "state_to_event" para transições de estado.
4. requires_time_column = true se o problema envolver horizonte temporal.
5. default_window_days: use o padrão da indústria ou infira do contexto.
6. label_builder_required = true se precisar construir a variável target a partir dos dados.
7. recommended_entity_key: sugira o candidato mais provável da indústria.
8. recommended_metrics: liste métricas relevantes.
9. disallowed_metrics: métricas que não fazem sentido para o problema.
10. guardrails sempre devem ter block_id_targets=true, block_leakage=true, block_constant_target=true.

RESPONDA APENAS com JSON válido, sem markdown, sem explicações. Schema:
{
  "industry_hint": "string",
  "problem_type": "string",
  "target_expected": "string",
  "requires_time_column": boolean,
  "default_window_days": number,
  "label_builder_required": boolean,
  "recommended_entity_key": "string|null",
  "recommended_metrics": ["string"],
  "disallowed_metrics": ["string"]
}`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      project_id,
      project_name,
      project_description,
      declared_objective,
      organization_id,
      industry, // NEW: explicit industry selection from UI
    } = await req.json();

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

    console.log(`[generate-intent-contract] project=${project_id} industry=${industry || "auto"} objective="${declared_objective}"`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    // ─── Call AI to infer intent ─────────────────────────────

    const userPrompt = `Projeto: "${project_name || 'Sem nome'}"
Descrição: "${project_description || 'Sem descrição'}"
Objetivo declarado: "${declared_objective}"
Indústria selecionada: "${industry || 'auto-detectar'}"

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

    let contractJson: any;
    try {
      const cleanContent = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      contractJson = JSON.parse(cleanContent);
    } catch (parseErr) {
      console.error("[generate-intent-contract] Failed to parse AI response:", rawContent);
      throw new Error("IA retornou formato inválido para o contrato");
    }

    // ─── Resolve industry ────────────────────────────────────

    const resolvedIndustry: string = industry || contractJson.industry_hint || "generic";
    const adapter: DomainAdapter = DOMAIN_ADAPTERS[resolvedIndustry] || DOMAIN_ADAPTERS.generic;

    // ─── Check existing context for versioning ───────────────

    const { data: existing } = await supabase
      .from("project_ai_context")
      .select("id, context")
      .eq("project_id", project_id)
      .maybeSingle();

    const currentContext = (existing?.context as Record<string, any>) || {};
    const previousContract = currentContext.intent_contract;
    const previousVersion = previousContract?.contract_version || previousContract?.version || 0;

    // ─── Build intent_base (universal) ───────────────────────

    const intent_base = {
      declared_objective,
      problem_type: contractJson.problem_type || "classification",
      target_expected: contractJson.target_expected || "event",
      requires_time_column: contractJson.requires_time_column ?? true,
      default_window_days: contractJson.default_window_days || adapter.default_window_days,
      label_builder_required: contractJson.label_builder_required ?? false,
      recommended_metrics: contractJson.recommended_metrics || [],
      disallowed_metrics: contractJson.disallowed_metrics || [],
      guardrails: {
        block_id_targets: true,
        block_leakage: true,
        block_constant_target: true,
      },
    };

    // ─── Build full v2 contract ──────────────────────────────

    const newVersion = previousVersion + 1;
    const intentContractV2 = {
      intent_base,
      domain_adapter: adapter,
      contract_version: newVersion,
      created_at: new Date().toISOString(),
    };

    // ─── Build legacy-compatible flat contract ───────────────

    const intentContractLegacy = {
      declared_objective,
      industry_hint: resolvedIndustry,
      problem_type: intent_base.problem_type,
      target_expected: intent_base.target_expected,
      requires_time_column: intent_base.requires_time_column,
      default_window_days: intent_base.default_window_days,
      label_builder_required: intent_base.label_builder_required,
      recommended_entity_key: contractJson.recommended_entity_key || adapter.entity_candidates[0] || null,
      recommended_metrics: intent_base.recommended_metrics,
      disallowed_metrics: intent_base.disallowed_metrics,
      guardrails: intent_base.guardrails,
      version: newVersion,
      created_at: intentContractV2.created_at,
    };

    // ─── History management ──────────────────────────────────

    const contractHistory = currentContext.intent_contract_history || [];
    if (previousContract) {
      contractHistory.unshift({ ...previousContract, _saved_at: new Date().toISOString() });
      if (contractHistory.length > 5) contractHistory.length = 5;
    }

    // ─── Persist to project_ai_context ───────────────────────

    const updatedContext = {
      ...currentContext,
      // v2 contract as SSOT
      intent_contract: intentContractV2,
      // Legacy flat format for backward compatibility
      intent: intentContractLegacy,
      intent_contract_history: contractHistory,
      // Also keep old intent_history for backward compat
      intent_history: currentContext.intent_history || [],
    };

    // Also push to intent_history (legacy)
    const intentHistory = updatedContext.intent_history || [];
    const previousIntent = currentContext.intent;
    if (previousIntent?.declared_objective) {
      intentHistory.unshift({ ...previousIntent, _saved_at: new Date().toISOString() });
      if (intentHistory.length > 5) intentHistory.length = 5;
    }
    updatedContext.intent_history = intentHistory;

    // ─── Resolve org_id ──────────────────────────────────────

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

    // ─── Audit log ───────────────────────────────────────────

    try {
      await supabase.from("audit_logs").insert({
        action: "config_updated",
        resource_type: "project",
        resource_name: `intent_contract_v${newVersion}`,
        project_id,
        organization_id: orgId,
        metadata: {
          event: "intent_contract_created",
          version: newVersion,
          declared_objective,
          problem_type: intent_base.problem_type,
          industry: resolvedIndustry,
          adapter_used: adapter.industry,
        },
      });
    } catch (auditErr) {
      console.warn("[generate-intent-contract] Audit log failed:", auditErr);
    }

    console.log(`[generate-intent-contract] Contract v${newVersion} (${resolvedIndustry}) saved for project=${project_id}`);

    // ─── Response: v2 + legacy for backward compat ───────────

    return new Response(
      JSON.stringify({
        success: true,
        // New v2 format
        intent_base,
        domain_adapter: adapter,
        contract_version: newVersion,
        created_at: intentContractV2.created_at,
        // Legacy flat format (backward compat)
        intent_contract: intentContractLegacy,
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
