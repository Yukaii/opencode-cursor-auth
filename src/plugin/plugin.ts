/**
 * OpenCode Cursor Auth Plugin
 *
 * An OpenCode plugin that provides OAuth authentication for Cursor's AI backend,
 * following the architecture established by opencode-gemini-auth.
 *
 * This plugin starts a local OpenAI-compatible server that proxies requests
 * to Cursor's Agent API, enabling OpenCode to use Cursor's models.
 */

import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { platform } from "node:os";

import {
  LoginManager,
  CURSOR_API_BASE_URL,
} from "../lib/auth/login";
import { CursorClient } from "../lib/api/cursor-client";
import { listCursorModels } from "../lib/api/cursor-models";
import { decodeJwtPayload } from "../lib/utils/jwt";
import { refreshAccessToken } from "../lib/auth/helpers";
import { createAgentServiceClient, AgentMode } from "../lib/api/agent-service";
import type {
  PluginContext,
  PluginResult,
  GetAuth,
  Provider,
  LoaderResult,
  OAuthAuthDetails,
  TokenExchangeResult,
  AuthDetails,
} from "./types";

// --- Constants ---

export const CURSOR_PROVIDER_ID = "cursor";

// Server port for the OpenAI-compatible proxy
const CURSOR_PROXY_PORT = 18741; // Random high port unlikely to conflict
const CURSOR_PROXY_BASE_URL = `http://127.0.0.1:${CURSOR_PROXY_PORT}/v1`;

// --- Server State ---

let proxyServer: ReturnType<typeof Bun.serve> | null = null;
let currentAccessToken: string | null = null;

// --- Auth Helpers ---

/**
 * Check if auth details are OAuth type
 */
function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === "oauth";
}

/**
 * Check if access token has expired or is missing
 */
function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== "number") {
    return true;
  }
  // Add 60 second buffer
  return auth.expires <= Date.now() + 60 * 1000;
}

/**
 * Parse stored refresh token parts (format: "refreshToken|apiKey")
 */
function parseRefreshParts(refresh: string): {
  refreshToken: string;
  apiKey?: string;
} {
  const [refreshToken = "", apiKey = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    apiKey: apiKey || undefined,
  };
}

/**
 * Format refresh token parts for storage
 */
function formatRefreshParts(refreshToken: string, apiKey?: string): string {
  return apiKey ? `${refreshToken}|${apiKey}` : refreshToken;
}

/**
 * Refresh an access token using the refresh token
 */
async function refreshCursorAccessToken(
  auth: OAuthAuthDetails,
  client: PluginContext["client"]
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  try {
    const result = await refreshAccessToken(
      parts.refreshToken,
      CURSOR_API_BASE_URL
    );

    if (!result) {
      return undefined;
    }

    const updatedAuth: OAuthAuthDetails = {
      type: "oauth",
      refresh: formatRefreshParts(result.refreshToken, parts.apiKey),
      access: result.accessToken,
      expires: Date.now() + 3600 * 1000, // 1 hour default
    };

    // Try to get actual expiration from token
    const payload = decodeJwtPayload(result.accessToken);
    if (payload?.exp && typeof payload.exp === "number") {
      updatedAuth.expires = payload.exp * 1000;
    }

    // Persist the updated auth
    try {
      await client.auth.set({
        path: { id: CURSOR_PROVIDER_ID },
        body: updatedAuth,
      });
    } catch (e) {
      console.error("Failed to persist refreshed Cursor credentials:", e);
    }

    return updatedAuth;
  } catch (error) {
    console.error("Failed to refresh Cursor access token:", error);
    return undefined;
  }
}

// --- OpenAI-Compatible Proxy Server ---

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

function generateId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function messagesToPrompt(messages: OpenAIMessage[]): string {
  const userMessages = messages.filter(m => m.role === "user");
  const systemMessages = messages.filter(m => m.role === "system");

  let prompt = "";

  if (systemMessages.length > 0) {
    prompt += systemMessages.map(m => m.content).join("\n") + "\n\n";
  }

  if (userMessages.length > 0) {
    prompt += userMessages[userMessages.length - 1]?.content ?? "";
  }

  return prompt;
}

function createErrorResponse(message: string, type: string = "invalid_request_error", status: number = 400): Response {
  return new Response(
    JSON.stringify({
      error: { message, type, param: null, code: null },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

function createSSEChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function handleChatCompletions(req: Request): Promise<Response> {
  if (!currentAccessToken) {
    return createErrorResponse("No access token available", "authentication_error", 401);
  }

  let body: OpenAIChatRequest;
  try {
    body = await req.json() as OpenAIChatRequest;
  } catch {
    return createErrorResponse("Invalid JSON body");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return createErrorResponse("messages is required and must be a non-empty array");
  }

  const model = body.model ?? "auto";
  const prompt = messagesToPrompt(body.messages);
  const stream = body.stream ?? false;

  const client = createAgentServiceClient(currentAccessToken);
  const completionId = generateId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        try {
          // Send initial chunk with role
          controller.enqueue(encoder.encode(createSSEChunk({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          })));

          // Stream content
          for await (const chunk of client.chatStream({ message: prompt, model, mode: AgentMode.AGENT })) {
            if (chunk.type === "text" || chunk.type === "token") {
              if (chunk.content) {
                controller.enqueue(encoder.encode(createSSEChunk({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
                })));
              }
            } else if (chunk.type === "error") {
              controller.enqueue(encoder.encode(createSSEChunk({
                error: { message: chunk.error ?? "Unknown error", type: "server_error" },
              })));
              break;
            }
          }

          // Send final chunk
          controller.enqueue(encoder.encode(createSSEChunk({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })));

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err: any) {
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } else {
    try {
      const content = await client.chat({ message: prompt, model, mode: AgentMode.AGENT });

      return new Response(JSON.stringify({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(content.length / 4),
          total_tokens: Math.ceil((prompt.length + content.length) / 4),
        },
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err: any) {
      return createErrorResponse(err.message ?? "Unknown error", "server_error", 500);
    }
  }
}

async function handleModels(): Promise<Response> {
  if (!currentAccessToken) {
    return createErrorResponse("No access token available", "authentication_error", 401);
  }

  try {
    const cursorClient = new CursorClient(currentAccessToken);
    const models = await listCursorModels(cursorClient);

    const openaiModels = models.map(m => {
      let owned_by = "cursor";
      const lowerName = (m.displayName ?? "").toLowerCase();
      if (lowerName.includes("claude") || lowerName.includes("opus") || lowerName.includes("sonnet")) {
        owned_by = "anthropic";
      } else if (lowerName.includes("gpt")) {
        owned_by = "openai";
      } else if (lowerName.includes("gemini")) {
        owned_by = "google";
      } else if (lowerName.includes("grok")) {
        owned_by = "xai";
      }

      return {
        id: m.displayModelId || m.modelId,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by,
      };
    });

    return new Response(JSON.stringify({
      object: "list",
      data: openaiModels,
    }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return createErrorResponse(err.message ?? "Failed to fetch models", "server_error", 500);
  }
}

function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/**
 * Start the OpenAI-compatible proxy server
 */
function startProxyServer(): void {
  if (proxyServer) {
    console.log("[Cursor Plugin] Proxy server already running on port", CURSOR_PROXY_PORT);
    return;
  }

  console.log("[Cursor Plugin] Starting proxy server on port", CURSOR_PROXY_PORT);

  try {
    proxyServer = Bun.serve({
      port: CURSOR_PROXY_PORT,
      async fetch(req) {
        const url = new URL(req.url);
        const method = req.method;

        console.log(`[Cursor Proxy] ${method} ${url.pathname}`);

        if (method === "OPTIONS") {
          return handleCORS();
        }

        if (url.pathname === "/v1/chat/completions" && method === "POST") {
          return handleChatCompletions(req);
        }

        if (url.pathname === "/v1/models" && method === "GET") {
          return handleModels();
        }

        if (url.pathname === "/health" || url.pathname === "/") {
          return new Response(JSON.stringify({ status: "ok", port: CURSOR_PROXY_PORT }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        return createErrorResponse(`Unknown endpoint: ${method} ${url.pathname}`, "not_found", 404);
      },
    });
    console.log("[Cursor Plugin] Proxy server started successfully on port", CURSOR_PROXY_PORT);
  } catch (error) {
    console.error("[Cursor Plugin] Failed to start proxy server:", error);
  }
}

// --- OAuth Flow Helpers ---

/**
 * Open a URL in the default browser
 */
function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command =
      platform() === "darwin"
        ? `open "${url}"`
        : platform() === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;

    exec(command, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// --- Main Plugin ---

/**
 * Cursor OAuth Plugin for OpenCode
 *
 * Provides authentication for Cursor's AI backend using:
 * - Browser-based OAuth flow with PKCE
 * - API key authentication
 * - Automatic token refresh
 * - Local OpenAI-compatible proxy server
 */
export const CursorOAuthPlugin = async ({
  client,
}: PluginContext): Promise<PluginResult> => ({
  auth: {
    provider: CURSOR_PROVIDER_ID,

    loader: async (
      getAuth: GetAuth,
      provider: Provider
    ): Promise<LoaderResult | null> => {
      console.log("[Cursor Plugin] Loader called");
      const auth = await getAuth();

      if (!isOAuthAuth(auth)) {
        console.log("[Cursor Plugin] No OAuth auth found, returning null");
        return null;
      }

      console.log("[Cursor Plugin] OAuth auth found, checking token expiry");

      // Refresh token if needed
      let authRecord = auth;
      if (accessTokenExpired(authRecord)) {
        console.log("[Cursor Plugin] Token expired, refreshing...");
        const refreshed = await refreshCursorAccessToken(authRecord, client);
        if (refreshed) {
          authRecord = refreshed;
          console.log("[Cursor Plugin] Token refreshed successfully");
        } else {
          console.log("[Cursor Plugin] Token refresh failed");
        }
      }

      // Update the current access token for the proxy server
      currentAccessToken = authRecord.access ?? null;
      console.log("[Cursor Plugin] Access token set:", currentAccessToken ? "yes" : "no");

      // Set model costs to 0 (Cursor handles billing)
      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (model) {
            model.cost = { input: 0, output: 0 };
          }
        }
      }

      // Dynamically populate provider models from Cursor API if available.
      if (authRecord.access) {
        try {
          const cursorClient = new CursorClient(authRecord.access);
          const models = await listCursorModels(cursorClient);
          if (models.length > 0) {
            provider.models = provider.models ?? {};
            for (const m of models) {
              // Determine if this is a "thinking" (reasoning) model
              const isThinking =
                m.modelId?.includes("thinking") ||
                m.displayModelId?.includes("thinking") ||
                m.displayName?.toLowerCase().includes("thinking");

              // Build model config
              const modelConfig = {
                name: m.displayName || m.displayNameShort || m.modelId,
                cost: { input: 0, output: 0 },
                temperature: true,
                attachment: true,
                ...(isThinking ? { reasoning: true } : {}),
              };

              // Register model under all its identifiers
              const ids = [
                m.modelId,
                m.displayModelId,
                ...(m.aliases ?? []),
              ].filter((id): id is string => !!id);

              for (const id of ids) {
                // Merge with existing config if present (preserving user overrides)
                provider.models[id] = {
                  ...modelConfig,
                  ...provider.models[id],
                  cost: { input: 0, output: 0 }, // Always force cost to 0
                };
              }
            }
          }
        } catch (error) {
          console.warn(
            "[Cursor OAuth] Failed to list models; continuing with defaults.",
            error
          );
        }
      }

      // Start the proxy server
      startProxyServer();

      console.log("[Cursor Plugin] Returning baseURL:", CURSOR_PROXY_BASE_URL);

      return {
        apiKey: "cursor-via-opencode", // Dummy key, not used
        baseURL: CURSOR_PROXY_BASE_URL,
      };
    },

    methods: [
      {
        label: "OAuth with Cursor",
        type: "oauth",
        authorize: async () => {
          console.log("\n=== Cursor OAuth Setup ===");
          console.log(
            "1. You'll be asked to sign in to your Cursor account."
          );
          console.log(
            "2. After signing in, the authentication will complete automatically."
          );
          console.log(
            "3. Return to this terminal when you see confirmation.\n"
          );

          const loginManager = new LoginManager();
          const { metadata, loginUrl } = loginManager.startLogin();

          return {
            url: loginUrl,
            instructions:
              "Complete the sign-in flow in your browser. We'll automatically detect when you're done.",
            method: "auto",
            callback: async (): Promise<TokenExchangeResult> => {
              try {
                // Open browser
                try {
                  await openBrowser(loginUrl);
                } catch {
                  console.log(
                    "Could not open browser automatically. Please visit the URL above."
                  );
                }

                // Wait for authentication
                const result = await loginManager.waitForResult(metadata, {
                  onProgress: () => process.stdout.write("."),
                });

                if (!result) {
                  return {
                    type: "failed",
                    error: "Authentication timed out or was cancelled",
                  };
                }

                // Get token expiration
                let expires = Date.now() + 3600 * 1000; // 1 hour default
                const payload = decodeJwtPayload(result.accessToken);
                if (payload?.exp && typeof payload.exp === "number") {
                  expires = payload.exp * 1000;
                }

                return {
                  type: "success",
                  refresh: result.refreshToken,
                  access: result.accessToken,
                  expires,
                };
              } catch (error) {
                return {
                  type: "failed",
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                };
              }
            },
          };
        },
      },
      {
        provider: CURSOR_PROVIDER_ID,
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
});

// Alias for compatibility
export const CursorCLIOAuthPlugin = CursorOAuthPlugin;
