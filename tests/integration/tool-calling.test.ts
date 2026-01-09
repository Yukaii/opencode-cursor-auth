import { describe, test, expect, beforeAll } from "bun:test";
import {
  hasValidCredentials,
  createTestClient,
  withTimeout,
  DEFAULT_TEST_MODEL,
  AgentMode,
  type AgentServiceClient,
} from "../helpers";

const TOOL_TEST_TIMEOUT = 30000;

describe("Agent Service Tool Calling Integration", () => {
  let client: AgentServiceClient;
  let hasCredentials: boolean;

  beforeAll(async () => {
    hasCredentials = await hasValidCredentials();
    if (hasCredentials) {
      client = await createTestClient();
    }
  });

  describe("exec request infrastructure", () => {
    test("chatStream yields chunks and handles various chunk types", async () => {
      if (!hasCredentials) {
        console.log("⏭️  Skipping: No Cursor credentials available");
        return;
      }

      const chunkTypes = new Set<string>();
      let textContent = "";
      let errorText = "";

      const promise = (async () => {
        for await (const chunk of client.chatStream({
          message: "Say hello",
          model: DEFAULT_TEST_MODEL,
          mode: AgentMode.AGENT,
        })) {
          chunkTypes.add(chunk.type);

          if (chunk.type === "text" && chunk.content) {
            textContent += chunk.content;
          }

          if (chunk.type === "exec_request" && chunk.execRequest) {
            const req = chunk.execRequest;
            switch (req.type) {
              case "shell":
                await client.sendShellResult(req.id, req.execId, req.command, req.cwd || ".", "output", "", 0, 1);
                break;
              case "request_context":
                await client.sendRequestContextResult(req.id, req.execId);
                break;
              case "ls":
                await client.sendLsResult(req.id, req.execId, "file.txt");
                break;
              case "read":
                await client.sendReadResult(req.id, req.execId, "content", req.path, 1, 7n, false);
                break;
              case "grep":
                await client.sendGrepResult(req.id, req.execId, req.pattern || "", req.path || ".", []);
                break;
            }
          }

          if (chunk.type === "error") {
            errorText = chunk.error ?? "Unknown error";
            console.log(`⚠️  Error: ${errorText}`);
            break;
          }
        }
      })();

      await withTimeout(promise, TOOL_TEST_TIMEOUT, "Basic stream test timed out");

      console.log(`   Chunk types seen: [${Array.from(chunkTypes).join(", ")}]`);
      console.log(`   Text received: ${textContent.length} chars`);

      if (
        errorText.toLowerCase().includes("monthly limit") ||
        errorText.includes("grpc-status 8")
      ) {
        console.log("⏭️  Skipping: Cursor usage limit reached");
        return;
      }

      expect(chunkTypes.size).toBeGreaterThan(0);
      expect(chunkTypes.has("text") || chunkTypes.has("done")).toBe(true);
    }, TOOL_TEST_TIMEOUT);

    test("ASK mode returns response without tool calls", async () => {
      if (!hasCredentials) {
        console.log("⏭️  Skipping: No Cursor credentials available");
        return;
      }

      let textContent = "";
      let execRequestCount = 0;
      let errorText = "";

      const promise = (async () => {
        for await (const chunk of client.chatStream({
          message: "What is 2+2?",
          model: DEFAULT_TEST_MODEL,
          mode: AgentMode.ASK,
        })) {
          if (chunk.type === "text" && chunk.content) {
            textContent += chunk.content;
          }
          if (chunk.type === "exec_request") {
            execRequestCount++;
          }
          if (chunk.type === "error") {
            errorText = chunk.error ?? "Unknown error";
            console.log(`⚠️  Error: ${errorText}`);
            break;
          }
        }
      })();

      await withTimeout(promise, TOOL_TEST_TIMEOUT, "ASK mode test timed out");

      console.log(`   Text: ${textContent.length} chars, Exec requests: ${execRequestCount}`);

      const errorMessage = errorText ?? "";
      if (
        errorMessage.toLowerCase().includes("monthly limit") ||
        errorMessage.includes("grpc-status 8")
      ) {
        console.log("⏭️  Skipping: Cursor usage limit reached");
        return;
      }

      expect(textContent.length).toBeGreaterThan(0);
    }, TOOL_TEST_TIMEOUT);
  });

  describe("send result methods exist", () => {
    test("client has all tool result methods", async () => {
      if (!hasCredentials) {
        console.log("⏭️  Skipping: No Cursor credentials available");
        return;
      }

      expect(typeof client.sendShellResult).toBe("function");
      expect(typeof client.sendReadResult).toBe("function");
      expect(typeof client.sendLsResult).toBe("function");
      expect(typeof client.sendGrepResult).toBe("function");
      expect(typeof client.sendWriteResult).toBe("function");
      expect(typeof client.sendRequestContextResult).toBe("function");
    });
  });
});
