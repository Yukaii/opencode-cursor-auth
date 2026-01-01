import { describe, test, expect, beforeAll } from "bun:test";
import {
  hasValidCredentials,
  getAccessToken,
  withTimeout,
  INTEGRATION_TEST_TIMEOUT,
} from "../helpers";
import { listCursorModels, type CursorModelInfo } from "../../src/lib/api/cursor-models";
import { CursorClient } from "../../src/lib/api/cursor-client";

describe("Model Fetching Integration", () => {
  let hasCredentials: boolean;
  let accessToken: string;

  beforeAll(async () => {
    hasCredentials = await hasValidCredentials();
    if (hasCredentials) {
      accessToken = await getAccessToken();
    }
  });

  test("fetches available models from Cursor API", async () => {
    if (!hasCredentials) {
      console.log("⏭️  Skipping: No Cursor credentials available");
      return;
    }

    const cursorClient = new CursorClient(accessToken);
    const models = await withTimeout(
      listCursorModels(cursorClient),
      INTEGRATION_TEST_TIMEOUT,
      "Model fetch timed out"
    );

    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    const firstModel = models[0] as CursorModelInfo;
    expect(firstModel).toHaveProperty("modelId");
    expect(typeof firstModel.modelId).toBe("string");
  }, INTEGRATION_TEST_TIMEOUT);

  test("models have expected properties", async () => {
    if (!hasCredentials) {
      console.log("⏭️  Skipping: No Cursor credentials available");
      return;
    }

    const cursorClient = new CursorClient(accessToken);
    const models = await listCursorModels(cursorClient);

    for (const model of models.slice(0, 5)) {
      expect(model.modelId).toBeTruthy();
      expect(Array.isArray(model.aliases)).toBe(true);
    }
  }, INTEGRATION_TEST_TIMEOUT);

  test("includes common model types", async () => {
    if (!hasCredentials) {
      console.log("⏭️  Skipping: No Cursor credentials available");
      return;
    }

    const cursorClient = new CursorClient(accessToken);
    const models = await listCursorModels(cursorClient);
    const modelIds = models.map((m) => m.modelId);

    const knownModels = ["gpt-4", "gpt-4o", "claude", "sonnet"];
    const hasKnownModel = knownModels.some((known) =>
      modelIds.some((id) => id.toLowerCase().includes(known))
    );

    expect(hasKnownModel).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT);
});
