/**
 * Tool-calling benchmark for free-tier Copilot models.
 *
 * Tests each model on a suite of tool-calling scenarios, scoring
 * correctness, parameter accuracy, and latency.
 */

const BASE = "http://localhost:8080";
const API_KEY = "sk-proxy-e2e-test-key";

const FREE_MODELS = [
  "oswe-vscode-prime",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4",
  "gpt-3.5-turbo",
];

// ── Tool definitions ─────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a location.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name, e.g. 'San Francisco'" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit" },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search a product catalog by query, with optional filters.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          category: { type: "string", enum: ["electronics", "clothing", "food", "books"], description: "Product category" },
          max_price: { type: "number", description: "Maximum price filter" },
          in_stock: { type: "boolean", description: "Only show in-stock items" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email to a recipient.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body text" },
          cc: { type: "array", items: { type: "string" }, description: "CC recipients" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Perform a mathematical calculation.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Math expression to evaluate, e.g. '(5 + 3) * 2'" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Create a calendar event.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title" },
          date: { type: "string", description: "Date in YYYY-MM-DD format" },
          time: { type: "string", description: "Time in HH:MM format (24h)" },
          duration_minutes: { type: "integer", description: "Duration in minutes" },
          attendees: { type: "array", items: { type: "string" }, description: "Email addresses of attendees" },
        },
        required: ["title", "date", "time"],
      },
    },
  },
];

// ── Test cases ───────────────────────────────────────────

interface TestCase {
  name: string;
  difficulty: "easy" | "medium" | "hard";
  messages: Array<{ role: string; content: string }>;
  expect: {
    toolName: string;
    requiredParams: Record<string, (v: any) => boolean>;
    optionalParams?: string[];
  };
}

const CASES: TestCase[] = [
  // ── Easy: single tool, obvious choice ──
  {
    name: "simple_weather",
    difficulty: "easy",
    messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
    expect: {
      toolName: "get_weather",
      requiredParams: {
        location: (v) => typeof v === "string" && v.toLowerCase().includes("tokyo"),
      },
    },
  },
  {
    name: "simple_calc",
    difficulty: "easy",
    messages: [{ role: "user", content: "Calculate 15 * 7 + 3" }],
    expect: {
      toolName: "calculate",
      requiredParams: {
        expression: (v) => typeof v === "string" && v.length > 0,
      },
    },
  },
  {
    name: "simple_email",
    difficulty: "easy",
    messages: [{ role: "user", content: "Send an email to alice@example.com with subject 'Meeting Tomorrow' and body 'Let's meet at 3pm.'" }],
    expect: {
      toolName: "send_email",
      requiredParams: {
        to: (v) => v === "alice@example.com",
        subject: (v) => typeof v === "string" && v.toLowerCase().includes("meeting"),
        body: (v) => typeof v === "string" && v.length > 0,
      },
    },
  },

  // ── Medium: needs correct optional params or mild inference ──
  {
    name: "weather_with_unit",
    difficulty: "medium",
    messages: [{ role: "user", content: "What's the temperature in Berlin in Celsius?" }],
    expect: {
      toolName: "get_weather",
      requiredParams: {
        location: (v) => typeof v === "string" && v.toLowerCase().includes("berlin"),
        unit: (v) => v === "celsius",
      },
    },
  },
  {
    name: "product_search_filtered",
    difficulty: "medium",
    messages: [{ role: "user", content: "Find me electronics under $50 that are in stock" }],
    expect: {
      toolName: "search_products",
      requiredParams: {
        category: (v) => v === "electronics",
        max_price: (v) => v === 50 || v === 50.0,
        in_stock: (v) => v === true,
      },
      optionalParams: ["query"],
    },
  },
  {
    name: "calendar_full_params",
    difficulty: "medium",
    messages: [{ role: "user", content: "Schedule a meeting called 'Sprint Review' on 2025-01-15 at 14:00 for 60 minutes with bob@co.com and carol@co.com" }],
    expect: {
      toolName: "create_calendar_event",
      requiredParams: {
        title: (v) => typeof v === "string" && v.toLowerCase().includes("sprint"),
        date: (v) => v === "2025-01-15",
        time: (v) => v === "14:00",
        duration_minutes: (v) => v === 60,
        attendees: (v) => Array.isArray(v) && v.length === 2,
      },
    },
  },
  {
    name: "email_with_cc",
    difficulty: "medium",
    messages: [{ role: "user", content: "Email dave@test.com about 'Q4 Report' with body 'Attached is the Q4 report.' and CC finance@test.com" }],
    expect: {
      toolName: "send_email",
      requiredParams: {
        to: (v) => v === "dave@test.com",
        subject: (v) => typeof v === "string" && v.toLowerCase().includes("q4"),
        body: (v) => typeof v === "string" && v.length > 0,
        cc: (v) => Array.isArray(v) && v.some((e: string) => e.includes("finance")),
      },
    },
  },

  // ── Hard: ambiguous, requires inference, or tricky ──
  {
    name: "implicit_tool_choice",
    difficulty: "hard",
    messages: [{ role: "user", content: "I need to know if it'll rain in London — use Fahrenheit please" }],
    expect: {
      toolName: "get_weather",
      requiredParams: {
        location: (v) => typeof v === "string" && v.toLowerCase().includes("london"),
        unit: (v) => v === "fahrenheit",
      },
    },
  },
  {
    name: "no_tool_needed",
    difficulty: "hard",
    messages: [{ role: "user", content: "What is the capital of France?" }],
    expect: {
      toolName: "__none__", // should NOT call a tool
      requiredParams: {},
    },
  },
  {
    name: "complex_search_inference",
    difficulty: "hard",
    messages: [{ role: "user", content: "I'm looking for a good novel, something available and not too expensive — say under 20 bucks" }],
    expect: {
      toolName: "search_products",
      requiredParams: {
        category: (v) => v === "books",
        max_price: (v) => v === 20 || v === 20.0,
        in_stock: (v) => v === true,
      },
      optionalParams: ["query"],
    },
  },
  {
    name: "multi_step_context",
    difficulty: "hard",
    messages: [
      { role: "user", content: "I just had a meeting with the Tokyo office." },
      { role: "assistant", content: "That sounds great! How did it go?" },
      { role: "user", content: "Good — can you check the weather there? I might fly out next week." },
    ],
    expect: {
      toolName: "get_weather",
      requiredParams: {
        location: (v) => typeof v === "string" && v.toLowerCase().includes("tokyo"),
      },
    },
  },
];

// ── Runner ───────────────────────────────────────────────

interface CaseResult {
  case: string;
  difficulty: string;
  passed: boolean;
  calledTool: boolean;
  correctTool: boolean;
  paramScore: number; // 0.0 - 1.0
  paramDetails: Record<string, boolean>;
  latencyMs: number;
  error?: string;
  rawToolCall?: any;
}

async function runCase(model: string, tc: TestCase): Promise<CaseResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: tc.messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 256,
        temperature: 0,
      }),
    });
    const latencyMs = performance.now() - start;
    const body = (await res.json()) as any;

    if (!res.ok) {
      return {
        case: tc.name,
        difficulty: tc.difficulty,
        passed: false,
        calledTool: false,
        correctTool: false,
        paramScore: 0,
        paramDetails: {},
        latencyMs,
        error: body?.error?.message ?? `HTTP ${res.status}`,
      };
    }

    const choice = body.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    const calledTool = Array.isArray(toolCalls) && toolCalls.length > 0;

    // Special case: "no tool needed"
    if (tc.expect.toolName === "__none__") {
      return {
        case: tc.name,
        difficulty: tc.difficulty,
        passed: !calledTool,
        calledTool,
        correctTool: !calledTool,
        paramScore: calledTool ? 0 : 1,
        paramDetails: {},
        latencyMs,
      };
    }

    if (!calledTool) {
      return {
        case: tc.name,
        difficulty: tc.difficulty,
        passed: false,
        calledTool: false,
        correctTool: false,
        paramScore: 0,
        paramDetails: {},
        latencyMs,
      };
    }

    const call = toolCalls[0];
    const fnName = call.function?.name;
    const correctTool = fnName === tc.expect.toolName;

    let args: Record<string, any> = {};
    try {
      args = typeof call.function?.arguments === "string"
        ? JSON.parse(call.function.arguments)
        : call.function?.arguments ?? {};
    } catch {
      // malformed JSON
    }

    // Score parameters
    const paramDetails: Record<string, boolean> = {};
    const checks = Object.entries(tc.expect.requiredParams);
    for (const [key, validator] of checks) {
      try {
        paramDetails[key] = validator(args[key]);
      } catch {
        paramDetails[key] = false;
      }
    }

    const paramScore = checks.length > 0
      ? Object.values(paramDetails).filter(Boolean).length / checks.length
      : 1;

    const passed = correctTool && paramScore === 1;

    return {
      case: tc.name,
      difficulty: tc.difficulty,
      passed,
      calledTool,
      correctTool,
      paramScore,
      paramDetails,
      latencyMs,
      rawToolCall: { name: fnName, arguments: args },
    };
  } catch (e: any) {
    return {
      case: tc.name,
      difficulty: tc.difficulty,
      passed: false,
      calledTool: false,
      correctTool: false,
      paramScore: 0,
      paramDetails: {},
      latencyMs: performance.now() - start,
      error: e.message,
    };
  }
}

interface ModelScore {
  model: string;
  totalCases: number;
  passed: number;
  failed: number;
  accuracy: number;
  toolSelectionAccuracy: number;
  avgParamScore: number;
  avgLatencyMs: number;
  byDifficulty: Record<string, { passed: number; total: number; accuracy: number }>;
  failures: Array<{ case: string; reason: string }>;
}

async function benchModel(model: string): Promise<{ score: ModelScore; results: CaseResult[] }> {
  console.log(`\n  Testing ${model}...`);
  const results: CaseResult[] = [];

  // Run 3 trials per case to reduce variance
  const TRIALS = 3;

  for (const tc of CASES) {
    let bestResult: CaseResult | null = null;
    let passCount = 0;

    for (let t = 0; t < TRIALS; t++) {
      const r = await runCase(model, tc);
      if (r.passed) passCount++;
      // Keep the best result (or the first if none pass)
      if (!bestResult || (r.passed && !bestResult.passed)) bestResult = r;
    }

    // Mark as passed if majority of trials pass
    const majorityPassed = passCount >= 2;
    const final = { ...bestResult!, passed: majorityPassed };
    results.push(final);

    const icon = final.passed ? "✓" : "✗";
    const detail = final.error
      ? final.error
      : !final.calledTool && tc.expect.toolName !== "__none__"
        ? "no tool called"
        : !final.correctTool
          ? `wrong tool: ${final.rawToolCall?.name}`
          : final.paramScore < 1
            ? `params: ${Object.entries(final.paramDetails).filter(([, v]) => !v).map(([k]) => k).join(", ")} wrong`
            : "";
    console.log(`    ${icon} ${tc.name} [${tc.difficulty}] (${passCount}/${TRIALS} trials, ${final.latencyMs.toFixed(0)}ms)${detail ? ` — ${detail}` : ""}`);
  }

  // Compute model score
  const passed = results.filter((r) => r.passed).length;
  const toolCorrect = results.filter((r) => r.correctTool).length;
  const avgParam = results.reduce((s, r) => s + r.paramScore, 0) / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;

  const byDifficulty: Record<string, { passed: number; total: number; accuracy: number }> = {};
  for (const diff of ["easy", "medium", "hard"]) {
    const subset = results.filter((r) => r.difficulty === diff);
    const p = subset.filter((r) => r.passed).length;
    byDifficulty[diff] = { passed: p, total: subset.length, accuracy: subset.length > 0 ? p / subset.length : 0 };
  }

  const failures = results
    .filter((r) => !r.passed)
    .map((r) => {
      let reason = r.error ?? "";
      if (!r.calledTool && CASES.find((c) => c.name === r.case)?.expect.toolName !== "__none__") reason = "no tool called";
      else if (!r.correctTool) reason = `wrong tool: ${r.rawToolCall?.name}`;
      else if (r.paramScore < 1) reason = `bad params: ${Object.entries(r.paramDetails).filter(([, v]) => !v).map(([k]) => k).join(", ")}`;
      return { case: r.case, reason };
    });

  return {
    score: {
      model,
      totalCases: results.length,
      passed,
      failed: results.length - passed,
      accuracy: passed / results.length,
      toolSelectionAccuracy: toolCorrect / results.length,
      avgParamScore: avgParam,
      avgLatencyMs: avgLatency,
      byDifficulty,
      failures,
    },
    results,
  };
}

async function main() {
  console.log("=== Copilot Free Model Tool-Calling Benchmark ===");
  console.log(`Cases: ${CASES.length} (${CASES.filter((c) => c.difficulty === "easy").length} easy, ${CASES.filter((c) => c.difficulty === "medium").length} medium, ${CASES.filter((c) => c.difficulty === "hard").length} hard)`);
  console.log(`Trials per case: 3 (majority vote)`);
  console.log(`Models: ${FREE_MODELS.length}`);

  const scores: ModelScore[] = [];

  for (const model of FREE_MODELS) {
    const { score } = await benchModel(model);
    scores.push(score);
  }

  // ── Leaderboard ──
  console.log("\n\n========================================");
  console.log("      TOOL-CALLING LEADERBOARD");
  console.log("========================================\n");

  const sorted = scores.sort((a, b) => b.accuracy - a.accuracy || a.avgLatencyMs - b.avgLatencyMs);

  console.log("RANK | MODEL                   | SCORE     | EASY    | MEDIUM  | HARD    | TOOL SEL | PARAM   | AVG LAT");
  console.log("-----|-------------------------|-----------|---------|---------|---------|----------|---------|--------");

  sorted.forEach((s, i) => {
    const rank = `#${i + 1}`.padStart(4);
    const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
    const d = (diff: string) => {
      const b = s.byDifficulty[diff]!;
      return `${b.passed}/${b.total} ${pct(b.accuracy)}`;
    };
    console.log(
      `${rank} | ${s.model.padEnd(23)} | ${s.passed}/${s.totalCases} (${pct(s.accuracy).padStart(4)}) | ${d("easy").padStart(7)} | ${d("medium").padStart(7)} | ${d("hard").padStart(7)} | ${pct(s.toolSelectionAccuracy).padStart(8)} | ${pct(s.avgParamScore).padStart(7)} | ${s.avgLatencyMs.toFixed(0).padStart(5)}ms`
    );
  });

  // ── Failure analysis ──
  console.log("\n── FAILURE DETAILS ──\n");
  for (const s of sorted) {
    if (s.failures.length === 0) {
      console.log(`${s.model}: No failures ✓`);
    } else {
      console.log(`${s.model} (${s.failures.length} failures):`);
      for (const f of s.failures) {
        console.log(`  ✗ ${f.case}: ${f.reason}`);
      }
    }
  }

  // Save raw
  const outPath = "./bench/tool-calling-results.json";
  await Bun.write(outPath, JSON.stringify(scores, null, 2));
  console.log(`\nRaw results saved to ${outPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
