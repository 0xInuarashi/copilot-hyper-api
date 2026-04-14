import { createHash } from "crypto";
import { getConfig } from "../config.js";
import { getResolvedVersions } from "./version-sync.js";

export type Initiator = "user" | "agent";

// Stable per-process IDs matching real VS Code formats:
//  - Machine ID: 64-char hex string (SHA-256 of hardware identifiers in real VS Code)
//  - Session ID: UUID + Unix-ms timestamp (real VS Code appends a timestamp to the UUID)
const CLIENT_MACHINE_ID = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const CLIENT_SESSION_ID = `${crypto.randomUUID()}${Date.now()}`;

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
  // Use live-synced versions when available, fall back to config defaults
  const v = getResolvedVersions();
  return {
    Authorization: `Bearer ${sessionToken}`,
    "X-Request-Id": crypto.randomUUID(),
    "Vscode-Sessionid": CLIENT_SESSION_ID,
    "Vscode-Machineid": CLIENT_MACHINE_ID,
    "Editor-Version": v.editorVersion,
    "Editor-Plugin-Version": v.pluginVersion,
    "Copilot-Integration-Id": config.COPILOT_INTEGRATION_ID,
    "OpenAI-Organization": "github-copilot",
    "OpenAI-Intent": "conversation-panel",
    "Content-Type": "application/json",
    "User-Agent": v.userAgent,
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    "X-Initiator": initiator,
    "X-Interaction-Id": interactionId ?? crypto.randomUUID(),
    "X-Interaction-Type": initiator === "user" ? "conversation-user" : "conversation-agent",
    "X-Agent-Task-Id": agentTaskId ?? crypto.randomUUID(),
    "X-Client-Session-Id": CLIENT_SESSION_ID,
    "X-Client-Machine-Id": CLIENT_MACHINE_ID,
    "x-github-api-version": v.githubApiVersion,
    "x-vscode-user-agent-library-version": "undici",
  };
}
