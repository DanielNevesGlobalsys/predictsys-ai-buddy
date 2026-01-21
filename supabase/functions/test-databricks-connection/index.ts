import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Test Databricks SQL Warehouse connection by executing SELECT 1
 */
async function testDatabricksConnection(
  host: string,
  httpPath: string,
  accessToken: string,
  catalog?: string,
  schema?: string
): Promise<{ success: boolean; message: string }> {
  // Build the SQL Statement API URL
  const baseUrl = `https://${host}/api/2.0/sql/statements`;
  
  // Build the SQL query - SELECT 1 is the simplest test
  const sqlQuery = "SELECT 1 AS test_value";
  
  // Build request body
  const requestBody: Record<string, any> = {
    statement: sqlQuery,
    warehouse_id: httpPath.replace(/^\/sql\/1\.0\/warehouses\//, '').replace(/^\/sql\/protocolv1\/o\/\d+\//, ''),
    wait_timeout: "30s"
  };
  
  // Add catalog if provided
  if (catalog && catalog.trim()) {
    requestBody.catalog = catalog.trim();
  }
  
  // Add schema if provided  
  if (schema && schema.trim()) {
    requestBody.schema = schema.trim();
  }

  console.log(`[test-databricks] Testing connection to ${host}`);
  console.log(`[test-databricks] HTTP Path: ${httpPath}`);
  console.log(`[test-databricks] Warehouse ID extracted: ${requestBody.warehouse_id}`);

  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();
    console.log(`[test-databricks] Response status: ${response.status}`);

    if (!response.ok) {
      console.error(`[test-databricks] Error response:`, responseText);
      
      // Parse error for user-friendly message
      try {
        const errorData = JSON.parse(responseText);
        const errorMessage = errorData.message || errorData.error?.message || 'Unknown error';
        
        if (response.status === 401 || response.status === 403) {
          return { 
            success: false, 
            message: `Authentication failed. Please check your Personal Access Token. (${response.status})` 
          };
        }
        
        if (response.status === 404) {
          return { 
            success: false, 
            message: `Endpoint not found. Please verify the host and HTTP Path. (${response.status})` 
          };
        }
        
        return { 
          success: false, 
          message: `Databricks error: ${errorMessage}` 
        };
      } catch {
        return { 
          success: false, 
          message: `Connection failed with status ${response.status}` 
        };
      }
    }

    const data = JSON.parse(responseText);
    console.log(`[test-databricks] Statement status: ${data.status?.state}`);

    // Check statement state
    const state = data.status?.state;
    if (state === 'SUCCEEDED' || state === 'RUNNING' || state === 'PENDING') {
      return { 
        success: true, 
        message: 'Connection successful! Databricks SQL Warehouse is accessible.' 
      };
    }
    
    if (state === 'FAILED') {
      const error = data.status?.error?.message || 'Query execution failed';
      return { 
        success: false, 
        message: `Query failed: ${error}` 
      };
    }

    return { 
      success: true, 
      message: 'Connection established successfully.' 
    };

  } catch (error: any) {
    console.error(`[test-databricks] Connection error:`, error);
    return { 
      success: false, 
      message: `Connection error: ${error.message || 'Unable to connect to Databricks'}` 
    };
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { connector_type, connection_config } = await req.json();

    console.log(`[test-databricks] Testing connection for type: ${connector_type}`);

    if (connector_type !== 'databricks') {
      return new Response(
        JSON.stringify({ 
          success: false, 
          message: `Invalid connector type: ${connector_type}. Expected 'databricks'.`
        }),
        { 
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400 
        }
      );
    }

    const { host, http_path, access_token, catalog, schema } = connection_config;

    // Validate required fields
    if (!host || !http_path || !access_token) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          message: 'Missing required fields: host, http_path, and access_token are required.'
        }),
        { 
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400 
        }
      );
    }

    // Clean the host (remove protocol if included)
    const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const result = await testDatabricksConnection(
      cleanHost,
      http_path,
      access_token,
      catalog,
      schema
    );

    console.log(`[test-databricks] Test result: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.message}`);

    return new Response(
      JSON.stringify({ 
        success: result.success, 
        message: result.message,
        connector_type 
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );

  } catch (error: unknown) {
    console.error("[test-databricks] Error:", error);
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
