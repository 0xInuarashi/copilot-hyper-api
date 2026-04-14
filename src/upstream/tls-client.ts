/**
 * TLS fingerprint spoofing via wreq-js.
 *
 * wreq-js uses a native addon to produce Chrome-like TLS handshakes
 * (JA3/JA4). This is optional — if the addon is unavailable (e.g. Bun
 * native module incompatibility), we fall back to the standard fetch.
 *
 * Instead of hardcoding a single browser profile, we probe the installed
 * wreq-js version for the newest Chrome profile it supports. This way,
 * upgrading wreq-js automatically picks up newer fingerprints without
 * a code change.
 *
 * Enabled by ENABLE_TLS_FINGERPRINT=true in config.
 */

import { logger } from "../logger.js";

interface WreqSession {
  get(url: string, opts?: any): Promise<any>;
  post(url: string, opts?: any): Promise<any>;
  fetch(url: string, opts?: any): Promise<Response>;
}

// Chrome profiles to probe, newest first.
// When wreq-js adds new profiles, just prepend them here.
// The init loop tries each one and uses the first that works.
const CHROME_PROFILES = [
  "chrome_131",
  "chrome_130",
  "chrome_127",
  "chrome_126",
  "chrome_124",
  "chrome_123",
  "chrome_120",
  "chrome_118",
  "chrome_116",
  "chrome_112",
  "chrome_110",
  "chrome_107",
  "chrome_104",
  "chrome_103",
];

let wreqSession: WreqSession | null = null;
let initAttempted = false;
let _available = false;
let _selectedProfile: string | null = null;

function getPlatformOS(): string {
  switch (process.platform) {
    case "darwin": return "macos";
    case "win32": return "windows";
    default: return "linux";
  }
}

function initSession(): void {
  if (initAttempted) return;
  initAttempted = true;

  let wreq: any;
  try {
    wreq = require("wreq-js");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ event: "tls_client_init", status: "unavailable", reason: msg });
    return;
  }

  // Probe profiles newest-first, use the first one that initializes
  for (const profile of CHROME_PROFILES) {
    try {
      wreqSession = wreq.Session({ browser: profile, os: getPlatformOS() });
      _selectedProfile = profile;
      _available = true;
      logger.info({ event: "tls_client_init", status: "ok", browser: profile });
      return;
    } catch {
      // This profile isn't supported by this wreq-js version, try next
      continue;
    }
  }

  // None worked
  logger.warn({
    event: "tls_client_init",
    status: "no_profile",
    reason: `wreq-js loaded but none of ${CHROME_PROFILES.length} Chrome profiles are supported`,
  });
}

export function isTlsClientAvailable(): boolean {
  if (!initAttempted) initSession();
  return _available;
}

/** Returns the active Chrome profile string, or null if TLS client isn't active. */
export function getTlsProfile(): string | null {
  if (!initAttempted) initSession();
  return _selectedProfile;
}

/**
 * Perform a fetch using the TLS-spoofed session.
 * Falls back to native fetch if wreq-js is unavailable.
 */
export async function tlsFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!initAttempted) initSession();

  if (!wreqSession) {
    return fetch(url, init);
  }

  try {
    return await wreqSession.fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ event: "tls_fetch_fallback", reason: msg });
    return fetch(url, init);
  }
}
