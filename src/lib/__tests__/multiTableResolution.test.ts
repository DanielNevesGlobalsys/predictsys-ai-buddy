import { describe, it, expect } from "vitest";
import {
  classifyTable,
  resolveMultiTableLayout,
  checkColumnBlock,
  rankTemporalColumns,
  detectGovernanceConflicts,
  getEntityTableAdjustment,
  getTimeTableAdjustment,
  type TableMetrics,
} from "@/lib/multiTableResolution";
import { AGRO_ADAPTER, RETAIL_ADAPTER, HEALTH_ADAPTER, getAdapter } from "@/lib/domainAdapters";

// ═══ SCENARIO 1: Fact + Dimension simples ═══════════════════

describe("Scenario 1: Fact + simple dimension", () => {
  const tables: TableMetrics[] = [
    { table_name: "Pedidos", row_count: 50000, has_numeric_measures: true, has_operational_dates: true },
    { table_name: "Clientes", row_count: 2000, has_numeric_measures: false, has_operational_dates: false },
  ];

  it("classifies Pedidos as fact and Clientes as dimension", () => {
    const layout = resolveMultiTableLayout(tables);
    expect(layout.primary_table).toBe("Pedidos");
    expect(layout.dimension_tables).toContain("Clientes");
  });

  it("entity and time adjustments favor fact table", () => {
    const layout = resolveMultiTableLayout(tables);
    const entityAdj = getEntityTableAdjustment("Pedidos.customer_id", layout);
    expect(entityAdj.adjustment).toBeGreaterThan(0);

    const dimAdj = getEntityTableAdjustment("Clientes.customer_id", layout);
    expect(dimAdj.adjustment).toBeLessThan(0);
  });
});

// ═══ SCENARIO 2: Dimension with high cardinality ═════════════

describe("Scenario 2: Dimension with high cardinality should not win", () => {
  const tables: TableMetrics[] = [
    { table_name: "Vendas", row_count: 100000, has_numeric_measures: true, has_operational_dates: true },
    {
      table_name: "Produtos", row_count: 80000,
      has_numeric_measures: false, has_operational_dates: false,
      columns: [
        { column_name: "cod_produto", inferred_type: "text" },
        { column_name: "descricao", inferred_type: "text" },
        { column_name: "categoria", inferred_type: "text" },
        { column_name: "marca", inferred_type: "text" },
      ],
    },
  ];

  it("Vendas remains primary fact despite Produtos having high row count", () => {
    const layout = resolveMultiTableLayout(tables, RETAIL_ADAPTER);
    expect(layout.primary_table).toBe("Vendas");
  });
});

// ═══ SCENARIO 3: Dimension with "última compra" date ═════════

describe("Scenario 3: Derived date from dimension loses to operational", () => {
  const columns = [
    { column_name: "Vendas.data_compra", inferred_type: "date" },
    { column_name: "Clientes.data_ult_compra", inferred_type: "date" },
    { column_name: "Clientes.data_cadastro", inferred_type: "date" },
  ];

  const tables: TableMetrics[] = [
    { table_name: "Vendas", row_count: 50000, has_numeric_measures: true, has_operational_dates: true },
    { table_name: "Clientes", row_count: 2000 },
  ];

  it("ranks data_compra (fact) above data_ult_compra (dimension)", () => {
    const layout = resolveMultiTableLayout(tables, RETAIL_ADAPTER);
    const ranked = rankTemporalColumns(columns, layout.classifications, RETAIL_ADAPTER);
    
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    expect(ranked[0].column).toBe("Vendas.data_compra");
    expect(ranked[0].category).toBe("operational_fact");
  });
});

// ═══ SCENARIO 4: SK_* as feature should be blocked ═══════════

describe("Scenario 4: SK_* blocked as feature", () => {
  it("blocks SK_COOPERADO as feature", () => {
    const result = checkColumnBlock("SK_COOPERADO", "feature", "dimension");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("SK");
  });

  it("blocks SK_DATA as feature", () => {
    const result = checkColumnBlock("SK_DATA", "feature", null);
    expect(result.blocked).toBe(true);
  });

  it("blocks sk_filial as feature", () => {
    const result = checkColumnBlock("sk_filial", "feature", "dimension");
    expect(result.blocked).toBe(true);
  });

  it("blocks SK_* as target", () => {
    const result = checkColumnBlock("SK_COOPERADO", "target", null);
    expect(result.blocked).toBe(true);
  });

  it("blocks CPF as feature", () => {
    const result = checkColumnBlock("cpf", "feature", null);
    expect(result.blocked).toBe(true);
  });

  it("blocks email as feature", () => {
    const result = checkColumnBlock("email", "feature", null);
    expect(result.blocked).toBe(true);
  });

  it("blocks matricula as feature", () => {
    const result = checkColumnBlock("matricula", "feature", null);
    expect(result.blocked).toBe(true);
  });
});

// ═══ SCENARIO 5: Calendar + Fact ═════════════════════════════

describe("Scenario 5: Calendar is auxiliary, not protagonist", () => {
  const tables: TableMetrics[] = [
    { table_name: "Detalhe Movimentação", row_count: 449000, has_numeric_measures: true, has_operational_dates: true },
    { table_name: "Calendário", row_count: 3650 },
  ];

  it("classifies Calendário as lookup_temporal", () => {
    const layout = resolveMultiTableLayout(tables, AGRO_ADAPTER);
    const calClass = layout.classifications.find(c => c.table_name === "Calendário");
    expect(calClass?.role).toMatch(/dimension|lookup_temporal/);
  });

  it("detects conflict when calendar is used as primary time", () => {
    const layout = resolveMultiTableLayout(tables, AGRO_ADAPTER);
    const conflicts = detectGovernanceConflicts(
      "Detalhe Movimentação.CODLOT",
      "Calendário.SK_DATA",
      [],
      layout,
    );
    const calConflict = conflicts.find(c => c.code === "DIMENSION_TIME_CONFLICT" || c.code === "CALENDAR_OVERPRIMARY_CONFLICT");
    expect(calConflict).toBeDefined();
  });
});

// ═══ SCENARIO 6: Multi-table agro ════════════════════════════

describe("Scenario 6: Multi-table agro with 8 tables", () => {
  const tables: TableMetrics[] = [
    { table_name: "Detalhe Movimentação", row_count: 449120, has_numeric_measures: true, has_operational_dates: true },
    { table_name: "Lote Café", row_count: 15000, has_numeric_measures: true, has_operational_dates: true },
    { table_name: "Cooperado", row_count: 3000, has_numeric_measures: false, has_operational_dates: false },
    { table_name: "Calendário", row_count: 3650, has_numeric_measures: false, has_operational_dates: false },
    { table_name: "Safra", row_count: 50, has_numeric_measures: false, has_operational_dates: false },
    { table_name: "Filial", row_count: 20, has_numeric_measures: false, has_operational_dates: false },
    { table_name: "Produtos", row_count: 200, has_numeric_measures: false, has_operational_dates: false },
    { table_name: "Representantes", row_count: 100, has_numeric_measures: false, has_operational_dates: false },
  ];

  it("picks Detalhe Movimentação as primary fact", () => {
    const layout = resolveMultiTableLayout(tables, AGRO_ADAPTER);
    expect(layout.primary_table).toBe("Detalhe Movimentação");
  });

  it("classifies all support tables as dimensions", () => {
    const layout = resolveMultiTableLayout(tables, AGRO_ADAPTER);
    expect(layout.dimension_tables).toContain("Cooperado");
    expect(layout.dimension_tables).toContain("Calendário");
    expect(layout.dimension_tables).toContain("Safra");
    expect(layout.dimension_tables).toContain("Filial");
  });

  it("blocks CELCPR, SK_COOPERADO, CODEMP as features", () => {
    for (const col of ["celcpr", "SK_COOPERADO", "codemp"]) {
      const block = checkColumnBlock(col, "feature", "dimension", AGRO_ADAPTER);
      expect(block.blocked).toBe(true);
    }
  });

  it("detects conflict if Cooperado.CELCPR is entity", () => {
    const layout = resolveMultiTableLayout(tables, AGRO_ADAPTER);
    const conflicts = detectGovernanceConflicts(
      "Cooperado.CELCPR",
      "Detalhe Movimentação.DATMOV",
      [],
      layout,
    );
    expect(conflicts.some(c => c.code === "DIMENSION_ENTITY_CONFLICT")).toBe(true);
  });

  it("ranks DATMOV above Cooperado dates", () => {
    const columns = [
      { column_name: "Detalhe Movimentação.DATMOV", inferred_type: "date" },
      { column_name: "Cooperado.Data Ult. Ent. Café", inferred_type: "date" },
      { column_name: "Cooperado.Data Ult. Compra", inferred_type: "date" },
      { column_name: "Calendário.SK_DATA", inferred_type: "date" },
    ];
    const layout = resolveMultiTableLayout(tables, AGRO_ADAPTER);
    const ranked = rankTemporalColumns(columns, layout.classifications, AGRO_ADAPTER);
    expect(ranked[0].column).toBe("Detalhe Movimentação.DATMOV");
  });
});

// ═══ SCENARIO 7: Non-agro domain (retail) ════════════════════

describe("Scenario 7: Retail multi-table works with generic rules", () => {
  const tables: TableMetrics[] = [
    { table_name: "Vendas", row_count: 200000, has_numeric_measures: true, has_operational_dates: true },
    { table_name: "Clientes", row_count: 10000 },
    { table_name: "Produtos", row_count: 5000 },
    { table_name: "Lojas", row_count: 50 },
  ];

  it("picks Vendas as primary fact with retail adapter", () => {
    const layout = resolveMultiTableLayout(tables, RETAIL_ADAPTER);
    expect(layout.primary_table).toBe("Vendas");
  });

  it("also works without any adapter (generic)", () => {
    const layout = resolveMultiTableLayout(tables);
    expect(layout.primary_table).toBe("Vendas");
  });

  it("blocks SK columns even in retail domain", () => {
    const block = checkColumnBlock("SK_CLIENTE", "feature", "dimension");
    expect(block.blocked).toBe(true);
  });
});

// ═══ Additional: getAdapter ══════════════════════════════════

describe("getAdapter", () => {
  it("returns agro adapter for 'agronegócio'", () => {
    expect(getAdapter("agronegócio").domain).toBe("agro");
  });

  it("returns retail adapter for 'varejo'", () => {
    expect(getAdapter("varejo").domain).toBe("retail");
  });

  it("returns health adapter for 'saúde'", () => {
    expect(getAdapter("saúde").domain).toBe("health");
  });

  it("returns generic for unknown industry", () => {
    expect(getAdapter("unknown_xyz").domain).toBe("generic");
  });
});
