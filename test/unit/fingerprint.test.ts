import { describe, test, expect } from "bun:test";
import { orderHeaders, orderBodyFields } from "../../src/upstream/fingerprint.js";

describe("orderHeaders", () => {
  test("reorders known headers to Copilot order", () => {
    const input = {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
      "User-Agent": "GithubCopilot/1.0",
      "Editor-Version": "vscode/1.95.0",
      Accept: "application/json",
    };

    const ordered = orderHeaders(input);
    const keys = Object.keys(ordered);

    // Authorization should come before Content-Type
    expect(keys.indexOf("Authorization")).toBeLessThan(keys.indexOf("Content-Type"));
    // Editor-Version before User-Agent
    expect(keys.indexOf("Editor-Version")).toBeLessThan(keys.indexOf("User-Agent"));
    // User-Agent before Accept
    expect(keys.indexOf("User-Agent")).toBeLessThan(keys.indexOf("Accept"));
  });

  test("preserves all headers (none lost)", () => {
    const input = {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
      "X-Custom": "value",
    };
    const ordered = orderHeaders(input);
    expect(Object.keys(ordered).length).toBe(3);
    expect(ordered["X-Custom"]).toBe("value");
  });

  test("unknown headers appear after known ones", () => {
    const input = {
      "X-Custom": "value",
      Authorization: "Bearer tok",
    };
    const ordered = orderHeaders(input);
    const keys = Object.keys(ordered);
    expect(keys[0]).toBe("Authorization");
    expect(keys[1]).toBe("X-Custom");
  });

  test("case-insensitive matching", () => {
    const input = {
      "content-type": "application/json",
      AUTHORIZATION: "Bearer tok",
    };
    const ordered = orderHeaders(input);
    const keys = Object.keys(ordered);
    // Authorization should come first regardless of case
    expect(keys[0]).toBe("AUTHORIZATION");
  });
});

describe("orderBodyFields", () => {
  test("reorders known fields to Copilot order", () => {
    const input = {
      stream: true,
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    };

    const result = JSON.parse(orderBodyFields(input));
    const keys = Object.keys(result);

    expect(keys[0]).toBe("messages");
    expect(keys[1]).toBe("model");
    expect(keys[2]).toBe("temperature");
    expect(keys[3]).toBe("stream");
  });

  test("preserves all fields", () => {
    const input = {
      custom_field: "value",
      model: "gpt-4",
      messages: [],
    };
    const result = JSON.parse(orderBodyFields(input));
    expect(result.custom_field).toBe("value");
    expect(result.model).toBe("gpt-4");
  });

  test("unknown fields appear after known ones", () => {
    const input = {
      zzz_custom: "last",
      aaa_custom: "also last",
      model: "gpt-4",
    };
    const result = JSON.parse(orderBodyFields(input));
    const keys = Object.keys(result);
    expect(keys[0]).toBe("model");
  });

  test("returns valid JSON string", () => {
    const input = { messages: [], model: "gpt-4", stream: true };
    const str = orderBodyFields(input);
    expect(typeof str).toBe("string");
    const parsed = JSON.parse(str);
    expect(parsed.model).toBe("gpt-4");
  });
});
