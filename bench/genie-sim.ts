/**
 * Genie endurance test — chains hard prompts back-to-back until failure.
 * Usage:
 *   bun run bench/genie-sim.ts                # start from prompt 1
 *   bun run bench/genie-sim.ts --start 3      # skip to prompt 3
 *   bun run bench/genie-sim.ts --only 2       # run only prompt 2
 */

const API = 'http://localhost:8080/v1/chat/completions'
const API_KEY = 'sk-proxy-e2e-test-key'
const MODEL = 'oswe-vscode-prime'

// Parse CLI args
const args = process.argv.slice(2)
const startIdx = args.includes('--start') ? parseInt(args[args.indexOf('--start') + 1]) - 1 : 0
const onlyIdx = args.includes('--only') ? parseInt(args[args.indexOf('--only') + 1]) - 1 : -1

interface Message {
  role: string
  content: string | null
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

const SYSTEM: Message = {
  role: 'system',
  content: `You are Genie, a task-execution agent on a Linux VPS. Use bash, read_file, web_fetch tools to investigate.`,
}

const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Execute a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read file contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch URL content.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
]

const STREAM_READ_TIMEOUT_MS = 60_000
const MAX_STREAM_RETRIES = 4
const RETRY_INITIAL_DELAY_MS = 3_000  // 3s → 6s → 12s → 24s backoff

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

async function streamChatOnce(messages: Message[]): Promise<Message> {
  const start = Date.now()
  const bodySize = JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: true }).length

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
          setTimeout(() => reject(new Error('Stream read timeout — no data for 60s')), STREAM_READ_TIMEOUT_MS),
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
  console.log(`  ↳ ${elapsed}ms, ${chunks} chunks, body=${Math.round(bodySize/1024)}KB, content=${content.length}ch, tools=${tcList.length}`)

  // Detect empty response
  if (!content && Object.keys(toolCalls).length === 0) {
    throw new Error('Empty response — stream produced no content or tool calls')
  }

  const msg: Message = { role: 'assistant', content: content || null }
  if (tcList.length) msg.tool_calls = tcList
  return msg
}

async function streamChat(messages: Message[]): Promise<Message> {
  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    try {
      return await streamChatOnce(messages)
    } catch (err) {
      if (attempt < MAX_STREAM_RETRIES && isTransientError(err)) {
        const delay = RETRY_INITIAL_DELAY_MS * Math.pow(2, attempt)
        console.warn(`  ⚠️  Transient error (attempt ${attempt + 1}/${MAX_STREAM_RETRIES + 1}), retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error('Unreachable')
}

async function executeTool(name: string, args: any): Promise<string> {
  if (name === 'bash') {
    try {
      const proc = Bun.spawn(['bash', '-c', args.command], { timeout: 30_000 })
      const out = await new Response(proc.stdout).text()
      return out.slice(0, 8000) || '[no output]'
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (name === 'read_file') {
    try {
      const f = Bun.file(args.path)
      const text = await f.text()
      return text.slice(0, 8000)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (name === 'web_fetch') {
    try {
      const res = await fetch(args.url, { signal: AbortSignal.timeout(10_000) })
      const text = await res.text()
      return text.slice(0, 8000)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return `Unknown tool: ${name}`
}

// ─── Hard prompts to chain back-to-back ──────────────────────────────────────

const PROMPTS = [
  'do a comprehensive review on the openclaw that we just installed. im concerned that there is spyware or exploits inside it, so do a deep analysis and a thorough investigation on it for me.',
  'now do a full security audit of this machine. check for unauthorized SSH keys, cron jobs, open ports, running services, setuid binaries, world-writable files, and anything else suspicious. be thorough.',
  'investigate our copilot-hyper-api codebase at /home/dev/copilot-hyper-api. review the authentication flow, check for hardcoded secrets, review the session token handling, and look for any injection or SSRF vulnerabilities in the proxy routes.',
  'set up a basic monitoring stack: check what system resources are being used, find the top processes, check disk usage across all mounts, review systemd service health, and create a summary report at /tmp/system-health-report.txt.',
  'do a deep dive into the node_modules of /home/dev/copilot-hyper-api — check for known vulnerable packages, look for any postinstall scripts that do suspicious things, check if any deps pull from non-standard registries, and see if there are any binary/native addons compiled in.',
]

const MAX_ROUNDS_PER_PROMPT = 80
const ABSOLUTE_MAX_ROUNDS = 500

// ─── Simple context management (mirrors what the real genie client does) ──────

const CHARS_PER_TOKEN = 4
const MODEL_LIMIT_TOKENS = 185_000  // oswe-vscode-prime = 200k, leave headroom
const MICRO_THRESHOLD = 35_000      // start clearing old tool outputs early to keep payload small
const COMPACT_THRESHOLD = 55_000    // drop old rounds before payload gets too large for upstream
const CLEARED_TOOL = '[Earlier tool output cleared for context management]'

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

function microCompact(msgs: Message[], preserveLast = 12): Message[] {
  if (msgs.length <= preserveLast) return msgs
  const cutoff = msgs.length - preserveLast
  let cleared = 0
  const result = msgs.map((m, i) => {
    if (i >= cutoff) return m
    if (m.role === 'tool' && m.content && m.content !== CLEARED_TOOL && m.content.length > 80) {
      cleared++
      return { ...m, content: CLEARED_TOOL }
    }
    if (m.role === 'assistant' && m.tool_calls?.length && m.content && m.content.length > 100) {
      cleared++
      return { ...m, content: '[Earlier reasoning cleared]' }
    }
    if (m.role === 'assistant' && !m.tool_calls && m.content && m.content.length > 300) {
      cleared++
      return { ...m, content: m.content.slice(0, 150) + '...' }
    }
    return m
  })
  if (cleared > 0) console.log(`  🗜️  Microcompacted: cleared ${cleared} old messages`)
  return result
}

function dropOldestRounds(msgs: Message[], dropFraction = 0.25): Message[] {
  const firstUserIdx = msgs.findIndex(m => m.role === 'user')
  if (firstUserIdx === -1) return msgs
  const prefix = msgs.slice(0, firstUserIdx + 1)
  const rest = msgs.slice(firstUserIdx + 1)
  const dropCount = Math.max(2, Math.floor(rest.length * dropFraction))
  const kept = rest.slice(dropCount)
  console.log(`  🗑️  Dropped ${dropCount} oldest messages (${rest.length} → ${kept.length})`)
  return [
    ...prefix,
    { role: 'assistant', content: `[${dropCount} earlier messages were dropped to fit context window. Continuing with recent context.]` } as Message,
    ...kept,
  ]
}

function manageContext(msgs: Message[]): Message[] {
  let tokens = estimateTokens(msgs)
  if (tokens < MICRO_THRESHOLD) return msgs

  console.log(`  📊 Context at ${tokens} tokens (micro threshold: ${MICRO_THRESHOLD})`)
  let current = microCompact(msgs)
  tokens = estimateTokens(current)
  console.log(`  📊 After microcompact: ${tokens} tokens`)

  if (tokens < COMPACT_THRESHOLD) return current

  // No LLM compaction in the sim — just drop oldest rounds aggressively
  console.log(`  📊 Over compact threshold (${COMPACT_THRESHOLD}), dropping oldest rounds`)
  current = dropOldestRounds(current)
  tokens = estimateTokens(current)
  console.log(`  📊 After drop: ${tokens} tokens, ${current.length} messages`)

  // If still over, keep dropping
  let safety = 0
  while (tokens > COMPACT_THRESHOLD && safety < 5) {
    current = dropOldestRounds(current)
    tokens = estimateTokens(current)
    console.log(`  📊 Additional drop: ${tokens} tokens, ${current.length} messages`)
    safety++
  }

  return current
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  let messages: Message[] = [SYSTEM]
  let totalRounds = 0
  let totalRetries = 0
  let totalCompactions = 0
  let peakTokens = 0
  const startTime = Date.now()

  const fromIdx = onlyIdx >= 0 ? onlyIdx : startIdx
  const toIdx = onlyIdx >= 0 ? onlyIdx + 1 : PROMPTS.length

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Genie Endurance Test — run until failure`)
  console.log(`  Model: ${MODEL}`)
  console.log(`  Prompts: ${fromIdx + 1}–${toIdx} of ${PROMPTS.length} (${MAX_ROUNDS_PER_PROMPT} rounds each)`)
  console.log(`  Absolute cap: ${ABSOLUTE_MAX_ROUNDS} rounds`)
  console.log(`${'='.repeat(60)}\n`)

  for (let pi = fromIdx; pi < toIdx; pi++) {
    const prompt = PROMPTS[pi]
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`  PROMPT ${pi + 1}/${PROMPTS.length}: ${prompt.slice(0, 80)}...`)
    console.log(`${'─'.repeat(60)}`)

    messages.push({ role: 'user', content: prompt })
    let consecutiveFailures = 0

    for (let round = 1; round <= MAX_ROUNDS_PER_PROMPT; round++) {
      totalRounds++
      if (totalRounds > ABSOLUTE_MAX_ROUNDS) {
        console.log(`\n🛑 Absolute round cap (${ABSOLUTE_MAX_ROUNDS}) reached`)
        break
      }

      // Cooldown every 10 rounds to avoid hammering upstream
      if (totalRounds > 1 && totalRounds % 10 === 0) {
        console.log(`  ⏸️  Cooldown (1s) after ${totalRounds} rounds`)
        await new Promise(r => setTimeout(r, 1000))
      }

      // Context management before each API call
      const beforeCtx = messages.length
      messages = manageContext(messages)
      if (messages.length !== beforeCtx) totalCompactions++

      const estTokens = estimateTokens(messages)
      if (estTokens > peakTokens) peakTokens = estTokens
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`\n--- P${pi+1} R${round} | total:${totalRounds} | ${messages.length} msgs | ~${estTokens} tok | ${elapsed}s ---`)

      let reply: Message
      try {
        reply = await streamChat(messages)
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures++
        // If we've failed multiple rounds in a row, do a long cooldown before giving up
        if (consecutiveFailures <= 2 && isTransientError(err)) {
          const cooldown = 30_000 * consecutiveFailures
          console.warn(`  🔥 Round-level failure #${consecutiveFailures}, cooling down ${cooldown/1000}s before next round`)
          await new Promise(r => setTimeout(r, cooldown))
          // Re-manage context to try shrinking payload
          messages = manageContext(messages)
          continue
        }
        console.error(`\n❌ FATAL at prompt ${pi+1} round ${round} (total round ${totalRounds})`)
        console.error(`   Error: ${err instanceof Error ? err.message : String(err)}`)
        console.error(`   Messages: ${messages.length}, Est tokens: ${estTokens}`)
        printStats(totalRounds, totalRetries, totalCompactions, peakTokens, messages.length, startTime)
        return
      }

      messages.push(reply)

      // No tool calls = prompt finished
      if (!reply.tool_calls?.length) {
        console.log(`\n✅ Prompt ${pi+1} done! (${reply.content?.length ?? 0} chars):`)
        console.log(reply.content?.slice(0, 300) ?? '[empty]')
        break
      }

      for (const tc of reply.tool_calls) {
        let args: any = {}
        try { args = JSON.parse(tc.function.arguments) } catch {}
        console.log(`  🔧 ${tc.function.name}: ${JSON.stringify(args).slice(0, 100)}`)

        const result = await executeTool(tc.function.name, args)
        console.log(`  📋 ${result.slice(0, 120).replace(/\n/g, '\\n')}...`)

        messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
      }
    }

    if (totalRounds > ABSOLUTE_MAX_ROUNDS) break
  }

  printStats(totalRounds, totalRetries, totalCompactions, peakTokens, messages.length, startTime)
}

function printStats(rounds: number, retries: number, compactions: number, peak: number, msgs: number, start: number) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ENDURANCE TEST RESULTS`)
  console.log(`${'='.repeat(60)}`)
  console.log(`  Total rounds:    ${rounds}`)
  console.log(`  Total retries:   ${retries}`)
  console.log(`  Compactions:     ${compactions}`)
  console.log(`  Peak tokens:     ~${peak}`)
  console.log(`  Final messages:  ${msgs}`)
  console.log(`  Elapsed:         ${elapsed}s`)
  console.log(`${'='.repeat(60)}\n`)
}

main().catch(console.error)
