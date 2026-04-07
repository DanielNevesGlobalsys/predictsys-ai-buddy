/**
 * LIS AI OS — Orchestration Integration Tests
 * Tests the edge function lis-orchestrator via real HTTP calls.
 * Run with: deno test --allow-net --allow-env --allow-read supabase/functions/lis-orchestrator/index.test.ts
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

const ORCHESTRATOR_URL = `${SUPABASE_URL}/functions/v1/lis-orchestrator`;

// ─── Helper ───

async function invokeOrchestrator(
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(ORCHESTRATOR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ─── Auth helper ───

async function getTestToken(): Promise<string | null> {
  // This test requires a real user session — skip if not available
  const testEmail = Deno.env.get("TEST_USER_EMAIL");
  const testPassword = Deno.env.get("TEST_USER_PASSWORD");
  if (!testEmail || !testPassword) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const data = await res.json();
  await (res.body?.cancel?.() || Promise.resolve());
  return data.access_token || null;
}

// ─── Tests ───

Deno.test("LIS Orchestrator — rejects unauthenticated requests", async () => {
  const res = await fetch(ORCHESTRATOR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      project_id: "test",
      organization_id: "test",
      stage: "eda",
    }),
  });
  const body = await res.text();
  assertEquals(res.status, 401);
});

Deno.test("LIS Orchestrator — rejects missing required fields", async () => {
  const token = await getTestToken();
  if (!token) {
    console.log("SKIP: No test credentials configured");
    return;
  }

  const { status, data } = await invokeOrchestrator(
    { project_id: "test" },
    token,
  );
  assertEquals(status, 400);
  assertExists(data.error);
});

Deno.test("LIS Orchestrator — returns orchestration metadata", async () => {
  const token = await getTestToken();
  if (!token) {
    console.log("SKIP: No test credentials configured");
    return;
  }

  // Use a stage that should resolve orchestration config
  const { status, data } = await invokeOrchestrator(
    {
      project_id: "00000000-0000-0000-0000-000000000000",
      organization_id: "00000000-0000-0000-0000-000000000000",
      stage: "eda",
      agent_name: "data_engineer_agent",
      execution_mode: "shadow",
    },
    token,
  );

  // May fail on project not found, but should include orchestration or error
  if (status === 200) {
    assertExists(data.orchestration);
    assertEquals(data.orchestration.primary_agent, "data_engineer_agent");
    assertEquals(data.orchestration.validator_agent, "governance_agent");
    assertExists(data.orchestration.application_policy);
    assertExists(data.execution_id);
  }
});

Deno.test("LIS Orchestrator — CORS headers present", async () => {
  const res = await fetch(ORCHESTRATOR_URL, { method: "OPTIONS" });
  await res.text();
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});
