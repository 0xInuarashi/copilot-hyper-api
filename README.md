# Copilot Hyper API

A proxy that turns your GitHub Copilot subscription into a full OpenAI + Anthropic compatible API, with intelligent auto-routing that picks the right model for every request.

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Login with your GitHub account (needs active Copilot subscription)
bun run login

# 3. Start the server
bun run start
```

That's it. Your API is live at `http://localhost:8787`.

```bash
# Test it
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <your-proxy-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello!"}]}'
```

---

## What This Does

Copilot Hyper API sits between your apps and GitHub Copilot's internal API, exposing three standard surfaces:

| Endpoint | Format | Example Client |
|----------|--------|---------------|
| `POST /v1/chat/completions` | OpenAI Chat | Any OpenAI SDK, Cursor, Continue |
| `POST /v1/responses` | OpenAI Responses | Custom apps |
| `POST /v1/messages` | Anthropic Messages | Anthropic SDK, Claude clients |

All models available through your Copilot subscription work out of the box: GPT-4o, GPT-4.1, GPT-5-mini, Claude Sonnet 4.6, Claude Opus 4.6, and more.

### Smart Billing

The proxy mimics Copilot's session tracking headers so multi-turn agent conversations are billed as a single premium interaction — not one per turn. It detects whether a request is a user-initiated turn or an agent continuation and sets `X-Initiator` accordingly, keeping session IDs (`X-Interaction-Id`, `X-Agent-Task-Id`) stable across the conversation.

When using `"model": "auto"`, the judge only runs on the first user turn. All subsequent agent turns in the same conversation reuse the cached model, saving latency and ensuring consistency.

---

## The Auto Router

Set `"model": "auto"` and let the system pick the best model for the job.

Every incoming request gets classified on two dimensions by a judge model (gpt-4o, free via Copilot):

```
                        short output          long output
                   ┌─────────────────────┬─────────────────────┐
     low           │  oswe-vscode-prime   │  oswe-vscode-prime   │
   complexity      │  (free)              │  (free)              │
                   ├─────────────────────┼─────────────────────┤
     hard          │  oswe-vscode-prime   │  claude-sonnet-4.6   │
   complexity      │  (free)              │  (paid)              │
                   ├─────────────────────┼─────────────────────┤
    extreme        │  claude-sonnet-4.6   │  claude-opus-4.6     │
   complexity      │  (paid)              │  (premium)           │
                   └─────────────────────┴─────────────────────┘
```

**Philosophy: quality over cost.** The router would rather over-spend (route to Opus) than under-deliver (route to free tier). Most everyday requests land in the free tier anyway.

Response headers tell you what happened:

```
x-auto-routed: true
x-auto-model: oswe-vscode-prime
x-auto-provider: copilot
x-auto-complexity: low
x-auto-length: short
x-auto-confidence: 0.95
x-auto-latency-ms: 1823
```

---

## Configuration

Create a `.env` file (or set environment variables):

```env
# Required
PROXY_API_KEY=sk-your-secret-key        # Your API key for authenticating to this proxy
GITHUB_OAUTH_TOKEN=ghu_xxxxx            # From `bun run login`

# Optional
PORT=8787                                # Server port
LOG_LEVEL=info                           # raw | debug | info | warn | error

# OpenRouter override (replaces free tier with any OpenRouter model)
OPENROUTER_ENABLED=false
OPENROUTER_API_KEY=sk-or-v1-xxxxx
OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
```

### OpenRouter Free Tier Override

Don't like Raptor Mini for the free tier? Enable OpenRouter and swap in any model:

```env
OPENROUTER_ENABLED=true
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
```

When enabled, all requests that would route to the free tier go through OpenRouter instead. The judge and paid tiers still use Copilot.

---

## API Reference

### Models

```
GET /v1/models              # OpenAI format
GET /anthropic/v1/models    # Anthropic format
```

Both include `"auto"` as the first model in the list.

### OpenAI Chat Completions

```
POST /v1/chat/completions
```

Standard OpenAI chat API. Supports streaming (`"stream": true`), tool calls, and all Copilot models. Use `"model": "auto"` for intelligent routing.

### OpenAI Responses

```
POST /v1/responses
```

Accepts `{instructions, input, model, stream}`. Translates to Copilot's internal format.

### Anthropic Messages

```
POST /v1/messages
POST /anthropic/v1/messages
```

Standard Anthropic Messages API. Supports streaming, system prompts (string or block array), and `"model": "auto"`.

### Health

```
GET /healthz    # Always 200
GET /readyz     # 200 if config valid + Copilot token works
```

---

## Auth

All API endpoints require authentication:

```
Authorization: Bearer <PROXY_API_KEY>
# or
x-api-key: <PROXY_API_KEY>
```

The proxy key is compared using timing-safe constant-time comparison.

---

## Development

```bash
bun run dev          # Hot reload
bun run dev-debug    # With debug logging
bun run dev-raw      # Full request/response logging

bun run typecheck    # Type check
bun run lint         # Biome linter
bun test             # All tests
bun run test:unit    # Unit tests
bun run test:e2e     # End-to-end (needs running server)
```

---

## Benchmarks

The `bench/` directory contains comprehensive benchmarks for both the auto-router judge and model code quality.

### Judge Routing Benchmark

Tests how accurately each model classifies request complexity + expected length across 200 test cases:

```bash
bun run bench:full    # 200 cases x 5 models x 5 runs
```

**Winner:** gpt-4o (76.4% route accuracy, 1607ms avg latency)

### Coding Quality Benchmark

20 coding tasks (10 easy, 6 medium, 4 hard) sent to all 5 free Copilot models, judged by Claude Opus 4.6:

| Model | Score (/10) | Latency |
|-------|------------|---------|
| gpt-5-mini | 9.95 | 16.0s |
| oswe-vscode-prime | 9.90 | 7.8s |
| gpt-4.1 | 9.60 | 12.3s |
| gpt-4o | 9.15 | 7.1s |
| gpt-4o-mini | 8.30 | 4.9s |

Full results: [`bench/coding-results.md`](bench/coding-results.md)

---

## Architecture

```
Client Request
     │
     ▼
┌─────────────┐
│  Hono App   │  middleware: request ID, CORS, API key auth
└──────┬──────┘
       │
       ▼
┌─────────────┐     model == "auto"?
│   Router    │────────────────────────┐
└──────┬──────┘                        ▼
       │                     ┌──────────────────┐
       │                     │  Judge (gpt-4o)  │
       │                     │  classify request │
       │                     └────────┬─────────┘
       │                              │
       │◄─────────────────────────────┘
       │         routed model + provider
       ▼
┌─────────────┐
│  Translate  │  OpenAI/Anthropic format → Copilot format
└──────┬──────┘
       │
       ▼
┌─────────────────────────────┐
│        Upstream             │
│  ┌─────────┐ ┌───────────┐ │
│  │ Copilot │ │ OpenRouter│ │
│  └─────────┘ └───────────┘ │
└─────────────────────────────┘
```

---

## Project Structure

```
src/
├── index.ts              # App entry, middleware, route mounting
├── config.ts             # Zod-validated configuration
├── logger.ts             # Structured JSON logging
├── auth/
│   ├── proxy-key.ts      # Inbound API key validation
│   └── session-token.ts  # Copilot token management (auto-refresh)
├── auto/
│   └── judge.ts          # Request classifier + model router + route cache
├── cli/
│   └── login.ts          # GitHub device code OAuth flow
├── routes/
│   ├── health.ts         # /healthz, /readyz
│   ├── models.ts         # /v1/models, /anthropic/v1/models
│   ├── openai.ts         # /v1/chat/completions, /v1/responses
│   └── anthropic.ts      # /v1/messages
├── translate/
│   ├── openai-chat.ts    # OpenAI <-> Copilot format mapping
│   ├── openai-responses.ts
│   ├── anthropic.ts      # Anthropic <-> Copilot format mapping
│   └── sse.ts            # Server-sent events parser
└── upstream/
    ├── client.ts         # Copilot HTTP client + streaming
    ├── headers.ts        # Session headers, initiator detection, stable IDs
    ├── models.ts         # Model list caching + fuzzy resolution
    └── openrouter.ts     # OpenRouter HTTP client + streaming
docs/
├── copilot-header-models.md    # Model availability: VS Code vs CLI headers
└── copilot-header-profiles.md  # Full header diff between client profiles
```

---

## License

MIT
