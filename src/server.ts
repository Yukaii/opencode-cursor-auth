/**
 * OpenAI-Compatible API Server
 * 
 * Routes OpenAI API requests through Cursor's Agent API backend.
 * Supports:
 * - POST /v1/chat/completions (streaming and non-streaming)
 * - GET /v1/models
 * 
 * Usage:
 *   CURSOR_ACCESS_TOKEN=<token> bun run src/server.ts
 *   
 * Or with auto-loaded credentials:
 *   bun run src/server.ts
 */

import { createAgentServiceClient, AgentMode, type OpenAIToolDefinition, type ExecRequest, type McpExecRequest, type AgentStreamChunk } from "./lib/api/agent-service";
import { FileCredentialManager } from "./lib/storage";

// --- Constants ---

const API_BASE = "https://api2.cursor.sh";

// --- Types ---

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// --- Session Management for Cursor stream reuse ---
interface CursorSession {
  id: string;
  client: ReturnType<typeof createAgentServiceClient>;
  iterator: AsyncGenerator<AgentStreamChunk>;
  pendingExecs: Map<string, ExecRequest>;
  createdAt: number;
  lastActivity: number;
  model: string;
}

const cursorSessions = new Map<string, CursorSession>();
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes idle timeout

function createSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function makeToolCallId(sessionId: string, callBase: string): string {
  return `sess_${sessionId}__call_${callBase}`;
}

function parseSessionIdFromToolCallId(toolCallId: string | null | undefined): string | null {
  if (!toolCallId) return null;
  const match = toolCallId.match(/^sess_([a-zA-Z0-9]+)__call_/);
  if (!match) return null;
  return match[1] ?? null;
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
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

interface ToolResultRequestBody {
  tool_call_id: string;
  content?: string;
  is_error?: boolean;
  error?: string;
}

interface OpenAIChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
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

interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface OpenAIModelsResponse {
  object: "list";
  data: OpenAIModel[];
}

// --- Model Details (from Cursor API) ---

interface CursorModelDetails {
  modelId: string;
  displayModelId: string;
  displayName: string;
  displayNameShort: string;
  aliases: string[];
  maxMode?: boolean;
}

// Cache for fetched models
let cachedModels: CursorModelDetails[] | null = null;
let modelsCacheTime = 0;
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Pending tool results keyed by OpenAI tool_call_id
interface PendingToolResult {
  execRequest: ExecRequest;  // Can be any exec request type now
  client: ReturnType<typeof createAgentServiceClient>;
  resolve?: (result: { content?: string; error?: string }) => void;
}
const pendingToolResults = new Map<string, PendingToolResult>();

// --- Proto Parsing Helpers ---

function decodeVarint(bytes: Uint8Array, offset: number): { value: number; newOffset: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  
  while (pos < bytes.length) {
    const byte = bytes[pos]!;
    value |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  
  return { value, newOffset: pos };
}

function decodeString(bytes: Uint8Array, offset: number): { value: string; newOffset: number } {
  const { value: length, newOffset: dataStart } = decodeVarint(bytes, offset);
  const value = new TextDecoder().decode(bytes.slice(dataStart, dataStart + length));
  return { value, newOffset: dataStart + length };
}

function parseModelDetails(bytes: Uint8Array, start: number, end: number): CursorModelDetails {
  const model: CursorModelDetails = {
    modelId: "",
    displayModelId: "",
    displayName: "",
    displayNameShort: "",
    aliases: [],
  };
  
  let pos = start;
  while (pos < end) {
    const { value: tag, newOffset: afterTag } = decodeVarint(bytes, pos);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    pos = afterTag;
    
    if (wireType === 2) { // Length-delimited
      const { value: str, newOffset } = decodeString(bytes, pos);
      pos = newOffset;
      
      switch (fieldNumber) {
        case 1: model.modelId = str; break;
        case 3: model.displayModelId = str; break;
        case 4: model.displayName = str; break;
        case 5: model.displayNameShort = str; break;
        case 6: model.aliases.push(str); break;
      }
    } else if (wireType === 0) { // Varint
      const { value, newOffset } = decodeVarint(bytes, pos);
      pos = newOffset;
      
      if (fieldNumber === 7) {
        model.maxMode = value === 1;
      }
    }
  }
  
  return model;
}

function parseGetUsableModelsResponse(bytes: Uint8Array): CursorModelDetails[] {
  const models: CursorModelDetails[] = [];
  let pos = 0;
  
  while (pos < bytes.length) {
    const { value: tag, newOffset: afterTag } = decodeVarint(bytes, pos);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    pos = afterTag;
    
    if (fieldNumber === 1 && wireType === 2) {
      const { value: length, newOffset: dataStart } = decodeVarint(bytes, pos);
      const model = parseModelDetails(bytes, dataStart, dataStart + length);
      models.push(model);
      pos = dataStart + length;
    } else if (wireType === 2) {
      const { value: length, newOffset } = decodeVarint(bytes, pos);
      pos = newOffset + length;
    } else if (wireType === 0) {
      const { newOffset } = decodeVarint(bytes, pos);
      pos = newOffset;
    }
  }
  
  return models;
}

// --- Model Fetching ---

async function fetchUsableModels(accessToken: string): Promise<CursorModelDetails[]> {
  // Check cache
  if (cachedModels && Date.now() - modelsCacheTime < MODEL_CACHE_TTL) {
    return cachedModels;
  }
  
  // GetUsableModelsRequest is empty
  const requestBody = new Uint8Array([]);
  
  // Add gRPC-Web frame
  const framedBody = new Uint8Array(5 + requestBody.length);
  framedBody[0] = 0; // compression flag
  const len = requestBody.length;
  framedBody[1] = (len >> 24) & 0xff;
  framedBody[2] = (len >> 16) & 0xff;
  framedBody[3] = (len >> 8) & 0xff;
  framedBody[4] = len & 0xff;
  framedBody.set(requestBody, 5);
  
  const url = `${API_BASE}/aiserver.v1.AiService/GetUsableModels`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "Authorization": `Bearer ${accessToken}`,
      "x-cursor-client-version": "cli-2025.11.25-d5b3271",
      "x-ghost-mode": "false",
      "x-request-id": crypto.randomUUID(),
    },
    body: framedBody,
  });
  
  if (!response.ok) {
    throw new Error(`GetUsableModels failed: ${response.status}`);
  }
  
  const responseBuffer = await response.arrayBuffer();
  const responseBytes = new Uint8Array(responseBuffer);
  
  if (responseBytes.length < 5) {
    throw new Error("Response too short");
  }
  
  const compressionFlag = responseBytes[0];
  const messageLength = (responseBytes[1]! << 24) | (responseBytes[2]! << 16) | (responseBytes[3]! << 8) | responseBytes[4]!;
  
  if (compressionFlag !== 0) {
    throw new Error("Compressed responses not supported");
  }
  
  const messageData = responseBytes.slice(5, 5 + messageLength);
  const models = parseGetUsableModelsResponse(messageData);
  
  // Update cache
  cachedModels = models;
  modelsCacheTime = Date.now();
  
  return models;
}

function cursorModelToOpenAI(model: CursorModelDetails): OpenAIModel {
  // Determine owner based on model name
  let owned_by = "cursor";
  const lowerName = model.displayName.toLowerCase();
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
    id: model.displayModelId || model.modelId,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by,
  };
}

function resolveModel(requestedModel: string, models: CursorModelDetails[]): string {
  // First, check direct match on displayModelId or modelId
  const directMatch = models.find(m => 
    m.displayModelId === requestedModel || 
    m.modelId === requestedModel
  );
  if (directMatch) {
    return directMatch.modelId;
  }
  
  // Check aliases
  const aliasMatch = models.find(m => m.aliases.includes(requestedModel));
  if (aliasMatch) {
    return aliasMatch.modelId;
  }
  
  // No match found, use as-is (let Cursor API handle it)
  return requestedModel;
}

// --- Helpers ---

function generateId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Convert OpenAI messages array to a prompt string for Cursor.
 * Handles the full message history including:
 * - system messages (prepended)
 * - user messages
 * - assistant messages (including those with tool_calls)
 * - tool result messages (role: "tool")
 * 
 * For multi-turn conversations with tool calls, this formats the conversation
 * so the model can see what tools were called and their results.
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
  
  if (hasToolResults) {
    // Multi-turn with tool results - format the full conversation
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
    
    // Add instruction for the model to continue
    parts.push("\nBased on the tool results above, please continue your response:");
  } else {
    // Simple case - just use the last user message (original behavior)
    const userMessages = conversationMessages.filter(m => m.role === "user");
    if (userMessages.length > 0) {
      const lastUserMsg = userMessages[userMessages.length - 1];
      parts.push(lastUserMsg?.content ?? "");
    }
  }
  
  return parts.join("\n\n");
}

function createErrorResponse(message: string, type: string = "invalid_request_error", status: number = 400): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code: null,
      },
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

// --- SSE Streaming ---

function createSSEChunk(chunk: OpenAIStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function createSSEDone(): string {
  return "data: [DONE]\n\n";
}

// --- Server ---

async function getAccessToken(): Promise<string> {
  // First check environment variable
  const envToken = process.env.CURSOR_ACCESS_TOKEN;
  if (envToken) {
    return envToken;
  }
  
  // Fall back to credential manager
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) {
    throw new Error("No access token found. Set CURSOR_ACCESS_TOKEN or authenticate first.");
  }
  return token;
}

async function handleChatCompletions(req: Request, accessToken: string): Promise<Response> {
  let body: OpenAIChatRequest;
  
  try {
    body = await req.json() as OpenAIChatRequest;
  } catch {
    return createErrorResponse("Invalid JSON body");
  }
  
  // Validate required fields
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return createErrorResponse("messages is required and must be a non-empty array");
  }
  
  // Fetch available models and resolve the requested model
  let model: string;
  try {
    const models = await fetchUsableModels(accessToken);
    model = resolveModel(body.model ?? "auto", models);
  } catch (err) {
    // If model fetching fails, use the requested model as-is
    console.warn("Failed to fetch models, using requested model directly:", err);
    model = body.model ?? "default";
  }
  
  const prompt = messagesToPrompt(body.messages);
  const stream = body.stream ?? false;
  
  const client = createAgentServiceClient(accessToken);
  const completionId = generateId();
  const created = Math.floor(Date.now() / 1000);
  
  if (stream) {
    // Streaming response
    const encoder = new TextEncoder();
    let isClosed = false;
    let hasToolCalls = false;
    let toolCallIndex = 0; // For internal Cursor tool calls (built-in)
    let mcpToolCallIndex = 0; // Separate counter for MCP tool calls emitted to OpenAI
    const toolCallIdMap: Map<string, number> = new Map(); // Map Cursor call IDs to OpenAI indices
    let toolExecutionCompleted = false;  // Track if we've completed tool execution
    let heartbeatCountAfterExec = 0;     // Count heartbeats after tool execution
    
    const readable = new ReadableStream({
      async start(controller) {
        try {
          // Send initial chunk with role
          const initialChunk: OpenAIStreamChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: body.model ?? "gpt-4o",
            choices: [{
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            }],
          };
          controller.enqueue(encoder.encode(createSSEChunk(initialChunk)));
          
          // Stream content
          const tools = body.tools as OpenAIToolDefinition[] | undefined;
          for await (const chunk of client.chatStream({ message: prompt, model, mode: AgentMode.AGENT, tools })) {
            if (isClosed) break;
            
            if (chunk.type === "text" || chunk.type === "token") {
              if (chunk.content) {
                const streamChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: { content: chunk.content },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(streamChunk)));
              }
            } else if (chunk.type === "tool_call_started" && chunk.toolCall) {
              // Tool call started - we handle these internally via exec_requests
              // Don't emit to OpenAI client since we execute them locally
              console.log(`[DEBUG] Tool call started: ${chunk.toolCall.name} (handled internally)`);
              toolCallIdMap.set(chunk.toolCall.callId, toolCallIndex++);
            } else if (chunk.type === "partial_tool_call" && chunk.toolCall && chunk.partialArgs) {
              // Partial tool call arguments - ignore since we handle via exec_requests
              // Just log for debugging
              console.log(`[DEBUG] Partial tool call for: ${chunk.toolCall.callId}`);
            } else if (chunk.type === "tool_call_completed" && chunk.toolCall) {
              // Tool call completed - we'll get the actual execution via exec_request
              console.log(`[DEBUG] Tool call completed: ${chunk.toolCall.name}`);
            } else if (chunk.type === "exec_request" && chunk.execRequest) {
              // Server is requesting tool execution
              const execReq = chunk.execRequest;
              
              console.log("[DEBUG] Received exec_request:", {
                type: execReq.type,
                id: execReq.id,
              });
              
              // If client provided tools, emit ALL exec_requests as tool_calls for client to execute
              // This is the OpenAI-compatible mode
              const clientProvidedTools = tools && tools.length > 0;
              
              if (clientProvidedTools && execReq.type !== 'request_context') {
                // Convert built-in exec_request to OpenAI tool_call format
                hasToolCalls = true;
                const currentIndex = mcpToolCallIndex++;
                
                // Determine tool name and arguments based on exec type
                let toolName: string;
                let toolArgs: Record<string, any>;
                
                if (execReq.type === 'shell') {
                  toolName = 'bash';
                  toolArgs = { command: execReq.command };
                  if (execReq.cwd) toolArgs.cwd = execReq.cwd;
                } else if (execReq.type === 'read') {
                  toolName = 'read';
                  toolArgs = { filePath: execReq.path };
                } else if (execReq.type === 'ls') {
                  toolName = 'list';
                  toolArgs = { path: execReq.path };
                } else if (execReq.type === 'grep') {
                  toolName = execReq.glob ? 'glob' : 'grep';
                  toolArgs = execReq.glob 
                    ? { pattern: execReq.glob, path: execReq.path }
                    : { pattern: execReq.pattern, path: execReq.path };
                } else if (execReq.type === 'mcp') {
                  toolName = execReq.toolName;
                  toolArgs = execReq.args;
                } else {
                  // Unknown type - skip
                  console.log(`[DEBUG] Unknown exec type ${(execReq as any).type}, skipping`);
                  continue;
                }
                
                console.log(`[DEBUG] Emitting tool_call to client: ${toolName}(${JSON.stringify(toolArgs)})`);
                
                // Generate OpenAI-style tool call ID
                const callIdBase = execReq.type === 'mcp' ? execReq.toolCallId : execReq.execId || String(execReq.id);
                const openaiToolCallId = `call_${callIdBase.replace(/-/g, "").slice(0, 24)}`;
                
                // Send tool call chunk to OpenAI client
                const toolCallChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
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
                };
                controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));
                
                // End the OpenAI stream with tool_calls finish reason
                const toolCallsFinishChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "tool_calls",
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(toolCallsFinishChunk)));
                controller.enqueue(encoder.encode(createSSEDone()));
                
                // Close the OpenAI stream immediately - client (OpenCode) can now proceed
                // The client will execute the tool and send results in a NEW request with
                // role: "tool" messages. We don't need to wait here - the new request will
                // create a fresh conversation with Cursor including the tool results.
                isClosed = true;
                controller.close();
                
                console.log("[DEBUG] OpenAI stream closed. Client will send tool results in new request.");
                return; // Exit the stream handler - we're done with this request
                
              } else if (execReq.type === 'shell') {
                // Execute shell command locally
                console.log(`[DEBUG] Executing shell command: ${execReq.command}`);
                const startTime = Date.now();
                const cwd = execReq.cwd || process.cwd();
                try {
                  const proc = Bun.spawn(['sh', '-c', execReq.command], {
                    cwd,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  });
                  const stdout = await new Response(proc.stdout).text();
                  const stderr = await new Response(proc.stderr).text();
                  const exitCode = await proc.exited;
                  const executionTimeMs = Date.now() - startTime;
                  console.log(`[DEBUG] Shell result (exit=${exitCode}): ${(stdout + stderr).slice(0, 200)}`);
                  
                  await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, stdout, stderr, exitCode, executionTimeMs);
                  console.log("[DEBUG] Sent shell result");
                  toolExecutionCompleted = true;
                } catch (err: any) {
                  console.error("[ERROR] Shell execution failed:", err.message);
                  const executionTimeMs = Date.now() - startTime;
                  await client.sendShellResult(execReq.id, execReq.execId, execReq.command, cwd, "", `Error: ${err.message}`, 1, executionTimeMs);
                  toolExecutionCompleted = true;
                }
              } else if (execReq.type === 'ls') {
                // Execute ls locally
                console.log(`[DEBUG] Executing ls: ${execReq.path}`);
                try {
                  const proc = Bun.spawn(['ls', '-la'], {
                    cwd: execReq.path,
                    stdout: 'pipe',
                    stderr: 'pipe',
                  });
                  const output = await new Response(proc.stdout).text();
                  await proc.exited;
                  console.log(`[DEBUG] LS result: ${output.slice(0, 200)}`);
                  
                  await client.sendLsResult(execReq.id, execReq.execId, output);
                  console.log("[DEBUG] Sent ls result");
                  toolExecutionCompleted = true;
                } catch (err: any) {
                  console.error("[ERROR] LS execution failed:", err.message);
                  await client.sendLsResult(execReq.id, execReq.execId, `Error: ${err.message}`);
                  toolExecutionCompleted = true;
                }
              } else if (execReq.type === 'request_context') {
                // Send request context (workspace info)
                console.log("[DEBUG] Sending request context");
                try {
                  await client.sendRequestContextResult(execReq.id, execReq.execId);
                  console.log("[DEBUG] Sent request context result");
                } catch (err: any) {
                  console.error("[ERROR] Request context failed:", err.message);
                }
              } else if (execReq.type === 'read') {
                // Read file locally
                console.log(`[DEBUG] Reading file: ${execReq.path}`);
                try {
                  const file = Bun.file(execReq.path);
                  const content = await file.text();
                  const stats = await file.stat();
                  const totalLines = content.split('\n').length;
                  const fileSize = BigInt(stats.size);
                  const truncated = false; // TODO: implement truncation if needed
                  
                  console.log(`[DEBUG] File content (${content.length} chars): ${content.slice(0, 200)}`);
                  
                  await client.sendReadResult(execReq.id, execReq.execId, content, execReq.path, totalLines, fileSize, truncated);
                  console.log("[DEBUG] Sent read result");
                  toolExecutionCompleted = true;
                } catch (err: any) {
                  console.error("[ERROR] File read failed:", err.message);
                  // For errors, we still need to send a proper ReadResult
                  // but with an error case instead of success
                  // For now, send empty content with path - the server might handle this better
                  await client.sendReadResult(execReq.id, execReq.execId, `Error: ${err.message}`, execReq.path, 0, 0n, false);
                  toolExecutionCompleted = true;
                }
              } else if (execReq.type === 'grep') {
                // Handle grep/glob file search locally
                console.log(`[DEBUG] Executing grep/glob: pattern=${execReq.pattern}, path=${execReq.path}, glob=${execReq.glob}`);
                try {
                  const searchPath = execReq.path || process.cwd();
                  let files: string[] = [];
                  
                  if (execReq.glob) {
                    // This is a glob search - find files matching the glob pattern
                    // Use Bun's glob API for proper glob support
                    const glob = new Bun.Glob(execReq.glob);
                    const matches: string[] = [];
                    for await (const file of glob.scan({ cwd: searchPath, onlyFiles: true })) {
                      matches.push(`${searchPath}/${file}`);
                      if (matches.length >= 100) break; // Limit results
                    }
                    files = matches;
                    console.log(`[DEBUG] Glob found ${files.length} files`);
                  } else if (execReq.pattern) {
                    // This is a grep search - find files containing the pattern
                    // Use ripgrep if available, otherwise fall back to grep
                    const rgCmd = `rg -l "${execReq.pattern}" "${searchPath}" 2>/dev/null || grep -rl "${execReq.pattern}" "${searchPath}" 2>/dev/null | head -100`;
                    const proc = Bun.spawn(['sh', '-c', rgCmd], {
                      stdout: 'pipe',
                      stderr: 'pipe',
                    });
                    const output = await new Response(proc.stdout).text();
                    await proc.exited;
                    files = output.trim().split('\n').filter(f => f.length > 0);
                    console.log(`[DEBUG] Grep found ${files.length} files`);
                  }
                  
                  await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || execReq.glob || '', searchPath, files);
                  console.log("[DEBUG] Sent grep result");
                  toolExecutionCompleted = true;
                } catch (err: any) {
                  console.error("[ERROR] Grep execution failed:", err.message);
                  // Send empty result on error
                  await client.sendGrepResult(execReq.id, execReq.execId, execReq.pattern || '', execReq.path || process.cwd(), []);
                  toolExecutionCompleted = true;
                }
              } else if (execReq.type === 'mcp') {
                // MCP tool call when client didn't provide tools
                // This is an edge case - most clients (like OpenCode) provide tools
                // For now, emit as tool_call and close stream
                hasToolCalls = true;
                const currentIndex = mcpToolCallIndex++;
                
                console.log("[DEBUG] MCP tool call (no client tools):", {
                  toolName: execReq.toolName,
                  args: execReq.args,
                });
                
                // Generate OpenAI-style tool call ID
                const openaiToolCallId = `call_${execReq.toolCallId.replace(/-/g, "").slice(0, 24) || execReq.id}`;
                
                // Send tool call chunk to OpenAI client
                const toolCallChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: currentIndex,
                        id: openaiToolCallId,
                        type: "function",
                        function: {
                          name: execReq.toolName,
                          arguments: JSON.stringify(execReq.args),
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(toolCallChunk)));
                
                // End the OpenAI stream with tool_calls finish reason
                const toolCallsFinishChunk: OpenAIStreamChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model ?? "gpt-4o",
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "tool_calls",
                  }],
                };
                controller.enqueue(encoder.encode(createSSEChunk(toolCallsFinishChunk)));
                controller.enqueue(encoder.encode(createSSEDone()));
                
                // Close the OpenAI stream - client will send results in new request
                isClosed = true;
                controller.close();
                
                console.log("[DEBUG] OpenAI stream closed. Client will send MCP tool results in new request.");
                return;
              }
            } else if (chunk.type === "error") {
              // Send error in stream format
              console.error("Cursor API error:", chunk.error);
              const errorChunk = {
                error: {
                  message: chunk.error ?? "Unknown error",
                  type: "server_error",
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
              break;
            } else if (chunk.type === "done") {
              // Stream is ending
              break;
            } else if (chunk.type === "checkpoint") {
              // Checkpoint received - this happens after tool execution
              // We should continue waiting for the model's response after processing tool results
              console.log("[DEBUG] Checkpoint received, continuing to wait for model response...");
              // Don't reset toolExecutionCompleted - we'll use it to track heartbeats
            } else if (chunk.type === "heartbeat") {
              // Heartbeat received - model is still thinking/working
              if (toolExecutionCompleted) {
                heartbeatCountAfterExec++;
                console.log(`[DEBUG] Heartbeat after tool execution: ${heartbeatCountAfterExec}`);
                // After 10 heartbeats post-exec without text, assume the model is done
                // (This is a heuristic - the model should send turn_ended but sometimes doesn't)
                if (heartbeatCountAfterExec >= 10) {
                  console.log("[DEBUG] Ending stream after 10 heartbeats post-exec");
                  break;
                }
              }
            }
          }
          
          if (!isClosed) {
            // Send final chunk with finish_reason
            const finalChunk: OpenAIStreamChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: body.model ?? "gpt-4o",
              choices: [{
                index: 0,
                delta: {},
                finish_reason: hasToolCalls ? "tool_calls" : "stop",
              }],
            };
            controller.enqueue(encoder.encode(createSSEChunk(finalChunk)));
            
            // Send done signal
            controller.enqueue(encoder.encode(createSSEDone()));
            isClosed = true;
            controller.close();
          }
        } catch (err: any) {
          console.error("Stream error:", err);
          if (!isClosed) {
            isClosed = true;
            try {
              controller.error(err);
            } catch {
              // Controller may already be in error state
            }
          }
        }
      },
      cancel() {
        isClosed = true;
      }
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
    // Non-streaming response
    try {
      const tools = body.tools as OpenAIToolDefinition[] | undefined;
      const content = await client.chat({ message: prompt, model, mode: AgentMode.AGENT, tools });
      
      const response: OpenAIChatResponse = {
        id: completionId,
        object: "chat.completion",
        created,
        model: body.model ?? "gpt-4o",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(content.length / 4),
          total_tokens: Math.ceil((prompt.length + content.length) / 4),
        },
      };
      
      return new Response(JSON.stringify(response), {
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

async function handleModels(accessToken: string): Promise<Response> {
  try {
    const models = await fetchUsableModels(accessToken);
    const openaiModels = models.map(cursorModelToOpenAI);
    
    const response: OpenAIModelsResponse = {
      object: "list",
      data: openaiModels,
    };
    
    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return createErrorResponse(err.message ?? "Failed to fetch models", "server_error", 500);
  }
}

async function handleToolResult(req: Request): Promise<Response> {
  let body: ToolResultRequestBody;
  try {
    body = await req.json() as ToolResultRequestBody;
  } catch {
    return createErrorResponse("Invalid JSON body", "invalid_request", 400);
  }

  if (!body.tool_call_id || typeof body.tool_call_id !== "string") {
    return createErrorResponse("tool_call_id is required", "invalid_request", 400);
  }

  const pending = pendingToolResults.get(body.tool_call_id);
  if (!pending) {
    return createErrorResponse("tool_call_id not pending or already resolved", "invalid_request", 404);
  }

  // Remove from pending to avoid duplicate sends
  pendingToolResults.delete(body.tool_call_id);

  // If there's a resolve function, use it (new streaming approach)
  if (pending.resolve) {
    if (body.is_error || body.error) {
      pending.resolve({ error: body.error ?? body.content ?? "Tool returned an error" });
    } else {
      pending.resolve({ content: body.content ?? "" });
    }
    
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Fallback: directly send result to Cursor (old approach)
  // This code path is only used for backward compatibility when resolve function is not set
  const { execRequest, client } = pending;
  try {
    const content = body.content ?? "";
    const isError = body.is_error ?? false;
    
    // Handle different exec request types
    if (execRequest.type === 'mcp') {
      const mcpReq = execRequest as McpExecRequest & { type: 'mcp' };
      if (isError || body.error) {
        await client.sendToolResult(mcpReq, {
          error: body.error ?? content ?? "Tool returned an error",
        });
      } else {
        await client.sendToolResult(mcpReq, {
          success: { content, isError },
        });
      }
    } else if (execRequest.type === 'shell') {
      await client.sendShellResult(execRequest.id, execRequest.execId, execRequest.command, execRequest.cwd || process.cwd(), content, "", isError ? 1 : 0, 0);
    } else if (execRequest.type === 'read') {
      const lines = content.split('\n').length;
      await client.sendReadResult(execRequest.id, execRequest.execId, content, execRequest.path, lines, BigInt(content.length), false);
    } else if (execRequest.type === 'ls') {
      await client.sendLsResult(execRequest.id, execRequest.execId, content);
    } else if (execRequest.type === 'grep') {
      const files = content.trim().split('\n').filter(f => f.length > 0);
      await client.sendGrepResult(execRequest.id, execRequest.execId, execRequest.pattern || '', execRequest.path || process.cwd(), files);
    } else {
      return createErrorResponse(`Unknown exec request type: ${(execRequest as any).type}`, "invalid_request", 400);
    }

    return new Response(JSON.stringify({ status: "ok" }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return createErrorResponse(err.message ?? "Failed to send tool result", "server_error", 500);
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

// --- Main ---

const PORT = parseInt(process.env.PORT ?? "18741", 10);

console.log("Starting OpenAI-compatible API server...");

let accessToken: string;
try {
  accessToken = await getAccessToken();
  console.log("Access token loaded successfully");
} catch (err: any) {
  console.error("Failed to get access token:", err.message);
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120, // 2 minutes to allow for long tool executions
  
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    
    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleCORS();
    }
    
    // Route requests
    if (url.pathname === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, accessToken);
    }
    
    if (url.pathname === "/v1/models" && method === "GET") {
      return handleModels(accessToken);
    }

    if (url.pathname === "/v1/tool_results" && method === "POST") {
      return handleToolResult(req);
    }
    
    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", version: "1.0.0" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    
    // 404 for unknown routes
    return createErrorResponse(`Unknown endpoint: ${method} ${url.pathname}`, "not_found", 404);
  },
});

console.log(`
╔════════════════════════════════════════════════════════════╗
║  OpenAI-Compatible API Server                              ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT.toString().padEnd(24)}║
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/chat/completions  - Chat completions           ║
║    POST /v1/tool_results     - Submit tool results         ║
║    GET  /v1/models            - List available models      ║
║    GET  /health               - Health check               ║
║                                                            ║
║  Usage with curl:                                          ║
║    curl http://localhost:${PORT}/v1/chat/completions \${" ".repeat(Math.max(0, 6 - PORT.toString().length))}║
║      -H "Content-Type: application/json" \                 ║
║      -d '{"model":"gpt-4o","messages":[...]}'              ║
║                                                            ║
║  Usage with OpenAI SDK:                                    ║
║    const openai = new OpenAI({                             ║
║      baseURL: "http://localhost:${PORT}/v1",${" ".repeat(Math.max(0, 20 - PORT.toString().length))}║
║      apiKey: "not-needed"                                  ║
║    });                                                     ║

╚════════════════════════════════════════════════════════════╝
`);
