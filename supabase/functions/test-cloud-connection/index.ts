import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

type PowerBIConnectionStatus =
  | 'auth_failed'
  | 'workspace_not_found'
  | 'dataset_not_found'
  | 'connected_partial_discovery'
  | 'connected_full_discovery';

const PRIMARY_SOURCE_TYPES = new Set([
  'sql', 'sqlserver', 'azure_sql', 'azuresqldw', 'azure_synapse',
  'databricks', 'synapse', 'postgresql', 'mysql', 'oracle',
  'snowflake', 'bigquery', 'amazonredshift', 'aws_redshift',
  'microsoftfabricwarehouse', 'microsoftfabriclakehouse',
  'fabric_warehouse', 'fabric_lakehouse', 'sql_server',
  'analysisservices', 'analysis_services',
]);

function classifySourceRole(dsType: string): 'primary' | 'auxiliary' {
  return PRIMARY_SOURCE_TYPES.has(dsType.toLowerCase()) ? 'primary' : 'auxiliary';
}

function computeSourceConfidence(
  server: string | null,
  database: string | null,
  role: 'primary' | 'auxiliary',
): 'high' | 'medium' | 'low' {
  if (role === 'primary' && server && database) return 'high';
  if (role === 'primary' && server) return 'medium';
  if (role === 'auxiliary') return 'low';
  return 'low';
}

interface SourceTraceInfo {
  datasource_type: string | null;
  datasource_server: string | null;
  datasource_database: string | null;
  source_role: 'primary' | 'auxiliary';
  confidence: 'high' | 'medium' | 'low';
}

interface PowerBIValidationResult {
  success: boolean;
  connection_status: PowerBIConnectionStatus;
  message: string;
  auth_valid: boolean;
  workspace_valid: boolean;
  dataset_valid: boolean;
  discovery_available: boolean;
  semantic_model_type?: string;
  source_trace?: SourceTraceInfo;
  discovered_tables?: string[];
}

async function validatePowerBI(config: Record<string, any>): Promise<PowerBIValidationResult> {
  const { workspace_id, dataset_id, client_id, client_secret, tenant_id } = config;

  const fail = (status: PowerBIConnectionStatus, message: string, partial: Partial<PowerBIValidationResult> = {}): PowerBIValidationResult => ({
    success: false,
    connection_status: status,
    message,
    auth_valid: false,
    workspace_valid: false,
    dataset_valid: false,
    discovery_available: false,
    ...partial,
  });

  if (!workspace_id || !dataset_id || !client_id || !client_secret || !tenant_id) {
    return fail('auth_failed', 'Parâmetros obrigatórios ausentes (workspace_id, dataset_id, client_id, client_secret, tenant_id).');
  }

  // Step 1: Authenticate with Azure AD
  let access_token: string;
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
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error('[test-pbi] Auth failed:', tokenResp.status, errText);
      return fail('auth_failed', `Falha na autenticação Azure AD (${tokenResp.status}). Verifique client_id, client_secret e tenant_id.`);
    }
    const tokenData = await tokenResp.json();
    access_token = tokenData.access_token;
  } catch (err) {
    return fail('auth_failed', `Erro de rede ao autenticar com Azure AD: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Validate workspace access
  try {
    const wsUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}`;
    const wsResp = await fetch(wsUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
    if (!wsResp.ok) {
      return fail('workspace_not_found', `Workspace não encontrado ou sem acesso (HTTP ${wsResp.status}). Verifique o Workspace ID e permissões do Service Principal.`, { auth_valid: true });
    }
  } catch (err) {
    return fail('workspace_not_found', `Erro ao validar workspace: ${err instanceof Error ? err.message : String(err)}`, { auth_valid: true });
  }

  // Step 3: Validate dataset access
  let semanticModelType: string | undefined;
  try {
    const dsUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}`;
    const dsResp = await fetch(dsUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
    if (!dsResp.ok) {
      return fail('dataset_not_found', `Dataset não encontrado ou sem acesso (HTTP ${dsResp.status}). Verifique o Dataset ID.`, { auth_valid: true, workspace_valid: true });
    }
    const dsData = await dsResp.json();
    semanticModelType = dsData.defaultMode || undefined;
  } catch (err) {
    return fail('dataset_not_found', `Erro ao validar dataset: ${err instanceof Error ? err.message : String(err)}`, { auth_valid: true, workspace_valid: true });
  }

  // Step 4: Try discovery with DAX fallback chain
  let discoveryAvailable = false;
  const discoveredTables: string[] = [];

  const executeUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;

  // Try INFO.TABLES()
  try {
    const resp = await fetch(executeUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ query: 'EVALUATE INFO.TABLES()' }], serializerSettings: { includeNulls: true } }),
    });
    if (resp.ok) {
      const result = await resp.json();
      const rows = result.results?.[0]?.tables?.[0]?.rows || [];
      for (const row of rows) {
        const name = row['[Name]'] || row['Name'];
        if (name && !name.startsWith('DateTable') && !name.startsWith('LocalDateTable')) {
          discoveredTables.push(name);
        }
      }
      if (discoveredTables.length > 0) discoveryAvailable = true;
    }
  } catch { /* continue to fallbacks */ }

  // Fallback 1: TMSCHEMA_TABLES
  if (!discoveryAvailable) {
    try {
      const resp = await fetch(executeUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ query: 'SELECT [Name] FROM $SYSTEM.TMSCHEMA_TABLES WHERE NOT [IsHidden]' }], serializerSettings: { includeNulls: true } }),
      });
      if (resp.ok) {
        const result = await resp.json();
        const rows = result.results?.[0]?.tables?.[0]?.rows || [];
        for (const row of rows) {
          const name = row['[Name]'] || row['Name'] || Object.values(row)[0];
          if (name && typeof name === 'string' && !name.startsWith('DateTable') && !name.startsWith('LocalDateTable')) {
            discoveredTables.push(name);
          }
        }
        if (discoveredTables.length > 0) discoveryAvailable = true;
      }
    } catch { /* continue */ }
  }

  // Fallback 2: Simple DAX test
  if (!discoveryAvailable) {
    try {
      const resp = await fetch(executeUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ query: 'EVALUATE ROW("ok", 1)' }], serializerSettings: { includeNulls: true } }),
      });
      if (resp.ok) discoveryAvailable = true;
    } catch { /* continue */ }
  }

  // Fallback 3: REST /tables endpoint
  if (!discoveryAvailable || discoveredTables.length === 0) {
    try {
      const tablesUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/tables`;
      const resp = await fetch(tablesUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
      if (resp.ok) {
        const data = await resp.json();
        const tables = data.value || [];
        for (const t of tables) {
          if (t.name && !discoveredTables.includes(t.name)) {
            discoveredTables.push(t.name);
          }
        }
        if (discoveredTables.length > 0 && !discoveryAvailable) discoveryAvailable = true;
      }
    } catch { /* continue */ }
  }

  // Step 5: Try source trace (datasources endpoint)
  let sourceTrace: SourceTraceInfo | undefined;
  try {
    const srcUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/datasources`;
    const srcResp = await fetch(srcUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
    if (srcResp.ok) {
      const srcData = await srcResp.json();
      const datasources = srcData.value || [];
      if (datasources.length > 0) {
        // Pick primary source first, then any
        const sqlLike = datasources.find((d: any) => {
          const t = (d.datasourceType || '').toLowerCase();
          return PRIMARY_SOURCE_TYPES.has(t);
        });
        const primary = sqlLike || datasources[0];
        const details = primary.connectionDetails || {};
        const dsType = (primary.datasourceType || 'unknown').toLowerCase();
        const role = classifySourceRole(dsType);
        const server = details.server || details.url || null;
        const database = details.database || null;

        sourceTrace = {
          datasource_type: dsType,
          datasource_server: server,
          datasource_database: database,
          source_role: role,
          confidence: computeSourceConfidence(server, database, role),
        };
      }
    }
  } catch { /* best-effort */ }

  const hasDiscoveredTables = discoveredTables.length > 0;
  const connectionStatus: PowerBIConnectionStatus = (discoveryAvailable && hasDiscoveredTables)
    ? 'connected_full_discovery'
    : 'connected_partial_discovery';

  const message = (discoveryAvailable && hasDiscoveredTables)
    ? 'Conexão validada com sucesso. Discovery automático disponível.'
    : 'Conexão com Power BI estabelecida. O dataset foi acessado com sucesso, porém o modelo semântico não permitiu listar automaticamente todas as tabelas. Selecione uma tabela manualmente ou escolha uma das tabelas detectadas.';

  return {
    success: true,
    connection_status: connectionStatus,
    message,
    auth_valid: true,
    workspace_valid: true,
    dataset_valid: true,
    discovery_available: discoveryAvailable && hasDiscoveredTables,
    semantic_model_type: semanticModelType,
    source_trace: sourceTrace,
    discovered_tables: discoveredTables.length > 0 ? discoveredTables : undefined,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { connector_type, connection_config } = await req.json();

    console.log(`Testing cloud connection for type: ${connector_type}`);

    // Power BI: granular multi-step validation
    if (connector_type === 'powerbi') {
      const result = await validatePowerBI(connection_config);
      console.log(`[test-pbi] Result: ${result.connection_status} - ${result.message}`);
      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    // Other connectors: existing parameter validation
    let isValid = false;
    let message = "";

    switch (connector_type) {
      case "azure_sql":
      case "azure_synapse":
        if (connection_config.server && connection_config.database && 
            connection_config.username && connection_config.password) {
          isValid = true;
          message = "Azure SQL connection parameters validated";
        } else {
          message = "Missing required Azure SQL parameters";
        }
        break;

      case "azure_blob":
        if (connection_config.account_name && connection_config.container && 
            connection_config.sas_token) {
          isValid = true;
          message = "Azure Blob Storage connection parameters validated";
        } else {
          message = "Missing required Azure Blob Storage parameters";
        }
        break;

      case "aws_s3":
        if (connection_config.bucket && connection_config.region && 
            connection_config.access_key_id && connection_config.secret_access_key) {
          isValid = true;
          message = "AWS S3 connection parameters validated";
        } else {
          message = "Missing required AWS S3 parameters";
        }
        break;

      case "aws_rds":
      case "aws_redshift":
        if (connection_config.endpoint && connection_config.database && 
            connection_config.username && connection_config.password) {
          isValid = true;
          message = "AWS database connection parameters validated";
        } else {
          message = "Missing required AWS database parameters";
        }
        break;

      case "aws_athena":
        if (connection_config.region && connection_config.database && 
            connection_config.s3_output && connection_config.access_key_id) {
          isValid = true;
          message = "AWS Athena connection parameters validated";
        } else {
          message = "Missing required AWS Athena parameters";
        }
        break;

      default:
        message = `Connector type '${connector_type}' is not yet supported`;
    }

    console.log(`Test result: ${isValid ? "success" : "failed"} - ${message}`);

    return new Response(
      JSON.stringify({ success: isValid, message, connector_type }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: unknown) {
    console.error("Error testing cloud connection:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred while testing the connection";
    
    return new Response(
      JSON.stringify({ success: false, message: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
