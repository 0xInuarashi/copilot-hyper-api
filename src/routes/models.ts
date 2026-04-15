import { Hono } from "hono";
import { getModels, getRawModels, getOpenAIModelList, getAnthropicModelList } from "../upstream/models.js";

const models = new Hono();

models.get("/models", async (c) => {
  try {
    const rawModels = await getRawModels();
    const autoEntry = {
      id: "auto",
      name: "auto",
      version: "auto",
      family: "copilot-hyper-api",
      object: "model",
      owned_by: "copilot-hyper-api",
      capabilities: {
        limits: { max_prompt_tokens: 200000, max_output_tokens: 64000 },
        supports: { tool_calls: true, vision: true, streaming: true },
      },
    };
    return c.json({ data: [autoEntry, ...rawModels] });
  } catch (err: any) {
    return c.json(
      { error: { message: err.message, type: "server_error", code: "internal_error" } },
      500,
    );
  }
});

models.get("/v1/models", async (c) => {
  try {
    const modelList = await getModels();
    return c.json(getOpenAIModelList(modelList));
  } catch (err: any) {
    return c.json(
      { error: { message: err.message, type: "server_error", code: "internal_error" } },
      500,
    );
  }
});

models.get("/anthropic/v1/models", async (c) => {
  try {
    const modelList = await getModels();
    return c.json(getAnthropicModelList(modelList));
  } catch (err: any) {
    return c.json(
      { type: "error", error: { type: "api_error", message: err.message } },
      500,
    );
  }
});

export default models;
