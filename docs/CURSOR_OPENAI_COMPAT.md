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
1) Add an OpenAI request shim (similar to Gemini’s `prepareGeminiRequest`) that detects `/v1/chat/completions`, maps messages/model to `ChatRequest`, and chooses streaming vs non‑streaming paths.
2) Route to `CursorClient.chat`/`chatStream` instead of hitting OpenAI URLs; attach checksum + Cursor headers.
3) Add a response normalizer that emits OpenAI JSON/SSE shapes from `StreamChunk` output, including proper `id/object/created/model` fields and a final `finish_reason`.
4) Wire the loader’s `fetch` override to use the shim when the target URL is OpenAI‑style; otherwise fall back to the original fetch.
5) Keep auth refresh logic intact so tokens remain valid mid‑stream; surface errors in OpenAI error format.
