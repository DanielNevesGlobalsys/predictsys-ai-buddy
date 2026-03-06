import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let _cachedKey: string | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

/**
 * Fetches the OpenAI API key from an external Supabase database table `api_openai`.
 */
export async function getOpenAIKey(): Promise<string> {
  if (_cachedKey && Date.now() - _cachedAt < CACHE_TTL_MS) {
    return _cachedKey;
  }

  const url = Deno.env.get("EXTERNAL_SUPABASE_URL");
  const anonKey = Deno.env.get("EXTERNAL_SUPABASE_ANON_KEY");

  if (!url || !anonKey) {
    throw new Error("EXTERNAL_SUPABASE_URL or EXTERNAL_SUPABASE_ANON_KEY not configured");
  }

  const extClient = createClient(url, anonKey);
  const { data, error } = await extClient
    .from("api_openai")
    .select("key")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[openai-client] DB error fetching key:", JSON.stringify(error));
    throw new Error(`Failed to query api_openai table: ${error.message} (code: ${error.code})`);
  }

  if (!data || !data.key) {
    console.error("[openai-client] No rows found in api_openai table. Ensure the table has a row with a 'key' column and RLS allows reading with anon key.");
    throw new Error("No OpenAI key found in api_openai table. Check that the table has data and RLS permits access.");
  }

  _cachedKey = data.key;
  _cachedAt = Date.now();
  return _cachedKey!;
}

const OPENAI_BASE = "https://api.openai.com/v1/chat/completions";

interface OpenAIChatOptions {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  tools?: any[];
  tool_choice?: any;
}

/**
 * Calls OpenAI Chat Completions API using the key from the external DB.
 * Returns the raw Response object for flexibility.
 */
export async function callOpenAI(options: OpenAIChatOptions): Promise<Response> {
  const apiKey = await getOpenAIKey();

  const body: any = {
    model: options.model || "gpt-4o-mini",
    messages: options.messages,
  };

  if (options.max_tokens) body.max_tokens = options.max_tokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.tools) body.tools = options.tools;
  if (options.tool_choice) body.tool_choice = options.tool_choice;

  return fetch(OPENAI_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
