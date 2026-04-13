// ═══════════════════════════════════════════════════════════════════
// Domain Adapters — Industry-specific vocabulary and boosts
// These extend the universal multi-table resolution with
// domain knowledge. Core rules live in multiTableResolution.ts.
// ═══════════════════════════════════════════════════════════════════

import type { DomainAdapter } from "./multiTableResolution";

export const AGRO_ADAPTER: DomainAdapter = {
  domain: "agro",
  factTableTokens: [
    "movimenta", "detalhe", "recebimento", "pesagem",
    "lote", "lote_cafe", "lotecaf", "operacao",
  ],
  dimensionTableTokens: [
    "cooperado", "safra", "filial", "representante",
    "origem", "produtor", "fazenda", "grupo_economico",
    "municipio",
  ],
  adminIdPatterns: [
    "celcpr", "cel_cpr", "codpes", "sk_cooperado", "sk_pessoa",
    "sk_filial", "sk_produto", "sk_representante", "sk_origem", "sk_safra",
  ],
  operationalDateTokens: [
    "datmov", "data_movimentacao", "data_recebimento",
    "data_pesagem", "data_colheita", "data_plantio", "dt_movimento",
  ],
  entityBoosts: [
    { pattern: "codlot", tier: 1 },
    { pattern: "cod_lote", tier: 1 },
    { pattern: "lote", tier: 1 },
    { pattern: "cod_talhao", tier: 1 },
    { pattern: "talhao", tier: 1 },
    { pattern: "codpes", tier: 2 },
    { pattern: "cod_produtor", tier: 2 },
    { pattern: "cooperado", tier: 2 },
    { pattern: "fazenda", tier: 2 },
    { pattern: "codgre", tier: 3 },
    { pattern: "cod_grupo", tier: 3 },
  ],
  valueBoosts: [
    "qtd", "sacas", "peso", "volume", "producao", "captacao",
    "recebimento", "rendimento", "produtividade", "tonelada",
    "kg", "litro", "quantidade", "qtdpes", "qtdsac",
  ],
};

export const RETAIL_ADAPTER: DomainAdapter = {
  domain: "retail",
  factTableTokens: [
    "venda", "sale", "pedido", "order", "compra", "purchase",
    "transacao", "transaction", "item_pedido", "line_item",
    "carrinho", "cart", "checkout",
  ],
  dimensionTableTokens: [
    "cliente", "customer", "produto", "product",
    "loja", "store", "categoria", "category",
    "fornecedor", "supplier", "vendedor", "seller",
    "campanha", "campaign", "promocao", "promotion",
  ],
  adminIdPatterns: [
    "cod_cliente", "customer_code", "seller_code",
  ],
  operationalDateTokens: [
    "data_compra", "purchase_date", "order_date",
    "data_pedido", "data_venda", "sale_date",
    "data_entrega", "delivery_date",
  ],
  entityBoosts: [
    { pattern: "customer_id", tier: 1 },
    { pattern: "id_cliente", tier: 1 },
    { pattern: "cpf", tier: 1 },
    { pattern: "cnpj", tier: 2 },
  ],
  valueBoosts: [
    "valor", "value", "amount", "total", "revenue", "receita",
    "ticket", "price", "preco", "custo", "cost", "desconto", "discount",
  ],
};

export const HEALTH_ADAPTER: DomainAdapter = {
  domain: "health",
  factTableTokens: [
    "atendimento", "attendance", "consulta", "visit",
    "internacao", "admission", "sinistro", "claim",
    "procedimento", "procedure", "exame", "exam",
    "prescricao", "prescription",
  ],
  dimensionTableTokens: [
    "paciente", "patient", "medico", "doctor", "physician",
    "hospital", "clinic", "clinica", "especialidade", "specialty",
    "convenio", "insurance", "plano", "plan",
    "cid", "icd", "diagnostico", "diagnosis",
  ],
  adminIdPatterns: [
    "prontuario", "medical_record", "crm",
  ],
  operationalDateTokens: [
    "data_internacao", "admission_date",
    "data_consulta", "visit_date", "appointment_date",
    "data_alta", "discharge_date",
    "data_sinistro", "claim_date",
  ],
  entityBoosts: [
    { pattern: "patient_id", tier: 1 },
    { pattern: "id_paciente", tier: 1 },
    { pattern: "prontuario", tier: 1 },
    { pattern: "cpf", tier: 2 },
  ],
  valueBoosts: [
    "valor", "value", "custo", "cost", "amount",
    "valor_sinistro", "claim_amount", "coparticipacao",
  ],
};

export const FINANCE_ADAPTER: DomainAdapter = {
  domain: "finance",
  factTableTokens: [
    "transacao", "transaction", "lancamento", "entry",
    "pagamento", "payment", "cobranca", "billing",
    "contrato", "contract", "emprestimo", "loan",
    "parcela", "installment",
  ],
  dimensionTableTokens: [
    "cliente", "customer", "conta", "account",
    "agencia", "branch", "produto", "product",
    "modalidade", "modality", "segmento", "segment",
  ],
  adminIdPatterns: [
    "numero_conta", "account_number", "agencia_code",
  ],
  operationalDateTokens: [
    "data_transacao", "transaction_date",
    "data_pagamento", "payment_date",
    "data_vencimento", "due_date",
    "data_contratacao", "contract_date",
  ],
  entityBoosts: [
    { pattern: "account_id", tier: 1 },
    { pattern: "id_conta", tier: 1 },
    { pattern: "contract_id", tier: 1 },
    { pattern: "cpf", tier: 2 },
    { pattern: "cnpj", tier: 2 },
  ],
  valueBoosts: [
    "valor", "value", "saldo", "balance", "amount",
    "principal", "juros", "interest", "parcela", "installment",
    "receita", "revenue", "margem", "spread",
  ],
};

export const EDUCATION_ADAPTER: DomainAdapter = {
  domain: "education",
  factTableTokens: [
    "matricula", "enrollment", "frequencia", "attendance",
    "nota", "grade", "avaliacao", "assessment",
    "mensalidade", "tuition",
  ],
  dimensionTableTokens: [
    "aluno", "student", "professor", "teacher",
    "disciplina", "course", "turma", "class",
    "campus", "unidade", "unit",
  ],
  adminIdPatterns: ["ra", "registro_academico"],
  operationalDateTokens: [
    "data_matricula", "enrollment_date",
    "data_aula", "class_date",
    "data_prova", "exam_date",
  ],
  entityBoosts: [
    { pattern: "student_id", tier: 1 },
    { pattern: "id_aluno", tier: 1 },
    { pattern: "ra", tier: 1 },
    { pattern: "matricula", tier: 2 },
  ],
  valueBoosts: ["nota", "grade", "score", "frequencia", "attendance_rate"],
};

export const LOGISTICS_ADAPTER: DomainAdapter = {
  domain: "logistics",
  factTableTokens: [
    "remessa", "shipment", "entrega", "delivery",
    "pedido", "order", "carga", "load",
    "viagem", "trip", "rota", "route",
    "rastreamento", "tracking",
  ],
  dimensionTableTokens: [
    "transportadora", "carrier", "motorista", "driver",
    "veiculo", "vehicle", "deposito", "warehouse",
    "destino", "destination", "remetente", "sender",
  ],
  adminIdPatterns: ["tracking_code", "placa", "license_plate"],
  operationalDateTokens: [
    "data_embarque", "ship_date",
    "data_entrega", "delivery_date",
    "data_coleta", "pickup_date",
  ],
  entityBoosts: [
    { pattern: "order_id", tier: 1 },
    { pattern: "shipment_id", tier: 1 },
    { pattern: "tracking", tier: 2 },
  ],
  valueBoosts: ["peso", "weight", "volume", "frete", "freight", "custo", "cost", "distancia", "distance"],
};

// ─── Adapter Registry ──────────────────────────────────────────

const ADAPTER_REGISTRY: Record<string, DomainAdapter> = {
  agro: AGRO_ADAPTER,
  agronegocio: AGRO_ADAPTER,
  agriculture: AGRO_ADAPTER,
  retail: RETAIL_ADAPTER,
  varejo: RETAIL_ADAPTER,
  ecommerce: RETAIL_ADAPTER,
  health: HEALTH_ADAPTER,
  saude: HEALTH_ADAPTER,
  healthcare: HEALTH_ADAPTER,
  finance: FINANCE_ADAPTER,
  financeiro: FINANCE_ADAPTER,
  banking: FINANCE_ADAPTER,
  education: EDUCATION_ADAPTER,
  educacao: EDUCATION_ADAPTER,
  logistics: LOGISTICS_ADAPTER,
  logistica: LOGISTICS_ADAPTER,
  supply_chain: LOGISTICS_ADAPTER,
};

const GENERIC_ADAPTER: DomainAdapter = {
  domain: "generic",
  factTableTokens: [],
  dimensionTableTokens: [],
  adminIdPatterns: [],
  operationalDateTokens: [],
  entityBoosts: [],
  valueBoosts: [],
};

/**
 * Get the domain adapter for a given industry string.
 * Falls back to generic (empty) adapter.
 */
export function getAdapter(industry: string): DomainAdapter {
  const lo = (industry || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  // Try exact match first
  if (ADAPTER_REGISTRY[lo]) return ADAPTER_REGISTRY[lo];
  // Try partial match
  for (const [key, adapter] of Object.entries(ADAPTER_REGISTRY)) {
    if (lo.includes(key) || key.includes(lo)) return adapter;
  }
  return GENERIC_ADAPTER;
}

/**
 * Detect domain from project settings or intent contract.
 */
export function detectDomainFromSettings(settings: Record<string, any>): DomainAdapter {
  const industry = (
    settings?.industry ||
    settings?.intent_contract_v3?.business_context?.industry ||
    settings?.business_intent_contract?.industry ||
    ""
  );
  return getAdapter(industry);
}
