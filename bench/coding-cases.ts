/**
 * 20 coding benchmark cases: 10 easy, 6 medium, 4 hard.
 * Each case has a prompt, rubric for the judge, and difficulty tier.
 */

export interface CodingCase {
  name: string;
  difficulty: "easy" | "medium" | "hard";
  prompt: string;
  rubric: string;
}

export const codingCases: CodingCase[] = [
  // ── Easy (10) ──────────────────────────────────────────────────────────────

  {
    name: "FizzBuzz",
    difficulty: "easy",
    prompt:
      "Write a function `fizzBuzz(n: number): string[]` that returns an array for numbers 1 to n. For multiples of 3 return \"Fizz\", multiples of 5 return \"Buzz\", multiples of both return \"FizzBuzz\", otherwise the number as a string.",
    rubric:
      "Correctness checks: fizzBuzz(15) should end with 'FizzBuzz', fizzBuzz(1) → ['1'], fizzBuzz(0) → []. Must use modulo correctly and check 15 (both) before 3 or 5 individually. Deduct if it only prints instead of returning an array.",
  },
  {
    name: "Reverse string",
    difficulty: "easy",
    prompt:
      "Write a function `reverseString(s: string): string` that reverses a string without using the built-in `.reverse()` method.",
    rubric:
      "Correctness: 'hello' → 'olleh', '' → '', 'a' → 'a'. Any approach is fine (loop, reduce, spread+reverse is borderline — they said no .reverse). Deduct if it mutates input or uses Array.prototype.reverse.",
  },
  {
    name: "Palindrome number",
    difficulty: "easy",
    prompt:
      "Write a function `isPalindromeNumber(x: number): boolean` that checks if an integer is a palindrome. Negative numbers are not palindromes. Do NOT convert the number to a string.",
    rubric:
      "Correctness: 121 → true, -121 → false, 10 → false, 0 → true, 1221 → true. Must work purely with math (reverse half or full number). Deduct heavily if it converts to string.",
  },
  {
    name: "Two Sum",
    difficulty: "easy",
    prompt:
      "Write a function `twoSum(nums: number[], target: number): [number, number]` that returns indices of two numbers that add up to the target. Assume exactly one solution exists.",
    rubric:
      "Correctness: [2,7,11,15] target 9 → [0,1]. An O(n) hash map solution is ideal. O(n²) brute force is correct but lower quality. Deduct if it returns the values instead of indices.",
  },
  {
    name: "Fibonacci",
    difficulty: "easy",
    prompt:
      "Write a function `fib(n: number): number` that returns the nth Fibonacci number (0-indexed: fib(0)=0, fib(1)=1, fib(2)=1, fib(10)=55).",
    rubric:
      "Correctness: fib(0)=0, fib(1)=1, fib(10)=55. Must NOT use naive recursive approach (exponential time). Iterative or memoized is expected. Deduct for stack overflow on fib(50).",
  },
  {
    name: "Anagram check",
    difficulty: "easy",
    prompt:
      "Write a function `isAnagram(s: string, t: string): boolean` that returns true if t is an anagram of s (case-insensitive, letters only).",
    rubric:
      "Correctness: 'listen'/'silent' → true, 'hello'/'world' → false, different lengths → false. Should be case-insensitive. Sorting or frequency count both fine.",
  },
  {
    name: "Flatten array",
    difficulty: "easy",
    prompt:
      "Write a function `flatten(arr: any[]): any[]` that deeply flattens a nested array. Example: flatten([1, [2, [3, [4]]]]) → [1, 2, 3, 4].",
    rubric:
      "Correctness: deeply nested → flat, empty arrays handled, mixed types preserved. Recursive or iterative both fine. Deduct if only flattens one level.",
  },
  {
    name: "Max subarray sum",
    difficulty: "easy",
    prompt:
      "Write a function `maxSubarraySum(nums: number[]): number` that finds the contiguous subarray with the largest sum (Kadane's algorithm). Example: [-2,1,-3,4,-1,2,1,-5,4] → 6.",
    rubric:
      "Correctness: classic Kadane's result is 6 for the example. Should handle all-negative arrays (return the least negative). O(n) expected. Deduct for O(n²) or wrong handling of negatives.",
  },
  {
    name: "Roman to integer",
    difficulty: "easy",
    prompt:
      "Write a function `romanToInt(s: string): number` that converts a Roman numeral string to an integer. Handle subtractive notation (IV=4, IX=9, XL=40, XC=90, CD=400, CM=900).",
    rubric:
      "Correctness: 'III'→3, 'IV'→4, 'IX'→9, 'LVIII'→58, 'MCMXCIV'→1994. Must handle subtractive cases by comparing current and next values. Deduct if it only handles additive.",
  },
  {
    name: "Merge sorted arrays",
    difficulty: "easy",
    prompt:
      "Write a function `mergeSorted(a: number[], b: number[]): number[]` that merges two sorted arrays into one sorted array in O(n+m) time.",
    rubric:
      "Correctness: [1,3,5] + [2,4,6] → [1,2,3,4,5,6]. Must use two-pointer approach for O(n+m). Handle empty arrays and unequal lengths. Deduct for sort-based approach (O(n log n)).",
  },

  // ── Medium (6) ─────────────────────────────────────────────────────────────

  {
    name: "Balanced parentheses",
    difficulty: "medium",
    prompt:
      "Write a function `isBalanced(s: string): boolean` that checks if a string containing '()', '[]', '{}' has balanced brackets. Ignore non-bracket characters.",
    rubric:
      "Correctness: '([{}])' → true, '([)]' → false, '' → true, '(' → false, '{[()]}' → true. Must use a stack. Deduct if it only handles one bracket type or doesn't ignore other chars.",
  },
  {
    name: "LRU Cache",
    difficulty: "medium",
    prompt:
      "Implement an LRU Cache class with constructor(capacity), get(key), and put(key, value). Both get and put should be O(1). When capacity is exceeded, evict the least recently used item.",
    rubric:
      "Correctness: get updates recency, put evicts LRU when full. O(1) requires a hash map + doubly linked list (or Map with insertion order). Deduct if eviction is wrong or operations are O(n).",
  },
  {
    name: "Deep clone",
    difficulty: "medium",
    prompt:
      "Write a function `deepClone<T>(obj: T): T` that creates a deep copy of a JavaScript value. Handle plain objects, arrays, Date, RegExp, Map, Set, and null. Bonus: handle circular references.",
    rubric:
      "Correctness: nested objects are independent copies, Date/RegExp create new instances with same value, Map/Set cloned deeply. Deduct if it only does shallow copy or uses JSON.parse(JSON.stringify). Circular ref handling is bonus points.",
  },
  {
    name: "Binary tree level order",
    difficulty: "medium",
    prompt:
      "Given a binary tree node type `{ val: number; left: TreeNode | null; right: TreeNode | null }`, write a function `levelOrder(root: TreeNode | null): number[][]` that returns values grouped by level (BFS).",
    rubric:
      "Correctness: returns [[root], [level1...], [level2...], ...]. null root → []. Must use BFS (queue), not DFS with level tracking (acceptable but less clean). Deduct if it flattens instead of grouping by level.",
  },
  {
    name: "Throttle function",
    difficulty: "medium",
    prompt:
      "Write a function `throttle<T extends (...args: any[]) => void>(fn: T, delay: number): T` that ensures fn is called at most once every `delay` ms. The first call should execute immediately.",
    rubric:
      "Correctness: first call fires immediately, subsequent calls within delay are dropped or deferred to next window. Must use timestamps or timers correctly. Args and context (this) should be forwarded. Deduct if it behaves like debounce instead.",
  },
  {
    name: "Permutations",
    difficulty: "medium",
    prompt:
      "Write a function `permutations(nums: number[]): number[][]` that returns all permutations of an array of distinct integers. Example: [1,2,3] → [[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]].",
    rubric:
      "Correctness: 3 elements → 6 permutations, 0 elements → [[]], 1 element → [[n]]. Backtracking or Heap's algorithm expected. All permutations must be unique and complete. Deduct if it returns duplicates or misses permutations.",
  },

  // ── Hard (4) ───────────────────────────────────────────────────────────────

  {
    name: "Promise pool",
    difficulty: "hard",
    prompt:
      "Write a function `promisePool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]>` that executes async tasks with a maximum concurrency limit, returning results in the original order. Handle rejections by collecting errors without stopping other tasks.",
    rubric:
      "Correctness: never exceeds concurrency limit, results are in original order (not completion order), rejected tasks don't prevent others from running. Must use a pool/queue pattern, not Promise.all in chunks (which wastes slots). Deduct for chunk-based approach or losing order.",
  },
  {
    name: "Expression parser",
    difficulty: "hard",
    prompt:
      "Write a function `evaluate(expr: string): number` that parses and evaluates arithmetic expressions with +, -, *, /, parentheses, and unary minus. Respect operator precedence: parens > unary > * / > + -. Examples: '2+3*4' → 14, '(2+3)*4' → 20, '-3+4' → 1, '10/(2+3)' → 2.",
    rubric:
      "Correctness: precedence correct (multiplication before addition), parentheses work, unary minus handled, division by zero handled gracefully. Recursive descent or shunting-yard algorithm expected. Deduct for using eval() or if precedence is wrong.",
  },
  {
    name: "Trie with autocomplete",
    difficulty: "hard",
    prompt:
      "Implement a Trie class with: insert(word), search(word) → boolean, startsWith(prefix) → boolean, and autocomplete(prefix, limit?) → string[] that returns up to `limit` (default 10) words matching the prefix, sorted alphabetically.",
    rubric:
      "Correctness: insert/search/startsWith all correct, autocomplete returns alphabetically sorted matches respecting limit. Should use DFS to collect words from prefix node. Deduct if autocomplete is missing or unsorted, or if search returns true for prefixes that aren't complete words.",
  },
  {
    name: "Event emitter",
    difficulty: "hard",
    prompt:
      "Implement a TypedEventEmitter class with: on(event, listener), off(event, listener), once(event, listener), emit(event, ...args). Add a wildcard '*' listener that fires for ALL events. `off` should remove only the specific listener instance. `once` listeners should auto-remove after one call.",
    rubric:
      "Correctness: on/emit basic flow works, off removes only the target listener (not others with same function), once fires exactly once then is removed, '*' wildcard receives (eventName, ...args). Deduct if off removes all matching listeners instead of the specific one, or if wildcard doesn't receive the event name.",
  },
];
