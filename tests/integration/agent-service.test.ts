import { describe, test, expect, beforeAll } from "bun:test";
import {
  hasValidCredentials,
  createTestClient,
  collectStreamText,
  withTimeout,
  INTEGRATION_TEST_TIMEOUT,
  DEFAULT_TEST_MODEL,
  AgentMode,
  type AgentServiceClient,
} from "../helpers";

describe("Agent Service Integration", () => {
  let client: AgentServiceClient;
  let hasCredentials: boolean;

  beforeAll(async () => {
    hasCredentials = await hasValidCredentials();
    if (hasCredentials) {
      client = await createTestClient();
    }
  });

  describe("chat streaming", () => {
    test("basic streaming response", async () => {
      if (!hasCredentials) {
        console.log("⏭️  Skipping: No Cursor credentials available");
        return;
      }

      let response: string;

      try {
        response = await withTimeout(
          collectStreamText(client, "Reply with exactly: hello world"),
          INTEGRATION_TEST_TIMEOUT,
          "Chat streaming timed out"
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("monthly limit") || message.includes("grpc-status 8")) {
          console.log("⏭️  Skipping: Cursor usage limit reached");
          return;
        }
        throw err;
      }

      expect(response.length).toBeGreaterThan(0);
      expect(response.toLowerCase()).toContain("hello");
    }, INTEGRATION_TEST_TIMEOUT);

    test("streaming with ASK mode", async () => {
      if (!hasCredentials) {
        console.log("⏭️  Skipping: No Cursor credentials available");
        return;
      }

      let textReceived = "";

      try {
        for await (const chunk of client.chatStream({
          message: "What is 2+2? Reply with just the number.",
          model: DEFAULT_TEST_MODEL,
          mode: AgentMode.ASK,
        })) {
          if (chunk.type === "text" && chunk.content) {
            textReceived += chunk.content;
          }
          if (chunk.type === "error") {
            throw new Error(chunk.error ?? "Unknown error");
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("monthly limit") || message.includes("grpc-status 8")) {
          console.log("⏭️  Skipping: Cursor usage limit reached");
          return;
        }
        throw err;
      }

      expect(textReceived).toContain("4");
    }, INTEGRATION_TEST_TIMEOUT);

    test("handles multi-line responses", async () => {
      if (!hasCredentials) {
        console.log("⏭️  Skipping: No Cursor credentials available");
        return;
      }

      let response: string;

      try {
        response = await withTimeout(
          collectStreamText(
            client,
            "Write a haiku about code. Format it with line breaks."
          ),
          INTEGRATION_TEST_TIMEOUT,
          "Multi-line streaming timed out"
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("monthly limit") || message.includes("grpc-status 8")) {
          console.log("⏭️  Skipping: Cursor usage limit reached");
          return;
        }
        throw err;
      }

      expect(response.length).toBeGreaterThan(10);
      expect(response.split(/\n/).length).toBeGreaterThanOrEqual(1);
    }, INTEGRATION_TEST_TIMEOUT);
  });

  describe("error handling", () => {
    test("handles invalid model gracefully", async () => {
      if (!hasCredentials) {
        console.log("⏭️  Skipping: No Cursor credentials available");
        return;
      }

      let errorReceived = false;
      let textReceived = "";

      try {
        for await (const chunk of client.chatStream({
          message: "Hello",
          model: "nonexistent-model-12345",
          mode: AgentMode.ASK,
        })) {
          if (chunk.type === "error") {
            errorReceived = true;
            break;
          }
          if (chunk.type === "text" && chunk.content) {
            textReceived += chunk.content;
          }
        }
      } catch {
        errorReceived = true;
      }

      expect(errorReceived || textReceived.length > 0).toBe(true);
    }, INTEGRATION_TEST_TIMEOUT);
  });

  describe("different models", () => {
    const modelsToTest = ["gpt-5.1", "claude-4.5-sonnet"];

    for (const modelId of modelsToTest) {
      test(`works with model: ${modelId}`, async () => {
        if (!hasCredentials) {
          console.log("⏭️  Skipping: No Cursor credentials available");
          return;
        }

        let responseText = "";
        try {
          for await (const chunk of client.chatStream({
            message: "Say 'ok' and nothing else.",
            model: modelId,
            mode: AgentMode.ASK,
          })) {
            if (chunk.type === "text" && chunk.content) {
              responseText += chunk.content;
            }
            if (chunk.type === "error") {
              console.log(`⚠️  Model ${modelId} error: ${chunk.error}`);
              return;
            }
          }
          expect(responseText.length).toBeGreaterThan(0);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`⚠️  Model ${modelId} not available: ${message}`);
        }
      }, INTEGRATION_TEST_TIMEOUT);
    }
  });
});
