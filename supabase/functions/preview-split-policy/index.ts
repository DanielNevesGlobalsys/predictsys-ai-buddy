import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GateResult {
  gate: string;
  status: "PASS" | "WARN" | "BLOCK";
  message: string;
  details?: Record<string, unknown>;
}

interface SplitPreview {
  train_rows: number;
  valid_rows: number;
  test_rows: number;
  time_ranges?: { split: string; from: string; to: string }[];
  notes: string[];
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { project_id, selection_version, strategy: requestedStrategy, params: requestedParams } = await req.json();
    if (!project_id) {
      return new Response(JSON.stringify({ error: "project_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[preview-split-policy] Starting for project ${project_id}`);

    // Parallel fetch (include EDA snapshot for date column ranges)
    const [aiCtxRes, dsStateRes, selectionRes, numStatsRes, projectRes, edaSnapRes] = await Promise.all([
      supabase.from("project_ai_context").select("id, context").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_dataset_state").select("row_count, col_count").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_model_selection").select("selection_version").eq("project_id", project_id).maybeSingle(),
      supabase.from("project_numeric_stats").select("column_name, min_value, max_value").eq("project_id", project_id),
      supabase.from("projects").select("dataset_rows, total_rows").eq("id", project_id).maybeSingle(),
      supabase.from("project_eda_snapshots").select("eda_json").eq("project_id", project_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    // Fallback chain: dataset_state → projects table → numeric stats estimate
    let totalRows = dsStateRes.data?.row_count
      || (projectRes.data as any)?.dataset_rows
      || (projectRes.data as any)?.total_rows
      || 0;
    if (totalRows === 0 && numStatsRes.data && numStatsRes.data.length > 0) {
      const idStat = numStatsRes.data.find((n: any) => /^id/i.test(n.column_name));
      const anyStat = idStat || numStatsRes.data[0];
      if (anyStat?.max_value && Number(anyStat.max_value) > 0) {
        totalRows = Math.round(Number(anyStat.max_value));
        console.log(`[preview-split-policy] Fallback row estimate from ${anyStat.column_name}: ${totalRows}`);
      }
    }
    // Last resort: if we have any stats at all, assume minimum viable dataset
    if (totalRows === 0 && numStatsRes.data && numStatsRes.data.length > 0) {
      totalRows = 1000;
      console.log(`[preview-split-policy] Last-resort fallback: assuming ${totalRows} rows`);
    }
    const currentSelVersion = selection_version || (selectionRes.data as any)?.selection_version || 1;
    const aiContext = (aiCtxRes.data?.context as Record<string, any>) || {};
    const contractHints = aiContext.contract_hints || {};
    const intentContract = aiContext.intent_contract || aiContext.intent || {};
    const intentBase = intentContract.intent_base || intentContract;
    const domainAdapter = intentContract.domain_adapter || {};

    const entityKey: string | null = contractHints.entity_key || null;
    const timeAnchor: string | null = contractHints.time_anchor_column || null;
    const requiresTime: boolean = intentBase.requires_time_column ?? false;

    if (totalRows === 0) {
      return new Response(JSON.stringify({ error: "Nenhum dado encontrado." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Determine strategy
    let strategy = requestedStrategy || "random";
    const params = requestedParams || {};
    const gates: GateResult[] = [];
    const notes: string[] = [];
    let recommendedPolicy: Record<string, any> | null = null;

    // Auto-detect strategy
    if (!requestedStrategy) {
      if (requiresTime && timeAnchor) {
        strategy = "temporal";
      } else if (entityKey && !timeAnchor) {
        strategy = "grouped";
      } else {
        strategy = "random";
      }
    }

    // SPLIT_SANITY gates
    if (requiresTime && !timeAnchor) {
      gates.push({
        gate: "SPLIT_SANITY",
        status: "BLOCK",
        message: "Split temporal obrigatório, mas nenhuma coluna de data/hora foi detectada. Selecione a coluna de data na Etapa 2.",
        details: { requires_time_column: true, time_anchor: null },
      });
    }

    if (strategy === "random" && timeAnchor && requiresTime) {
      // Strong WARN — user chose random but temporal is recommended
      const objective = (intentBase.declared_objective || intentBase.objective || "").toLowerCase();
      const isChurnLike = /churn|convers|inadimpl|atrit|evas|cancel|reten/.test(objective);
      gates.push({
        gate: "SPLIT_SANITY",
        status: isChurnLike ? "BLOCK" : "WARN",
        message: isChurnLike
          ? `Para objetivos de ${objective.includes("churn") ? "churn" : "conversão"}, split temporal é obrigatório para evitar data leakage. Use split temporal.`
          : "Coluna temporal detectada, mas split aleatório selecionado. Split temporal é recomendado para problemas com dependência temporal.",
        details: { recommended_strategy: "temporal", time_anchor: timeAnchor },
      });
      recommendedPolicy = { strategy: "temporal", params: { train_months: 12, valid_months: 2, test_months: 1, time_grain: "month" } };
    }

    // Compute split preview
    const defaultParams: Record<string, any> = {
      temporal: { train_months: 12, valid_months: 2, test_months: 1, time_grain: "month" },
      random: { test_size: 0.2, seed: 42 },
      grouped: { group_key: entityKey || "", test_size: 0.2, seed: 42 },
    };

    const effectiveParams = { ...defaultParams[strategy] || {}, ...params };

    let preview: SplitPreview;

    if (strategy === "temporal") {
      const trainMonths = effectiveParams.train_months || 12;
      const validMonths = effectiveParams.valid_months || 2;
      const testMonths = effectiveParams.test_months || 1;
      const totalMonths = trainMonths + validMonths + testMonths;

      const trainPct = trainMonths / totalMonths;
      const validPct = validMonths / totalMonths;
      const testPct = testMonths / totalMonths;

      const trainRows = Math.floor(totalRows * trainPct);
      const validRows = Math.floor(totalRows * validPct);
      const testRows = totalRows - trainRows - validRows;

      // --- Detect actual date range from multiple sources ---
      const formatLocalDate = (d: Date): string => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      };

      // Try parse a date string in multiple formats
      const tryParseDate = (val: unknown): Date | null => {
        if (!val) return null;
        const s = String(val).trim();
        // ISO / YYYY-MM-DD
        const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (isoMatch) {
          const d = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
          return !isNaN(d.getTime()) && d.getFullYear() > 1900 ? d : null;
        }
        // dd/MM/yyyy
        const brMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (brMatch) {
          const d = new Date(Number(brMatch[3]), Number(brMatch[2]) - 1, Number(brMatch[1]));
          return !isNaN(d.getTime()) && d.getFullYear() > 1900 ? d : null;
        }
        // Epoch number
        const num = Number(s);
        if (!isNaN(num) && num > 946684800000 && num < 4102444800000) {
          return new Date(num);
        }
        if (!isNaN(num) && num > 946684800 && num < 4102444800) {
          return new Date(num * 1000);
        }
        // Fallback: native parse
        const d = new Date(s);
        return !isNaN(d.getTime()) && d.getFullYear() > 1900 ? d : null;
      };

      let detectedMinDate: Date | null = null;
      let detectedMaxDate: Date | null = null;
      let dateSourceUsed = "none";
      let dateParseWarning = false;

      // Source 1: EDA snapshot — look for time anchor column stats
      if (edaSnapRes.data?.eda_json && timeAnchor) {
        const eda = edaSnapRes.data.eda_json as Record<string, any>;
        // EDA JSON may store per-column stats in various structures
        const colStats = eda.column_stats || eda.columns || {};
        const anchorStats = colStats[timeAnchor] || {};
        
        const edaMin = tryParseDate(anchorStats.min || anchorStats.min_value || anchorStats.earliest);
        const edaMax = tryParseDate(anchorStats.max || anchorStats.max_value || anchorStats.latest);
        
        if (edaMin && edaMax && edaMax > edaMin) {
          detectedMinDate = edaMin;
          detectedMaxDate = edaMax;
          dateSourceUsed = "eda_snapshot";
        }

        // Also check temporal_summary if available
        if (!detectedMinDate && eda.temporal_summary) {
          const ts = eda.temporal_summary;
          const tsMin = tryParseDate(ts.min_date || ts.start_date);
          const tsMax = tryParseDate(ts.max_date || ts.end_date);
          if (tsMin && tsMax && tsMax > tsMin) {
            detectedMinDate = tsMin;
            detectedMaxDate = tsMax;
            dateSourceUsed = "eda_temporal_summary";
          }
        }
      }

      // Source 2: Numeric stats (existing behavior — works if dates stored as epoch)
      if (!detectedMinDate && timeAnchor) {
        const timeStat = (numStatsRes.data || []).find((n: any) => n.column_name === timeAnchor);
        if (timeStat?.min_value != null && timeStat?.max_value != null) {
          const parsedMin = tryParseDate(timeStat.min_value);
          const parsedMax = tryParseDate(timeStat.max_value);
          if (parsedMin && parsedMax && parsedMax > parsedMin) {
            detectedMinDate = parsedMin;
            detectedMaxDate = parsedMax;
            dateSourceUsed = "numeric_stats";
          }
        }
      }

      // Source 3: Categorical stats — top categories might contain date strings
      if (!detectedMinDate && timeAnchor) {
        const { data: catStats } = await supabase
          .from("project_categorical_stats")
          .select("top_categories")
          .eq("project_id", project_id)
          .eq("column_name", timeAnchor)
          .maybeSingle();
        
        if (catStats?.top_categories) {
          const cats = Array.isArray(catStats.top_categories) ? catStats.top_categories : [];
          const parsedDates: Date[] = [];
          let failCount = 0;
          for (const cat of cats) {
            const val = typeof cat === "object" ? (cat as any).value || (cat as any).category : cat;
            const d = tryParseDate(val);
            if (d) parsedDates.push(d);
            else failCount++;
          }
          if (parsedDates.length >= 2) {
            parsedDates.sort((a, b) => a.getTime() - b.getTime());
            detectedMinDate = parsedDates[0];
            detectedMaxDate = parsedDates[parsedDates.length - 1];
            dateSourceUsed = "categorical_stats";
            if (failCount > parsedDates.length * 0.3) {
              dateParseWarning = true;
            }
          }
        }
      }

      console.log(`[preview-split-policy] Date detection: source=${dateSourceUsed}, min=${detectedMinDate ? formatLocalDate(detectedMinDate) : "null"}, max=${detectedMaxDate ? formatLocalDate(detectedMaxDate) : "null"}`);

      // Build time ranges from detected dates
      const timeRanges: { split: string; from: string; to: string }[] = [];
      let dataSpanMonths = 0;

      if (detectedMinDate && detectedMaxDate && detectedMaxDate > detectedMinDate) {
        dataSpanMonths = (detectedMaxDate.getFullYear() - detectedMinDate.getFullYear()) * 12 
          + (detectedMaxDate.getMonth() - detectedMinDate.getMonth());

        // Split points relative to max_date (ref_end), never "today"
        const totalSpanMs = detectedMaxDate.getTime() - detectedMinDate.getTime();
        const trainEndMs = detectedMinDate.getTime() + totalSpanMs * trainPct;
        const validEndMs = trainEndMs + totalSpanMs * validPct;

        const trainEnd = new Date(trainEndMs);
        const validEnd = new Date(validEndMs);

        timeRanges.push(
          { split: "train", from: formatLocalDate(detectedMinDate), to: formatLocalDate(trainEnd) },
          { split: "valid", from: formatLocalDate(trainEnd), to: formatLocalDate(validEnd) },
          { split: "test", from: formatLocalDate(validEnd), to: formatLocalDate(detectedMaxDate) },
        );
      } else if (timeAnchor) {
        // Could not detect valid dates — add gate
        gates.push({
          gate: "SPLIT_SANITY",
          status: "BLOCK",
          message: `Não foi possível detectar datas válidas na coluna "${timeAnchor}". Verifique se a coluna contém datas no formato YYYY-MM-DD ou dd/MM/yyyy.`,
          details: { time_anchor: timeAnchor, date_source: dateSourceUsed },
        });
      }

      // Add parse quality warning
      if (dateParseWarning) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: `Mais de 30% dos valores da coluna "${timeAnchor}" não puderam ser interpretados como data. As datas detectadas podem ser aproximadas.`,
          details: { time_anchor: timeAnchor },
        });
      }

      preview = {
        train_rows: trainRows,
        valid_rows: validRows,
        test_rows: testRows,
        time_ranges: timeRanges,
        detected_min_date: detectedMinDate ? formatLocalDate(detectedMinDate) : null,
        detected_max_date: detectedMaxDate ? formatLocalDate(detectedMaxDate) : null,
        notes: [],
      } as any;
      notes.push(`Split temporal: treino=${trainMonths}m, validação=${validMonths}m, teste=${testMonths}m`);

      // === TEMPORAL COVERAGE GATES ===

      // 1. Minimum train months
      if (trainMonths < 6) {
        const objective = (intentBase.declared_objective || intentBase.objective || "").toLowerCase();
        const isChurnLike = /churn|convers|inadimpl|atrit|evas|cancel|reten/.test(objective);
        gates.push({
          gate: "SPLIT_SANITY",
          status: isChurnLike ? "BLOCK" : "WARN",
          message: `Período de treino de ${trainMonths} meses é curto${isChurnLike ? " para problemas de churn/conversão" : ""}. Recomendado: ≥ 6 meses.`,
          details: { train_months: trainMonths, recommended_min: 6 },
        });
      }

      // 2. Data span vs requested span (temporal gaps)
      if (dataSpanMonths > 0 && dataSpanMonths < totalMonths) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: `Dataset cobre apenas ${dataSpanMonths} meses, mas split solicita ${totalMonths} meses. Podem existir buracos temporais.`,
          details: { data_span_months: dataSpanMonths, requested_months: totalMonths },
        });
      }

      // 3. Minimum row counts per split
      if (testRows < 200) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "BLOCK",
          message: `Split temporal produz apenas ${testRows} linhas de teste (mínimo: 200). Aumente os dados ou ajuste as proporções.`,
          details: { test_rows: testRows, min_required: 200 },
        });
      }
      if (validRows < 200) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: `Split temporal produz apenas ${validRows} linhas de validação (mínimo recomendado: 200). Resultados de validação podem ser instáveis.`,
          details: { valid_rows: validRows, min_recommended: 200 },
        });
      }
      if (trainRows < 500) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: `Split temporal produz apenas ${trainRows} linhas de treino. Resultados podem ser pouco confiáveis.`,
          details: { train_rows: trainRows },
        });
      }
    } else if (strategy === "grouped") {
      const testSize = effectiveParams.test_size || 0.2;
      const trainRows = Math.floor(totalRows * (1 - testSize) * 0.875);
      const validRows = Math.floor(totalRows * (1 - testSize) * 0.125);
      const testRows = totalRows - trainRows - validRows;

      preview = { train_rows: trainRows, valid_rows: validRows, test_rows: testRows, notes: [] };
      notes.push(`Split por grupo (${entityKey || "entity_key"}): ${(testSize * 100).toFixed(0)}% teste`);

      if (!entityKey) {
        gates.push({
          gate: "SPLIT_SANITY",
          status: "WARN",
          message: "Split agrupado selecionado, mas nenhuma entity_key detectada. O split pode não prevenir vazamento entre treino e teste.",
        });
      }
    } else {
      // random
      const testSize = effectiveParams.test_size || 0.2;
      const trainRows = Math.floor(totalRows * (1 - testSize) * 0.875);
      const validRows = Math.floor(totalRows * (1 - testSize) * 0.125);
      const testRows = totalRows - trainRows - validRows;

      preview = { train_rows: trainRows, valid_rows: validRows, test_rows: testRows, notes: [] };
      notes.push(`Split aleatório: ${((1 - testSize) * 100).toFixed(0)}% treino, ${(testSize * 100).toFixed(0)}% teste`);
    }

    preview.notes = notes;

    // If no blocks or warns, add PASS
    if (gates.length === 0) {
      gates.push({
        gate: "SPLIT_SANITY",
        status: "PASS",
        message: `Split ${strategy} configurado: treino=${preview.train_rows}, validação=${preview.valid_rows}, teste=${preview.test_rows}.`,
      });
    }

    const hasBlock = gates.some(g => g.status === "BLOCK");
    const policyStatus = hasBlock ? "blocked" : "ready";

    // Upsert split policy
    const { data: existing } = await supabase
      .from("project_split_policies")
      .select("id")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      await supabase.from("project_split_policies").update({
        selection_version: currentSelVersion,
        strategy,
        time_anchor_column: timeAnchor,
        entity_key_column: entityKey,
        params: effectiveParams,
        status: policyStatus,
        preview: { ...preview, gates },
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
    } else {
      await supabase.from("project_split_policies").insert({
        project_id,
        selection_version: currentSelVersion,
        strategy,
        time_anchor_column: timeAnchor,
        entity_key_column: entityKey,
        params: effectiveParams,
        status: policyStatus,
        preview: { ...preview, gates },
      });
    }

    // Persist summary in AI context
    if (aiCtxRes.data) {
      const currentCtx = aiCtxRes.data.context as Record<string, any> || {};
      await supabase.from("project_ai_context").update({
        context: {
          ...currentCtx,
          split_policy: {
            strategy,
            time_anchor_column: timeAnchor,
            entity_key_column: entityKey,
            params: effectiveParams,
            status: policyStatus,
            preview_summary: { train_rows: preview.train_rows, valid_rows: preview.valid_rows, test_rows: preview.test_rows },
            updated_at: new Date().toISOString(),
          },
        },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiCtxRes.data.id);
    }

    // === POLICY DRIFT: check if selection_version changed ===
    const existingPolicyVersion = (await supabase
      .from("project_split_policies")
      .select("selection_version")
      .eq("project_id", project_id)
      .neq("status", "outdated")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()).data;

    if (existingPolicyVersion && existingPolicyVersion.selection_version < currentSelVersion) {
      // Mark old policies as outdated
      await supabase.from("project_split_policies")
        .update({ status: "outdated", updated_at: new Date().toISOString() })
        .eq("project_id", project_id)
        .lt("selection_version", currentSelVersion);

      gates.push({
        gate: "POLICY_DRIFT",
        status: "WARN",
        message: `Split policy anterior (v${existingPolicyVersion.selection_version}) ficou desatualizada após mudança de seleção (v${currentSelVersion}). Nova policy gerada.`,
        details: { old_version: existingPolicyVersion.selection_version, new_version: currentSelVersion },
      });
    }

    // CLASS BALANCE auto-detection
    let classBalancePolicy: Record<string, any> | null = null;
    const labelBuilder = aiContext.label_builder;
    if (labelBuilder?.preview_summary?.positive_rate) {
      const pr = labelBuilder.preview_summary.positive_rate;
      const topClassPct = Math.max(pr, 1 - pr);
      if (topClassPct > 0.90) {
        const method = topClassPct > 0.95 ? "undersample" : "class_weight";
        classBalancePolicy = { method, threshold: topClassPct, auto_applied: true };
        gates.push({
          gate: "CLASS_BALANCE",
          status: "WARN",
          message: `Desbalanceamento detectado (classe dominante: ${(topClassPct * 100).toFixed(1)}%). Será aplicado ${method} automaticamente.`,
          details: { top_class_pct: topClassPct, method },
        });
      }
    }

    // Persist class_balance in AI context
    if (aiCtxRes.data && classBalancePolicy) {
      const currentCtx2 = (await supabase.from("project_ai_context").select("context").eq("id", aiCtxRes.data.id).single()).data;
      const ctx2 = (currentCtx2?.context as Record<string, any>) || {};
      await supabase.from("project_ai_context").update({
        context: {
          ...ctx2,
          class_balance: {
            ...classBalancePolicy,
            updated_at: new Date().toISOString(),
          },
        },
        last_updated_at: new Date().toISOString(),
      }).eq("id", aiCtxRes.data.id);
    }

    console.log(`[preview-split-policy] Done: strategy=${strategy}, status=${policyStatus}`);

    return new Response(JSON.stringify({
      success: true,
      policy: {
        strategy,
        time_anchor_column: timeAnchor,
        entity_key_column: entityKey,
        params: effectiveParams,
      },
      preview,
      gates,
      recommended_policy: recommendedPolicy,
      class_balance: classBalancePolicy,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[preview-split-policy] Error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Erro desconhecido",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
