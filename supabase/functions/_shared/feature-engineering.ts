/**
 * Feature Engineering Shared Utilities
 * 
 * This module provides declarative feature transformations that are applied
 * consistently across EDA, training, and batch predictions.
 */

// ==================== Types ====================

export type FeatureExpression =
  | {
      type: "ratio";
      numerator: string;
      denominator: string;
      eps?: number;
    }
  | {
      type: "difference";
      minuend: string;
      subtrahend: string;
    }
  | {
      type: "sum";
      columns: string[];
    }
  | {
      type: "binary_flag";
      column: string;
      op: ">" | ">=" | "<" | "<=" | "==" | "!=";
      value: number;
    }
  | {
      type: "log1p";
      column: string;
    };

export interface ProjectFeature {
  id: string;
  project_id: string;
  name: string;
  label: string;
  description?: string;
  enabled: boolean;
  expression: FeatureExpression;
}

export type RawRecord = Record<string, string | number | boolean | null>;
export type FeatureValues = Record<string, number | string | boolean | null>;

// ==================== Helper Functions ====================

/**
 * Safely parse a value to number
 */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  
  if (typeof value === "number") {
    return isNaN(value) ? null : value;
  }
  
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  
  if (typeof value === "string") {
    // Handle comma as decimal separator (common in PT-BR)
    const normalized = value.trim().replace(",", ".");
    const parsed = parseFloat(normalized);
    return isNaN(parsed) ? null : parsed;
  }
  
  return null;
}

/**
 * Get numeric value from record, treating missing/invalid as null
 */
function getNumericValue(record: RawRecord, column: string): number | null {
  const value = record[column];
  return toNumber(value);
}

// ==================== Expression Evaluators ====================

function evaluateRatio(
  record: RawRecord,
  expr: Extract<FeatureExpression, { type: "ratio" }>
): number | null {
  const numerator = getNumericValue(record, expr.numerator);
  const denominator = getNumericValue(record, expr.denominator);
  const eps = expr.eps ?? 1e-6;
  
  if (numerator === null) return null;
  if (denominator === null || Math.abs(denominator) < eps) {
    // Division by zero or near-zero: return 0 to avoid NaN/Infinity
    return 0;
  }
  
  return numerator / denominator;
}

function evaluateDifference(
  record: RawRecord,
  expr: Extract<FeatureExpression, { type: "difference" }>
): number | null {
  const minuend = getNumericValue(record, expr.minuend);
  const subtrahend = getNumericValue(record, expr.subtrahend);
  
  // Treat missing values as 0 for difference
  const a = minuend ?? 0;
  const b = subtrahend ?? 0;
  
  return a - b;
}

function evaluateSum(
  record: RawRecord,
  expr: Extract<FeatureExpression, { type: "sum" }>
): number | null {
  if (!expr.columns || expr.columns.length === 0) {
    return null;
  }
  
  let sum = 0;
  let hasAnyValue = false;
  
  for (const col of expr.columns) {
    const value = getNumericValue(record, col);
    if (value !== null) {
      sum += value;
      hasAnyValue = true;
    }
    // Missing columns are treated as 0
  }
  
  // Return null only if ALL columns were missing
  return hasAnyValue ? sum : null;
}

function evaluateBinaryFlag(
  record: RawRecord,
  expr: Extract<FeatureExpression, { type: "binary_flag" }>
): number | null {
  const value = getNumericValue(record, expr.column);
  
  if (value === null) return null;
  
  let result: boolean;
  
  switch (expr.op) {
    case ">":
      result = value > expr.value;
      break;
    case ">=":
      result = value >= expr.value;
      break;
    case "<":
      result = value < expr.value;
      break;
    case "<=":
      result = value <= expr.value;
      break;
    case "==":
      result = value === expr.value;
      break;
    case "!=":
      result = value !== expr.value;
      break;
    default:
      return null;
  }
  
  return result ? 1 : 0;
}

function evaluateLog1p(
  record: RawRecord,
  expr: Extract<FeatureExpression, { type: "log1p" }>
): number | null {
  const value = getNumericValue(record, expr.column);
  
  if (value === null) return null;
  
  // log(1 + x) is undefined for x <= -1
  if (value <= -1) return null;
  
  return Math.log(1 + value);
}

// ==================== Main Function ====================

/**
 * Apply all enabled feature transformations to a record.
 * 
 * @param record - The original row data (already parsed)
 * @param features - List of configured features for the project
 * @returns Object containing only the new feature columns
 */
export function applyFeatureTransforms(
  record: RawRecord,
  features: ProjectFeature[]
): FeatureValues {
  const result: FeatureValues = {};
  
  for (const feature of features) {
    // Skip disabled features
    if (!feature.enabled) continue;
    
    // Skip if expression is invalid
    if (!feature.expression || !feature.expression.type) continue;
    
    let value: number | string | boolean | null = null;
    
    try {
      switch (feature.expression.type) {
        case "ratio":
          value = evaluateRatio(record, feature.expression as Extract<FeatureExpression, { type: "ratio" }>);
          break;
          
        case "difference":
          value = evaluateDifference(record, feature.expression as Extract<FeatureExpression, { type: "difference" }>);
          break;
          
        case "sum":
          value = evaluateSum(record, feature.expression as Extract<FeatureExpression, { type: "sum" }>);
          break;
          
        case "binary_flag":
          value = evaluateBinaryFlag(record, feature.expression as Extract<FeatureExpression, { type: "binary_flag" }>);
          break;
          
        case "log1p":
          value = evaluateLog1p(record, feature.expression as Extract<FeatureExpression, { type: "log1p" }>);
          break;
          
        default:
          // Unknown expression type, skip
          continue;
      }
    } catch (err) {
      // If any error occurs during evaluation, set to null and continue
      console.error(`Error evaluating feature ${feature.name}:`, err);
      value = null;
    }
    
    result[feature.name] = value;
  }
  
  return result;
}

/**
 * Enrich a record with feature values
 */
export function enrichRecord(
  record: RawRecord,
  features: ProjectFeature[]
): RawRecord {
  const featureValues = applyFeatureTransforms(record, features);
  return { ...record, ...featureValues };
}

/**
 * Get feature names from a list of features
 */
export function getFeatureNames(features: ProjectFeature[]): string[] {
  return features.filter(f => f.enabled).map(f => f.name);
}
