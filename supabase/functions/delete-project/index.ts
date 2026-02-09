import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Autenticação necessária" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ success: false, error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Starting deletion for project: ${project_id}`);

    // 1. Verify user owns this project (RLS enforced)
    const { data: project, error: projectError } = await supabaseUser
      .from("projects")
      .select("id, user_id, dataset_filename, organization_id")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      return new Response(
        JSON.stringify({ success: false, error: "Projeto não encontrado ou sem permissão" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Storage cleanup (before DB cascade, since DB function can't do storage)
    if (project.dataset_filename) {
      const { error: storageError } = await supabaseAdmin.storage
        .from("datasets")
        .remove([project.dataset_filename]);
      if (storageError) console.warn(`[delete-project] storage datasets:`, storageError.message);
    }

    try {
      const userFolder = `${project.user_id}/${project_id}`;
      const { data: bigFiles } = await supabaseAdmin.storage
        .from("big_imports")
        .list(userFolder);
      if (bigFiles && bigFiles.length > 0) {
        const paths = bigFiles.map(f => `${userFolder}/${f.name}`);
        await supabaseAdmin.storage.from("big_imports").remove(paths);
        console.log(`[delete-project] Deleted ${paths.length} big_imports files`);
      }
    } catch (e) {
      console.warn(`[delete-project] big_imports cleanup error:`, e);
    }

    // 3. Call the DB function that handles full cascade with 300s timeout
    const { data: result, error: rpcError } = await supabaseAdmin
      .rpc("delete_project_cascade", { p_project_id: project_id });

    if (rpcError) {
      console.error(`[delete-project] RPC error:`, rpcError);
      return new Response(
        JSON.stringify({ success: false, error: "Erro ao excluir projeto: " + rpcError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[delete-project] Project ${project_id} deleted successfully`, result);

    return new Response(
      JSON.stringify({ success: true, message: "Projeto excluído com sucesso", details: result }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error(`[delete-project] Unexpected error:`, error);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno ao excluir projeto" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
