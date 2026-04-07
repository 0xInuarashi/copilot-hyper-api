import { getConfig } from "../config.js";

export function getCopilotHeaders(sessionToken: string): Record<string, string> {
  const config = getConfig();
  return {
    Authorization: `Bearer ${sessionToken}`,
    "Editor-Version": config.COPILOT_EDITOR_VERSION,
    "Editor-Plugin-Version": "copilot/1.0.0",
    "Copilot-Integration-Id": config.COPILOT_INTEGRATION_ID,
    "OpenAI-Intent": "conversation-panel",
    "User-Agent": `GithubCopilot/1.0`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}
