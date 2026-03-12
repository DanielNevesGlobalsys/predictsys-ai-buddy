import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type PowerBIConnectionStatus =
  | 'auth_failed'
  | 'workspace_not_found'
  | 'dataset_not_found'
  | 'connected_partial_discovery'
  | 'connected_full_discovery';

interface PowerBIValidationResult {
  success: boolean;
  connection_status: PowerBIConnectionStatus;
  message: string;
  auth_valid: boolean;
  workspace_valid: boolean;
  dataset_valid: boolean;
  discovery_available: boolean;
  semantic_model_type?: string;
  source_trace?: {
    datasource_type: string | null;
    datasource_server: string | null;
    datasource_database: string | null;
  };
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

  // Step 4: Try discovery (DAX INFO.TABLES)
  let discoveryAvailable = false;
  try {
    const executeUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/executeQueries`;
    const resp = await fetch(executeUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ query: 'EVALUATE ROW("ok", 1)' }], serializerSettings: { includeNulls: true } }),
    });
    discoveryAvailable = resp.ok;
  } catch {
    discoveryAvailable = false;
  }

  // Step 5: Try source trace (datasources endpoint)
  let sourceTrace: PowerBIValidationResult['source_trace'] | undefined;
  try {
    const srcUrl = `https://api.powerbi.com/v1.0/myorg/groups/${workspace_id}/datasets/${dataset_id}/datasources`;
    const srcResp = await fetch(srcUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
    if (srcResp.ok) {
      const srcData = await srcResp.json();
      const datasources = srcData.value || [];
      if (datasources.length > 0) {
        const primary = datasources[0];
        const details = primary.connectionDetails || {};
        sourceTrace = {
          datasource_type: primary.datasourceType || null,
          datasource_server: details.server || details.url || null,
          datasource_database: details.database || null,
        };
      }
    }
  } catch { /* best-effort */ }

  const connectionStatus: PowerBIConnectionStatus = discoveryAvailable ? 'connected_full_discovery' : 'connected_partial_discovery';
  const message = discoveryAvailable
    ? 'Conexão validada com sucesso. Discovery automático disponível.'
    : 'Conexão validada com sucesso. O dataset do Power BI foi acessado, mas o discovery automático completo do semantic model não está disponível para este caso. Você pode continuar informando manualmente a tabela desejada ou usar a fonte analítica detectada.';

  return {
    success: true,
    connection_status: connectionStatus,
    message,
    auth_valid: true,
    workspace_valid: true,
    dataset_valid: true,
    discovery_available: discoveryAvailable,
    semantic_model_type: semanticModelType,
    source_trace: sourceTrace,
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
