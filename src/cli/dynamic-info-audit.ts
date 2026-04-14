/**
 * Dynamic Info Audit
 *
 * Checks all version strings and dynamic values sent to providers against
 * their upstream sources. Reports what's current and what's stale.
 *
 * Usage:
 *   bun run src/cli/dynamic-info-audit.ts
 *   bun run src/cli/dynamic-info-audit.ts --json
 */

import { loadConfig, getConfig } from "../config.js";
import { getResolvedVersions, initVersionSync, stopVersionSync } from "../upstream/version-sync.js";
import { getTlsProfile, isTlsClientAvailable } from "../upstream/tls-client.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  field: string;
  current: string;
  latest: string;
  source: string;
  status: "ok" | "stale" | "unknown" | "unavailable" | "unverifiable";
  note?: string;
}

// ── Fetch helpers (all with 10s timeouts) ────────────────────────────────────

async function fetchLatestVSCodeVersion(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/microsoft/vscode/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "copilot-hyper-api/audit",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name ?? null;
  } catch {
    return null;
  }
}

async function fetchMarketplaceVersion(extensionId: string): Promise<string | null> {
  try {
    const res = await fetch(
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json;api-version=6.0-preview.1",
        },
        body: JSON.stringify({
          filters: [{ criteria: [{ filterType: 7, value: extensionId }] }],
          flags: 914,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{
        extensions?: Array<{ versions?: Array<{ version?: string }> }>;
      }>;
    };
    return data.results?.[0]?.extensions?.[0]?.versions?.[0]?.version ?? null;
  } catch {
    return null;
  }
}

async function fetchLatestChromeVersion(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      versions?: Array<{ version?: string }>;
    };
    const ver = data.versions?.[0]?.version;
    if (!ver) return null;
    return parseInt(ver.split(".")[0]!, 10);
  } catch {
    return null;
  }
}

async function fetchGitHubApiVersions(): Promise<string[] | null> {
  try {
    const res = await fetch("https://api.github.com/versions", {
      headers: {
        Accept: "application/json",
        "User-Agent": "copilot-hyper-api/audit",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as string[];
  } catch {
    return null;
  }
}

// ── Version comparison ───────────────────────────────────────────────────────

function extractVersion(prefixed: string): string {
  // "vscode/1.115.0" → "1.115.0", "copilot-chat/0.43.1" → "0.43.1"
  const idx = prefixed.indexOf("/");
  return idx >= 0 ? prefixed.slice(idx + 1) : prefixed;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function versionStatus(current: string, latest: string): "ok" | "stale" {
  return compareSemver(current, latest) >= 0 ? "ok" : "stale";
}

// ── Main audit ───────────────────────────────────────────────────────────────

async function runAudit(): Promise<AuditEntry[]> {
  const config = getConfig();
  const entries: AuditEntry[] = [];

  // Ensure version sync has run at least once
  await initVersionSync(
    {
      editorVersion: config.COPILOT_EDITOR_VERSION,
      pluginVersion: config.COPILOT_PLUGIN_VERSION,
      userAgent: config.COPILOT_USER_AGENT,
      copilotCoreVersion: "copilot/1.300.0",
      githubApiVersion: "2025-04-01",
    },
    86_400_000,
  );
  const resolved = getResolvedVersions();

  // Fetch all sources in parallel
  const [latestVSCode, latestCopilotChat, latestCopilotCore, latestChromeMajor, ghApiVersions] =
    await Promise.all([
      fetchLatestVSCodeVersion(),
      fetchMarketplaceVersion("GitHub.copilot-chat"),
      fetchMarketplaceVersion("GitHub.copilot"),
      fetchLatestChromeVersion(),
      fetchGitHubApiVersions(),
    ]);

  // 1. VS Code Editor Version
  const currentEditor = extractVersion(resolved.editorVersion);
  if (latestVSCode) {
    entries.push({
      field: "Editor-Version",
      current: `vscode/${currentEditor}`,
      latest: `vscode/${latestVSCode}`,
      source: "github.com/microsoft/vscode/releases",
      status: versionStatus(currentEditor, latestVSCode),
    });
  } else {
    entries.push({
      field: "Editor-Version",
      current: `vscode/${currentEditor}`,
      latest: "?",
      source: "github.com/microsoft/vscode/releases",
      status: "unknown",
      note: "Failed to fetch latest VS Code release",
    });
  }

  // 2. Copilot Chat Plugin Version
  const currentPlugin = extractVersion(resolved.pluginVersion);
  if (latestCopilotChat) {
    entries.push({
      field: "Editor-Plugin-Version",
      current: `copilot-chat/${currentPlugin}`,
      latest: `copilot-chat/${latestCopilotChat}`,
      source: "marketplace.visualstudio.com (GitHub.copilot-chat)",
      status: versionStatus(currentPlugin, latestCopilotChat),
    });
  } else {
    entries.push({
      field: "Editor-Plugin-Version",
      current: `copilot-chat/${currentPlugin}`,
      latest: "?",
      source: "marketplace.visualstudio.com (GitHub.copilot-chat)",
      status: "unknown",
      note: "Failed to fetch from Marketplace",
    });
  }

  // 3. User-Agent (derived from Copilot Chat version)
  const currentUA = extractVersion(resolved.userAgent);
  if (latestCopilotChat) {
    entries.push({
      field: "User-Agent",
      current: `GitHubCopilotChat/${currentUA}`,
      latest: `GitHubCopilotChat/${latestCopilotChat}`,
      source: "marketplace.visualstudio.com (GitHub.copilot-chat)",
      status: versionStatus(currentUA, latestCopilotChat),
    });
  } else {
    entries.push({
      field: "User-Agent",
      current: `GitHubCopilotChat/${currentUA}`,
      latest: "?",
      source: "marketplace.visualstudio.com (GitHub.copilot-chat)",
      status: "unknown",
    });
  }

  // 4. Copilot Core (token refresh header)
  const currentCore = extractVersion(resolved.copilotCoreVersion);
  if (latestCopilotCore) {
    entries.push({
      field: "Copilot-Core (token refresh)",
      current: `copilot/${currentCore}`,
      latest: `copilot/${latestCopilotCore}`,
      source: "marketplace.visualstudio.com (GitHub.copilot)",
      status: versionStatus(currentCore, latestCopilotCore),
    });
  } else {
    entries.push({
      field: "Copilot-Core (token refresh)",
      current: `copilot/${currentCore}`,
      latest: "?",
      source: "marketplace.visualstudio.com (GitHub.copilot)",
      status: "unknown",
    });
  }

  // 5. TLS Chrome Profile
  const tlsProfile = getTlsProfile();
  const tlsAvailable = isTlsClientAvailable();
  if (!config.ENABLE_TLS_FINGERPRINT) {
    entries.push({
      field: "TLS Chrome Profile",
      current: "disabled",
      latest: latestChromeMajor ? `chrome_${latestChromeMajor}` : "?",
      source: "versionhistory.googleapis.com",
      status: "unavailable",
      note: "ENABLE_TLS_FINGERPRINT=false",
    });
  } else if (!tlsAvailable) {
    entries.push({
      field: "TLS Chrome Profile",
      current: "wreq-js not available",
      latest: latestChromeMajor ? `chrome_${latestChromeMajor}` : "?",
      source: "versionhistory.googleapis.com",
      status: "unavailable",
      note: "wreq-js native addon failed to load",
    });
  } else if (latestChromeMajor && tlsProfile) {
    const currentChromeMajor = parseInt(tlsProfile.replace("chrome_", ""), 10);
    const drift = latestChromeMajor - currentChromeMajor;
    entries.push({
      field: "TLS Chrome Profile",
      current: tlsProfile,
      latest: `chrome_${latestChromeMajor}`,
      source: "versionhistory.googleapis.com",
      status: drift <= 2 ? "ok" : "stale",
      note: drift > 0 ? `${drift} major versions behind (wreq-js may not support newer)` : undefined,
    });
  } else {
    entries.push({
      field: "TLS Chrome Profile",
      current: tlsProfile ?? "none",
      latest: "?",
      source: "versionhistory.googleapis.com",
      status: "unknown",
      note: "Failed to fetch Chrome stable version",
    });
  }

  // 6. GitHub API Version (now auto-synced)
  const currentGhApi = resolved.githubApiVersion;
  if (ghApiVersions && ghApiVersions.length > 0) {
    const sorted = [...ghApiVersions].sort();
    const latestGhApi = sorted[sorted.length - 1]!;
    entries.push({
      field: "x-github-api-version",
      current: currentGhApi,
      latest: latestGhApi,
      source: "api.github.com/versions",
      status: currentGhApi === latestGhApi ? "ok" : "stale",
    });
  } else {
    entries.push({
      field: "x-github-api-version",
      current: currentGhApi,
      latest: "?",
      source: "api.github.com/versions",
      status: "unknown",
      note: "Failed to fetch GitHub API versions",
    });
  }

  // 7. Version Sync status (reports whether the server will auto-sync at runtime)
  const configEditorVer = extractVersion(config.COPILOT_EDITOR_VERSION);
  const syncedDifferent = currentEditor !== configEditorVer;
  entries.push({
    field: "Version Sync",
    current: config.VERSION_SYNC_ENABLED ? "enabled" : "disabled",
    latest: "n/a",
    source: "internal",
    status: config.VERSION_SYNC_ENABLED ? "ok" : "stale",
    note: config.VERSION_SYNC_ENABLED
      ? syncedDifferent
        ? `Config default ${configEditorVer} → live ${currentEditor}`
        : "Live versions match config defaults"
      : "Set VERSION_SYNC_ENABLED=true so versions stay current automatically",
  });

  // ── Hardcoded values (no upstream source — surfaced for manual review) ──────

  // 8. Copilot Integration ID
  entries.push({
    field: "Copilot-Integration-Id",
    current: config.COPILOT_INTEGRATION_ID,
    latest: "n/a",
    source: "hardcoded (config)",
    status: "unverifiable",
    note: "No upstream source — verify against real VS Code traffic",
  });

  // 9. OpenAI-Organization header
  entries.push({
    field: "OpenAI-Organization",
    current: "github-copilot",
    latest: "n/a",
    source: "hardcoded (headers.ts)",
    status: "unverifiable",
    note: "No upstream source — verify against real VS Code traffic",
  });

  // 10. OpenAI-Intent header
  entries.push({
    field: "OpenAI-Intent",
    current: "conversation-panel",
    latest: "n/a",
    source: "hardcoded (headers.ts)",
    status: "unverifiable",
    note: "No upstream source — verify against real VS Code traffic",
  });

  // 11. VS Code user-agent library version
  entries.push({
    field: "x-vscode-user-agent-library-version",
    current: "undici",
    latest: "n/a",
    source: "hardcoded (headers.ts)",
    status: "unverifiable",
    note: "Matches VS Code 1.100+ — monitor for future library changes",
  });

  // 12. Token refresh User-Agent (now derived from synced copilot core version)
  const tokenRefreshUA = `GithubCopilot/${extractVersion(resolved.copilotCoreVersion)}`;
  if (latestCopilotCore) {
    entries.push({
      field: "Token Refresh User-Agent",
      current: tokenRefreshUA,
      latest: `GithubCopilot/${latestCopilotCore}`,
      source: "marketplace.visualstudio.com (GitHub.copilot)",
      status: versionStatus(extractVersion(resolved.copilotCoreVersion), latestCopilotCore),
    });
  } else {
    entries.push({
      field: "Token Refresh User-Agent",
      current: tokenRefreshUA,
      latest: "?",
      source: "marketplace.visualstudio.com (GitHub.copilot)",
      status: "unknown",
      note: "Failed to fetch from Marketplace",
    });
  }

  // 13. OAuth Client ID
  entries.push({
    field: "OAuth Client ID",
    current: config.COPILOT_CLIENT_ID,
    latest: "n/a",
    source: "hardcoded (config)",
    status: "unverifiable",
    note: "GitHub OAuth client ID — could rotate without notice",
  });

  // 14. Token endpoint path
  entries.push({
    field: "Token Endpoint",
    current: "/copilot_internal/v2/token",
    latest: "n/a",
    source: "hardcoded (session-token.ts)",
    status: "unverifiable",
    note: "API version path — breaks if GitHub bumps to v3",
  });

  // 15. API base fallback
  entries.push({
    field: "API Base Fallback",
    current: "https://api.githubcopilot.com",
    latest: "n/a",
    source: "hardcoded (session-token.ts)",
    status: "unverifiable",
    note: "Used when token response lacks endpoints.api",
  });

  // 16. Header order template
  entries.push({
    field: "Header Order Template",
    current: "captured 2025-04 (22 headers)",
    latest: "n/a",
    source: "mitmproxy capture (fingerprint.ts)",
    status: "unverifiable",
    note: "Re-capture from real VS Code periodically to detect ordering changes",
  });

  // 17. Body field order template
  entries.push({
    field: "Body Field Order Template",
    current: "captured 2025-04 (15 fields)",
    latest: "n/a",
    source: "mitmproxy capture (fingerprint.ts)",
    status: "unverifiable",
    note: "Re-capture from real VS Code periodically to detect field changes",
  });

  return entries;
}

// ── Output formatting ────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  ok: "\x1b[32mOK\x1b[0m",
  stale: "\x1b[31mSTALE\x1b[0m",
  unknown: "\x1b[33m???\x1b[0m",
  unavailable: "\x1b[90mN/A\x1b[0m",
  unverifiable: "\x1b[36mFIXED\x1b[0m",
};

function printTable(entries: AuditEntry[]) {
  const fieldW = Math.max(...entries.map((e) => e.field.length), 5);
  const currentW = Math.max(...entries.map((e) => e.current.length), 7);
  const latestW = Math.max(...entries.map((e) => e.latest.length), 6);

  console.log(
    `${"Field".padEnd(fieldW)}  ${"Current".padEnd(currentW)}  ${"Latest".padEnd(latestW)}  Status  Source`,
  );
  console.log("─".repeat(fieldW + currentW + latestW + 30));

  for (const e of entries) {
    const icon = STATUS_ICON[e.status] ?? e.status;
    console.log(
      `${e.field.padEnd(fieldW)}  ${e.current.padEnd(currentW)}  ${e.latest.padEnd(latestW)}  ${icon.padEnd(13)}  ${e.source}`,
    );
    if (e.note) {
      console.log(`${"".padEnd(fieldW)}  \x1b[90m${e.note}\x1b[0m`);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

// Suppress info/warn logs during audit — we only want the table
const origLog = console.log;
const origInfo = console.info;
const origWarn = console.warn;
let logsHeld = true;
console.log = (...args: any[]) => { if (!logsHeld) origLog(...args); };
console.info = (...args: any[]) => { if (!logsHeld) origInfo(...args); };
console.warn = (...args: any[]) => { if (!logsHeld) origWarn(...args); };

loadConfig();

const jsonMode = process.argv.includes("--json");

origLog("Auditing dynamic provider info...\n");

const entries = await runAudit();

// Restore console for output
logsHeld = false;
console.log = origLog;
console.info = origInfo;
console.warn = origWarn;

if (jsonMode) {
  console.log(JSON.stringify(entries, null, 2));
} else {
  printTable(entries);

  const staleCount = entries.filter((e) => e.status === "stale").length;
  const unknownCount = entries.filter((e) => e.status === "unknown").length;
  const fixedCount = entries.filter((e) => e.status === "unverifiable").length;

  console.log("");
  if (staleCount > 0) {
    console.log(`\x1b[31m${staleCount} value(s) are stale and should be updated.\x1b[0m`);
  }
  if (unknownCount > 0) {
    console.log(`\x1b[33m${unknownCount} value(s) could not be verified (network issue?).\x1b[0m`);
  }
  if (fixedCount > 0) {
    console.log(`\x1b[36m${fixedCount} value(s) are hardcoded with no automated verification.\x1b[0m`);
  }
  if (staleCount === 0 && unknownCount === 0) {
    console.log("\x1b[32mAll dynamic values are current.\x1b[0m");
  }
}

stopVersionSync();
