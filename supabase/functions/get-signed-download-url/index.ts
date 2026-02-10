import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startMs = Date.now();

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // ── Auth: validate JWT ──────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Parse request ───────────────────────────────────────────
    const { bucket, path, file_name, export_job_id } = await req.json();

    let targetBucket: string;
    let targetPath: string;
    let suggestedFileName: string;

    if (export_job_id) {
      // Mode 1: Download an export job result
      const { data: job, error: jobError } = await supabase
        .from("export_jobs")
        .select("*")
        .eq("id", export_job_id)
        .eq("user_id", user.id)
        .eq("status", "completed")
        .single();

      if (jobError || !job) {
        return new Response(
          JSON.stringify({ error: "Export job not found or not yours" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // The export is stored in "exports" bucket
      targetBucket = "exports";
      targetPath = `${job.user_id}/${job.project_id}/${job.id}.csv`;
      suggestedFileName = `${job.export_type}_${job.id.slice(0, 8)}.csv`;
    } else if (bucket && path) {
      // Mode 2: Direct storage path download
      // Validate the user owns the file (path must start with their user_id)
      if (!path.startsWith(user.id + "/")) {
        return new Response(
          JSON.stringify({ error: "Access denied: file does not belong to you" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const allowedBuckets = ["datasets", "exports", "big_imports"];
      if (!allowedBuckets.includes(bucket)) {
        return new Response(
          JSON.stringify({ error: `Bucket "${bucket}" not allowed` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      targetBucket = bucket;
      targetPath = path;
      suggestedFileName = file_name || path.split("/").pop() || "download";
    } else {
      return new Response(
        JSON.stringify({ error: "Provide export_job_id or (bucket + path)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Generate signed URL (5 min expiry) ──────────────────────
    const { data: signedData, error: signedError } = await supabase.storage
      .from(targetBucket)
      .createSignedUrl(targetPath, 5 * 60, {
        download: suggestedFileName,
      });

    if (signedError || !signedData?.signedUrl) {
      console.error("[get-signed-download-url] Signed URL error:", signedError);
      return new Response(
        JSON.stringify({
          error: "Failed to generate download URL",
          detail: signedError?.message,
          download_path: "failed",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const elapsedMs = Date.now() - startMs;

    console.log(
      `[get-signed-download-url] OK: bucket=${targetBucket}, path=${targetPath}, ` +
        `file="${suggestedFileName}", elapsed=${elapsedMs}ms`,
    );

    return new Response(
      JSON.stringify({
        signed_url: signedData.signedUrl,
        file_name: suggestedFileName,
        bucket: targetBucket,
        download_path: "direct_storage",
        signed_url_generation_ms: elapsedMs,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[get-signed-download-url] Error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message, download_path: "error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
