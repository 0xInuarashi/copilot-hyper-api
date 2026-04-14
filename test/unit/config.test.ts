import { describe, test, expect } from "bun:test";
import { loadConfig, getConfig, resetConfig } from "../../src/config.js";

describe("config", () => {
  test("loads valid config", () => {
    resetConfig();
    const config = loadConfig({
      PROXY_API_KEY: "sk-test",
      GITHUB_OAUTH_TOKEN: "gho_test",
      PORT: "3000",
    });
    expect(config.PROXY_API_KEY).toBe("sk-test");
    expect(config.GITHUB_OAUTH_TOKEN).toBe("gho_test");
    expect(config.PORT).toBe(3000);
    expect(config.COPILOT_CLIENT_ID).toBe("Iv1.b507a08c87ecfe98");
    expect(config.LOG_LEVEL).toBe("info");
  });

  test("missing PROXY_API_KEY → boot error", () => {
    resetConfig();
    expect(() => loadConfig({ GITHUB_OAUTH_TOKEN: "gho_test" })).toThrow("Invalid configuration");
    expect(() => loadConfig({ GITHUB_OAUTH_TOKEN: "gho_test" })).toThrow("PROXY_API_KEY");
  });

  test("missing GITHUB_OAUTH_TOKEN → boot error", () => {
    resetConfig();
    expect(() => loadConfig({ PROXY_API_KEY: "sk-test" })).toThrow("Invalid configuration");
    expect(() => loadConfig({ PROXY_API_KEY: "sk-test" })).toThrow("GITHUB_OAUTH_TOKEN");
  });

  test("invalid PORT → boot error", () => {
    resetConfig();
    expect(() =>
      loadConfig({
        PROXY_API_KEY: "sk-test",
        GITHUB_OAUTH_TOKEN: "gho_test",
        PORT: "not-a-number",
      }),
    ).toThrow("Invalid configuration");
  });

  test("getConfig throws if not loaded", () => {
    resetConfig();
    expect(() => getConfig()).toThrow("Config not loaded");
  });

  test("getConfig returns loaded config", () => {
    resetConfig();
    loadConfig({ PROXY_API_KEY: "sk-test", GITHUB_OAUTH_TOKEN: "gho_test" });
    const config = getConfig();
    expect(config.PROXY_API_KEY).toBe("sk-test");
  });

  test("defaults are applied correctly", () => {
    resetConfig();
    const config = loadConfig({
      PROXY_API_KEY: "sk-test",
      GITHUB_OAUTH_TOKEN: "gho_test",
    });
    expect(config.PORT).toBe(8080);
    expect(config.MODEL_CACHE_TTL_SECONDS).toBe(900);
    expect(config.SESSION_TOKEN_SAFETY_WINDOW_SECONDS).toBe(120);
    expect(config.COPILOT_EDITOR_VERSION).toBe("vscode/1.110.0");
    expect(config.COPILOT_PLUGIN_VERSION).toBe("copilot-chat/0.38.0");
    expect(config.COPILOT_USER_AGENT).toBe("GitHubCopilotChat/0.38.0");
    expect(config.COPILOT_INTEGRATION_ID).toBe("vscode-chat");
  });
});
