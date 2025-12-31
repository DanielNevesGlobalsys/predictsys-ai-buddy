import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface TranslationRequest {
  texts: { key: string; value: string }[];
  targetLanguage: string;
  sourceLanguage?: string;
}

const languageNames: Record<string, string> = {
  "pt": "Portuguese",
  "pt-BR": "Portuguese",
  "en": "English",
  "es": "Spanish",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      console.error("[translate-content] LOVABLE_API_KEY not configured");
      return new Response(
        JSON.stringify({ success: false, error: "AI API not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { texts, targetLanguage, sourceLanguage }: TranslationRequest = await req.json();

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "No texts provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!targetLanguage) {
      return new Response(
        JSON.stringify({ success: false, error: "Target language is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Filter out empty texts
    const validTexts = texts.filter(t => t.value && t.value.trim().length > 0);
    
    if (validTexts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, translations: {} }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const targetLangName = languageNames[targetLanguage] || targetLanguage;
    const sourceLangName = sourceLanguage ? (languageNames[sourceLanguage] || sourceLanguage) : "auto-detect";

    // Build prompt for translation
    const textsToTranslate = validTexts.map(t => `[${t.key}]: ${t.value}`).join("\n");
    
    const systemPrompt = `You are a professional translator. Translate the following texts to ${targetLangName}. 
The texts are from a machine learning project management application.
Maintain the meaning and context of the original text.
Return ONLY a valid JSON object with the same keys and translated values.
Do not include any markdown formatting, code blocks, or explanations.`;

    const userPrompt = `Translate these texts from ${sourceLangName} to ${targetLangName}:

${textsToTranslate}

Return as JSON object like: {"key1": "translated text 1", "key2": "translated text 2"}`;

    console.log(`[translate-content] Translating ${validTexts.length} texts to ${targetLangName}`);

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      }),
    });

    if (!aiResponse.ok) {
      const status = aiResponse.status;
      console.error(`[translate-content] AI Gateway error: ${status}`);
      
      if (status === 429) {
        return new Response(
          JSON.stringify({ success: false, error: "Rate limit exceeded" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (status === 402) {
        return new Response(
          JSON.stringify({ success: false, error: "AI credits exhausted" }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: "AI translation error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices?.[0]?.message?.content || "";

    console.log(`[translate-content] AI response: ${content.substring(0, 200)}...`);

    // Parse the JSON response
    let translations: Record<string, string> = {};
    try {
      // Clean up the response - remove markdown code blocks if present
      let cleanContent = content.trim();
      if (cleanContent.startsWith("```")) {
        cleanContent = cleanContent.replace(/```json?\n?/g, "").replace(/```\n?$/g, "").trim();
      }
      translations = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error("[translate-content] Failed to parse AI response:", parseError);
      // Return original texts if parsing fails
      translations = validTexts.reduce((acc, t) => ({ ...acc, [t.key]: t.value }), {});
    }

    return new Response(
      JSON.stringify({ success: true, translations }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[translate-content] Unexpected error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
