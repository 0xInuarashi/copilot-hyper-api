import { createHash } from "crypto";
import { getConfig } from "../config.js";

export type Initiator = "user" | "agent";

// Stable per-process IDs (matching Copilot CLI behavior)
const CLIENT_SESSION_ID = crypto.randomUUID();
const CLIENT_MACHINE_ID = crypto.randomUUID();

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
  return raw.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
}

/**
 * Conversation session map: conversationKey → current random UUIDs.
 * Key is a hash of the first user message (stable across all turns in a conversation).
 * Value holds the current interaction's random UUIDs, rotated on each new user turn.
 */
const conversationSessions = new Map<string, { interactionId: string; agentTaskId: string }>();

/**
 * Derive a stable conversation key from all user messages.
 * Hashing all user messages (not just the first) prevents collisions when
 * two conversations share the same opening message but diverge later.
 * A creation timestamp is embedded on first encounter to further eliminate
 * collisions for truly identical message sequences.
 */
const conversationTimestamps = new Map<string, string>();

function conversationKey(messages: any[]): string {
  // Only include genuine user text messages — skip tool_result-only messages
  // (Anthropic sends tool results as role:"user" with type:"tool_result" blocks,
  // which are agent continuations, not real user turns).
  const userMsgs = messages?.filter((m: any) => {
    if (m.role !== "user") return false;
    if (Array.isArray(m.content)) {
      return m.content.some((b: any) => b.type !== "tool_result");
    }
    return true;
  });
  if (!userMsgs?.length) return "";
  const contentKey = userMsgs.map((m: any) => stableText(m.content ?? "")).join("|");
  const baseHash = createHash("sha256").update(contentKey).digest("hex");

  // Attach a timestamp on first encounter so identical message sequences
  // started at different times still get distinct keys.
  if (!conversationTimestamps.has(baseHash)) {
    conversationTimestamps.set(baseHash, Date.now().toString());
    if (conversationTimestamps.size > 10000) {
      const oldest = conversationTimestamps.keys().next().value!;
      conversationTimestamps.delete(oldest);
    }
  }
  return createHash("sha256").update(baseHash + conversationTimestamps.get(baseHash)!).digest("hex");
}

/**
 * Get session IDs for this request. Uses true random UUIDs (matching Copilot CLI).
 * - User turns: generate fresh UUIDs, store them for the conversation.
 * - Agent turns: reuse the current UUIDs from the conversation.
 */
export function deriveSessionIds(messages: any[], initiator: Initiator): { interactionId: string; agentTaskId: string } {
  const key = conversationKey(messages);
  if (!key) {
    return { interactionId: crypto.randomUUID(), agentTaskId: crypto.randomUUID() };
  }

  if (initiator === "agent") {
    const existing = conversationSessions.get(key);
    if (existing) return existing;
  }

  // New user turn: rotate UUIDs
  const ids = { interactionId: crypto.randomUUID(), agentTaskId: crypto.randomUUID() };
  conversationSessions.set(key, ids);

  if (conversationSessions.size > 10000) {
    const oldest = conversationSessions.keys().next().value!;
    conversationSessions.delete(oldest);
  }

  return ids;
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
