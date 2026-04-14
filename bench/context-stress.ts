/**
 * Context window stress test — fill context to 200K tokens, find the breaking point.
 * No compaction. Just grow until something breaks.
 *
 * Usage:
 *   bun run bench/context-stress.ts              # default: 32KB tool output cap
 *   bun run bench/context-stress.ts --cap 64     # 64KB tool output cap
 *   bun run bench/context-stress.ts --cap 0      # no cap (raw output)
 */

const API = 'http://localhost:8080/v1/chat/completions'
const API_KEY = 'sk-proxy-e2e-test-key'
const MODEL = 'oswe-vscode-prime'

// Parse CLI args
const args = process.argv.slice(2)
const toolOutputCap = args.includes('--cap')
  ? parseInt(args[args.indexOf('--cap') + 1]) * 1024
  : 32 * 1024 // default 32KB per tool output

interface Message {
  role: string
  content: string | null
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

const SYSTEM: Message = {
  role: 'system',
  content: `You are Genie, a deep code analysis agent. You read large files and analyze them thoroughly.
When given a file to read, you MUST use read_file to read it fully, then provide detailed analysis.
Do NOT summarize or skip parts. Read every file completely.
After analyzing each file, explain what you found in detail — the more detail the better.
Keep all previous analysis in mind as you go, building a comprehensive picture.`,
}

const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Execute a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read file contents. Returns the full file.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: 'byte offset to start reading from' }, length: { type: 'number', description: 'number of bytes to read' } }, required: ['path'] } } },
]

const STREAM_READ_TIMEOUT_MS = 120_000  // 2 min — large contexts = slow responses
const MAX_STREAM_RETRIES = 5
const RETRY_INITIAL_DELAY_MS = 5_000   // 5s → 10s → 20s → 40s → 80s

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('empty response') ||
    msg.includes('stream') ||
    msg.includes('socket') ||
    msg.includes('connection') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed')
  )
}

const CHARS_PER_TOKEN = 4

function estimateTokens(msgs: Message[]): number {
  let chars = 0
  for (const m of msgs) {
    chars += m.content?.length ?? 0
    if (m.tool_calls) for (const tc of m.tool_calls) chars += tc.function.name.length + tc.function.arguments.length + 20
    if (m.tool_call_id) chars += m.tool_call_id.length
    chars += 12
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function bodySize(msgs: Message[]): number {
  return JSON.stringify({ model: MODEL, messages: msgs, tools: TOOLS, stream: true }).length
}

async function streamChatOnce(messages: Message[]): Promise<Message> {
  const start = Date.now()
  const bSize = bodySize(messages)

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: true }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No body')

  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCalls: Record<number, { id: string; type: string; function: { name: string; arguments: string } }> = {}
  let chunks = 0

  while (true) {
    let readResult: { done: boolean; value?: Uint8Array }
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Stream read timeout')), STREAM_READ_TIMEOUT_MS),
        ),
      ])
    } catch (e) {
      reader.cancel().catch(() => {})
      throw e
    }
    const { done, value } = readResult
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const payload = trimmed.slice(6)
      if (payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload)
        if (chunk.error) throw new Error(`Stream error: ${chunk.error.message}`)
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        chunks++
        if (delta.content) content += delta.content
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (tc.id) toolCalls[idx] = { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
            if (tc.function?.name && toolCalls[idx]) toolCalls[idx].function.name = tc.function.name
            if (tc.function?.arguments && toolCalls[idx]) toolCalls[idx].function.arguments += tc.function.arguments
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Stream error')) throw e
      }
    }
  }

  const elapsed = Date.now() - start
  const tcList = Object.values(toolCalls)
  const bodySizeKB = Math.round(bSize / 1024)
  const bodySizeMB = (bSize / (1024 * 1024)).toFixed(1)
  console.log(`  ↳ ${elapsed}ms, ${chunks} chunks, body=${bodySizeKB > 1024 ? bodySizeMB + 'MB' : bodySizeKB + 'KB'}, content=${content.length}ch, tools=${tcList.length}`)

  if (!content && Object.keys(toolCalls).length === 0) {
    throw new Error('Empty response — stream produced no content or tool calls')
  }

  const msg: Message = { role: 'assistant', content: content || null }
  if (tcList.length) msg.tool_calls = tcList
  return msg
}

async function streamChat(messages: Message[]): Promise<{ reply: Message; retries: number }> {
  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    try {
      const reply = await streamChatOnce(messages)
      return { reply, retries: attempt }
    } catch (err) {
      if (attempt < MAX_STREAM_RETRIES && isTransientError(err)) {
        const delay = RETRY_INITIAL_DELAY_MS * Math.pow(2, attempt)
        console.warn(`  ⚠️  Retry ${attempt + 1}/${MAX_STREAM_RETRIES}, backoff ${Math.round(delay/1000)}s: ${err instanceof Error ? err.message : String(err)}`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error('Unreachable')
}

async function executeTool(name: string, args: any): Promise<string> {
  let raw = ''
  if (name === 'bash') {
    try {
      const proc = Bun.spawn(['bash', '-c', args.command], { timeout: 30_000 })
      raw = await new Response(proc.stdout).text()
      if (!raw) raw = '[no output]'
    } catch (e) {
      raw = `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  } else if (name === 'read_file') {
    try {
      const f = Bun.file(args.path)
      const text = await f.text()
      if (args.offset || args.length) {
        const start = args.offset ?? 0
        const len = args.length ?? text.length
        raw = text.slice(start, start + len)
      } else {
        raw = text
      }
      if (!raw) raw = '[empty file]'
    } catch (e) {
      raw = `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  } else {
    raw = `Unknown tool: ${name}`
  }

  // Apply cap if configured
  if (toolOutputCap > 0 && raw.length > toolOutputCap) {
    const keep = Math.floor((toolOutputCap - 100) / 2)
    raw = raw.slice(0, keep) + `\n\n...[truncated — ${(raw.length - toolOutputCap).toLocaleString()} chars removed]...\n\n` + raw.slice(-keep)
  }

  return raw
}

// ─── Main ───────────────────────────────────────────────────────────────────

const PROMPT = `I need you to do a deep source code analysis. Read these files one by one and analyze each thoroughly:

1. First: /home/dev/copilot-hyper-api/src/routes/openai.ts — analyze the full request handling flow
2. Then: /home/dev/copilot-hyper-api/src/upstream/client.ts — analyze the upstream connection management
3. Then: /home/dev/copilot-hyper-api/src/translate/openai-chat.ts — analyze the translation layer
4. Then: /home/dev/copilot-hyper-api/src/auth/session-token.ts — analyze the auth flow
5. Then: /home/dev/copilot-hyper-api/node_modules/zod/v3/types.js — analyze how zod validation works internally (read the first 100KB)
6. Then: /home/dev/copilot-hyper-api/node_modules/tough-cookie/dist/index.js — analyze the cookie handling library
7. Then: /usr/lib/node_modules/openclaw/dist/runtime-schema-HP9KKAMz.js — read the first 200KB and analyze the schema system
8. Then: /usr/lib/node_modules/openclaw/dist/channel.runtime-DLmhCHod.js — read the first 200KB and analyze the channel runtime
9. Then: /usr/lib/node_modules/openclaw/dist/server.impl-CsRRyd9F.js — read the first 200KB and analyze the server implementation

After reading each file, write a detailed analysis (at least 500 words). Do NOT skip files or summarize briefly — the goal is to build up a complete understanding across all files.

When you're done with all files, write a comprehensive cross-file analysis that ties everything together.`

async function main() {
  let messages: Message[] = [SYSTEM, { role: 'user', content: PROMPT }]
  let totalRetries = 0
  let round = 0
  const startTime = Date.now()
  const milestones = [25_000, 50_000, 75_000, 100_000, 125_000, 150_000, 175_000, 200_000]
  const hitMilestones = new Set<number>()

  const capStr = toolOutputCap > 0 ? `${Math.round(toolOutputCap / 1024)}KB` : 'none'

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Context Window Stress Test`)
  console.log(`  Model: ${MODEL}`)
  console.log(`  Tool output cap: ${capStr}`)
  console.log(`  Goal: Fill context to 200K tokens`)
  console.log(`  Retries: ${MAX_STREAM_RETRIES}x with 5s exponential backoff`)
  console.log(`  Stream timeout: ${STREAM_READ_TIMEOUT_MS / 1000}s`)
  console.log(`${'='.repeat(60)}\n`)

  for (round = 1; round <= 200; round++) {
    const tokens = estimateTokens(messages)
    const bSize = bodySize(messages)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)

    // Milestone logging
    for (const m of milestones) {
      if (tokens >= m && !hitMilestones.has(m)) {
        hitMilestones.add(m)
        console.log(`\n  🎯 MILESTONE: ${(m/1000).toFixed(0)}K tokens reached! (body=${Math.round(bSize/1024)}KB, round=${round})`)
      }
    }

    const bodySizeKB = Math.round(bSize / 1024)
    const bodySizeMB = (bSize / (1024 * 1024)).toFixed(1)
    const bodyStr = bodySizeKB > 1024 ? bodySizeMB + 'MB' : bodySizeKB + 'KB'
    console.log(`\n--- R${round} | ${messages.length} msgs | ~${tokens} tok | body=${bodyStr} | ${elapsed}s ---`)

    // Cooldown every round — match the endurance test's natural pacing (~8-10s/round)
    // Quick tool-call rounds (1-3s) ramp body size too fast for upstream to handle
    if (round > 1) {
      const bodyKB = Math.round(bSize / 1024)
      let cooldown: number
      if (bodyKB < 30) cooldown = 2_000         // tiny body: 2s
      else if (bodyKB < 60) cooldown = 5_000    // small: 5s
      else if (bodyKB < 100) cooldown = 8_000   // medium: 8s (danger zone starts ~90KB)
      else if (bodyKB < 200) cooldown = 10_000  // large: 10s
      else cooldown = 15_000                     // very large: 15s
      console.log(`  ⏸️  Cooldown (${cooldown/1000}s, body=${bodyKB}KB)`)
      await new Promise(r => setTimeout(r, cooldown))
    }

    let reply: Message
    let retries: number
    try {
      const result = await streamChat(messages)
      reply = result.reply
      retries = result.retries
      totalRetries += retries
      if (retries > 0) console.log(`  ✓ Succeeded after ${retries} retries`)
    } catch (err) {
      const finalTokens = estimateTokens(messages)
      const finalBody = bodySize(messages)
      console.error(`\n❌ FAILED at round ${round}`)
      console.error(`   Error: ${err instanceof Error ? err.message : String(err)}`)
      console.error(`   Tokens: ~${finalTokens}`)
      console.error(`   Body: ${Math.round(finalBody/1024)}KB (${(finalBody/(1024*1024)).toFixed(1)}MB)`)
      console.error(`   Messages: ${messages.length}`)
      printStats(round, totalRetries, messages.length, finalTokens, finalBody, startTime, hitMilestones)
      return
    }

    messages.push(reply)

    // If no tool calls, model finished
    if (!reply.tool_calls?.length) {
      console.log(`  📝 Content response (${reply.content?.length ?? 0} chars)`)
      // Check if it seems done
      if (round > 5 && reply.content && reply.content.length > 1000) {
        console.log(`  ✅ Model produced final analysis`)
        // Don't break — prompt it to keep going
        messages.push({
          role: 'user',
          content: 'Good analysis. Now go deeper — re-read the largest files you analyzed and look for patterns you missed the first time. Focus on edge cases, error handling paths, and potential security issues. Read the files again fully.',
        })
        continue
      }
      // Push it to keep reading
      if (round <= 3) {
        messages.push({
          role: 'user',
          content: 'Continue. Read the next file from the list.',
        })
      }
      continue
    }

    for (const tc of reply.tool_calls) {
      let tcArgs: any = {}
      try { tcArgs = JSON.parse(tc.function.arguments) } catch {}
      const argStr = JSON.stringify(tcArgs).slice(0, 120)
      console.log(`  🔧 ${tc.function.name}: ${argStr}`)

      const result = await executeTool(tc.function.name, tcArgs)
      const resultLen = result.length
      console.log(`  📋 ${resultLen > 1024 ? (resultLen/1024).toFixed(0) + 'KB' : resultLen + 'ch'} result`)

      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
    }
  }

  const finalTokens = estimateTokens(messages)
  const finalBody = bodySize(messages)
  printStats(round, totalRetries, messages.length, finalTokens, finalBody, startTime, hitMilestones)
}

function printStats(rounds: number, retries: number, msgs: number, tokens: number, bodyBytes: number, start: number, milestones: Set<number>) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  CONTEXT STRESS TEST RESULTS`)
  console.log(`${'='.repeat(60)}`)
  console.log(`  Total rounds:     ${rounds}`)
  console.log(`  Total retries:    ${retries}`)
  console.log(`  Final tokens:     ~${tokens}`)
  console.log(`  Final body:       ${Math.round(bodyBytes/1024)}KB (${(bodyBytes/(1024*1024)).toFixed(1)}MB)`)
  console.log(`  Final messages:   ${msgs}`)
  console.log(`  Milestones hit:   ${[...milestones].map(m => `${(m/1000).toFixed(0)}K`).join(', ') || 'none'}`)
  console.log(`  Elapsed:          ${elapsed}s`)
  console.log(`  Tool output cap:  ${toolOutputCap > 0 ? Math.round(toolOutputCap/1024) + 'KB' : 'none'}`)
  console.log(`${'='.repeat(60)}\n`)
}

main().catch(console.error)
