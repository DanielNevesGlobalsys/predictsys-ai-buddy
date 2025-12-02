import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Get auth header to identify user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Autenticação necessária" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create client with user's token for RLS
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { project_id } = await req.json();

    if (!project_id) {
      return new Response(
        JSON.stringify({ success: false, error: "project_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[clear-project-chat] Starting chat clear for project: ${project_id}`);

    // 1. Verify user owns this project (RLS will enforce this)
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      console.error(`[clear-project-chat] Project not found or access denied:`, projectError);
      return new Response(
        JSON.stringify({ success: false, error: "Projeto não encontrado ou sem permissão" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Delete all chat messages for this project
    const { error: deleteError, count } = await supabase
      .from("project_chat_messages")
      .delete()
      .eq("project_id", project_id);

    if (deleteError) {
      console.error(`[clear-project-chat] Error deleting messages:`, deleteError);
      return new Response(
        JSON.stringify({ success: false, error: "Erro ao limpar histórico: " + deleteError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[clear-project-chat] Cleared chat history for project ${project_id}`);

    return new Response(
      JSON.stringify({ success: true, message: "Histórico do chat limpo com sucesso" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error(`[clear-project-chat] Unexpected error:`, error);
    return new Response(
      JSON.stringify({ success: false, error: "Erro interno ao limpar histórico" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
