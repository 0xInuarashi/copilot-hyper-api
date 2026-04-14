/**
 * Copilot request fingerprint ordering.
 *
 * Real Copilot VSCode clients send headers and body fields in a specific order.
 * Matching this order reduces fingerprinting risk. The orders below were captured
 * via mitmproxy from an actual VSCode + Copilot Chat session.
 */

// Header order as observed from VSCode Copilot Chat (2025-04)
const COPILOT_HEADER_ORDER = [
  "host",
  "authorization",
  "x-request-id",
  "vscode-sessionid",
  "vscode-machineid",
  "editor-version",
  "editor-plugin-version",
  "copilot-integration-id",
  "openai-organization",
  "openai-intent",
  "content-type",
  "user-agent",
  "accept",
  "accept-encoding",
  // Additional headers we send that real clients also include
  "x-initiator",
  "x-interaction-id",
  "x-interaction-type",
  "x-agent-task-id",
  "x-client-session-id",
  "x-client-machine-id",
  "x-github-api-version",
  "x-vscode-user-agent-library-version",
];

// Body field order as observed from real Copilot Chat requests
const COPILOT_BODY_FIELD_ORDER = [
  "messages",
  "model",
  "temperature",
  "top_p",
  "max_tokens",
  "n",
  "stream",
  "intent",
  "intent_threshold",
  "intent_content",
  // Additional fields we may use
  "tools",
  "tool_choice",
  "response_format",
  "stop",
  "seed",
];

/**
 * Reorder headers to match Copilot VSCode's observed ordering.
 * Keys not in the template are appended at the end in their original order.
 */
export function orderHeaders(headers: Record<string, string>): Record<string, string> {
  const ordered: Record<string, string> = {};
  const lowerMap = new Map<string, { original: string; value: string }>();

  // Build a lowercase → original mapping
  for (const [key, value] of Object.entries(headers)) {
    lowerMap.set(key.toLowerCase(), { original: key, value });
  }

  // Place known headers first in the correct order
  for (const lk of COPILOT_HEADER_ORDER) {
    const entry = lowerMap.get(lk);
    if (entry) {
      ordered[entry.original] = entry.value;
      lowerMap.delete(lk);
    }
  }

  // Append remaining headers in their original order
  for (const { original, value } of lowerMap.values()) {
    ordered[original] = value;
  }

  return ordered;
}

/**
 * Reorder body fields to match Copilot VSCode's observed ordering.
 * Returns a new JSON string. Fields not in the template are appended at the end.
 */
export function orderBodyFields(body: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};

  // Place known fields first
  for (const key of COPILOT_BODY_FIELD_ORDER) {
    if (key in body) {
      ordered[key] = body[key];
    }
  }

  // Append remaining fields in original order
  for (const [key, value] of Object.entries(body)) {
    if (!(key in ordered)) {
      ordered[key] = value;
    }
  }

  return JSON.stringify(ordered);
}
