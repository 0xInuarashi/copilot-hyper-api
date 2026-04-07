# AGENTS.md — Repository Context for AI Agents

This document gives AI coding agents full context to work effectively in this codebase.

## What This Project Is

**copilot-hyper-api** is a Bun/TypeScript proxy that exposes GitHub Copilot's internal API through standard OpenAI and Anthropic API surfaces. It adds an intelligent "auto" routing mode that classifies requests by complexity and routes them to the optimal model tier.

**Runtime:** Bun (not Node.js)
**Framework:** Hono
**Language:** TypeScript (strict)
**Test runner:** `bun test`
**Linter:** Biome

## Key Commands

```bash
bun install              # Install deps
bun run start            # Start server (port from .env or 8787)
bun run dev              # Dev with hot reload
bun run login            # GitHub OAuth device code flow → writes .env
bun test                 # Run all tests
bun run typecheck        # TypeScript type check
bun run lint             # Biome lint
```

## Architecture Overview

```
Inbound request (OpenAI or Anthropic format)
  → Middleware (request ID, CORS, API key auth)
  → Route handler (openai.ts or anthropic.ts)
  → If model == "auto": judge.ts classifies → picks model + provider
  → Translate request to Copilot's internal format
  → Upstream fetch (Copilot API or OpenRouter)
  → Translate response back to caller's format
  → Stream or return JSON
```

### Core Data Flow

1. **Auth:** Inbound requests carry `Authorization: Bearer <PROXY_API_KEY>`. The proxy authenticates to Copilot using a session token derived from `GITHUB_OAUTH_TOKEN`.

2. **Model resolution:** Model IDs are resolved against Copilot's `/models` endpoint (cached). Unknown models get Levenshtein suggestions. The special model `"auto"` triggers the judge.

3. **Auto routing:** The judge calls gpt-4o (free via Copilot) to classify the request on two dimensions — complexity (low/hard/extreme) and expected output length (short/long). These map to three tiers:
   - **Free:** `oswe-vscode-prime` — low complexity, or hard+short
   - **Paid:** `claude-sonnet-4.6` — hard+long, or extreme+short
   - **Premium:** `claude-opus-4.6` — extreme+long

4. **OpenRouter override:** When `OPENROUTER_ENABLED=true`, free-tier requests route through OpenRouter instead of Copilot. Only affects inference, not the judge.

## File-by-File Guide

### `src/config.ts`
Zod schema for all environment variables. Call `loadConfig(env)` at startup. Access via `getConfig()` anywhere. Key fields: `PROXY_API_KEY`, `GITHUB_OAUTH_TOKEN`, `PORT`, `OPENROUTER_ENABLED`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`.

### `src/index.ts`
Hono app setup. Mounts middleware (request ID via nanoid, CORS, API key auth via `proxyKeyMiddleware`) and all route groups. Entry point.

### `src/auth/proxy-key.ts`
Middleware that validates the inbound Bearer token or x-api-key header against `PROXY_API_KEY` using timing-safe comparison. Returns 401 on mismatch.

### `src/auth/session-token.ts`
Manages Copilot session tokens. Fetches from `https://api.github.com/copilot_internal/v2/token`, caches per OAuth token (keyed by SHA256), auto-refreshes before expiry with a safety window. Single-flight pattern prevents thundering herd. Exports `getSessionToken()` and `invalidateSessionToken()`.

### `src/auto/judge.ts`
The brain of auto-routing. Exports:
- `judge(messages)` — classifies a request, returns `JudgeResult` with complexity, expectedLength, confidence, reasoning, routed model, and provider.
- `routeModel(complexity, expectedLength)` — pure function mapping classification to `{model, provider}`.
- `textOf(content)` — extracts text from string or content block array.
- `autoRouteHeaders(jr)` — builds `x-auto-*` response headers.

The judge model is gpt-4o. The system prompt is a detailed rubric defining the three complexity tiers and two length tiers. Response is parsed as JSON.

### `src/routes/openai.ts`
Two endpoints:
- `POST /v1/chat/completions` — Standard OpenAI chat. If `model === "auto"`, runs judge, replaces model, sets auto headers. Supports streaming and non-streaming. Dispatches to either `copilotFetch`/`streamCopilot` or `openrouterFetch`/`streamOpenRouter` based on provider.
- `POST /v1/responses` — Simpler format with `{instructions, input, model}`. Same auto-routing logic.

### `src/routes/anthropic.ts`
`POST /v1/messages` and `POST /anthropic/v1/messages`. Handles Anthropic message format (system can be string or array of blocks). Same auto-routing pattern. Translates Anthropic format to/from Copilot's internal format.

### `src/routes/models.ts`
`GET /v1/models` (OpenAI format) and `GET /anthropic/v1/models` (Anthropic format). Both prepend the `"auto"` model to the list.

### `src/routes/health.ts`
`GET /healthz` (always 200) and `GET /readyz` (validates config + session token).

### `src/translate/openai-chat.ts`
Maps between OpenAI chat completion format and Copilot's internal format. Handles both streaming (SSE) and non-streaming responses.

### `src/translate/anthropic.ts`
Maps between Anthropic Messages format and Copilot's internal format. Handles system prompts, content blocks, and streaming.

### `src/translate/sse.ts`
Parses Server-Sent Events streams. Exports `parseSSE()` async generator yielding `SSEEvent` objects with `event`, `data`, and `id` fields.

### `src/upstream/client.ts`
Copilot HTTP client. Exports:
- `copilotFetch(path, init, retryOn401)` — standard fetch with auto auth headers and 401 retry. Throws `UpstreamError` for error responses.
- `streamCopilot(path, body, signal)` — async generator for SSE streaming.

### `src/upstream/openrouter.ts`
OpenRouter HTTP client. Mirrors the Copilot client interface:
- `openrouterFetch(path, init)` — fetch against `https://openrouter.ai/api/v1`.
- `streamOpenRouter(path, body, signal)` — SSE streaming.

### `src/upstream/models.ts`
Fetches and caches the model list from Copilot. Exports `getOpenAIModelList()`, `getAnthropicModelList()`, and `resolveModel(id)` with fuzzy matching via Levenshtein distance. Caches for 900s by default. The `"auto"` model is prepended to lists.

### `src/upstream/headers.ts`
Builds Copilot-specific request headers (editor version, machine ID, session ID, etc.).

### `src/cli/login.ts`
Interactive CLI for GitHub device code OAuth. Walks user through the flow, verifies Copilot subscription, writes token to `.env`.

## Test Structure

```
test/
├── unit/           # Config parsing, SSE parsing, auth logic
├── contract/       # Request/response format translation correctness
├── integration/    # Route handling with mocked upstream
├── e2e/            # Full stack with real Copilot API (E2E=1 required)
└── fixtures/       # Mock Copilot API responses
```

Run with `bun test`. E2E tests need `E2E=1` env var and a running server.

## Bench Structure

```
bench/
├── cases-200.ts                # 200 test prompts across 6 complexity/length buckets
├── judge-full-compare.ts       # Main benchmark: 200 cases x 5 models x 5 runs
├── judge-benchmark.ts          # Single-model judge accuracy
├── judge-compare.ts            # Multi-model comparison
├── judge-complexity-only.ts    # Complexity dimension only
├── judge-length.ts             # Length dimension only
├── judge-length-compare.ts     # Length comparison
├── judge-openrouter-compare.ts # OpenRouter model comparison
├── coding-bench.ts             # 20 coding tasks x 5 models (collects responses)
├── coding-cases.ts             # 20 coding challenge definitions
├── coding-responses.json       # Cached model responses (227KB)
└── coding-results.md           # Final scoring by Claude Opus 4.6
```

All benchmarks load config at the top with `loadConfig()` before importing project modules (ES module import hoisting means config must be loaded in the same top-level block before dynamic imports).

## Conventions

- **No default exports.** Everything is named exports.
- **Zod for validation.** Config and request bodies validated with Zod schemas.
- **Structured logging.** JSON format via `src/logger.ts`. Levels: raw > debug > info > warn > error. Headers are sanitized (Bearer tokens masked except at `raw` level).
- **Single-flight pattern.** Used in session-token.ts and models.ts to prevent duplicate concurrent fetches.
- **Error types.** `UpstreamError` (from client.ts) carries `statusCode` and optional `upstreamBody`. Route handlers map these to appropriate HTTP responses.

## Common Patterns

### Adding a new route
1. Create handler in `src/routes/`
2. Mount in `src/index.ts` via `app.route()`
3. Use `proxyKeyMiddleware` for auth
4. Add tests in `test/integration/`

### Adding a new upstream provider
1. Create client in `src/upstream/` mirroring `copilotFetch`/`streamCopilot` interface
2. Add provider to the `Provider` type in `judge.ts`
3. Update `routeModel()` to return the new provider when appropriate
4. Update route handlers to dispatch based on `provider`

### Modifying the auto-router
- Routing table: `routeModel()` in `src/auto/judge.ts`
- Classification prompt: `SYSTEM_PROMPT` constant in `src/auto/judge.ts`
- Judge model: `JUDGE_MODEL` constant (currently `gpt-4o`)
- Test changes against: `bun run bench:full`

## Environment

The `.env` file (not committed) contains:
```
GITHUB_OAUTH_TOKEN=ghu_...   # From `bun run login`
PROXY_API_KEY=sk-...          # Your chosen API key
PORT=8787                     # Optional
OPENROUTER_ENABLED=false      # Optional
OPENROUTER_API_KEY=           # Optional
OPENROUTER_MODEL=             # Optional
```

## Important Notes

- The project uses **Bun**, not Node.js. Use `bun run`, `bun test`, not `npm`/`node`.
- Copilot's internal API is at `https://api.githubcopilot.com`. Session tokens expire and are auto-refreshed.
- The `"auto"` model is synthetic — it's not a real Copilot model. It triggers the judge pipeline.
- Copilot already has its own auto model (`goldeneye-free-auto`) — no naming conflict with ours.
- Free Copilot models: `gpt-5-mini`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`, `oswe-vscode-prime` (Raptor Mini).
- OpenRouter free models have aggressive rate limits — don't benchmark at scale against them.
