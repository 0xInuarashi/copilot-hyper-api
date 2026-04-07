#!/usr/bin/env bun

const COPILOT_CLIENT_ID = process.env.COPILOT_CLIENT_ID ?? "Iv1.b507a08c87ecfe98";
const SCOPE = "read:user";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: SCOPE,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to request device code: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as DeviceCodeResponse;
}

async function pollForToken(deviceCode: string, initialInterval: number): Promise<string> {
  let interval = initialInterval;

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = (await res.json()) as any;

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === "authorization_pending") {
      continue;
    }

    if (data.error === "slow_down") {
      interval += 5;
      continue;
    }

    if (data.error === "expired_token") {
      throw new Error("Device code expired. Please try again.");
    }

    if (data.error === "access_denied") {
      throw new Error("Access denied. The user cancelled the authorization.");
    }

    throw new Error(`Unexpected error during polling: ${data.error ?? "unknown"}`);
  }
}

async function verifyCopilotAccess(oauthToken: string): Promise<void> {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    method: "GET",
    headers: {
      Authorization: `token ${oauthToken}`,
      Accept: "application/json",
      "User-Agent": "GithubCopilot/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `This GitHub account does not have Copilot access (${res.status}). ` +
        `Make sure your account has an active GitHub Copilot subscription.\n${body}`,
    );
  }
}

async function getGitHubUser(oauthToken: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `token ${oauthToken}`,
      Accept: "application/json",
      "User-Agent": "GithubCopilot/1.0",
    },
  });

  if (!res.ok) return "unknown";
  const data = (await res.json()) as any;
  return data.login ?? "unknown";
}

async function main() {
  const args = process.argv.slice(2);
  const writeEnv = args.includes("--write-env");

  console.log("🔐 GitHub Copilot Device Login\n");

  const { device_code, user_code, verification_uri, interval } = await requestDeviceCode();

  console.log(`Please visit: ${verification_uri}`);
  console.log(`Enter code: ${user_code}\n`);
  console.log("Waiting for authorization...");

  const oauthToken = await pollForToken(device_code, interval);

  // Verify Copilot access
  console.log("Verifying Copilot access...");
  await verifyCopilotAccess(oauthToken);

  const login = await getGitHubUser(oauthToken);

  console.log(`\n✓ Logged in as ${login}`);
  console.log("\nAdd this to your .env:");
  console.log(`GITHUB_OAUTH_TOKEN=${oauthToken}`);

  if (writeEnv) {
    const fs = await import("fs");
    const path = await import("path");
    const envPath = path.join(process.cwd(), ".env");
    let content = "";
    try {
      content = fs.readFileSync(envPath, "utf-8");
    } catch {
      // file doesn't exist
    }

    // Remove existing GITHUB_OAUTH_TOKEN line if present
    const lines = content.split("\n").filter((l) => !l.startsWith("GITHUB_OAUTH_TOKEN="));
    lines.push(`GITHUB_OAUTH_TOKEN=${oauthToken}`);
    fs.writeFileSync(envPath, lines.join("\n") + "\n");
    console.log(`\n✓ Written to ${envPath}`);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
