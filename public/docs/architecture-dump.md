# PredictSys — Architecture & Data Contract Dump

> Gerado em: 2026-02-12  
> Versão: 1.0

---

## 1. Visão Geral

O **PredictSys** é uma plataforma SaaS de IA preditiva no-code que permite a empresas criar, treinar, implantar e monitorar modelos de machine learning sem escrever código. O fluxo do usuário segue 9 etapas sequenciais: (1) Definição de Intenção/Contrato, (2) Conexão e Ingestão de Dados, (3) Análise Exploratória (EDA), (4) Configuração de Target e Features, (5) Construção do Dataset de Modelagem (Builder), (6) Treinamento AutoML, (7) Deploy e Promoção do Modelo, (8) Scoring / Previsões em Batch, (9) Dashboard de Negócio e Agendamento. A arquitetura é multi-tenant com isolamento por organização, RLS em todas as tabelas, e edge functions serverless para lógica de backend.

---

## 2. Mapa do Fluxo Ponta-a-Ponta

### Step 1 — Informações e Intenção (`IntentContract`)

| Item | Detalhe |
|------|---------|
| **Inputs** | Nome do projeto, descrição, indústria, objetivo de negócio |
| **Outputs** | Registro em `projects`, `project_ai_context` |
| **Side Effects** | `projects.status = 'draft'` |
| **Edge Function** | `generate-intent-contract` |
| **Avança quando** | Projeto criado com sucesso |

### Step 2 — Conexão e Ingestão de Dados

| Item | Detalhe |
|------|---------|
| **Inputs** | Arquivo CSV, conexão DB, Databricks, Cloud connector |
| **Outputs** | `project_datasets`, `project_columns`, `project_dataset_state`, `import_manifests` |
| **Side Effects** | `project_dataset_state.source_type`, `row_count`, `col_count` atualizados |
| **Edge Functions** | `parse-file`, `process-import`, `import-preview`, `ingest-database`, `ingest-databricks`, `ingest-cloud-data` |
| **Avança quando** | `project_dataset_state.eda_ready = true` |
| **Bloqueia se** | Arquivo inválido, schema incompatível, zero linhas |

### Step 3 — Análise Exploratória (EDA)

| Item | Detalhe |
|------|---------|
| **Inputs** | Dataset ativo (`project_dataset_state.active_dataset_ref`) |
| **Outputs** | `project_numeric_stats`, `project_categorical_stats`, `project_eda_insights`, `project_eda_snapshots`, `project_column_inference` |
| **Side Effects** | Estatísticas calculadas, correlações, missing values |
| **Edge Function** | `calculate-eda` |
| **Avança quando** | EDA concluído com sucesso |

### Step 4 — Configuração de Target e Features

| Item | Detalhe |
|------|---------|
| **Inputs** | Colunas do dataset, inferências, sugestões da IA |
| **Outputs** | `project_model_selection` (SSOT) |
| **Side Effects** | `selection_version` incrementado, `target_column`, `feature_names`, `problem_type` definidos |
| **Edge Functions** | `upsert-model-selection`, `ai-suggest-targets`, `infer-problem` |
| **Avança quando** | `project_model_selection` salvo com target válido |
| **Bloqueia se** | Target não encontrado no dataset |

### Step 5 — Builder (Dataset de Modelagem)

| Item | Detalhe |
|------|---------|
| **Inputs** | `project_model_selection` (target, features, problem_type) |
| **Outputs** | `project_modeling_datasets`, `project_features` |
| **Side Effects** | Dataset filtrado/transformado para treinamento |
| **Edge Function** | `build-modeling-dataset` |
| **Avança quando** | `project_dataset_state.model_ready = true` |

### Step 6 — Treinamento AutoML

| Item | Detalhe |
|------|---------|
| **Inputs** | Dataset de modelagem, configuração de treinamento |
| **Outputs** | `project_models` (múltiplos candidatos) |
| **Side Effects** | Métricas (AUC, F1, MAE, RMSE, etc.), feature importance, artefatos JSONB |
| **Edge Functions** | `train-models`, `run-training-preflight` |
| **Avança quando** | Pelo menos 1 modelo treinado com sucesso |
| **Bloqueia se** | Preflight falha (missing target, insufficient rows, etc.) |

### Step 7 — Deploy e Promoção

| Item | Detalhe |
|------|---------|
| **Inputs** | `model_id` selecionado pelo usuário |
| **Outputs** | `project_dataset_state.production_model_id` atualizado |
| **Side Effects** | `projects.status = 'deployed'` |
| **Edge Function** | `deploy-model` |
| **Avança quando** | `production_model_id` definido |

### Step 8 — Scoring / Previsões em Batch

| Item | Detalhe |
|------|---------|
| **Inputs** | Dataset de scoring, modelo em produção |
| **Outputs** | `predictions`, `project_score_reports`, `project_scoring_jobs` |
| **Side Effects** | `predictions.is_latest = true` (promoted), `batch_id` gerado |
| **Edge Function** | `run-batch-predictions` (multi-pass: CONTINUE/DONE) |
| **Avança quando** | `predictions` com `is_latest = true` existem |
| **Multi-pass** | Se retornar `status: "CONTINUE"`, chamar novamente com `next_offset`, `batch_id`, `running_stats` |

### Step 9 — Dashboard de Negócio

| Item | Detalhe |
|------|---------|
| **Inputs** | `predictions` (is_latest), `project_score_reports`, `project_business_config` |
| **Outputs** | Visualizações, KPIs, segmentação, exportação PDF |
| **Side Effects** | Métricas calculadas client-side e via `calculate-dashboard-metrics` |
| **Edge Function** | `calculate-dashboard-metrics` |
| **Diagnóstico** | Hook `useDashboardDataStatus` verifica 3 fontes antes de exibir erro |

### Step 9b — Agendamento

| Item | Detalhe |
|------|---------|
| **Inputs** | Configuração de cron/frequência |
| **Outputs** | Schedule salvo |
| **Edge Functions** | `upsert-schedule`, `run-scheduled-predictions` |

---

## 3. Single Source of Truth (SSOT)

| Conceito | Tabela/Campo SSOT | Notas |
|----------|-------------------|-------|
| Dataset ativo | `project_dataset_state.active_dataset_ref` | Referência ao `project_datasets.id` ativo |
| Target column | `project_model_selection.target_column` | Versionado por `selection_version` |
| Features | `project_model_selection.feature_names` | Array de nomes, versionado |
| Problem type | `project_model_selection.problem_type` | `classification` ou `regression` |
| Selection version | `project_model_selection.selection_version` | Incremento monotônico |
| Model ready | `project_dataset_state.model_ready` | Boolean, setado pelo Builder |
| EDA ready | `project_dataset_state.eda_ready` | Boolean, setado pela ingestão |
| Production model | `project_dataset_state.production_model_id` | FK para `project_models.id` |
| Predictions ready | `predictions.is_latest = true` | Filtro obrigatório para dashboard |
| Dashboard ready | Derivado de `predictions.is_latest` count > 0 | Sem campo dedicado |

### Regras de Precedência

1. `project_model_selection` (versão mais recente) > `project_settings` > inferência automática
2. `project_dataset_state.production_model_id` é a fonte canônica do modelo ativo
3. `import_manifests` é a fonte canônica do estado de ingestão

---

## 4. Catálogo de APIs / Edge Functions

### `parse-file`
- **Método**: POST
- **Payload entrada**: `{ project_id, file_path, delimiter?, encoding? }`
- **Payload saída**: `{ columns, sample_rows, row_count, detected_delimiter }`
- **Tabelas**: Lê `storage`, escreve `project_columns`
- **Status codes**: 200, 400, 500

### `process-import`
- **Método**: POST
- **Payload entrada**: `{ project_id, dataset_id, job_id, storage_path }`
- **Payload saída**: `{ status, rows_processed, manifest_id }`
- **Tabelas**: Lê `storage`, escreve `import_jobs`, `import_manifests`, `project_dataset_state`

### `calculate-eda`
- **Método**: POST
- **Payload entrada**: `{ project_id, dataset_id? }`
- **Payload saída**: `{ numeric_stats, categorical_stats, correlations, missing_summary }`
- **Tabelas**: Lê `project_datasets`, escreve `project_numeric_stats`, `project_categorical_stats`, `project_eda_snapshots`

### `ai-suggest-targets`
- **Método**: POST
- **Payload entrada**: `{ project_id, columns, context? }`
- **Payload saída**: `{ suggestions: [{ column, confidence, reason }] }`
- **Tabelas**: Lê `project_columns`, `project_ai_context`

### `infer-problem`
- **Método**: POST
- **Payload entrada**: `{ project_id, target_column }`
- **Payload saída**: `{ problem_type, confidence, reasoning }`
- **Tabelas**: Lê `project_columns`, `project_numeric_stats`

### `upsert-model-selection`
- **Método**: POST
- **Payload entrada**: `{ project_id, target_column, feature_names, problem_type, selection_version? }`
- **Payload saída**: `{ id, selection_version }`
- **Tabelas**: Escreve `project_model_selection`
- **Gates**: Valida target existe nas colunas

### `build-modeling-dataset`
- **Método**: POST
- **Payload entrada**: `{ project_id, selection_version? }`
- **Payload saída**: `{ dataset_id, row_count, feature_count, status }`
- **Tabelas**: Lê `project_model_selection`, `project_datasets`; escreve `project_modeling_datasets`, `project_features`
- **Gates**: Valida `model_selection` existe

### `run-training-preflight`
- **Método**: POST
- **Payload entrada**: `{ project_id }`
- **Payload saída**: `{ gates: { target_present, min_rows, feature_variance, ... }, can_proceed }`
- **Tabelas**: Lê `project_model_selection`, `project_modeling_datasets`

### `train-models`
- **Método**: POST
- **Payload entrada**: `{ project_id, algorithms?, hyperparameters? }`
- **Payload saída**: `{ models: [{ id, algorithm, metrics, status }] }`
- **Tabelas**: Lê `project_modeling_datasets`; escreve `project_models`
- **Status codes**: 200, 400 (preflight fail), 500

### `deploy-model`
- **Método**: POST
- **Payload entrada**: `{ project_id, model_id }`
- **Payload saída**: `{ status, production_model_id }`
- **Tabelas**: Escreve `project_dataset_state.production_model_id`, `projects.status`

### `run-batch-predictions`
- **Método**: POST
- **Payload entrada**: `{ project_id, pass_offset?, batch_id?, running_stats?, job_id? }`
- **Payload saída (CONTINUE)**: `{ status: "CONTINUE", next_offset, batch_id, running_stats, totals }`
- **Payload saída (DONE)**: `{ status: "DONE", batch_id, predictions_count, coverage_pct }`
- **Tabelas**: Lê `project_models`, `project_datasets`; escreve `predictions`, `project_score_reports`, `project_scoring_jobs`
- **Gates**: `feature_validation` (MISSING_FEATURES block se >20% ou baseMissing), entity_id detection case-insensitive

### `predict`
- **Método**: POST
- **Payload entrada**: `{ project_id, features: {} }`
- **Payload saída**: `{ prediction, probability, model_id }`
- **Tabelas**: Lê `project_models`

### `calculate-dashboard-metrics`
- **Método**: POST
- **Payload entrada**: `{ project_id, horizon_days?, filters? }`
- **Payload saída**: `{ kpis, segmentation, time_projection }`
- **Tabelas**: Lê `predictions`, `project_business_config`

### `generate-intent-contract`
- **Método**: POST
- **Payload entrada**: `{ project_id, description, industry }`
- **Payload saída**: `{ contract, suggestions }`
- **Tabelas**: Escreve `project_ai_context`

### `append-project-context`
- **Método**: POST
- **Payload entrada**: `{ project_id, context_key, context_value }`
- **Tabelas**: Escreve `project_ai_context.context`

### `audit-project-pipeline`
- **Método**: POST
- **Payload entrada**: `{ project_id }`
- **Payload saída**: `{ audit_report, gates, warnings }`
- **Tabelas**: Lê múltiplas tabelas do projeto

### `project-chat` / `global-chat`
- **Método**: POST
- **Payload entrada**: `{ message, project_id? }`
- **Payload saída**: `{ response }`
- **Tabelas**: Lê/escreve `project_chat_messages` / `global_chat_messages`

### `upsert-schedule`
- **Método**: POST
- **Payload entrada**: `{ project_id, cron_expression, enabled }`
- **Tabelas**: Escreve configuração de schedule

### `run-scheduled-predictions`
- **Método**: POST (invocado por cron)
- **Tabelas**: Mesmas de `run-batch-predictions`

### `get-signed-download-url`
- **Método**: POST
- **Payload entrada**: `{ bucket, path, file_name? }` ou `{ export_job_id }`
- **Payload saída**: `{ signed_url, file_name }`
- **Tabelas**: Lê `export_jobs`
- **Buckets permitidos**: `datasets`, `exports`, `big_imports`

### `process-export`
- **Método**: POST
- **Payload entrada**: `{ export_job_id }`
- **Tabelas**: Lê `predictions`; escreve `export_jobs`, `storage`

### `audit-log`
- **Método**: POST
- **Payload entrada**: `{ action, resource_type, metadata? }`
- **Tabelas**: Escreve `audit_logs`

### `track-event`
- **Método**: POST
- **Payload entrada**: `{ event_type, metadata? }`
- **Tabelas**: Escreve `platform_events`

### `aggregate-metrics-daily`
- **Método**: POST
- **Tabelas**: Lê várias; escreve `platform_metrics_daily`

### `enforce-data-retention`
- **Método**: POST
- **Tabelas**: Lê `organization_data_policy`; deleta dados antigos

### `materialize-derived-features`
- **Método**: POST
- **Tabelas**: Lê/escreve features derivadas

### `translate-content`
- **Método**: POST
- **Payload entrada**: `{ text, target_language }`
- **Payload saída**: `{ translated_text }`

### `generate-executive-summary`
- **Método**: POST
- **Payload entrada**: `{ project_id }`
- **Payload saída**: `{ summary }`

---

## 5. Modelo de Dados — Schema Essencial

### `projects`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | `gen_random_uuid()` |
| name | TEXT | NOT NULL | |
| description | TEXT | NULL | |
| status | TEXT | NOT NULL | `draft`, `data_uploaded`, `evaluated`, `deployed` |
| organization_id | UUID | FK | → `organizations.id` |
| user_id | UUID | NOT NULL | |
| created_at | TIMESTAMPTZ | NOT NULL | default `now()` |
| updated_at | TIMESTAMPTZ | NOT NULL | |

### `project_dataset_state`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| project_id | UUID | PK, FK | → `projects.id`, one-to-one |
| organization_id | UUID | FK | → `organizations.id` |
| active_dataset_ref | TEXT | NULL | |
| source_type | TEXT | NOT NULL | `csv`, `database`, `databricks`, `cloud` |
| row_count | INT | NOT NULL | default 0 |
| col_count | INT | NOT NULL | default 0 |
| eda_ready | BOOLEAN | NOT NULL | default false |
| model_ready | BOOLEAN | NOT NULL | default false |
| production_model_id | UUID | NULL, FK | → `project_models.id` |
| manifest_id | UUID | NULL, FK | → `import_manifests.id` |
| virtual_manifest | BOOLEAN | NOT NULL | |
| diagnostics | JSONB | NULL | |
| active_schema_json | JSONB | NULL | |
| last_job_id | TEXT | NULL | |
| last_success_at | TIMESTAMPTZ | NULL | |

### `project_model_selection`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | → `projects.id` |
| target_column | TEXT | NOT NULL | SSOT para target |
| feature_names | TEXT[] | NOT NULL | SSOT para features |
| problem_type | TEXT | NOT NULL | `classification` / `regression` |
| selection_version | INT | NOT NULL | Incremento monotônico |
| created_at | TIMESTAMPTZ | NOT NULL | |

### `project_columns`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | |
| column_name | TEXT | NOT NULL | |
| column_index | INT | NOT NULL | |
| inferred_type | TEXT | NOT NULL | default `text` |

### `project_models`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | |
| algorithm | TEXT | NOT NULL | |
| metrics | JSONB | NULL | AUC, F1, MAE, etc. |
| feature_importance | JSONB | NULL | |
| artifacts | JSONB | NULL | Modelo serializado |
| status | TEXT | NOT NULL | `trained`, `failed` |
| is_champion | BOOLEAN | | |
| created_at | TIMESTAMPTZ | | |

### `predictions`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | |
| user_id | UUID | NOT NULL | |
| entity_id | TEXT | NOT NULL | ID do cliente/entidade |
| entity_type | TEXT | NULL | |
| batch_id | TEXT | NULL | Agrupa previsões do mesmo run |
| is_latest | BOOLEAN | NULL | **Filtro obrigatório para dashboard** |
| problem_type | TEXT | NOT NULL | |
| predicted_class | TEXT | NULL | Para classificação |
| predicted_value | NUMERIC | NULL | Para regressão |
| probability_event | NUMERIC | NULL | Probabilidade [0,1] |
| prediction_date | DATE | NOT NULL | |
| reference_date | DATE | NOT NULL | |
| horizon_days | INT | NULL | |
| segment | TEXT | NULL | Segmento calculado |
| region, state, city | TEXT | NULL | Dimensões geográficas |
| channel, campaign | TEXT | NULL | Dimensões de marketing |
| cohort, age_group | TEXT | NULL | Dimensões demográficas |
| average_ticket | NUMERIC | NULL | |
| lifetime_value | NUMERIC | NULL | |
| potential_value | NUMERIC | NULL | |
| metadata | JSONB | NULL | |

### `project_score_reports`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | |
| batch_id | TEXT | | |
| predictions_count | INT | | |
| coverage_pct | NUMERIC | | |
| created_at | TIMESTAMPTZ | | |

### `project_ai_context`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | One-to-one |
| organization_id | UUID | FK | |
| context | JSONB | NOT NULL | Contexto acumulativo |
| status | TEXT | NOT NULL | |

### `import_manifests`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | |
| user_id | UUID | NOT NULL | |
| status | TEXT | NOT NULL | `ok`, `warn`, `fail` |
| total_files | INT | | |
| files_ok / files_warn / files_fail | INT | | |
| rows_sum / rows_consolidated | INT | | |
| columns_final | INT | | |
| canonical_schema | JSONB | NULL | |
| eda_ready | BOOLEAN | NULL | |
| model_ready | BOOLEAN | NULL | |

### `audit_logs`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| organization_id | UUID | FK | |
| project_id | UUID | NULL, FK | |
| user_id | UUID | NULL | |
| action | TEXT | NOT NULL | |
| resource_type | TEXT | NOT NULL | |
| resource_name | TEXT | NULL | |
| metadata | JSONB | NULL | |
| timestamp | TIMESTAMPTZ | NOT NULL | |

### `project_business_config`
| Campo | Tipo | Nullable | Notas |
|-------|------|----------|-------|
| id | UUID | PK | |
| project_id | UUID | FK | One-to-one |
| average_sale_value | NUMERIC | NULL | |
| average_margin_percent | NUMERIC | NULL | |
| baseline_conversion_percent | NUMERIC | NULL | |
| cost_per_contact | NUMERIC | NULL | |
| impact_window_days | INT | NULL | |

---

## 6. Estado do Produto (State Machine)

```
draft
  │ (create project)
  ▼
data_uploaded
  │ (EDA completa → eda_ready=true)
  ▼
evaluated
  │ (deploy-model → production_model_id set)
  ▼
deployed
  │ (run-batch-predictions → predictions.is_latest=true)
  ▼
predictions_ready (derivado, não campo)
  │ (dashboard renderiza)
  ▼
dashboard_ready (derivado, não campo)
```

### Transições Detalhadas

| De | Para | Trigger | Campos Alterados |
|----|------|---------|-----------------|
| `draft` | `data_uploaded` | Ingestão + parse OK | `project_dataset_state.*`, `projects.status` |
| `data_uploaded` | `evaluated` | EDA + Model Selection + Training OK | `eda_ready=true`, `model_ready=true`, `project_models` criados |
| `evaluated` | `deployed` | `deploy-model` | `production_model_id`, `projects.status='deployed'` |
| `deployed` | predictions_ready | `run-batch-predictions` DONE | `predictions.is_latest=true`, `project_score_reports` criado |
| predictions_ready | dashboard_ready | Dashboard carrega com sucesso | Nenhum (estado derivado client-side) |

---

## 7. Problemas Conhecidos / Pontos Frágeis

### 7.1 Race Condition de `selection_version`
- Se dois usuários editarem target/features simultaneamente, o `selection_version` pode colidir
- **Mitigação**: Incremento server-side no `upsert-model-selection`, mas sem lock explícito

### 7.2 Promoção `is_latest` não-atômica
- `run-batch-predictions` faz `UPDATE predictions SET is_latest=false WHERE project_id=X` seguido de `INSERT ... is_latest=true`
- Se o processo falhar entre os dois, predictions ficam sem `is_latest=true`
- **Mitigação**: Hook `useDashboardDataStatus` detecta esse estado e oferece CTA de "Finalizar scoring"

### 7.3 Artefatos de Modelo em JSONB
- Modelos são serializados como JSONB em `project_models.artifacts`
- Para modelos grandes, pode exceder limites práticos de JSONB (~255MB teórico, mas lento acima de 10MB)
- **Mitigação**: Modelos atuais são lightweight (decision trees, logistic regression)

### 7.4 Dataset State vs Manifest
- `project_dataset_state` e `import_manifests` podem divergir se a ingestão falhar parcialmente
- **Mitigação**: `audit-project-pipeline` valida consistência

### 7.5 Horizon Days no Dashboard
- Dashboard pode filtrar por `horizon_days` que não existe nas predictions atuais
- **Mitigação**: `useDashboardDataStatus` detecta horizons disponíveis e usa o com maior contagem

### 7.6 RLS e Visibilidade
- Se RLS bloquear leitura de predictions, dashboard mostra "vazio" em vez de "sem permissão"
- **Mitigação**: `useDashboardDataStatus` diferencia erro de RLS vs dados vazios

### 7.7 Multi-pass Scoring Timeout
- Edge functions têm timeout de ~60s. Se o dataset for muito grande, um único pass pode não completar
- **Mitigação**: Motor multi-pass com `CONTINUE/DONE` e `next_offset`

### 7.8 Encoding de CSV
- Arquivos com encoding não-UTF8 podem gerar caracteres corrompidos
- **Mitigação**: Detecção de encoding no `parse-file`, mas não 100% confiável

---

*Documento gerado automaticamente pelo PredictSys Architecture Dump v1.0*
