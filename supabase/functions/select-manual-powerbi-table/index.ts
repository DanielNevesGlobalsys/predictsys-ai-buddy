import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

    // Log submission event
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_manual_selection_submitted',
        project_id,
        source: 'connector_powerbi',
        status: 'info',
        metadata: { connection_id, workspace_id, dataset_id, manual_table_name: tableName },
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

    // 3. Build a virtual schema for the manual table (minimal)
    const schemaJson = [
      { name: tableName, type: 'table', source: 'powerbi_manual_assisted' },
    ];

    // 4. Call rpc_finalize_ingestion to create active dataset and persist state
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
      },
      p_schema_json: schemaJson,
      p_row_count: 1,
      p_col_count: 1,
      p_total_bytes: 0,
      p_sample_strategy: { method: 'manual_selection', source: 'powerbi' },
      p_file_count: 0,
    });

    if (finError) {
      console.error('[select-manual-pbi] rpc_finalize_ingestion error:', finError);

      // Log failure
      try {
        await supabaseAdmin.from('platform_events').insert({
          event_type: 'powerbi_manual_selection_failed',
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

    // Log success
    try {
      await supabaseAdmin.from('platform_events').insert({
        event_type: 'powerbi_manual_selection_saved',
        project_id,
        source: 'connector_powerbi',
        status: 'info',
        metadata: {
          connection_id,
          manual_table_name: tableName,
          manifest_id: result?.manifest_id,
          dataset_version: result?.dataset_version,
          dataset_status: 'active',
        },
      });
    } catch { /* best-effort */ }

    console.log(`[select-manual-pbi] Success: manifest=${result?.manifest_id} version=${result?.dataset_version}`);

    return new Response(JSON.stringify({
      success: true,
      connection_status: 'connected_partial_discovery',
      dataset_status: 'active',
      selection_mode: 'manual_assisted',
      manual_table_name: tableName,
      manifest_id: result?.manifest_id,
      dataset_version: result?.dataset_version,
      message: 'Tabela manual selecionada com sucesso. Dataset ativo registrado para este projeto.',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });

  } catch (error: unknown) {
    console.error('[select-manual-pbi] Error:', error);
    const msg = error instanceof Error ? error.message : 'Erro desconhecido';
    return new Response(JSON.stringify({ success: false, error_code: 'internal_error', message: msg }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
