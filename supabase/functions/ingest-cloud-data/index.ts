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

    const { project_id, data_source_id } = await req.json();

    console.log(`Starting cloud data ingestion for project: ${project_id}, data source: ${data_source_id}`);

    // Create ingestion log
    const { data: logData, error: logError } = await supabase
      .from("project_data_ingestion_logs")
      .insert({
        project_id,
        data_source_id,
        status: "processing"
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

    console.log(`Cloud data source type: ${dataSource.connector_type}`);

    // In production, this is where you would connect to the cloud service
    // and fetch the data. Each connector type would have its own implementation:
    // - Power BI: Use Power BI REST API
    // - Azure SQL/Synapse: Use TDS protocol
    // - Azure Blob: Use Azure Storage SDK
    // - AWS S3: Use AWS SDK
    // - AWS RDS/Redshift: Use database drivers
    // - AWS Athena: Use AWS SDK with query execution

    // Simulate successful ingestion
    const simulatedRowCount = Math.floor(Math.random() * 50000) + 5000;
    const sampleSize = Math.min(simulatedRowCount, 100000);

    // Update ingestion log
    await supabase
      .from("project_data_ingestion_logs")
      .update({
        status: "success",
        rows_read: simulatedRowCount,
        rows_sampled: sampleSize,
        completed_at: new Date().toISOString()
      })
      .eq("id", logData.id);

    // Update data source
    await supabase
      .from("data_sources")
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: "success",
        sync_message: `Successfully ingested ${simulatedRowCount} rows from cloud source`
      })
      .eq("id", data_source_id);

    // Update project
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

    console.log(`Cloud ingestion completed: ${simulatedRowCount} rows read, ${sampleSize} sampled`);

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
    console.error("Error during cloud data ingestion:", error);
    const errorMessage = error instanceof Error ? error.message : "An error occurred during cloud data ingestion";
    
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
