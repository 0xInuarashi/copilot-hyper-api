/**
 * Automatic version synchronization.
 *
 * Fetches current VS Code and Copilot extension versions from public APIs
 * so that header values stay current without manual updates.
 *
 * Sources:
 *  - VS Code: GitHub Releases API (microsoft/vscode)
 *  - Copilot Chat: VS Code Marketplace API (GitHub.copilot-chat)
 *  - Copilot core: VS Code Marketplace API (GitHub.copilot)
 *
 * Falls back to config defaults if any fetch fails.
 */

import { logger } from "../logger.js";

export interface ResolvedVersions {
  editorVersion: string;   // "vscode/1.110.0"
  pluginVersion: string;   // "copilot-chat/0.38.0"
  userAgent: string;       // "GitHubCopilotChat/0.38.0"
  copilotCoreVersion: string; // "copilot/1.300.0" (for token refresh)
  githubApiVersion: string;   // "2026-03-10" (x-github-api-version header)
}

interface CachedVersions {
  versions: ResolvedVersions;
  fetchedAt: number;
}

const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const VSCODE_RELEASES_URL =
  "https://api.github.com/repos/microsoft/vscode/releases/latest";
const GITHUB_API_VERSIONS_URL = "https://api.github.com/versions";

let _cache: CachedVersions | null = null;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _defaults: ResolvedVersions = {
  editorVersion: "vscode/1.110.0",
  pluginVersion: "copilot-chat/0.38.0",
  userAgent: "GitHubCopilotChat/0.38.0",
  copilotCoreVersion: "copilot/1.300.0",
  githubApiVersion: "2025-04-01",
};

// ── Marketplace fetch ───────────────────────────────────────────────────────

async function fetchMarketplaceVersion(extensionId: string): Promise<string | null> {
  try {
    const body = {
      filters: [
        {
          criteria: [{ filterType: 7, value: extensionId }],
        },
      ],
      flags: 914,
    };

    const res = await fetch(MARKETPLACE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json;api-version=6.0-preview.1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      results?: Array<{
        extensions?: Array<{
          versions?: Array<{ version?: string }>;
        }>;
      }>;
    };

    const version =
      data.results?.[0]?.extensions?.[0]?.versions?.[0]?.version ?? null;
    return version;
  } catch {
    return null;
  }
}

// ── VS Code version fetch ───────────────────────────────────────────────────

async function fetchVSCodeVersion(): Promise<string | null> {
  try {
    const res = await fetch(VSCODE_RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "copilot-hyper-api/version-sync",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name ?? null;
  } catch {
    return null;
  }
}

// ── GitHub API version fetch ────────────────────────────────────────────────

async function fetchLatestGitHubApiVersion(): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_API_VERSIONS_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "copilot-hyper-api/version-sync",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const versions = (await res.json()) as string[];
    if (!versions?.length) return null;

    // Versions are date strings like "2025-04-01" — sort and pick latest
    const sorted = [...versions].sort();
    return sorted[sorted.length - 1]!;
  } catch {
    return null;
  }
}

// ── Sync logic ──────────────────────────────────────────────────────────────

async function doSync(defaults: ResolvedVersions): Promise<ResolvedVersions> {
  const [vscodeVersion, copilotChatVersion, copilotCoreVersion, ghApiVersion] =
    await Promise.all([
      fetchVSCodeVersion(),
      fetchMarketplaceVersion("GitHub.copilot-chat"),
      fetchMarketplaceVersion("GitHub.copilot"),
      fetchLatestGitHubApiVersion(),
    ]);

  const resolved: ResolvedVersions = { ...defaults };

  if (vscodeVersion) {
    resolved.editorVersion = `vscode/${vscodeVersion}`;
    logger.info({ event: "version_sync", field: "editor", version: vscodeVersion });
  }

  if (copilotChatVersion) {
    resolved.pluginVersion = `copilot-chat/${copilotChatVersion}`;
    resolved.userAgent = `GitHubCopilotChat/${copilotChatVersion}`;
    logger.info({ event: "version_sync", field: "copilot-chat", version: copilotChatVersion });
  }

  if (copilotCoreVersion) {
    resolved.copilotCoreVersion = `copilot/${copilotCoreVersion}`;
    logger.info({ event: "version_sync", field: "copilot-core", version: copilotCoreVersion });
  }

  if (ghApiVersion) {
    resolved.githubApiVersion = ghApiVersion;
    logger.info({ event: "version_sync", field: "github-api-version", version: ghApiVersion });
  }

  if (!vscodeVersion && !copilotChatVersion && !copilotCoreVersion && !ghApiVersion) {
    logger.warn({ event: "version_sync", status: "all_failed", using: "defaults" });
  }

  return resolved;
}

/**
 * Initialize the version sync system.
 * Call once at startup. Performs an immediate sync, then refreshes on interval.
 */
export async function initVersionSync(
  defaults: ResolvedVersions,
  intervalMs: number,
): Promise<void> {
  _defaults = defaults;

  // Immediate first sync (non-blocking — fall back to defaults on failure)
  try {
    const versions = await doSync(defaults);
    _cache = { versions, fetchedAt: Date.now() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ event: "version_sync_init_error", error: msg });
    _cache = { versions: defaults, fetchedAt: Date.now() };
  }

  // Background refresh
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(async () => {
    try {
      const versions = await doSync(_defaults);
      const prev = _cache?.versions;

      // Log changes
      if (prev) {
        if (prev.editorVersion !== versions.editorVersion) {
          logger.info({ event: "version_updated", field: "editor", from: prev.editorVersion, to: versions.editorVersion });
        }
        if (prev.pluginVersion !== versions.pluginVersion) {
          logger.info({ event: "version_updated", field: "plugin", from: prev.pluginVersion, to: versions.pluginVersion });
        }
        if (prev.copilotCoreVersion !== versions.copilotCoreVersion) {
          logger.info({ event: "version_updated", field: "copilot-core", from: prev.copilotCoreVersion, to: versions.copilotCoreVersion });
        }
        if (prev.githubApiVersion !== versions.githubApiVersion) {
          logger.info({ event: "version_updated", field: "github-api-version", from: prev.githubApiVersion, to: versions.githubApiVersion });
        }
      }

      _cache = { versions, fetchedAt: Date.now() };
    } catch {
      // Keep existing cache on refresh failure
    }
  }, intervalMs);
}

/**
 * Get the currently resolved versions.
 * Returns defaults if sync hasn't completed yet.
 */
export function getResolvedVersions(): ResolvedVersions {
  return _cache?.versions ?? _defaults;
}

/** Stop the background refresh timer (for testing / shutdown). */
export function stopVersionSync(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  _cache = null;
}
