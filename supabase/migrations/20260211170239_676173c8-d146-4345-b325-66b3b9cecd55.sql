
-- A.1: Add unique index on project_columns (project_id, lower(column_name)) to prevent duplicates
-- First, deduplicate existing rows: keep the one with the latest created_at per (project_id, lower(column_name))
DELETE FROM project_columns
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY project_id, lower(column_name)
             ORDER BY created_at DESC
           ) AS rn
    FROM project_columns
  ) ranked
  WHERE rn > 1
);

-- Now create the unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_columns_unique_name
ON project_columns (project_id, lower(column_name));

-- B.2: Add materialization tracking columns to project_features
ALTER TABLE project_features
ADD COLUMN IF NOT EXISTS is_materialized boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS materialized_column_id uuid REFERENCES project_columns(id) ON DELETE SET NULL;
