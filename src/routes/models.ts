import { Hono } from "hono";
import { getModels, getOpenAIModelList, getAnthropicModelList } from "../upstream/models.js";

const models = new Hono();

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
