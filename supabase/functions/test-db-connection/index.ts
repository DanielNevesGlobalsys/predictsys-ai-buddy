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

    console.log(`Testing database connection for type: ${connector_type}`);

    // This is a simplified test - in production you would actually try to connect
    // For now, we validate the connection parameters
    
    let isValid = false;
    let message = "";

    if (connection_config.connection_string) {
      // Validate connection string format
      const connString = connection_config.connection_string;
      
      if (connector_type === "postgresql" && connString.startsWith("postgresql://")) {
        isValid = true;
        message = "Connection string format is valid";
      } else if (connector_type === "mysql" && connString.startsWith("mysql://")) {
        isValid = true;
        message = "Connection string format is valid";
      } else if (connector_type === "sqlserver" && (connString.includes("Server=") || connString.startsWith("sqlserver://"))) {
        isValid = true;
        message = "Connection string format is valid";
      } else {
        isValid = false;
        message = "Invalid connection string format for the selected database type";
      }
    } else {
      // Validate individual connection parameters
      const { host, port, database, username, password } = connection_config;
      
      if (!host || !port || !database || !username) {
        isValid = false;
        message = "Missing required connection parameters";
      } else {
        // In a real implementation, we would attempt an actual connection here
        // For now, we validate the format
        isValid = true;
        message = `Connection parameters validated for ${host}:${port}/${database}`;
      }
    }

    // Note: In a production environment, you would use database-specific libraries
    // to actually test the connection. This requires setting up the appropriate
    // Deno packages and handling connection pooling, timeouts, etc.

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
    console.error("Error testing database connection:", error);
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
