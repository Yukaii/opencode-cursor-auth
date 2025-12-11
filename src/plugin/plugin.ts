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
import { createAgentServiceClient, AgentMode, type OpenAIToolDefinition, type ExecRequest, type AgentStreamChunk } from "../lib/api/agent-service";
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

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

interface OpenAIStreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: OpenAIStreamToolCallDelta[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
}

function generateId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Convert OpenAI messages array to a prompt string for Cursor.
 * Handles the full message history including:
 * - system messages (prepended)
 * - user messages
 * - assistant messages (including those with tool_calls)
 * - tool result messages (role: "tool")
 */
function messagesToPrompt(messages: OpenAIMessage[]): string {
  const parts: string[] = [];
  
  // Extract system messages to prepend
  const systemMessages = messages.filter(m => m.role === "system");
  if (systemMessages.length > 0) {
    parts.push(systemMessages.map(m => m.content ?? "").join("\n"));
  }
  
  // Process non-system messages in order
  const conversationMessages = messages.filter(m => m.role !== "system");
  
  // Check if this is a continuation with tool results
  const hasToolResults = conversationMessages.some(m => m.role === "tool");
  
  // Format the full conversation history
  for (const msg of conversationMessages) {
    if (msg.role === "user") {
      parts.push(`User: ${msg.content ?? ""}`);
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant made tool calls - show what was called
        const toolCallsDesc = msg.tool_calls.map(tc => 
          `[Called tool: ${tc.function.name}(${tc.function.arguments})]`
        ).join("\n");
        if (msg.content) {
          parts.push(`Assistant: ${msg.content}\n${toolCallsDesc}`);
        } else {
          parts.push(`Assistant: ${toolCallsDesc}`);
        }
      } else if (msg.content) {
        parts.push(`Assistant: ${msg.content}`);
      }
    } else if (msg.role === "tool") {
      // Tool result - show the result with the tool call ID for context
      parts.push(`[Tool result for ${msg.tool_call_id}]: ${msg.content ?? ""}`);
    }
  }
  
  // Add instruction for the model to continue if there are tool results
  if (hasToolResults) {
    parts.push("\nBased on the tool results above, please continue your response:");
  }
  
  return parts.join("\n\n");
}

/**
 * Map exec request to OpenAI tool call format
 */
function mapExecRequestToTool(execReq: ExecRequest): {
  toolName: string | null;
  toolArgs: Record<string, any> | null;
} {
  if (execReq.type === "shell") {
    const toolArgs: Record<string, any> = { command: execReq.command };
    if (execReq.cwd) toolArgs.cwd = execReq.cwd;
    return { toolName: "bash", toolArgs };
  }
  if (execReq.type === "read") {
    return { toolName: "read", toolArgs: { filePath: execReq.path } };
  }
  if (execReq.type === "ls") {
    return { toolName: "list", toolArgs: { path: execReq.path } };
  }
  if (execReq.type === "grep") {
    const toolName = execReq.glob ? "glob" : "grep";
    const toolArgs = execReq.glob
      ? { pattern: execReq.glob, path: execReq.path }
      : { pattern: execReq.pattern, path: execReq.path };
    return { toolName, toolArgs };
  }
  if (execReq.type === "mcp") {
    return { toolName: execReq.toolName, toolArgs: execReq.args };
  }
  if (execReq.type === "write") {
    return { toolName: "write", toolArgs: { filePath: execReq.path, content: execReq.fileText } };
  }
  return { toolName: null, toolArgs: null };
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
  const tools = body.tools as OpenAIToolDefinition[] | undefined;
  
  // Always pass tools to Cursor - let the model decide when to use them
  // The model should be smart enough to not re-call tools unnecessarily
  // Stripping tools prevents multi-step flows (read -> write)
  const toolsToPass = tools;
  const toolsProvided = toolsToPass && toolsToPass.length > 0;
  
  // Log tool call status for debugging
  const toolCallCount = (body.messages as OpenAIMessage[])
    .filter(m => m.role === "assistant" && m.tool_calls)
    .reduce((acc, m) => acc + (m.tool_calls?.length ?? 0), 0);
  const toolResultCount = (body.messages as OpenAIMessage[])
    .filter(m => m.role === "tool").length;
  
  if (toolCallCount > 0) {
    console.log(`[Cursor Proxy] ${toolResultCount}/${toolCallCount} tool calls have results, passing ${toolsToPass?.length ?? 0} tools`);
  }

  const client = createAgentServiceClient(currentAccessToken);
  const completionId = generateId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    const encoder = new TextEncoder();
    let isClosed = false;
    let mcpToolCallIndex = 0;
    let pendingEditToolCall: string | null = null; // Track if we're in an edit/apply_diff flow

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

          // Stream content - pass tools to agent service (unless we have tool results)
          for await (const chunk of client.chatStream({ message: prompt, model, mode: AgentMode.AGENT, tools: toolsToPass })) {
            if (isClosed) break;

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
            } else if (chunk.type === "tool_call_started" && chunk.toolCall) {
              // Track file-modifying tool calls - they may require an internal read first
              if (chunk.toolCall.name === "edit" || chunk.toolCall.name === "apply_diff") {
                pendingEditToolCall = chunk.toolCall.callId;
                console.log(`[Cursor Proxy] File-modifying tool started (${chunk.toolCall.name}), will handle internal read locally`);
              }
            } else if (chunk.type === "exec_request" && chunk.execRequest) {
              const execReq = chunk.execRequest;
              
              // Skip context requests - these are internal to Cursor
              if (execReq.type === "request_context") {
                continue;
              }
              
              // Skip reads that are part of an edit/apply_diff flow - Cursor internally reads before editing
              // We handle these locally and let the actual write come through
              if (execReq.type === "read" && pendingEditToolCall) {
                console.log(`[Cursor Proxy] Handling internal read for edit flow locally`);
                try {
                  const file = Bun.file(execReq.path);
                  const content = await file.text();
                  const stats = await file.stat();
                  const totalLines = content.split("\n").length;
                  await client.sendReadResult(execReq.id, execReq.execId, content, execReq.path, totalLines, BigInt(stats.size), false);
                  console.log(`[Cursor Proxy] Internal read completed for edit flow`);
                } catch (err: any) {
                  await client.sendReadResult(execReq.id, execReq.execId, `Error: ${err.message}`, execReq.path, 0, 0n, false);
                }
                continue;
              }
              
              // When tools are provided by OpenCode, emit ALL exec requests as OpenAI tool_calls
              // This includes both MCP tools AND built-in tools (shell, read, write, ls, grep)
              // OpenCode will execute them and send a new request with full history + tool result
              // This "fresh session" approach avoids the KV blob issue with same-session continuation
              if (toolsProvided) {
                const { toolName, toolArgs } = mapExecRequestToTool(execReq);
                if (toolName && toolArgs) {
                  const currentIndex = mcpToolCallIndex++;
                  // Generate unique tool call ID using completion ID + index
                  // completionId format is "chatcmpl-{uuid}", so skip the "chatcmpl-" prefix (9 chars)
                  // This ensures unique IDs across different requests
                  const openaiToolCallId = `call_${completionId.slice(9, 17)}_${currentIndex}`;

                  console.log(`[Cursor Proxy] Emitting tool call: ${toolName} (type: ${execReq.type})`);

                  // Emit the tool call
                  controller.enqueue(encoder.encode(createSSEChunk({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: currentIndex,
                          id: openaiToolCallId,
                          type: "function",
                          function: {
                            name: toolName,
                            arguments: JSON.stringify(toolArgs),
                          },
                        }],
                      },
                      finish_reason: null,
                    }],
                  })));

                  // Emit finish with tool_calls reason
                  controller.enqueue(encoder.encode(createSSEChunk({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                  })));

                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  isClosed = true;
                  controller.close();
                  return;
                }
              }
              
              // If no tools provided, execute built-in tools internally (fallback for non-OpenCode clients)
              if (!toolsProvided && execReq.type !== "mcp") {
                console.log(`[Cursor Proxy] Executing built-in tool internally (no tools provided): ${execReq.type}`);
                if (execReq.type === "shell") {
                  const cwd = execReq.cwd || process.cwd();
                  const startTime = Date.now();
                  try {
                    const proc = Bun.spawn(["sh", "-c", execReq.command], { cwd, stdout: "pipe", stderr: "pipe" });
                    const stdout = await new Response(proc.stdout).text();
                    const stderr = await new Response(proc.stderr).text();
                    const exitCode = await proc.exited;
                    const executionTimeMs = Date.now() - startTime;
                    await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, stdout, stderr, exitCode, executionTimeMs);
                  } catch (err: any) {
                    const executionTimeMs = Date.now() - startTime;
                    await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, "", `Error: ${err.message}`, 1, executionTimeMs);
                  }
                } else if (execReq.type === "read") {
                  try {
                    const file = Bun.file(execReq.path);
                    const content = await file.text();
                    const stats = await file.stat();
                    const totalLines = content.split("\n").length;
                    await client.sendReadResult(execReq.id, execReq.execId, content, execReq.path, totalLines, BigInt(stats.size), false);
                  } catch (err: any) {
                    await client.sendReadResult(execReq.id, execReq.execId, `Error: ${err.message}`, execReq.path, 0, 0n, false);
                  }
                } else if (execReq.type === "ls") {
                  try {
                    const { readdir } = await import("node:fs/promises");
                    const entries = await readdir(execReq.path, { withFileTypes: true });
                    const files = entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name).join("\n");
                    await client.sendLsResult(execReq.id, execReq.execId, files);
                  } catch (err: any) {
                    await client.sendLsResult(execReq.id, execReq.execId, `Error: ${err.message}`);
                  }
                } else if (execReq.type === "grep") {
                  try {
                    let files: string[] = [];
                    if (execReq.glob) {
                      const globber = new Bun.Glob(execReq.glob);
                      files = Array.from(globber.scanSync(execReq.path || process.cwd()));
                    } else if (execReq.pattern) {
                      const rg = Bun.spawn(["rg", "-l", execReq.pattern, execReq.path || process.cwd()], { stdout: "pipe", stderr: "pipe" });
                      const stdout = await new Response(rg.stdout).text();
                      files = stdout.split("\n").filter((f) => f.length > 0);
                    }
                    await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || execReq.glob || "", execReq.path || process.cwd(), files);
                  } catch (err: any) {
                    await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || execReq.glob || "", execReq.path || process.cwd(), []);
                  }
                } else if (execReq.type === "write") {
                  try {
                    const { dirname } = await import("node:path");
                    const { mkdir } = await import("node:fs/promises");
                    const dir = dirname(execReq.path);
                    await mkdir(dir, { recursive: true });
                    
                    const content = execReq.fileBytes && execReq.fileBytes.length > 0 
                      ? execReq.fileBytes 
                      : execReq.fileText;
                    await Bun.write(execReq.path, content);
                    
                    const file = Bun.file(execReq.path);
                    const stats = await file.stat();
                    const linesCreated = typeof content === 'string' 
                      ? content.split("\n").length 
                      : new TextDecoder().decode(content).split("\n").length;
                    
                    await client.sendWriteResult(execReq.id, execReq.execId, {
                      success: {
                        path: execReq.path,
                        linesCreated,
                        fileSize: Number(stats.size),
                        fileContentAfterWrite: execReq.returnFileContentAfterWrite ? await file.text() : undefined
                      }
                    });
                  } catch (err: any) {
                    await client.sendWriteResult(execReq.id, execReq.execId, { 
                      error: { path: execReq.path, error: err.message } 
                    });
                  }
                }
              }
            } else if (chunk.type === "tool_call_started" && chunk.toolCall) {
              // tool_call_started is just a notification - actual tool handling happens via exec_request
              // Log for debugging purposes
              const tc = chunk.toolCall;
              console.log(`[Cursor Proxy] Tool call started: ${tc.name} (type: ${tc.toolType})`);
            } else if (chunk.type === "error") {
              controller.enqueue(encoder.encode(createSSEChunk({
                error: { message: chunk.error ?? "Unknown error", type: "server_error" },
              })));
              break;
            } else if (chunk.type === "done") {
              break;
            }
            // Ignore heartbeat, checkpoint, tool_call_completed, etc.
          }

          // Send final chunk
          if (!isClosed) {
            controller.enqueue(encoder.encode(createSSEChunk({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })));

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        } catch (err: any) {
          if (!isClosed) {
            try {
              controller.error(err);
            } catch {
              // Controller may already be closed
            }
          }
        }
      },
      cancel() {
        isClosed = true;
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
      const content = await client.chat({ message: prompt, model, mode: AgentMode.AGENT, tools });

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
        authorize: async (_inputs?: Record<string, string>) => {
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
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
});

// Alias for compatibility
export const CursorCLIOAuthPlugin = CursorOAuthPlugin;
