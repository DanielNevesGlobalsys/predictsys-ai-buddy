import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { connector_type, connection_config } = await req.json();

    console.log(`Testing cloud connection for type: ${connector_type}`);

    let isValid = false;
    let message = "";

    switch (connector_type) {
      case "powerbi":
        // Validate Power BI connection
        const { workspace_id, dataset_id, client_id, client_secret, tenant_id } = connection_config;
        if (workspace_id && dataset_id && client_id && client_secret && tenant_id) {
          // In production, we would validate these with Azure AD
          isValid = true;
          message = "Power BI connection parameters validated";
        } else {
          message = "Missing required Power BI parameters";
        }
        break;

      case "azure_sql":
      case "azure_synapse":
        // Validate Azure SQL/Synapse connection
        if (connection_config.server && connection_config.database && 
            connection_config.username && connection_config.password) {
          isValid = true;
          message = "Azure SQL connection parameters validated";
        } else {
          message = "Missing required Azure SQL parameters";
        }
        break;

      case "azure_blob":
        // Validate Azure Blob Storage connection
        if (connection_config.account_name && connection_config.container && 
            connection_config.sas_token) {
          isValid = true;
          message = "Azure Blob Storage connection parameters validated";
        } else {
          message = "Missing required Azure Blob Storage parameters";
        }
        break;

      case "aws_s3":
        // Validate AWS S3 connection
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
        // Validate AWS RDS/Redshift connection
        if (connection_config.endpoint && connection_config.database && 
            connection_config.username && connection_config.password) {
          isValid = true;
          message = "AWS database connection parameters validated";
        } else {
          message = "Missing required AWS database parameters";
        }
        break;

      case "aws_athena":
        // Validate AWS Athena connection
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
      JSON.stringify({ 
        success: isValid, 
        message,
        connector_type 
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  } catch (error: unknown) {
    console.error("Error testing cloud connection:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred while testing the connection";
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        message: errorMessage
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500 
      }
    );
  }
});
