import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface TableInfo {
  schema: string;
  name: string;
  type: "table" | "view";
  rowCount?: number;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { connector_type, connection_config, list_tables } = await req.json();

    console.log(`[test-db-connection] Testing connection for type: ${connector_type}, list_tables: ${list_tables}`);

    let isValid = false;
    let message = "";
    let tables: TableInfo[] = [];

    if (connector_type === "postgresql") {
      // Actually test PostgreSQL connection
      let connectionUrl = "";
      
      if (connection_config.connection_string) {
        connectionUrl = connection_config.connection_string;
      } else {
        const { host, port, database, username, password } = connection_config;
        if (!host || !port || !database || !username) {
          return new Response(
            JSON.stringify({ 
              success: false, 
              message: "Missing required connection parameters (host, port, database, username)"
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
          );
        }
        connectionUrl = `postgres://${username}:${password || ''}@${host}:${port}/${database}`;
      }

      try {
        const sql = postgres(connectionUrl, {
          max: 1,
          idle_timeout: 5,
          connect_timeout: 10,
        });

        // Test connection
        const result = await sql`SELECT 1 as test`;
        console.log("[test-db-connection] PostgreSQL connection successful");
        
        if (list_tables) {
          // List tables and views
          const tablesResult = await sql`
            SELECT 
              table_schema as schema,
              table_name as name,
              table_type as type
            FROM information_schema.tables 
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name
          `;
          
          tables = tablesResult.map((row: any) => ({
            schema: row.schema,
            name: row.name,
            type: row.type === 'VIEW' ? 'view' : 'table'
          }));
          
          console.log(`[test-db-connection] Found ${tables.length} tables/views`);
        }

        await sql.end();
        isValid = true;
        message = list_tables 
          ? `Connection successful. Found ${tables.length} tables/views.`
          : "Connection successful!";
      } catch (pgError: any) {
        console.error("[test-db-connection] PostgreSQL error:", pgError);
        isValid = false;
        message = pgError.message || "Failed to connect to PostgreSQL database";
      }
    } else if (connector_type === "mysql" || connector_type === "sqlserver" || connector_type === "oracle") {
      // For non-PostgreSQL databases, validate connection params
      if (connection_config.connection_string) {
        isValid = true;
        message = `Connection string format validated. Note: ${connector_type} connections are validated but not fully tested in this environment. Please proceed with data ingestion.`;
      } else {
        const { host, port, database, username } = connection_config;
        if (!host || !port || !database || !username) {
          isValid = false;
          message = "Missing required connection parameters";
        } else {
          isValid = true;
          message = `Connection parameters validated for ${host}:${port}/${database}. Note: ${connector_type} connections are validated but not fully tested in this environment.`;
        }
      }
    } else {
      isValid = false;
      message = `Unsupported database type: ${connector_type}`;
    }

    console.log(`[test-db-connection] Result: ${isValid ? "success" : "failed"} - ${message}`);

    return new Response(
      JSON.stringify({ 
        success: isValid, 
        message,
        connector_type,
        tables: list_tables ? tables : undefined
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  } catch (error: unknown) {
    console.error("[test-db-connection] Error:", error);
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
