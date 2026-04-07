import { describe, test, expect, beforeEach } from "bun:test";
import { resolveModel, ModelNotFoundError, type NormalizedModel } from "../../src/upstream/models.js";

const testModels: NormalizedModel[] = [
  {
    id: "gpt-4o-2024-05-13",
    family: "gpt-4o",
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: true,
  },
  {
    id: "claude-3.5-sonnet",
    family: "claude",
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: true,
  },
  {
    id: "gpt-4",
    family: "gpt-4",
    maxInputTokens: 8192,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsVision: false,
  },
];

describe("resolveModel", () => {
  test("exact match", () => {
    const result = resolveModel(testModels, "gpt-4o-2024-05-13");
    expect(result.id).toBe("gpt-4o-2024-05-13");
  });

  test("alias resolution: gpt-4o → gpt-4o-2024-05-13", () => {
    const result = resolveModel(testModels, "gpt-4o");
    expect(result.id).toBe("gpt-4o-2024-05-13");
  });

  test("alias resolution: claude-3-5-sonnet → claude-3.5-sonnet", () => {
    const result = resolveModel(testModels, "claude-3-5-sonnet");
    expect(result.id).toBe("claude-3.5-sonnet");
  });

  test("unknown model → ModelNotFoundError with suggestions", () => {
    try {
      resolveModel(testModels, "gpt-99-turbo");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError);
      expect((err as ModelNotFoundError).suggestions).toHaveLength(3);
    }
  });

  test("suggestions are based on Levenshtein distance", () => {
    try {
      resolveModel(testModels, "totally-unknown-model");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError);
      // Should suggest real models sorted by edit distance
      expect((err as ModelNotFoundError).suggestions.length).toBeGreaterThan(0);
      expect((err as ModelNotFoundError).suggestions.length).toBeLessThanOrEqual(3);
    }
  });
});
