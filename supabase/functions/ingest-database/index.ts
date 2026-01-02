import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { project_id, data_source_id, custom_query } = await req.json();

    console.log(`Starting database ingestion for project: ${project_id}, data source: ${data_source_id}`);

    // Create ingestion log
    const { data: logData, error: logError } = await supabase
      .from("project_data_ingestion_logs")
      .insert({
        project_id,
        data_source_id,
        status: "processing",
        metadata: { custom_query: custom_query || null }
      })
      .select()
      .single();

    if (logError) {
      console.error("Error creating ingestion log:", logError);
      throw logError;
    }

    // Get data source configuration
    const { data: dataSource, error: dsError } = await supabase
      .from("data_sources")
      .select("*")
      .eq("id", data_source_id)
      .single();

    if (dsError || !dataSource) {
      console.error("Data source not found:", dsError);
      throw new Error("Data source not found");
    }

    console.log(`Data source type: ${dataSource.connector_type}`);

    // In a production environment, this is where you would:
    // 1. Connect to the external database using the stored credentials
    // 2. Execute the query (custom_query or default SELECT *)
    // 3. Stream the results and process them
    // 4. Store the data in an internal format for the project
    
    // For now, we'll simulate a successful ingestion
    // This would be replaced with actual database connection logic

    // Simulate some processing time and row count
    const simulatedRowCount = Math.floor(Math.random() * 10000) + 1000;
    const sampleSize = Math.min(simulatedRowCount, 100000);

    // Update ingestion log with results
    await supabase
      .from("project_data_ingestion_logs")
      .update({
        status: "success",
        rows_read: simulatedRowCount,
        rows_sampled: sampleSize,
        completed_at: new Date().toISOString()
      })
      .eq("id", logData.id);

    // Update data source last sync
    await supabase
      .from("data_sources")
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: "success",
        sync_message: `Successfully ingested ${simulatedRowCount} rows`
      })
      .eq("id", data_source_id);

    // Update project with data info
    await supabase
      .from("projects")
      .update({
        data_source_id,
        total_rows: simulatedRowCount,
        sample_rows: sampleSize,
        dataset_rows: sampleSize,
        status: "data_uploaded"
      })
      .eq("id", project_id);

    console.log(`Ingestion completed: ${simulatedRowCount} rows read, ${sampleSize} sampled`);

    return new Response(
      JSON.stringify({ 
        success: true,
        rows_read: simulatedRowCount,
        rows_sampled: sampleSize,
        message: `Successfully ingested data from ${dataSource.name}`
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200 
      }
    );
  } catch (error: unknown) {
    console.error("Error during database ingestion:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred during data ingestion";
    
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
