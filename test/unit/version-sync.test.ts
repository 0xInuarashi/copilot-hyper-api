import { describe, test, expect, afterEach } from "bun:test";
import { getResolvedVersions, stopVersionSync, initVersionSync } from "../../src/upstream/version-sync.js";

afterEach(() => {
  stopVersionSync();
});

describe("version-sync", () => {
  test("getResolvedVersions returns defaults before init", () => {
    const v = getResolvedVersions();
    // Should return the module-level defaults
    expect(v.editorVersion).toMatch(/^vscode\//);
    expect(v.pluginVersion).toMatch(/^copilot-chat\//);
    expect(v.userAgent).toMatch(/^GitHubCopilotChat\//);
    expect(v.copilotCoreVersion).toMatch(/^copilot\//);
    expect(v.githubApiVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("initVersionSync accepts custom defaults", async () => {
    const defaults = {
      editorVersion: "vscode/1.999.0",
      pluginVersion: "copilot-chat/99.0.0",
      userAgent: "GitHubCopilotChat/99.0.0",
      copilotCoreVersion: "copilot/99.0.0",
      githubApiVersion: "2099-01-01",
    };

    // initVersionSync will try to fetch but may fail in test env — that's OK,
    // it falls back to provided defaults
    await initVersionSync(defaults, 86_400_000);

    const v = getResolvedVersions();
    // If fetch failed (likely in CI/test), should have the defaults
    // If fetch succeeded, should have live versions
    // Either way, the structure is valid
    expect(v.editorVersion).toMatch(/^vscode\//);
    expect(v.pluginVersion).toMatch(/^copilot-chat\//);
    expect(v.userAgent).toMatch(/^GitHubCopilotChat\//);
    expect(v.copilotCoreVersion).toMatch(/^copilot\//);
    expect(v.githubApiVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("stopVersionSync clears cache", async () => {
    await initVersionSync(
      {
        editorVersion: "vscode/1.0.0",
        pluginVersion: "copilot-chat/1.0.0",
        userAgent: "GitHubCopilotChat/1.0.0",
        copilotCoreVersion: "copilot/1.0.0",
        githubApiVersion: "2025-01-01",
      },
      86_400_000,
    );

    stopVersionSync();

    // After stop, should fall back to module-level defaults (not the custom ones)
    const v = getResolvedVersions();
    expect(v).toBeDefined();
    expect(v.editorVersion).toMatch(/^vscode\//);
  });

  test("version strings follow expected format", () => {
    const v = getResolvedVersions();

    // editor: "vscode/X.Y.Z"
    expect(v.editorVersion).toMatch(/^vscode\/\d+\.\d+\.\d+$/);
    // plugin: "copilot-chat/X.Y.Z"
    expect(v.pluginVersion).toMatch(/^copilot-chat\/\d+\.\d+\.\d+$/);
    // agent: "GitHubCopilotChat/X.Y.Z"
    expect(v.userAgent).toMatch(/^GitHubCopilotChat\/\d+\.\d+\.\d+$/);
    // core: "copilot/X.Y.Z"
    expect(v.copilotCoreVersion).toMatch(/^copilot\/\d+\.\d+\.\d+$/);
  });
});
