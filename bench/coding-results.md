# Coding Benchmark Results

Judge: Claude (Opus 4.6) | Date: 2026-04-07

Scoring: Correctness (0-5) + Quality (0-3) + Completeness (0-2) = Total (0-10)

## Per-Case Scores

| # | Case | Diff | gpt-5-mini | gpt-4.1 | gpt-4o | gpt-4o-mini | raptor-mini |
|---|------|------|-----------|---------|--------|------------|-------------|
| 1 | FizzBuzz | E | 10 | 10 | 9 | 9 | 10 |
| 2 | Reverse string | E | 10 | 9 | 9 | 6 | 10 |
| 3 | Palindrome number | E | 10 | 10 | 9 | 9 | 10 |
| 4 | Two Sum | E | 10 | 9 | 10 | 9 | 10 |
| 5 | Fibonacci | E | 10 | 10 | 9 | 6 | 10 |
| 6 | Anagram check | E | 10 | 10 | 9 | 6 | 10 |
| 7 | Flatten array | E | 10 | 10 | 10 | 8 | 10 |
| 8 | Max subarray sum | E | 10 | 10 | 9 | 9 | 10 |
| 9 | Roman to integer | E | 10 | 10 | 9 | 9 | 10 |
| 10 | Merge sorted arrays | E | 10 | 10 | 9 | 9 | 10 |
| 11 | Balanced parentheses | M | 10 | 10 | 7 | 7 | 10 |
| 12 | LRU Cache | M | 10 | 10 | 10 | 10 | 10 |
| 13 | Deep clone | M | 10 | 10 | 10 | 10 | 10 |
| 14 | Binary tree level order | M | 10 | 9 | 9 | 9 | 9 |
| 15 | Throttle function | M | 10 | 8 | 10 | 9 | 10 |
| 16 | Permutations | M | 10 | 10 | 10 | 7 | 10 |
| 17 | Promise pool | H | 9 | 9 | 9 | 9 | 9 |
| 18 | Expression parser | H | 10 | 10 | 8 | 8 | 10 |
| 19 | Trie with autocomplete | H | 10 | 10 | 10 | 10 | 10 |
| 20 | Event emitter | H | 10 | 8 | 8 | 7 | 10 |

## Summary

| Model | Total (/200) | Avg (/10) | Easy (/100) | Medium (/60) | Hard (/40) | Avg Latency |
|-------|-------------|-----------|-------------|-------------|------------|-------------|
| **gpt-5-mini** | **199** | **9.95** | 100 | 60 | 39 | 15967ms |
| **oswe-vscode-prime** | **198** | **9.90** | 100 | 59 | 39 | 7762ms |
| gpt-4.1 | 192 | 9.60 | 98 | 57 | 37 | 12313ms |
| gpt-4o | 183 | 9.15 | 92 | 56 | 35 | 7056ms |
| gpt-4o-mini | 166 | 8.30 | 80 | 52 | 34 | 4874ms |

## Key Findings

### gpt-5-mini (199/200) - WINNER
- Perfect 10 on 19/20 tasks. Only lost 1 point on Promise pool (AggregateError rejection semantics).
- Consistently writes TypeScript when prompted with TS types.
- Best algorithm choices: half-reverse for palindrome, O(1) queue via head pointer for BFS, 26-counter array for anagrams, stack-based iterative flatten.
- Downside: slowest model (16s avg), very verbose responses with explanations.

### oswe-vscode-prime (198/200) - RUNNER-UP
- Perfect 10 on 19/20 tasks. Lost 1 point on level order (uses shift() instead of head pointer).
- Concise, code-only responses - no fluff, no explanations.
- Consistently writes TypeScript with proper types.
- Best Event emitter implementation (only model with correct instance-specific off + once cancellation via {fn, original} pattern).
- 2x faster than gpt-5-mini at comparable quality.

### gpt-4.1 (192/200) - SOLID THIRD
- Lost points on: Two Sum (missing return path), Throttle (dead code), Level order (shift), Event emitter (Set deduplication).
- Good algorithm choices throughout.
- Verbose but clean responses.

### gpt-4o (183/200) - FOURTH
- Main weakness: sometimes writes Python when TypeScript is specified (Balanced parens, Expression parser).
- Verbose explanations that don't add value.
- All algorithms correct.

### gpt-4o-mini (166/200) - LAST
- Frequently writes Python when TypeScript is explicitly requested (6 cases).
- Event emitter: off() removes ALL matching instead of one instance; wildcard uses separate methods.
- Expression parser: unary minus only works before numbers, not expressions like -(2+3).
- Fastest model (5s avg) but lowest quality.

## Language Compliance

Models that wrote wrong language when TypeScript was specified in prompt signature:
- gpt-4o-mini: 6 violations (reverse, fib, anagram, balanced, permutations, expression parser)
- gpt-4o: 2 violations (balanced parens, expression parser)
- gpt-5-mini: 0 violations
- gpt-4.1: 0 violations
- oswe-vscode-prime: 0 violations
