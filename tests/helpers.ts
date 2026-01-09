import { FileCredentialManager } from "../src/lib/storage";
import {
  createAgentServiceClient,
  AgentMode,
  type AgentServiceClient,
} from "../src/lib/api/agent-service";

export const INTEGRATION_TEST_TIMEOUT = 60000;
export const DEFAULT_TEST_MODEL = "default";

export async function hasValidCredentials(): Promise<boolean> {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  return !!token;
}

export async function getAccessToken(): Promise<string> {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) {
    throw new Error(
      "No Cursor access token found. Run `bun run demo:login` to authenticate."
    );
  }
  return token;
}

export async function createTestClient(): Promise<AgentServiceClient> {
  const token = await getAccessToken();
  return createAgentServiceClient(token);
}

export async function skipIfNoCredentials(): Promise<void> {
  if (!(await hasValidCredentials())) {
    console.log("⏭️  Skipping: No Cursor credentials available");
    process.exit(0);
  }
}

export async function collectStreamText(
  client: AgentServiceClient,
  message: string,
  model: string = DEFAULT_TEST_MODEL
): Promise<string> {
  let result = "";
  for await (const chunk of client.chatStream({
    message,
    model,
    mode: AgentMode.ASK,
  })) {
    if (chunk.type === "text" && chunk.content) {
      result += chunk.content;
    }
    if (chunk.type === "error") {
      throw new Error(chunk.error ?? "Unknown streaming error");
    }
  }
  return result;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(message ?? `Test timeout after ${ms}ms`)),
        ms
      )
    ),
  ]);
}

export { AgentMode, type AgentServiceClient } from "../src/lib/api/agent-service";
export { FileCredentialManager } from "../src/lib/storage";
