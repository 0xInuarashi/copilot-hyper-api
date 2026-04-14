/**
 * Single-shot context test — send ONE massive prompt to test body size limits.
 * No tool loop, no history buildup. Just one big request.
 *
 * Usage:
 *   bun run bench/context-single-shot.ts --tokens 50    # 50K tokens (~200KB body)
 *   bun run bench/context-single-shot.ts --tokens 100   # 100K tokens (~400KB body)
 *   bun run bench/context-single-shot.ts --tokens 150   # 150K tokens (~600KB body)
 *   bun run bench/context-single-shot.ts --tokens 200   # 200K tokens (~800KB body)
 */

const API = 'http://localhost:8080/v1/chat/completions'
const API_KEY = 'sk-proxy-e2e-test-key'
const MODEL = 'oswe-vscode-prime'

const args = process.argv.slice(2)
const targetTokensK = args.includes('--tokens')
  ? parseInt(args[args.indexOf('--tokens') + 1])
  : 50

const CHARS_PER_TOKEN = 4
const targetChars = targetTokensK * 1000 * CHARS_PER_TOKEN

// Build padding text — repeat real code to make it realistic
const sourceFile = await Bun.file('/home/dev/copilot-hyper-api/src/routes/openai.ts').text()
const repeats = Math.ceil(targetChars / sourceFile.length)
const padding = Array.from({ length: repeats }, (_, i) =>
  `// ===== COPY ${i + 1}/${repeats} =====\n${sourceFile}`
).join('\n').slice(0, targetChars)

const messages = [
  {
    role: 'system',
    content: 'You are a code analyst. Respond with a brief 2-sentence summary of the code you were given.',
  },
  {
    role: 'user',
    content: `Analyze this codebase:\n\n${padding}\n\nGive a 2-sentence summary of what this code does.`,
  },
]

const body = JSON.stringify({ model: MODEL, messages, stream: true })
const bodyKB = Math.round(body.length / 1024)
const bodyMB = (body.length / (1024 * 1024)).toFixed(1)
const estTokens = Math.round(padding.length / CHARS_PER_TOKEN / 1000)

console.log(`\n${'='.repeat(60)}`)
console.log(`  Single-Shot Context Test`)
console.log(`  Target: ${targetTokensK}K tokens`)
console.log(`  Actual padding: ${estTokens}K tokens (~${padding.length.toLocaleString()} chars)`)
console.log(`  Body size: ${bodyKB > 1024 ? bodyMB + 'MB' : bodyKB + 'KB'}`)
console.log(`  Model: ${MODEL}`)
console.log(`${'='.repeat(60)}\n`)

const STREAM_READ_TIMEOUT_MS = 180_000 // 3 min for huge contexts

async function tryOnce(): Promise<{ content: string; chunks: number; elapsed: number }> {
  const start = Date.now()

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body,
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
        if (delta?.content) {
          content += delta.content
          chunks++
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Stream error')) throw e
      }
    }
  }

  return { content, chunks, elapsed: Date.now() - start }
}

// Try with retries
const MAX_RETRIES = 3
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    if (attempt > 0) {
      const delay = 10_000 * attempt
      console.log(`  ⏸️  Retry ${attempt}/${MAX_RETRIES}, waiting ${delay/1000}s...`)
      await new Promise(r => setTimeout(r, delay))
    }

    console.log(`  📤 Sending ${bodyKB > 1024 ? bodyMB + 'MB' : bodyKB + 'KB'} request...`)
    const result = await tryOnce()

    console.log(`\n  ✅ SUCCESS`)
    console.log(`  Response: ${result.content.length} chars, ${result.chunks} chunks`)
    console.log(`  Elapsed: ${(result.elapsed / 1000).toFixed(1)}s`)
    console.log(`  Content: ${result.content.slice(0, 200)}...`)
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  RESULT: ${targetTokensK}K tokens / ${bodyKB > 1024 ? bodyMB + 'MB' : bodyKB + 'KB'} body → ✅ OK`)
    console.log(`${'='.repeat(60)}\n`)
    process.exit(0)
  } catch (err) {
    console.error(`  ❌ Attempt ${attempt + 1}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`  RESULT: ${targetTokensK}K tokens / ${bodyKB > 1024 ? bodyMB + 'MB' : bodyKB + 'KB'} body → ❌ FAILED`)
console.log(`${'='.repeat(60)}\n`)
