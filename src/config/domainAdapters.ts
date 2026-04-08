// ═══════════════════════════════════════════════════════════════════
// Domain Adapters — Industry-specific defaults for Intent Contract
// ═══════════════════════════════════════════════════════════════════

import type { DomainAdapter, IndustryKey } from "@/types/intentContract";

const ADAPTERS: Record<IndustryKey, DomainAdapter> = {
  retail: {
    industry: "retail",
    display_name: "Varejo",
    entity_candidates: ["customer_id", "client_id", "user_id", "cpf", "id_cliente"],
    time_candidates: ["purchase_date", "order_date", "dt_compra", "dt_pedido", "created_at"],
    event_candidates: ["churned", "converted", "cancelled", "returned", "is_active"],
    value_candidates: ["revenue", "ticket_medio", "total_gasto", "lifetime_value", "order_value"],
    leakage_watchlist: ["cancel_date", "churn_date", "last_purchase_date", "days_since_last_purchase"],
    recommended_templates: [
      {
        template_id: "churn_retail",
        display_name: "Churn de Clientes",
        problem_type: "classification",
        description: "Prevê quais clientes têm maior probabilidade de deixar de comprar nos próximos N dias.",
      },
      {
        template_id: "conversao_lead",
        display_name: "Conversão de Leads",
        problem_type: "classification",
        description: "Prevê a probabilidade de um lead se tornar cliente.",
      },
      {
        template_id: "ticket_medio",
        display_name: "Previsão de Ticket Médio",
        problem_type: "regression",
        description: "Estima o valor de compra esperado por cliente.",
      },
    ],
    default_window_days: 90,
    column_dictionary: {
      customer_id: "Identificador único do cliente",
      purchase_date: "Data da compra ou transação",
      revenue: "Receita total da transação",
      ticket_medio: "Valor médio por compra",
    },
  },

  health: {
    industry: "health",
    display_name: "Saúde",
    entity_candidates: ["patient_id", "customer_id", "user_id", "cpf", "id_paciente", "prontuario"],
    time_candidates: ["appointment_date", "visit_date", "dt_consulta", "dt_evento", "dt_internacao", "admission_date"],
    event_candidates: [
      "missed_appointments", "no_show", "treatment_dropout", "cancelled_plan",
      "readmission", "abandono_tratamento", "falta_consulta",
    ],
    value_candidates: ["cost", "custo_internacao", "valor_plano", "total_procedures"],
    leakage_watchlist: [
      "discharge_date", "outcome", "final_status", "death_date",
      "dt_alta", "dt_obito", "resultado_final", "desfecho",
    ],
    recommended_templates: [
      {
        template_id: "adesao_tratamento",
        display_name: "Adesão ao Tratamento",
        problem_type: "classification",
        description: "Prevê a probabilidade de um paciente abandonar o tratamento prescrito.",
      },
      {
        template_id: "no_show",
        display_name: "No-Show (Falta em Consulta)",
        problem_type: "classification",
        description: "Prevê quais pacientes têm maior probabilidade de faltar à consulta agendada.",
      },
      {
        template_id: "demanda_consultas",
        display_name: "Demanda de Consultas",
        problem_type: "regression",
        description: "Estima o volume de consultas por período para planejamento de capacidade.",
      },
    ],
    default_window_days: 60,
    column_dictionary: {
      patient_id: "Identificador único do paciente",
      appointment_date: "Data da consulta agendada",
      no_show: "Indicador de falta (1=faltou, 0=compareceu)",
      treatment_dropout: "Indicador de abandono de tratamento",
      missed_appointments: "Número de consultas perdidas",
      discharge_date: "Data de alta (LEAKAGE — não usar como feature)",
    },
  },

  logistics: {
    industry: "logistics",
    display_name: "Logística",
    entity_candidates: ["shipment_id", "order_id", "tracking_id", "id_entrega", "id_pedido"],
    time_candidates: ["ship_date", "delivery_date", "dt_despacho", "dt_entrega", "created_at"],
    event_candidates: ["delayed", "returned", "damaged", "lost", "atrasado", "extraviado"],
    value_candidates: ["shipping_cost", "lead_time_days", "distance_km", "weight_kg"],
    leakage_watchlist: ["actual_delivery_date", "final_status", "resolution_date"],
    recommended_templates: [
      {
        template_id: "atraso_entrega",
        display_name: "Atraso na Entrega",
        problem_type: "classification",
        description: "Prevê a probabilidade de uma entrega atrasar.",
      },
      {
        template_id: "lead_time",
        display_name: "Lead Time de Entrega",
        problem_type: "regression",
        description: "Estima o tempo de entrega em dias.",
      },
    ],
    default_window_days: 30,
    column_dictionary: {
      shipment_id: "Identificador do envio",
      lead_time_days: "Tempo de entrega em dias",
    },
  },

  education: {
    industry: "education",
    display_name: "Educação",
    entity_candidates: ["student_id", "aluno_id", "matricula", "user_id", "ra"],
    time_candidates: ["enrollment_date", "dt_matricula", "semester_start", "created_at"],
    event_candidates: ["dropout", "evasao", "reprovado", "trancamento", "inativo"],
    value_candidates: ["gpa", "nota_media", "frequencia", "attendance_rate"],
    leakage_watchlist: ["final_grade", "graduation_date", "dt_conclusao", "resultado_final"],
    recommended_templates: [
      {
        template_id: "evasao_aluno",
        display_name: "Evasão Escolar",
        problem_type: "classification",
        description: "Prevê a probabilidade de um aluno abandonar o curso.",
      },
      {
        template_id: "desempenho_academico",
        display_name: "Desempenho Acadêmico",
        problem_type: "regression",
        description: "Estima a nota/desempenho final do aluno.",
      },
    ],
    default_window_days: 180,
    column_dictionary: {
      student_id: "Identificador único do aluno",
      dropout: "Indicador de evasão",
    },
  },

  finance: {
    industry: "finance",
    display_name: "Finanças",
    entity_candidates: ["account_id", "customer_id", "cpf", "cnpj", "id_conta", "id_cliente"],
    time_candidates: ["transaction_date", "due_date", "dt_vencimento", "dt_contrato", "created_at"],
    event_candidates: ["defaulted", "inadimplente", "fraud", "churn", "atraso_pagamento"],
    value_candidates: ["loan_amount", "balance", "saldo", "valor_parcela", "credit_limit"],
    leakage_watchlist: ["write_off_date", "collection_status", "final_status", "recovery_amount"],
    recommended_templates: [
      {
        template_id: "inadimplencia_por_atraso",
        display_name: "Inadimplência por Atraso",
        problem_type: "classification",
        description: "Prevê inadimplência com base no atraso de pagamento em dias.",
      },
      {
        template_id: "inadimplencia_por_status",
        display_name: "Inadimplência por Status",
        problem_type: "classification",
        description: "Prevê inadimplência com base na coluna de status do pagamento.",
      },
      {
        template_id: "fraude",
        display_name: "Detecção de Fraude",
        problem_type: "classification",
        description: "Identifica transações com alta probabilidade de serem fraudulentas.",
      },
    ],
    default_window_days: 90,
    column_dictionary: {
      account_id: "Identificador da conta",
      defaulted: "Indicador de inadimplência",
    },
  },

  agro: {
    industry: "agro",
    display_name: "Agro",
    entity_candidates: [
      "produtor", "cooperado", "cooperativa", "fazenda", "talhao", "lote",
      "codlot", "codpes", "filial", "unidade", "regiao", "propriedade",
      "fornecedor", "cod_produtor", "id_produtor", "codemp",
    ],
    time_candidates: [
      "datmov", "data_movimento", "data_recebimento", "data_entrega",
      "data_colheita", "data_plantio", "data_pesagem", "dt_movimento",
      "dt_recebimento", "dt_colheita", "created_at",
    ],
    event_candidates: [
      "quebra_safra", "nao_entrega", "inadimplente", "desvio_padrao",
      "cancelado", "devolvido", "rejeitado",
    ],
    value_candidates: [
      "qtdsac", "qtdpes", "peso", "peso_liquido", "peso_bruto",
      "volume", "producao", "captacao", "recebimento", "sacas",
      "toneladas", "kg", "rendimento", "produtividade",
      "valor_recebido", "valor_total", "litros", "arrobas",
    ],
    leakage_watchlist: [
      "resultado_final", "status_final", "data_liquidacao",
      "valor_liquidado", "data_encerramento",
    ],
    recommended_templates: [
      {
        template_id: "previsao_captacao",
        display_name: "Previsão de Captação",
        problem_type: "regression",
        description: "Prevê o volume de captação (sacas, kg, toneladas) por produtor/lote por período.",
      },
      {
        template_id: "previsao_producao",
        display_name: "Previsão de Produção",
        problem_type: "regression",
        description: "Estima a produção futura por fazenda, talhão ou região.",
      },
      {
        template_id: "previsao_safra",
        display_name: "Previsão de Safra",
        problem_type: "regression",
        description: "Prevê o volume total de safra por período e região.",
      },
      {
        template_id: "risco_nao_entrega",
        display_name: "Risco de Não-Entrega",
        problem_type: "classification",
        description: "Identifica produtores/lotes com risco de não cumprir a entrega contratada.",
      },
    ],
    default_window_days: 90,
    column_dictionary: {
      qtdsac: "Quantidade de sacas",
      qtdpes: "Quantidade pesada",
      datmov: "Data da movimentação",
      codlot: "Código do lote de café",
      codpes: "Código da pessoa/produtor",
      peso: "Peso da mercadoria",
      producao: "Volume de produção",
      captacao: "Volume captado",
      rendimento: "Rendimento por área/período",
    },
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
      {
        template_id: "classificacao_generica",
        display_name: "Classificação Genérica",
        problem_type: "classification",
        description: "Modelo de classificação binária para qualquer caso de uso.",
      },
      {
        template_id: "regressao_generica",
        display_name: "Regressão Genérica",
        problem_type: "regression",
        description: "Modelo de regressão para prever valores numéricos.",
      },
    ],
    default_window_days: 30,
    column_dictionary: {},
  },
};

export function getDomainAdapter(industry: IndustryKey): DomainAdapter {
  return ADAPTERS[industry] || ADAPTERS.generic;
}

export function hasAdapter(industry: string): boolean {
  return industry in ADAPTERS;
}

export function getAllIndustries(): { key: IndustryKey; display_name: string }[] {
  return Object.entries(ADAPTERS).map(([key, adapter]) => ({
    key: key as IndustryKey,
    display_name: adapter.display_name,
  }));
}

export { ADAPTERS as DOMAIN_ADAPTERS };
