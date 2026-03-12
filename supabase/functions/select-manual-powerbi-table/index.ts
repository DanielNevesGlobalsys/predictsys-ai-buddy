import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    // Also create user-scoped client
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader || '' } },
    });

    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ success: false, error_code: 'auth_required', message: 'Autenticação necessária.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 });
    }

    const body = await req.json();
    const {
      project_id,
      connection_id,
      workspace_id,
      dataset_id,
      manual_table_name,
      organization_id,
      // Optional: validate table via DAX
      client_id,
      client_secret,
      tenant_id,
    } = body;

    // Validate required fields
    if (!project_id) {
      return new Response(JSON.stringify({ success: false, error_code: 'missing_project_id', message: 'project_id é obrigatório.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }
    if (!manual_table_name || !manual_table_name.trim()) {
      return new Response(JSON.stringify({ success: false, error_code: 'manual_table_required', message: 'Informe o nome da tabela manualmente antes de continuar.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }

    const tableName = manual_table_name.trim();

    console.log(`[select-manual-pbi] project=${project_id} table=${tableName} connection=${connection_id}`);

    // Validate table exists AND extract actual columns via DAX TOPN(1)
    let tableValidated = false;
    let validationSkipped = false;
    let extractedColumns: string[] = [];
    let extractedRowCount = 0;
    let daxAccessToken: string | null = null;

    if (client_id && client_secret && tenant_id && workspace_id && dataset_id) {
      try {
        const tokenUrl = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`;
        const params = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id,
          client_secret,
          scope: 'https://analysis.windows.net/powerbi/api/.default',
        });
        const tokenResp = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        if (tokenResp.ok) {
          const tokenData = await tokenResp.json();
          daxAccessToken = tokenData.access_token;
          const executeUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;

          // Step 1: Get columns + sample via TOPN(1)
          const daxResp = await fetch(executeUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${daxAccessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              queries: [{ query: `EVALUATE TOPN(1, '${tableName}')` }],
              serializerSettings: { includeNulls: true },
            }),
          });
          if (daxResp.ok) {
            tableValidated = true;
            const daxResult = await daxResp.json();
            const rawRows = daxResult.results?.[0]?.tables?.[0]?.rows || [];
            if (rawRows.length > 0) {
              // Extract column names - Power BI wraps them in [brackets]
              const rawKeys = Object.keys(rawRows[0]);
              extractedColumns = rawKeys.map(k => k.replace(/^\[/, '').replace(/\]$/, ''));
              console.log(`[select-manual-pbi] Extracted ${extractedColumns.length} columns from DAX TOPN(1)`);
            }
          } else {
            console.warn(`[select-manual-pbi] DAX validation failed for table '${tableName}', proceeding anyway`);
          }

          // Step 2: Try to get approximate row count via COUNTROWS
          if (daxAccessToken && tableValidated) {
            try {
              const countResp = await fetch(executeUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${daxAccessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  queries: [{ query: `EVALUATE ROW("cnt", COUNTROWS('${tableName}'))` }],
                  serializerSettings: { includeNulls: true },
                }),
              });
              if (countResp.ok) {
                const countResult = await countResp.json();
                const countRows = countResult.results?.[0]?.tables?.[0]?.rows || [];
                if (countRows.length > 0) {
                  const cntVal = countRows[0]?.['[cnt]'] ?? countRows[0]?.cnt;
                  extractedRowCount = typeof cntVal === 'number' ? cntVal : parseInt(String(cntVal), 10) || 0;
                  console.log(`[select-manual-pbi] COUNTROWS = ${extractedRowCount}`);
                }
              }
            } catch (cntErr) {
              console.warn('[select-manual-pbi] COUNTROWS failed:', cntErr);
            }
          }
        }
      } catch (err) {
        console.warn(`[select-manual-pbi] Table validation error:`, err);
      }
    } else {
      validationSkipped = true;
    }

    // Use extracted data or fallback minimums
    const finalColCount = extractedColumns.length > 0 ? extractedColumns.length : 1;
    const finalRowCount = extractedRowCount > 0 ? extractedRowCount : 1;

    // Log submission event
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_manual_table_selected',
        project_id,
        source: 'connector_powerbi',
        status: 'info',
        metadata: {
          connection_id, workspace_id, dataset_id,
          manual_table_name: tableName,
          table_validated: tableValidated,
          validation_skipped: validationSkipped,
        },
      });
    } catch { /* best-effort */ }

    // 1. Update external_connections metadata if connection_id provided
    if (connection_id) {
      try {
        const { data: connData } = await supabaseAdmin
          .from('external_connections')
          .select('metadata')
          .eq('id', connection_id)
          .single();

        const existingMeta = (connData?.metadata as Record<string, any>) || {};
        await supabaseAdmin
          .from('external_connections')
          .update({
            connection_status: 'connected_partial_discovery',
            validation_message: `Tabela manual selecionada: ${tableName}`,
            last_validated_at: new Date().toISOString(),
            metadata: {
              ...existingMeta,
              selection_mode: 'manual_assisted',
              manual_table_name: tableName,
              source_mode: 'powerbi_manual_assisted',
            },
          })
          .eq('id', connection_id);
      } catch (err) {
        console.warn('[select-manual-pbi] Failed to update external_connections:', err);
      }
    }

    // 2. Resolve organization_id from project if not provided
    let orgId = organization_id;
    if (!orgId) {
      const { data: projSettings } = await supabaseAdmin
        .from('project_settings')
        .select('org_id')
        .eq('project_id', project_id)
        .single();
      orgId = projSettings?.org_id || null;
    }

    // 3. Build schema from extracted columns (or minimal fallback)
    const schemaJson = extractedColumns.length > 0
      ? extractedColumns.map((col, i) => ({ name: col, type: 'text', index: i, source: 'powerbi_dax' }))
      : [{ name: tableName, type: 'table', source: 'powerbi_manual_assisted' }];

    // 4. Call rpc_finalize_ingestion with REAL column/row counts
    const { data: finResult, error: finError } = await supabaseAdmin.rpc('rpc_finalize_ingestion', {
      p_project_id: project_id,
      p_source_type: 'powerbi',
      p_config_hash: `pbi_manual_${project_id}_${tableName}`,
      p_dataset_id: null,
      p_source_pointer: {
        connector_type: 'powerbi',
        selection_mode: 'manual_assisted',
        workspace_id: workspace_id || null,
        dataset_id: dataset_id || null,
        manual_table_name: tableName,
        connection_id: connection_id || null,
        connection_mode: 'assisted',
        discovery_status: extractedColumns.length > 0 ? 'full' : 'partial',
        table_validated: tableValidated,
        columns_extracted: extractedColumns.length,
      },
      p_schema_json: schemaJson,
      p_row_count: finalRowCount,
      p_col_count: finalColCount,
      p_total_bytes: 0,
      p_sample_strategy: { method: 'manual_selection', source: 'powerbi' },
      p_file_count: 0,
    });

    if (finError) {
      console.error('[select-manual-pbi] rpc_finalize_ingestion error:', JSON.stringify(finError));

      try {
        await supabaseAdmin.from('platform_events').insert({
          event_type: 'powerbi_manual_table_selected',
          project_id,
          source: 'connector_powerbi',
          status: 'error',
          metadata: { connection_id, error_code: 'finalize_failed', message: finError.message },
        });
      } catch { /* best-effort */ }

      return new Response(JSON.stringify({
        success: false,
        error_code: 'dataset_activation_failed',
        message: 'A tabela manual foi informada, mas não foi possível registrar o dataset ativo. Tente novamente.',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
    }

    const result = finResult as Record<string, any>;

    // CRITICAL: Insert into project_datasets with REAL counts
    let projectDatasetId: string | null = null;
    try {
      await supabaseAdmin
        .from('project_datasets')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('project_id', project_id)
        .eq('is_active', true);

      const { data: pdData, error: pdError } = await supabaseAdmin
        .from('project_datasets')
        .insert({
          project_id,
          user_id: user.id,
          name: `Power BI: ${tableName}`,
          storage_path: `powerbi_assisted/${project_id}/${tableName}`,
          file_size_bytes: 0,
          total_rows: finalRowCount,
          sample_rows: 0,
          columns_count: finalColCount,
          is_active: true,
          source_type: 'powerbi',
          source_metadata: {
            connector_type: 'powerbi',
            selection_mode: 'manual_assisted',
            manual_table_name: tableName,
            connection_id: connection_id || null,
            workspace_id: workspace_id || null,
            dataset_id: dataset_id || null,
            table_validated: tableValidated,
            manifest_id: result?.manifest_id,
            columns_extracted: extractedColumns.length,
          },
        })
        .select('id')
        .single();

      if (pdError) {
        console.warn('[select-manual-pbi] project_datasets insert warning:', JSON.stringify(pdError));
      } else {
        projectDatasetId = pdData?.id || null;
        console.log(`[select-manual-pbi] project_datasets row created: ${projectDatasetId}`);
      }
    } catch (pdErr) {
      console.warn('[select-manual-pbi] project_datasets insert error:', pdErr);
    }

    // CRITICAL: Persist extracted columns to project_columns
    if (extractedColumns.length > 0) {
      try {
        // Clear existing columns
        await supabaseAdmin.from('project_columns').delete().eq('project_id', project_id);

        const colsToInsert = extractedColumns.map((col, i) => ({
          project_id,
          column_name: col,
          column_index: i,
          inferred_type: 'texto',
        }));
        const { error: colErr } = await supabaseAdmin.from('project_columns').insert(colsToInsert);
        if (colErr) {
          console.warn('[select-manual-pbi] project_columns insert warning:', JSON.stringify(colErr));
        } else {
          console.log(`[select-manual-pbi] Inserted ${extractedColumns.length} columns into project_columns`);
        }
      } catch (colInsertErr) {
        console.warn('[select-manual-pbi] project_columns insert error:', colInsertErr);
      }
    }

    // Update project_dataset_state with real schema
    if (extractedColumns.length > 0) {
      try {
        await supabaseAdmin
          .from('project_dataset_state')
          .update({
            col_count: finalColCount,
            row_count: finalRowCount,
            active_schema_json: schemaJson,
            updated_at: new Date().toISOString(),
          })
          .eq('project_id', project_id);
      } catch { /* best-effort */ }
    }

    // Log success event
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_dataset_active',
        project_id,
        source: 'connector_powerbi',
        status: 'info',
        metadata: {
          connection_id,
          manual_table_name: tableName,
          manifest_id: result?.manifest_id,
          dataset_version: result?.dataset_version,
          dataset_status: 'active',
          connection_mode: 'assisted',
          discovery_status: 'partial',
          project_dataset_id: projectDatasetId,
        },
      });
    } catch { /* best-effort */ }

    console.log(`[select-manual-pbi] Success: manifest=${result?.manifest_id} version=${result?.dataset_version} dataset=${projectDatasetId}`);

    return new Response(JSON.stringify({
      success: true,
      connection_status: 'connected_partial_discovery',
      dataset_status: 'active',
      selection_mode: 'manual_assisted',
      manual_table_name: tableName,
      manifest_id: result?.manifest_id,
      dataset_version: result?.dataset_version,
      project_dataset_id: projectDatasetId,
      table_validated: tableValidated,
      message: 'Tabela manual selecionada com sucesso. Dataset ativo registrado para este projeto.',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });

  } catch (error: unknown) {
    console.error('[select-manual-pbi] Error:', error);
    const msg = error instanceof Error ? error.message : 'Erro desconhecido';
    return new Response(JSON.stringify({ success: false, error_code: 'internal_error', message: msg }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
