# 🔍 Auditoria de Coerência do Sistema PredictSys

> Gerado em: 2026-02-12  
> Escopo: Contratos, Estados, Invariantes e Pontos de Fragilidade

---

## Índice

1. [As 10 Invariantes Canônicas](#1-as-10-invariantes-canônicas)
2. [Detalhamento por Invariante](#2-detalhamento-por-invariante)
3. [Os 5 Pontos Mais Prováveis de Causar Modelo Fraco](#3-os-5-pontos-mais-prováveis-de-causar-modelo-fraco)

---

## 1. As 10 Invariantes Canônicas

| # | Invariante | Severidade |
|---|-----------|------------|
| I1 | Se `project_dataset_state.model_ready = true` → existe `project_modeling_datasets` com `is_current = true` e `status ≠ 'blocked'` | 🔴 Crítica |
| I2 | Se `project_dataset_state.production_model_id IS NOT NULL` → `project_models` possui registro com `status = 'completed'`, `is_production = true`, e `hyperparameters` contém `artifacts`, `normalization_stats` e `feature_names` | 🔴 Crítica |
| I3 | Se `project_scoring_jobs.status = 'done'` → existem registros em `predictions` com `is_latest = true` e `batch_id` correspondente ao job | 🔴 Crítica |
| I4 | Se `project_dataset_state.eda_ready = true` → existem registros em `project_columns`, `project_numeric_stats` e/ou `project_categorical_stats` para o projeto | 🟡 Alta |
| I5 | `project_model_selection.selection_version` ≥ `project_models.deployed_selection_version` para o modelo em produção (nunca o modelo pode ter uma versão de seleção *futura*) | 🔴 Crítica |
| I6 | Se `project_model_selection.target_column` existe → essa coluna aparece em `project_columns.column_name` para o mesmo projeto | 🟡 Alta |
| I7 | Se existe `project_score_reports` para um `batch_id` → existem `predictions` com o mesmo `batch_id` e `is_latest = true` | 🔴 Crítica |
| I8 | Se `project_modeling_contracts.status = 'READY'` → `problem_type` do contrato é semanticamente igual ao `project_model_selection.problem_type` (considerando aliases: binary ↔ classification) | 🟡 Alta |
| I9 | Se `project_dataset_state.manifest_id IS NOT NULL` → existe `import_manifests` com esse `id` e `status ∈ ('ok', 'warn')` (nunca referenciando manifesto com `status = 'fail'`) | 🟡 Alta |
| I10 | Para qualquer projeto, no máximo UM `project_models` pode ter `is_production = true` ao mesmo tempo | 🔴 Crítica |

---

## 2. Detalhamento por Invariante

### I1 — Dataset State → Modeling Dataset Exists

**Enunciado:** Se `project_dataset_state.model_ready = true`, então deve existir pelo menos um registro em `project_modeling_datasets` com `is_current = true` e `status ≠ 'blocked'`.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_dataset_state` | `model_ready` | `= true` |
| `project_modeling_datasets` | `is_current` | `= true` |
| `project_modeling_datasets` | `status` | `≠ 'blocked'` |
| `project_modeling_datasets` | `project_id` | `= project_dataset_state.project_id` |

**Função Responsável:**
- `build-modeling-dataset` (Edge Function) — é quem cria/atualiza `project_modeling_datasets` e seta `is_current = true` ao final.
- `process-import` / `parse-file` — são quem atualizam `project_dataset_state.model_ready`.

**Falha Típica:**
- O `process-import` seta `model_ready = true` no `project_dataset_state` mas o `build-modeling-dataset` falha silenciosamente (timeout, erro de parsing do dataset). Resultado: o pipeline prossegue para a tela de treinamento mas não encontra o dataset de modelagem.
- **Detecção:** `SELECT * FROM project_dataset_state WHERE model_ready = true AND project_id NOT IN (SELECT project_id FROM project_modeling_datasets WHERE is_current = true AND status != 'blocked')`

---

### I2 — Production Model → Artefatos Completos

**Enunciado:** Se `project_dataset_state.production_model_id` não é nulo, o modelo referenciado deve ter `status = 'completed'`, `is_production = true`, e `hyperparameters` deve conter as chaves `artifacts`, `normalization_stats` e `feature_names`.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_dataset_state` | `production_model_id` | `IS NOT NULL` |
| `project_models` | `id` | `= production_model_id` |
| `project_models` | `status` | `= 'completed'` |
| `project_models` | `is_production` | `= true` |
| `project_models` | `hyperparameters->artifacts` | `IS NOT NULL` |
| `project_models` | `hyperparameters->normalization_stats` | Presente |
| `project_models` | `hyperparameters->feature_names` | Presente (array não vazio) |

**Função Responsável:**
- `train-models` — persiste `hyperparameters` com os artefatos.
- `deploy-model` — seta `is_production = true` e atualiza `project_dataset_state.production_model_id`.

**Falha Típica:**
- `train-models` completa mas o JSONB de `hyperparameters` excede o limite prático (~256KB), truncando `artifacts` ou `normalization_stats`. O `deploy-model` referencia o modelo, mas o `run-batch-predictions` falha ao deserializar.
- **Detecção:** `SELECT pm.id, pg_column_size(pm.hyperparameters) as hp_size, pm.hyperparameters ? 'artifacts' as has_artifacts, pm.hyperparameters ? 'feature_names' as has_features FROM project_models pm WHERE pm.is_production = true AND (NOT (pm.hyperparameters ? 'artifacts') OR NOT (pm.hyperparameters ? 'feature_names'))`

---

### I3 — Scoring Job Done → Predictions Exist

**Enunciado:** Se um `project_scoring_jobs` tem `status = 'done'`, devem existir registros em `predictions` com `is_latest = true` e `batch_id` correspondente.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_scoring_jobs` | `status` | `= 'done'` |
| `project_scoring_jobs` | `batch_id` | valor a cruzar |
| `predictions` | `batch_id` | `= scoring_job.batch_id` |
| `predictions` | `is_latest` | `= true` |
| `predictions` | `project_id` | `= scoring_job.project_id` |

**Função Responsável:**
- `run-batch-predictions` — executa o scoring em multi-pass e insere predictions. Ao final, promove `is_latest = true` para o batch mais recente.

**Falha Típica:**
- **Race condition na promoção de `is_latest`**: O multi-pass faz `UPDATE predictions SET is_latest = false WHERE project_id = X` seguido de `UPDATE predictions SET is_latest = true WHERE batch_id = Y`. Se dois jobs concorrem, o segundo pode despromover o primeiro antes dele finalizar.
- **Detecção:** `SELECT sj.id, sj.batch_id, sj.status, COUNT(p.id) as pred_count FROM project_scoring_jobs sj LEFT JOIN predictions p ON p.batch_id = sj.batch_id AND p.is_latest = true WHERE sj.status = 'done' GROUP BY sj.id HAVING COUNT(p.id) = 0`

---

### I4 — EDA Ready → Stats Existem

**Enunciado:** Se `project_dataset_state.eda_ready = true`, devem existir registros populados em `project_columns` e pelo menos uma das tabelas de estatísticas (`project_numeric_stats` ou `project_categorical_stats`).

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_dataset_state` | `eda_ready` | `= true` |
| `project_columns` | `project_id` | `= project_id` (COUNT > 0) |
| `project_numeric_stats` | `project_id` | COUNT > 0 OU |
| `project_categorical_stats` | `project_id` | COUNT > 0 |

**Função Responsável:**
- `calculate-eda` — popula `project_columns`, `project_numeric_stats`, `project_categorical_stats`.
- `process-import` — seta `eda_ready` no `project_dataset_state`.

**Falha Típica:**
- `calculate-eda` falha parcialmente (ex: dataset muito grande, timeout) e a flag `eda_ready` permanece `true` de uma execução anterior, mas as stats são de um schema antigo (colunas diferentes).
- **Detecção:** `SELECT pds.project_id FROM project_dataset_state pds WHERE pds.eda_ready = true AND NOT EXISTS (SELECT 1 FROM project_columns pc WHERE pc.project_id = pds.project_id)`

---

### I5 — Selection Version ≥ Deployed Version

**Enunciado:** A `selection_version` no `project_model_selection` deve ser ≥ ao `deployed_selection_version` do modelo em produção. Um modelo nunca pode ter sido implantado com uma versão de seleção futura.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_model_selection` | `selection_version` | valor atual |
| `project_models` | `deployed_selection_version` | ≤ `selection_version` |
| `project_models` | `is_production` | `= true` |

**Função Responsável:**
- `deploy-model` — grava `deployed_selection_version` no momento do deploy.
- `upsert-model-selection` / `rpc_upsert_model_selection` — incrementa `selection_version`.

**Falha Típica:**
- O usuário altera target/features (incrementando `selection_version`), treina um novo modelo, mas o `deploy-model` é chamado com um modelo antigo que ainda referencia a versão anterior. Se o sistema não valida, o modelo antigo é promovido com features defasadas.
- **Detecção:** `SELECT pms.project_id, pms.selection_version, pm.deployed_selection_version FROM project_model_selection pms JOIN project_models pm ON pm.project_id = pms.project_id AND pm.is_production = true WHERE pm.deployed_selection_version > pms.selection_version`

---

### I6 — Target Column Existe nas Colunas do Projeto

**Enunciado:** O `target_column` definido em `project_model_selection` deve existir como registro em `project_columns` para o mesmo projeto.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_model_selection` | `target_column` | `IS NOT NULL` |
| `project_columns` | `column_name` | `= target_column` |
| `project_columns` | `project_id` | `= model_selection.project_id` |

**Função Responsável:**
- `upsert-model-selection` — valida (parcialmente) se o target é válido.
- `calculate-eda` — popula `project_columns`.
- `run-training-preflight` — gate que deveria bloquear se target não existe.

**Falha Típica:**
- Usuário faz re-upload de dataset com schema diferente (coluna renomeada ou removida). O `calculate-eda` recria `project_columns` mas o `project_model_selection.target_column` mantém o valor antigo. O treinamento é bloqueado mas a UI pode não mostrar a razão claramente.
- **Detecção:** `SELECT pms.project_id, pms.target_column FROM project_model_selection pms WHERE pms.target_column IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_columns pc WHERE pc.project_id = pms.project_id AND pc.column_name = pms.target_column)`

---

### I7 — Score Report → Predictions Existem

**Enunciado:** Se existe um `project_score_reports` para um `batch_id`, deve haver predictions com esse `batch_id` e `is_latest = true`.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_score_reports` | `batch_id` | valor a cruzar |
| `predictions` | `batch_id` | `= report.batch_id` |
| `predictions` | `is_latest` | `= true` |

**Função Responsável:**
- `run-batch-predictions` — cria o `project_score_reports` após inserir e promover predictions.
- `calculate-dashboard-metrics` — lê os reports para gerar KPIs.

**Falha Típica:**
- Um novo scoring roda e promove `is_latest = false` para o batch anterior, mas o `project_score_reports` do batch antigo permanece. O dashboard pode referenciar um report cujas predictions não são mais `is_latest`, gerando métricas inconsistentes.
- **Detecção:** `SELECT psr.id, psr.batch_id FROM project_score_reports psr WHERE NOT EXISTS (SELECT 1 FROM predictions p WHERE p.batch_id = psr.batch_id AND p.is_latest = true)`

---

### I8 — Contract ↔ Selection Problem Type Match

**Enunciado:** Se o `project_modeling_contracts` está `READY`, seu `problem_type` deve ser semanticamente igual ao do `project_model_selection`.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_modeling_contracts` | `status` | `= 'READY'` |
| `project_modeling_contracts` | `contract_json->problem_type` | valor |
| `project_model_selection` | `problem_type` | semanticamente igual |

**Função Responsável:**
- `upsert-model-selection` — sincroniza `problem_type` no contrato automaticamente.
- `generate-intent-contract` — cria o contrato inicial.

**Falha Típica:**
- O usuário muda o `problem_type` via UI (ex: de `classification` para `regression`) e o `upsert-model-selection` atualiza a seleção, mas falha ao sincronizar o contrato (ex: contrato locked). O `run-training-preflight` detecta `CONTRACT_PROBLEM_TYPE_MISMATCH` e bloqueia.
- **Detecção:** `SELECT pms.project_id, pms.problem_type as sel_type, pmc.contract_json->>'problem_type' as contract_type FROM project_model_selection pms JOIN project_modeling_contracts pmc ON pmc.project_id = pms.project_id WHERE pmc.status = 'READY' AND pms.problem_type IS NOT NULL AND pmc.contract_json->>'problem_type' IS NOT NULL AND LOWER(pms.problem_type) NOT IN (LOWER(pmc.contract_json->>'problem_type')) AND NOT (LOWER(pms.problem_type) IN ('binary','classification') AND LOWER(pmc.contract_json->>'problem_type') IN ('binary','classification'))`

---

### I9 — Dataset State Manifest → Manifest Válido

**Enunciado:** Se `project_dataset_state.manifest_id` não é nulo, o manifesto referenciado deve existir e ter `status ∈ ('ok', 'warn')`.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_dataset_state` | `manifest_id` | `IS NOT NULL` |
| `import_manifests` | `id` | `= manifest_id` |
| `import_manifests` | `status` | `∈ ('ok', 'warn')` |

**Função Responsável:**
- `process-import` — cria o manifesto e atualiza `project_dataset_state.manifest_id`.

**Falha Típica:**
- Um re-import falha e o manifesto fica com `status = 'fail'`, mas o `project_dataset_state.manifest_id` ainda referencia esse manifesto falho porque a atualização do state aconteceu antes da consolidação final do manifesto.
- **Detecção:** `SELECT pds.project_id, pds.manifest_id, im.status FROM project_dataset_state pds JOIN import_manifests im ON im.id = pds.manifest_id WHERE im.status NOT IN ('ok', 'warn')`

---

### I10 — Unicidade de Modelo em Produção

**Enunciado:** Para cada projeto, no máximo um modelo pode ter `is_production = true`.

**Tabelas/Campos a Checar:**
| Tabela | Campo | Condição |
|--------|-------|----------|
| `project_models` | `is_production` | `= true` |
| `project_models` | `project_id` | agrupamento |

**Função Responsável:**
- `deploy-model` — deve fazer `UPDATE project_models SET is_production = false WHERE project_id = X AND is_production = true` antes de promover o novo.

**Falha Típica:**
- Duas chamadas concorrentes de `deploy-model` (ex: usuário clica duas vezes rapidamente). Sem lock transacional, ambas podem promover modelos diferentes, resultando em dois modelos `is_production = true`. O `run-batch-predictions` pode pegar qualquer um deles.
- **Detecção:** `SELECT project_id, COUNT(*) as prod_count FROM project_models WHERE is_production = true GROUP BY project_id HAVING COUNT(*) > 1`

---

## 3. Os 5 Pontos Mais Prováveis de Causar Modelo Fraco

### 3.1 — Target Degenerado

**Problema:** A variável alvo tem distribuição que impede aprendizado real.

**Manifestações:**
| Tipo | Descrição | Threshold |
|------|-----------|-----------|
| Classe dominante | Uma classe representa >90% dos casos | `top_class_pct > 0.90` |
| Cardinalidade 1 | Target tem apenas 1 valor distinto | `distinct_count = 1` |
| ID sequencial | Target é na verdade um identificador (1, 2, 3...) | Pattern: incremental integers |
| Variância zero (regressão) | Todos os valores são iguais | `std_value = 0` |

**Como Detectar:**

```sql
-- Classificação: classe dominante
SELECT pcs.column_name, pcs.distinct_count, pcs.top_categories
FROM project_categorical_stats pcs
JOIN project_model_selection pms ON pms.project_id = pcs.project_id
WHERE pcs.column_name = pms.target_column
  AND pcs.distinct_count <= 1;

-- Regressão: variância zero
SELECT pns.column_name, pns.std_value, pns.min_value, pns.max_value
FROM project_numeric_stats pns
JOIN project_model_selection pms ON pms.project_id = pns.project_id
WHERE pns.column_name = pms.target_column
  AND (pns.std_value = 0 OR pns.std_value IS NULL);
```

**Onde Aparece nos Logs:**
- `audit-project-pipeline` → `stages.target.status = 'error'` com observação sobre cardinalidade ou dominância.
- `run-training-preflight` → bloqueia com código `TARGET_DEGENERATE`.
- `project_column_inference` → `can_be_target = false` com `block_reasons` contendo `'SINGLE_VALUE'` ou `'SEQUENTIAL_ID'`.

**Função Guardiã:** `run-training-preflight`, `audit-project-pipeline`

---

### 3.2 — Split Errado (Data Leakage Temporal)

**Problema:** O split treino/teste não respeita a ordem temporal, permitindo que o modelo "veja o futuro".

**Manifestações:**
- Métricas de treino muito superiores às de produção
- AUC de treino > 0.95 mas performance real < 0.60
- O dataset não tem coluna temporal identificada, forçando split aleatório em problemas que são inerentemente temporais

**Como Detectar:**

```sql
-- Verificar se o contrato define coluna temporal
SELECT pmc.project_id,
       pmc.contract_json->>'time_anchor_column' as time_col,
       pmc.contract_json->>'split_strategy' as split_strategy
FROM project_modeling_contracts pmc
WHERE pmc.status = 'READY'
  AND (pmc.contract_json->>'time_anchor_column' IS NULL
       OR pmc.contract_json->>'time_anchor_column' = '');

-- Verificar métricas do modelo (gap treino vs teste)
SELECT pm.id, pm.algorithm_name,
       pmm.metric_name, pmm.metric_value,
       pmm.split_name
FROM project_models pm
JOIN project_model_metrics pmm ON pmm.project_model_id = pm.id
WHERE pm.is_production = true
  AND pmm.metric_name IN ('auc', 'r2', 'accuracy')
ORDER BY pm.project_id, pmm.metric_name, pmm.split_name;
```

**Onde Aparece nos Logs:**
- `train-models` → logs com `split_strategy` e `time_column`.
- `audit-project-pipeline` → `stages.model.observations` com alertas sobre split.
- `project_modeling_contracts.contract_json.split_strategy` → `'random'` quando deveria ser `'temporal'`.

**Função Guardiã:** `generate-intent-contract` (define split), `run-training-preflight` (valida)

---

### 3.3 — Leakage de Features

**Problema:** Uma feature tem correlação perfeita ou quase perfeita com o target porque é derivada dele ou contém a resposta.

**Manifestações:**
- Feature com correlação > 0.98 com o target
- Feature que é uma transformação do target (ex: `churn_label` como feature para prever `churn`)
- Feature que só existe após o evento-alvo (ex: `data_cancelamento` como feature para prever cancelamento)

**Como Detectar:**

```sql
-- Verificar feature importance anômala (uma feature domina)
SELECT pfi.feature_name, pfi.importance_value,
       SUM(pfi.importance_value) OVER () as total_importance,
       pfi.importance_value / NULLIF(SUM(pfi.importance_value) OVER (), 0) as pct_importance
FROM project_feature_importances pfi
JOIN project_models pm ON pm.id = pfi.project_model_id
WHERE pm.is_production = true
ORDER BY pfi.importance_value DESC
LIMIT 5;
-- Se a top feature tem > 60% da importância total, investigar leakage

-- Verificar inferência de colunas para flags de leakage
SELECT pci.column_name, pci.semantic_role, pci.block_reasons
FROM project_column_inference pci
WHERE pci.block_reasons::text LIKE '%LEAKAGE%'
   OR pci.block_reasons::text LIKE '%TARGET_DERIVATIVE%';
```

**Onde Aparece nos Logs:**
- `audit-project-pipeline` → `incoherences` contendo referência a leakage.
- `run-training-preflight` → bloqueia com `FEATURE_LEAKAGE` se correlação > 0.98.
- `project_column_inference.block_reasons` → contém `'LEAKAGE'`.

**Função Guardiã:** `run-training-preflight` (gate determinístico com threshold 0.98), `audit-project-pipeline`

---

### 3.4 — Features Ausentes no Scoring

**Problema:** O modelo foi treinado com um conjunto de features que não está disponível no dataset de scoring, ou as features têm nomes/tipos diferentes.

**Manifestações:**
- `run-batch-predictions` falha com erro de feature mismatch
- Predictions são geradas mas com valores `null` ou constantes (fallback)
- O modelo usa encoding que não reconhece categorias novas

**Como Detectar:**

```sql
-- Comparar features do modelo vs features do dataset ativo
SELECT pm.id as model_id,
       pm.hyperparameters->'feature_names' as model_features,
       pds.active_schema_json as dataset_schema
FROM project_models pm
JOIN project_dataset_state pds ON pds.production_model_id = pm.id
WHERE pm.is_production = true;

-- Verificar scoring jobs com erros de feature
SELECT psj.id, psj.status, psj.error_message, psj.diagnostics
FROM project_scoring_jobs psj
WHERE psj.error_message LIKE '%feature%'
   OR psj.error_message LIKE '%column%not found%'
   OR psj.diagnostics::text LIKE '%missing_features%';
```

**Onde Aparece nos Logs:**
- `run-batch-predictions` → logs com `[WARN] Missing features:` seguido da lista.
- `project_scoring_jobs.diagnostics` → campo `missing_features` ou `feature_mismatch`.
- `project_score_reports.report_json` → `warnings` com referência a features ausentes.

**Função Guardiã:** `run-batch-predictions` (validação pré-scoring), `audit-project-pipeline`

---

### 3.5 — Dataset State Inconsistente

**Problema:** O `project_dataset_state` reflete um estado que não corresponde à realidade dos dados ou do manifesto.

**Manifestações:**
- `row_count` ou `col_count` = 0 mas `eda_ready = true`
- `manifest_id` referencia manifesto com `status = 'fail'`
- `model_ready = true` mas não existe `project_modeling_datasets.is_current = true`
- `production_model_id` referencia modelo com `status ≠ 'completed'`
- `source_type` diverge do tipo real do manifesto/dataset

**Como Detectar:**

```sql
-- Estado inconsistente: eda_ready mas sem dados
SELECT pds.project_id, pds.row_count, pds.col_count,
       pds.eda_ready, pds.model_ready, pds.manifest_id,
       pds.production_model_id
FROM project_dataset_state pds
WHERE (pds.eda_ready = true AND (pds.row_count = 0 OR pds.col_count = 0))
   OR (pds.model_ready = true AND NOT EXISTS (
         SELECT 1 FROM project_modeling_datasets pmd
         WHERE pmd.project_id = pds.project_id AND pmd.is_current = true
       ))
   OR (pds.production_model_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM project_models pm
         WHERE pm.id = pds.production_model_id AND pm.status = 'completed'
       ));

-- Manifesto referenciado está com falha
SELECT pds.project_id, pds.manifest_id, im.status
FROM project_dataset_state pds
JOIN import_manifests im ON im.id = pds.manifest_id
WHERE im.status = 'fail';
```

**Onde Aparece nos Logs:**
- `process-import` → logs de atualização do `project_dataset_state`.
- `audit-project-pipeline` → `stages.eda.status = 'error'` com observação sobre inconsistência.
- `useDatasetState` (hook frontend) → fallback para `import_manifests` quando `project_dataset_state` está vazio ou inconsistente (indicando que o SSOT não foi populado).

**Função Guardiã:** `process-import` (popula o state), `audit-project-pipeline` (detecta inconsistência)

---

## Anexo: Query Master de Verificação de Todas as Invariantes

```sql
-- ============================================================
-- QUERY MASTER: Verificação das 10 Invariantes
-- Execute no banco para um diagnóstico completo
-- ============================================================

WITH invariant_checks AS (
  -- I1: model_ready → modeling_dataset exists
  SELECT 'I1' as invariant, pds.project_id,
    CASE WHEN EXISTS (
      SELECT 1 FROM project_modeling_datasets pmd
      WHERE pmd.project_id = pds.project_id
        AND pmd.is_current = true AND pmd.status != 'blocked'
    ) THEN 'OK' ELSE 'VIOLATED' END as status
  FROM project_dataset_state pds
  WHERE pds.model_ready = true

  UNION ALL

  -- I5: selection_version >= deployed_selection_version
  SELECT 'I5', pms.project_id,
    CASE WHEN pm.deployed_selection_version <= pms.selection_version
      THEN 'OK' ELSE 'VIOLATED' END
  FROM project_model_selection pms
  JOIN project_models pm ON pm.project_id = pms.project_id AND pm.is_production = true

  UNION ALL

  -- I10: unicidade de modelo em produção
  SELECT 'I10', pm.project_id,
    CASE WHEN COUNT(*) <= 1 THEN 'OK' ELSE 'VIOLATED' END
  FROM project_models pm
  WHERE pm.is_production = true
  GROUP BY pm.project_id
)
SELECT invariant, project_id, status
FROM invariant_checks
WHERE status = 'VIOLATED'
ORDER BY invariant, project_id;
```

---

> ⚠️ **Nota:** Esta auditoria é baseada na análise estática do schema e do código. Recomenda-se executar as queries de detecção periodicamente (via `audit-project-pipeline` ou cron) para identificar violações em tempo real.
