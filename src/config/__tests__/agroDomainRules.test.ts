import { describe, it, expect } from "vitest";
import {
  scoreAgroColumn,
  rankAgroTargets,
  resolveAgroProblemType,
  runAgroGovernanceChecks,
  classifyAgroTable,
} from "../agroDomainRules";

// ─── Case A: Café / Captação ───────────────────────────────────

describe("Agro Target Scoring — Caso A: café/captação", () => {
  const columns = [
    { column_name: "Detalhe Movimentação.DATMOV", inferred_type: "datetime" },
    { column_name: "Detalhe Movimentação.QTDSAC", inferred_type: "numeric" },
    { column_name: "Detalhe Movimentação.CODLOT", inferred_type: "text" },
    { column_name: "Detalhe Movimentação.CODPES", inferred_type: "text" },
    { column_name: "Detalhe Movimentação.QTDPES", inferred_type: "numeric" },
  ];

  it("should rank QTDSAC as best target, not DATMOV", () => {
    const result = rankAgroTargets(columns, "captacao");
    expect(result.best_target).not.toBeNull();
    expect(result.best_target!.column).toContain("QTDSAC");
  });

  it("should identify DATMOV as time column", () => {
    const result = rankAgroTargets(columns, "captacao");
    expect(result.best_time).not.toBeNull();
    expect(result.best_time!.column).toContain("DATMOV");
  });

  it("should block DATMOV as target", () => {
    const score = scoreAgroColumn("Detalhe Movimentação.DATMOV", "datetime", "captacao");
    expect(score.blocked_as_target).toBe(true);
  });

  it("should identify CODLOT as entity", () => {
    const result = rankAgroTargets(columns, "captacao");
    expect(result.best_entity).not.toBeNull();
    expect(result.best_entity!.column).toContain("CODLOT");
  });
});

// ─── Case B: Soja / Produção ──────────────────────────────────

describe("Agro Target Scoring — Caso B: soja/produção", () => {
  const columns = [
    { column_name: "data_colheita", inferred_type: "date" },
    { column_name: "toneladas", inferred_type: "numeric" },
    { column_name: "fazenda_id", inferred_type: "text" },
  ];

  it("should rank toneladas as best target", () => {
    const result = rankAgroTargets(columns, "producao");
    expect(result.best_target).not.toBeNull();
    expect(result.best_target!.column).toBe("toneladas");
  });

  it("should block data_colheita as target", () => {
    const score = scoreAgroColumn("data_colheita", "date", "producao");
    expect(score.blocked_as_target).toBe(true);
  });
});

// ─── Case C: Erro proposital — só data ────────────────────────

describe("Agro Target Scoring — Caso C: only date columns", () => {
  const columns = [
    { column_name: "data_movimento", inferred_type: "datetime" },
    { column_name: "ano", inferred_type: "integer" },
    { column_name: "mes", inferred_type: "integer" },
  ];

  it("should find no valid target", () => {
    const result = rankAgroTargets(columns, "producao");
    expect(result.best_target).toBeNull();
  });
});

// ─── Case D: Multi-table agro ─────────────────────────────────

describe("Agro Table Classification — Case D: multi-table", () => {
  it("should classify Calendário as dimension_lookup_temporal", () => {
    const role = classifyAgroTable("Calendário", [
      { column_name: "Mês", inferred_type: "text" },
      { column_name: "Ano", inferred_type: "integer" },
    ]);
    expect(role.role).toBe("dimension_lookup_temporal");
  });

  it("should classify Detalhe Movimentação as event_fact", () => {
    const role = classifyAgroTable("Detalhe Movimentação", [
      { column_name: "QTDSAC", inferred_type: "numeric" },
      { column_name: "DATMOV", inferred_type: "datetime" },
      { column_name: "CODLOT", inferred_type: "text" },
    ]);
    expect(role.role).toBe("event_fact");
  });
});

// ─── Case E: Classificação agro ───────────────────────────────

describe("Agro Problem Type — Case E: classification", () => {
  it("should resolve risco_nao_entrega as classification", () => {
    expect(resolveAgroProblemType("risco_nao_entrega")).toBe("classification");
  });

  it("should resolve captacao as regression", () => {
    expect(resolveAgroProblemType("previsao_captacao")).toBe("regression");
  });

  it("should return null for unknown objectives", () => {
    expect(resolveAgroProblemType("something_random")).toBeNull();
  });
});

// ─── Governance Checks ────────────────────────────────────────

describe("Agro Governance Checks", () => {
  it("should block temporal target", () => {
    const checks = runAgroGovernanceChecks({
      industry: "agro",
      objective: "captacao",
      targetColumn: "DATMOV",
      timeColumn: "DATMOV",
      entityKey: "CODLOT",
      problemType: "regression",
      grain: "entity_time",
      splitStrategy: "temporal",
      columns: [
        { column_name: "DATMOV", inferred_type: "datetime" },
        { column_name: "QTDSAC", inferred_type: "numeric" },
        { column_name: "CODLOT", inferred_type: "text" },
      ],
    });
    const block = checks.find(c => c.check_id === "agro_target_temporal_conflict");
    expect(block).toBeDefined();
    expect(block!.severity).toBe("block");
  });

  it("should block non-quantitative target for production objective", () => {
    const checks = runAgroGovernanceChecks({
      industry: "agro",
      objective: "producao",
      targetColumn: "tipo_movimento",
      timeColumn: "DATMOV",
      entityKey: "CODLOT",
      problemType: "regression",
      grain: "entity_time",
      splitStrategy: "temporal",
      columns: [
        { column_name: "DATMOV", inferred_type: "datetime" },
        { column_name: "tipo_movimento", inferred_type: "text" },
        { column_name: "CODLOT", inferred_type: "text" },
      ],
    });
    const block = checks.find(c => c.check_id === "agro_problem_target_mismatch");
    expect(block).toBeDefined();
    expect(block!.severity).toBe("block");
  });

  it("should warn when split is not temporal with valid time", () => {
    const checks = runAgroGovernanceChecks({
      industry: "agro",
      objective: "captacao",
      targetColumn: "QTDSAC",
      timeColumn: "DATMOV",
      entityKey: "CODLOT",
      problemType: "regression",
      grain: "entity_time",
      splitStrategy: "stratified",
      columns: [
        { column_name: "DATMOV", inferred_type: "datetime" },
        { column_name: "QTDSAC", inferred_type: "numeric" },
        { column_name: "CODLOT", inferred_type: "text" },
      ],
    });
    const warn = checks.find(c => c.check_id === "agro_split_conflict");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("warning");
  });
});
