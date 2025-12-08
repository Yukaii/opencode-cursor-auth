# Cursor API → OpenAI Compatibility Notes

Summary of how to call the Cursor API and present it as an OpenAI‐style `/v1/chat/completions` endpoint, based on the in‑repo Cursor client (`src/lib/api/cursor-client.ts`) and the restored Cursor CLI sources (`cursor-agent-restored-source-code`).

## What the Cursor API expects
- Endpoint: `POST https://api2.cursor.sh/aiserver.v1.AiService/StreamChat` with `content-type: application/connect+proto` and `connect-protocol-version: 1`.
- Required headers: `authorization: Bearer <access>`, `x-cursor-checksum` (see `generateChecksum`), `x-cursor-client-version`, `x-cursor-client-type`, `x-ghost-mode`, `x-request-id`, `x-cursor-timezone`, `connect-accept-encoding`, `user-agent` (e.g., `connect-es/1.4.0`), `host`. Cursor CLI also sends `x-cursor-streaming: true` for SSE/http1.1 fallback; keep it for safety.
- Body format: Connect envelope `[flags:1][len:4 big-endian][proto payload]`. The payload is a protobuf `ChatMessage`:
  - `messages` (field 2, repeated): user/assistant entries (`role` map: user=1, assistant=2, system=3) with `content` and a `messageId` (field 13).
  - `instructions` (field 4): system prompt string.
  - `projectPath` (field 5): CLI uses `/project`.
  - `model` (field 7): model name.
  - `requestId` (field 9) and `conversationId` (field 15): UUIDs.
- Checksum: `x-cursor-checksum` is derived from the bearer token and a 30‑minute bucketed timestamp (see `generateChecksum`).

## What Cursor responses look like
- Streaming: Connect frames (`[flags][len][payload]`). Error frames have `flags=0x02`; normal frames contain `StreamChatResponse` with `msg` (field 1). `parseStreamChunks` already extracts `delta`, `done`, or `error` and concatenates `msg` strings.
- Non‑streaming: same frames returned in one buffer; concatenate `delta` chunks for the final text.

## Mapping OpenAI → Cursor
- Detect OpenAI chat completions (e.g., `/v1/chat/completions`).
- Convert the OpenAI `messages` array:
  - First system message → `instructions` (field 4).
  - Remaining messages → repeated `messages` (field 2) with role mapping and fresh `messageId`s.
  - Ignore OpenAI tool/function call fields for now; Cursor’s schema in this client is plain text.
- Model: map OpenAI `model` to a Cursor model string (pass through for now).
- Build `ChatRequest` and encode with `encodeChatRequest` → `addConnectEnvelope`.
- Send with Cursor headers (including checksum) via `CursorClient.chat` or `chatStream`.

## Mapping Cursor → OpenAI responses
- Streaming: wrap each `delta` chunk as an SSE `data:` line shaped like:
  - `{"id":"cursor-<uuid>","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."}}]}`
  - Emit a final done event and map `error` chunks to `400/500` with an OpenAI‑style error body.
- Non‑streaming: concatenate all `delta` content into a single `choices[0].message.content`.
- Usage fields: not available from this client path; return empty/zeroed usage to keep compatibility.

## Auth and refresh
- Reuse the OpenCode plugin flow in `src/plugin/plugin.ts`:
  - Loader should refresh when `accessTokenExpired` using `refreshCursorAccessToken`.
  - Inject Cursor headers before fetch; keep `x-cursor-client-version` and `x-cursor-client-type` stable.
  - Store refresh token plus optional API key as `refresh|apiKey` (see `formatRefreshParts`).

## Practical steps to finish the OpenAI wrapper
1) Add an OpenAI request shim (done in `src/lib/api/openai-compat.ts`) that detects `/v1/chat/completions`, maps messages/model to `ChatRequest`, and chooses streaming vs non‑streaming paths. Unsupported `tool_calls/function_call` are rejected with a clear 400 for now. Common model aliases (e.g., `gpt-4`, `gpt-3.5-turbo`) are mapped to Cursor equivalents.
2) Route to `CursorClient.chat`/`chatStream` instead of hitting OpenAI URLs; attach checksum + Cursor headers (done via `CursorClient`).
3) Add a response normalizer that emits OpenAI JSON/SSE shapes from `StreamChunk` output, including proper `id/object/created/model` fields and a final `finish_reason` (done).
4) Wire the loader’s `fetch` override to use the shim when the target URL is OpenAI‑style; otherwise fall back to the original fetch (done in `src/plugin/plugin.ts`).
5) Keep auth refresh logic intact so tokens remain valid mid‑stream; surface errors in OpenAI error format (done via existing refresh path).
6) Next work items: consider tool/function-call translation if needed, and propagate any usage tokens if Cursor starts returning them. Model aliasing is currently static; the Cursor CLI can also fetch model lists via `AiService.GetUsableModels`—we can mirror that later for dynamic population.

## Current status and gaps
- **Models:** We now call `AiService.GetUsableModels` over Connect+JSON to populate `provider.models` with modelId/displayModelId/aliases. Verified live; 17 models returned (composer, auto, sonnet/opus 4.5, gpt-5 variants, etc.).
- **Chat:** All known chat RPCs tested (`StreamChat`, `StreamChatWeb`, `StreamChatContext`, `StreamChatDeepContext`, `TaskStreamChatContext`) return `ERROR_DEPRECATED` (“Request type deprecated. Please upgrade to the latest version of Cursor.”) or similar when called with our hand-rolled payload. Adjusting headers/client-version did not fix this. The backend contract has changed.
- **Protos:** The Cursor agent bundle already includes generated Buf JS protos in `cursor-agent-restored-source-code/proto/dist/generated/aiserver/v1/*` (for example `aiserver_pb.js`, `chat_pb.js`, `aiserver_connect.js`). These exports cover the newer chat shapes (such as `StreamUnifiedChatRequestWithTools`, `StreamUnifiedChatResponse*`) and are imported directly by `cursor-agent-source/index.js`, so the bundle can build the expected payloads without shipping the raw `.proto` files.
- **OpenAI shim impact:** The OpenAI-compatible fetch path is implemented, but our shim still hand-rolls the deprecated `StreamChat` payload. We need to swap it to the generated `StreamUnifiedChat*` requests from the bundled protos for live calls to succeed. Model listing and auth refresh do work.
- **Unified protos reality:** The restored bundle does not actually expose `aiserver_pb` or `StreamUnifiedChat*` types as loadable modules—the webpack module table only includes `chat_pb`, `utils_pb`, and a handful of other services (analytics, background_composer, etc.). The standalone `chat_pb.js` file mutates globals and exports nothing, and the unified classes are absent. Without the real unified proto definitions (or a bundle that contains them), we cannot build the new chat payloads; attempts to load them via shims fall back to legacy `StreamChat`.

## Tool Calling Architecture (Working!)

### Overview

The OpenAI-compatible server now supports **full tool calling** with OpenCode and other OpenAI-compatible clients. This required understanding how Cursor's Agent API handles tool execution differently from OpenAI's API.

### Key Differences: Cursor vs OpenAI

| Aspect | Cursor Agent API | OpenAI API |
|--------|------------------|------------|
| Stream lifecycle | Single persistent stream for entire conversation | New request for each turn |
| Tool execution | Server requests client to execute, waits on same stream | Client receives tool_calls, executes, sends new request with results |
| Built-in tools | `shell`, `read`, `ls`, `grep`, etc. executed via `exec_request` | N/A - all tools are custom |
| Custom tools (MCP) | Sent as `exec_request` with `type: 'mcp'` | Sent as `tool_calls` in response |

### Implementation Strategy

When the client provides `tools` in the request, ALL `exec_request` messages from Cursor are converted to OpenAI `tool_calls` format:

1. **Client sends request** with `tools` array (e.g., `bash`, `read`, `glob`, etc.)
2. **Cursor model calls a tool** → Server receives `exec_request` (could be `type: 'shell'`, `type: 'read'`, `type: 'mcp'`, etc.)
3. **Server emits `tool_calls`** chunk to client with the tool name and arguments
4. **Server emits `finish_reason: "tool_calls"`** and closes the SSE stream
5. **Client executes tool** locally (OpenCode handles this)
6. **Client sends new request** with tool result as a message (`role: "tool"`)
7. **Server formats conversation** with tool results and sends to Cursor
8. **Model continues** generating response

### Tool Name Mapping

Cursor's built-in exec types are mapped to OpenAI tool names:

| Cursor exec_request type | OpenAI tool name | Arguments |
|--------------------------|------------------|-----------|
| `shell` | `bash` | `{ command, cwd? }` |
| `read` | `read` | `{ filePath }` |
| `ls` | `list` | `{ path }` |
| `grep` (with pattern) | `grep` | `{ pattern, path }` |
| `grep` (with glob) | `glob` | `{ pattern, path }` |
| `mcp` | Original tool name | Original args |

### Message History Handling

When the client sends a follow-up request with tool results, `messagesToPrompt()` formats the full conversation:

```
System: <system message>

User: <original query>

Assistant: [Called tool: read({"filePath":"/tmp/x"})]

[Tool result for call_abc123]: <file contents>

Assistant: <continuation after tool>
```

## Session Reuse Strategy (planned)

**Problem:** Cursor’s Agent API keeps a single persistent stream per conversation. Our OpenAI translation currently starts a *new* Cursor session for every turn, paying ~6s bootstrap each time and losing the benefit of Cursor’s stream reuse.

**Goal:** Reuse the same Cursor session across turns (and across tool calls) while still presenting the OpenAI multi-turn pattern. Support multiple parallel OpenCode windows by isolating sessions.

**Plan:**
- **Session ID:** Generate a unique sessionId per incoming OpenAI conversation (e.g., per first request). Encode it into each emitted `tool_call_id` (`call_<sessionId>_<cursorCallId>`).
- **Session store:** Keep `{ client, requestId, appendSeqno }` per sessionId. One Cursor stream per OpenCode window.
- **Tool results routing:** When a follow-up request has `role: "tool"` messages, extract `tool_call_id`, recover `sessionId`, and route the tool result via the existing Cursor stream (`bidiAppend`) instead of starting a new session.
- **Continuation:** After sending tool results to Cursor, continue reading from the existing stream and forward the assistant’s continuation to the OpenAI client.
- **Cleanup:** Idle timeout and explicit completion tear down the session. If a sessionId is unknown, fall back to starting a fresh session.

**Multi-window safety:** Each OpenCode window keeps its own sessionId (embedded in its tool_call_ids), so sessions are isolated and can run in parallel without collision.
