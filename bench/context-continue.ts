/**
 * Context continuation test — start with ~180K tokens of context,
 * then try to continue the conversation with tool calls.
 *
 * Tests whether the upstream can handle successive requests
 * when the body is already massive.
 *
 * Usage:
 *   bun run bench/context-continue.ts                # default: 180K token base
 *   bun run bench/context-continue.ts --tokens 150   # 150K token base
 */

const API = 'http://localhost:8080/v1/chat/completions'
const API_KEY = 'sk-proxy-e2e-test-key'
const MODEL = 'oswe-vscode-prime'

const args = process.argv.slice(2)
const baseTokensK = args.includes('--tokens')
  ? parseInt(args[args.indexOf('--tokens') + 1])
  : 180

const CHARS_PER_TOKEN = 4
const targetChars = baseTokensK * 1000 * CHARS_PER_TOKEN
const STREAM_READ_TIMEOUT_MS = 180_000

interface Message {
  role: string
  content: string | null
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read file contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
]

// Build padding from real code
const sourceFile = await Bun.file('/home/dev/copilot-hyper-api/src/routes/openai.ts').text()
const repeats = Math.ceil(targetChars / sourceFile.length)
const padding = Array.from({ length: repeats }, (_, i) =>
  `// ===== COPY ${i + 1}/${repeats} =====\n${sourceFile}`
).join('\n').slice(0, targetChars)

function bodySize(msgs: Message[]): number {
  return JSON.stringify({ model: MODEL, messages: msgs, tools: TOOLS, stream: true }).length
}

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

async function streamChat(messages: Message[]): Promise<{ reply: Message; elapsed: number; chunks: number }> {
  const start = Date.now()

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

  const msg: Message = { role: 'assistant', content: content || null }
  const tcList = Object.values(toolCalls)
  if (tcList.length) msg.tool_calls = tcList

  return { reply: msg, elapsed: Date.now() - start, chunks }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now()

  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are Genie, a code analysis agent. You can read files using read_file. Analyze code thoroughly.',
    },
    {
      role: 'user',
      content: `Here is a large codebase for context:\n\n${padding}\n\nNow I need you to do some additional analysis. Read these files and analyze them:\n1. /home/dev/copilot-hyper-api/src/upstream/client.ts\n2. /home/dev/copilot-hyper-api/src/auth/session-token.ts\n3. /home/dev/copilot-hyper-api/src/translate/openai-chat.ts\n\nRead each file one by one. After reading all three, write a comprehensive analysis.`,
    },
  ]

  const bSize = bodySize(messages)
  const tokens = estimateTokens(messages)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Context Continuation Test`)
  console.log(`  Base context: ~${baseTokensK}K tokens`)
  console.log(`  Initial body: ${Math.round(bSize/1024)}KB (${(bSize/(1024*1024)).toFixed(1)}MB)`)
  console.log(`  Initial tokens: ~${tokens}`)
  console.log(`  Model: ${MODEL}`)
  console.log(`  Goal: Continue conversation on top of massive context`)
  console.log(`${'='.repeat(60)}\n`)

  const MAX_ROUNDS = 20
  let totalRetries = 0

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const curTokens = estimateTokens(messages)
    const curBody = bodySize(messages)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
    const bodyKB = Math.round(curBody / 1024)
    const bodyStr = bodyKB > 1024 ? (curBody / (1024*1024)).toFixed(1) + 'MB' : bodyKB + 'KB'

    console.log(`\n--- R${round} | ${messages.length} msgs | ~${curTokens} tok | body=${bodyStr} | ${elapsed}s ---`)

    // 10s cooldown between rounds (we're always in "huge body" territory)
    if (round > 1) {
      console.log(`  ⏸️  Cooldown (10s)`)
      await new Promise(r => setTimeout(r, 10_000))
    }

    // Try with retries
    let reply: Message
    let retries = 0
    for (let attempt = 0; attempt <= 5; attempt++) {
      try {
        const result = await streamChat(messages)
        reply = result.reply
        retries = attempt
        console.log(`  ↳ ${result.elapsed}ms, ${result.chunks} chunks, content=${result.reply.content?.length ?? 0}ch, tools=${result.reply.tool_calls?.length ?? 0}`)
        if (attempt > 0) console.log(`  ✓ Succeeded after ${attempt} retries`)
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt < 5 && (msg.includes('socket') || msg.includes('timeout') || msg.includes('connection') || msg.includes('Empty response'))) {
          const delay = 5_000 * Math.pow(2, attempt)
          console.warn(`  ⚠️  Retry ${attempt + 1}/5, backoff ${Math.round(delay/1000)}s: ${msg}`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        console.error(`\n❌ FAILED at round ${round}: ${msg}`)
        console.error(`   Tokens: ~${curTokens}, Body: ${bodyStr}, Messages: ${messages.length}`)
        printResults(round, totalRetries, messages, startTime, false)
        return
      }
    }

    totalRetries += retries
    messages.push(reply!)

    // Handle tool calls
    if (reply!.tool_calls?.length) {
      for (const tc of reply!.tool_calls) {
        let tcArgs: any = {}
        try { tcArgs = JSON.parse(tc.function.arguments) } catch {}
        console.log(`  🔧 ${tc.function.name}: ${JSON.stringify(tcArgs).slice(0, 100)}`)

        let result = ''
        try {
          result = await Bun.file(tcArgs.path).text()
          if (result.length > 32 * 1024) result = result.slice(0, 32 * 1024) + '\n...[truncated]'
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`
        }
        console.log(`  📋 ${result.length > 1024 ? (result.length/1024).toFixed(0) + 'KB' : result.length + 'ch'} result`)
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
      }
      continue
    }

    // Content response
    console.log(`  📝 Content (${reply!.content?.length ?? 0} chars)`)

    // If it wrote a long analysis, we're probably done
    if (reply!.content && reply!.content.length > 2000) {
      console.log(`  ✅ Got comprehensive analysis`)
      printResults(round, totalRetries, messages, startTime, true)
      return
    }

    // Push to keep going
    messages.push({
      role: 'user',
      content: 'Continue reading the next file from the list.',
    })
  }

  printResults(MAX_ROUNDS, totalRetries, messages, startTime, true)
}

function printResults(rounds: number, retries: number, msgs: Message[], start: number, success: boolean) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  const tokens = estimateTokens(msgs)
  const bSize = bodySize(msgs)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  CONTEXT CONTINUATION RESULTS`)
  console.log(`${'='.repeat(60)}`)
  console.log(`  Status:         ${success ? '✅ SUCCESS' : '❌ FAILED'}`)
  console.log(`  Base context:   ~${baseTokensK}K tokens`)
  console.log(`  Total rounds:   ${rounds}`)
  console.log(`  Total retries:  ${retries}`)
  console.log(`  Final tokens:   ~${tokens}`)
  console.log(`  Final body:     ${Math.round(bSize/1024)}KB (${(bSize/(1024*1024)).toFixed(1)}MB)`)
  console.log(`  Final messages: ${msgs.length}`)
  console.log(`  Elapsed:        ${elapsed}s`)
  console.log(`${'='.repeat(60)}\n`)
}

main().catch(console.error)
