# CLAUDE.md

## Project
Predicts is a low-code / AI-assisted data product for:
1. data ingestion and dataset understanding
2. EDA and business translation
3. intent contract / project configuration
4. dashboard generation and persistence
5. predictive pipeline orchestration (target, builder, train, score, deploy)

The current strategic goal is to stabilize the platform architecture, remove state inconsistencies, and make the pipeline universal across domains instead of fixing project-specific bugs one by one.

## Product priorities
Priority order:
1. Platform stability
2. Deterministic state synchronization
3. Universal multi-table logic
4. Predictive reliability
5. UX clarity
6. New features

## Current architecture areas
Main areas the assistant should inspect:
- ingestion / connectors
- schema inference
- EDA
- target discovery / predictive resolution
- SSOT / project settings persistence
- model selection
- builder / modeling dataset generation
- training preflight
- train pipeline
- scoring / deploy
- dashboard / business translation UI

## Core product rules
These are platform rules, not project-specific hacks:

1. SSOT must be authoritative.
   - UI, builder, preflight, train and scoring must read from the same final authoritative state.
   - No module may silently override SSOT with stale local fallback.

2. Aggregated targets are first-class citizens.
   - Targets such as agg_* are valid virtual/modeling targets.
   - They must not be validated only against raw physical schema.
   - Builder/train/preflight must validate against the effective consolidated modeling schema.

3. Multi-table resolution must be universal.
   - Prefer fact tables over dimension tables for entity and event time.
   - Administrative IDs must not be selected as predictive features by default.
   - Operational/event dates must outrank cadastral/reference dates.

4. Prevent leakage by design.
   - Columns that directly encode the target or future information must be excluded.
   - Blocking rules must be platform-level, not domain-only.

5. UI must reflect the real persisted state.
   - If the backend has official_target / official_entity_key / official_time_column, the UI must display them.
   - Do not show empty fields when authoritative values exist.

6. Predictive steps must degrade safely.
   - If a selected feature is absent from the consolidated schema, reconcile selection automatically when safe.
   - Only block if the remaining modeling space is no longer viable.

## Domain strategy
The platform must support multiple domains.
Domain adapters are allowed, but the core logic must remain universal:
- fact vs dimension heuristics
- admin ID blocking
- operational time prioritization
- schema reconciliation
- aggregated target handling

Never implement a fix that only works for one customer unless explicitly asked.

## Coding rules
- Prefer root-cause fixes over UI-only masking.
- Prefer deterministic functions over scattered heuristics.
- Centralize repeated logic into shared utilities.
- Preserve backward compatibility when reasonable.
- Add logs for every structural decision.
- When changing inference logic, update tests.

## Required workflow for Claude
For every non-trivial task:
1. audit current behavior
2. identify exact root cause
3. propose minimal structural patch
4. list affected files
5. implement patch
6. run or describe validation steps
7. summarize before/after behavior
8. call out risks and follow-up work

## Output style
Always answer in this structure:

### Diagnosis
- root cause
- where it happens
- why current behavior is wrong

### Patch plan
- files to change
- exact logic to add/remove

### Validation
- expected behavior after patch
- tests or manual checks

### Risks
- possible regressions
- next hardening steps

## Repository context files
When available, also read:
- README.md
- docs/
- architecture/
- prompt json files
- product specs
- bug logs / screenshots / transcripts

## What Claude should optimize for
- consistency across modules
- platform-level generalization
- lower bug recurrence
- lower manual debugging effort
- maintainable code for scale

## What Claude should avoid
- project-specific hardcoded fixes
- patching only the UI while backend remains inconsistent
- validating virtual targets against raw schema only
- selecting IDs and cadastral fields as business features by accident
- creating hidden state divergence between UI and backend

## Immediate mission
Help stabilize Predicts as a scalable platform.
Focus on:
- SSOT consistency
- builder/train/preflight alignment
- universal multi-table heuristics
- feature reconciliation
- predictable behavior across projects
