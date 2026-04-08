import { createHash } from "crypto";
import { getConfig } from "../config.js";

export type Initiator = "user" | "agent";

// Stable per-process IDs (matching Copilot CLI behavior)
const CLIENT_SESSION_ID = crypto.randomUUID();
const CLIENT_MACHINE_ID = crypto.randomUUID();

/** Derive a deterministic UUID from a seed string + salt. */
function deriveUUID(seed: string, salt: string): string {
  const hex = createHash("sha256").update(salt + seed).digest("hex");
  // Format as UUID v4 shape: 8-4-4-4-12
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Extract stable text from a message, stripping injected tags like <system-reminder>. */
function stableText(content: any): string {
  let raw: string;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .filter((p: any) => p.type === "text" || p.type === "tool_result")
      .map((p: any) => p.text ?? p.content ?? "")
      .join("");
  } else {
    return "";
  }
  // Strip XML-tagged blocks injected by frameworks (e.g. <system-reminder>...</system-reminder>)
  return raw.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
}

/**
 * Derive stable interaction + task IDs from the latest user prompt in a conversation.
 * Each new user turn gets a fresh interaction ID (matching Copilot CLI behavior).
 * Agent continuations (tool_result) reuse the preceding user turn's ID.
 */
export function deriveSessionIds(messages: any[]): { interactionId: string; agentTaskId: string } {
  // Walk backwards to find the last plain user message (not tool_result).
  // This ensures agent turns (tool results) share the same ID as the user turn that triggered them.
  let seed = "";
  if (messages?.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      // Skip user messages that are only tool_results (Anthropic format)
      if (Array.isArray(m.content) && m.content.every((b: any) => b.type === "tool_result")) continue;
      seed = stableText(m.content ?? "");
      break;
    }
  }
  return {
    interactionId: deriveUUID(seed, "interaction"),
    agentTaskId: deriveUUID(seed, "agent-task"),
  };
}

export function getCopilotHeaders(
  sessionToken: string,
  initiator: Initiator = "user",
  interactionId?: string,
  agentTaskId?: string,
): Record<string, string> {
  const config = getConfig();
  return {
    Authorization: `Bearer ${sessionToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Editor-Version": config.COPILOT_EDITOR_VERSION,
    "Editor-Plugin-Version": "copilot/1.0.0",
    "Copilot-Integration-Id": config.COPILOT_INTEGRATION_ID,
    "OpenAI-Intent": "conversation-panel",
    "User-Agent": "GithubCopilot/1.0",
    "X-Initiator": initiator,
    "X-Interaction-Id": interactionId ?? crypto.randomUUID(),
    "X-Interaction-Type": initiator === "user" ? "conversation-user" : "conversation-agent",
    "X-Agent-Task-Id": agentTaskId ?? crypto.randomUUID(),
    "X-Client-Session-Id": CLIENT_SESSION_ID,
    "X-Client-Machine-Id": CLIENT_MACHINE_ID,
  };
}
