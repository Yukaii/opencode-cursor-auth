# Session Reuse Implementation Guide

**Date**: January 1, 2026  
**Status**: In Progress - ResumeAction encoding implemented

## Overview

This document outlines how to implement session reuse for the Cursor proxy, based on analysis of the Cursor CLI source code. Session reuse would allow tool results to be sent back to an existing Cursor session via `BidiAppend` instead of creating a new session for each request.

## Current State

### What Works (Fresh Sessions)
- Each OpenCode request creates a new Cursor session
- Full conversation history is sent in every request
- Tool calls are emitted as OpenAI `tool_calls`, OpenCode executes them locally
- Follow-up requests include tool results in message history
- **Advantage**: Simple, reliable, matches standard OpenAI client behavior

### What Doesn't Work (Session Reuse)
- When tool results are sent via `BidiAppend` to continue a session, Cursor stores the model's response in **KV blobs** instead of streaming
- The stream only emits heartbeats after tool completion
- Text response is stored in blob, `turn_ended` never arrives via stream
- **Root cause**: Missing `ResumeAction` after tool result submission

## Recent Progress (January 2026)

### ResumeAction Discovery

Analysis of `cursor-agent-restored-source-code/agent-client/dist/connect.js` (lines 486-497) revealed that after sending tool results, the Cursor CLI sends a `ConversationAction` with `resumeAction` to signal the server to continue:

```javascript
const resumeActionMessage = new agent_pb.ConversationAction({
  action: {
    case: "resumeAction",
    value: new agent_pb.ResumeAction()
  }
});
```

### Implementation Completed

1. **Unit Tests** (`tests/unit/bidi-encoding.test.ts`):
   - Tests for `encodeBidiRequestId()`
   - Tests for `encodeBidiAppendRequest()`
   - Tests for `encodeResumeAction()`, `encodeConversationActionWithResume()`, `encodeAgentClientMessageWithConversationAction()`

2. **Proto Encoding** (`src/lib/api/proto/agent-messages.ts`):
   - `encodeResumeAction()` - encodes empty ResumeAction message
   - `encodeConversationActionWithResume()` - wraps ResumeAction in ConversationAction field 2
   - `encodeAgentClientMessageWithConversationAction()` - wraps in AgentClientMessage field 4

3. **AgentServiceClient** (`src/lib/api/agent-service.ts`):
   - Added `sendResumeAction()` method to send ResumeAction after tool results

### Proto Structure Reference

```
AgentClientMessage (to server):
  field 1: run_request (AgentRunRequest) - initial request
  field 2: exec_client_message (ExecClientMessage) - tool results
  field 4: conversation_action (ConversationAction) - actions like resume

ConversationAction:
  field 1: user_message_action (UserMessageAction) - for new user messages
  field 2: resume_action (ResumeAction) - signal to continue after tool results

ResumeAction:
  (empty message - presence signals resume)
```

### Expected Wire Format

For a ResumeAction message:
```
AgentClientMessage { conversation_action: ConversationAction { resume_action: ResumeAction {} } }
Hex: 22 02 12 00
  22 = field 4, wire type 2 (AgentClientMessage.conversation_action)
  02 = length 2
  12 = field 2, wire type 2 (ConversationAction.resume_action)
  00 = length 0 (empty ResumeAction)
```

## Cursor CLI Architecture Reference

### Key Source Files

| File | Purpose |
|------|---------|
| `agent-client/dist/connect.js:162-222` | Stream splitting (interaction, exec, checkpoint, kv) |
| `agent-client/dist/connect.js:281-548` | Main session run loop |
| `agent-kv/dist/controlled.js:122-226` | KV blob get/set handling |
| `agent-kv/dist/agent-store.js:102-182` | Conversation reconstruction from blobs |
| `proto/dist/generated/agent/v1/kv_pb.js` | KV message protocol definitions |
| `proto/dist/generated/agent/v1/agent_pb.js` | InteractionUpdate, ConversationState |
| `bidi-connect/dist/index.js:68-169` | BidiAppend transport layer |

### Stream Architecture

The Cursor CLI splits the incoming `AgentServerMessage` stream into 4 sub-streams:

```
AgentServerMessage
├── interactionStream  → UI updates (text_delta, tool_call_started, etc.)
├── execStream         → Tool execution requests (ExecServerMessage)  
├── checkpointStream   → Conversation state checkpoints
└── kvStream           → KV blob operations (get/set)
```

**Reference**: `connect.js:162-222`

```javascript
function splitStream(stream, detector) {
  const interactionStream = createWritableIterable();
  const execStream = createWritableIterable();
  const checkpointStream = createWritableIterable();
  const kvStream = createWritableIterable();
  
  for await (const message of stream) {
    if (message.message.case === "interactionUpdate" || 
        message.message.case === "interactionQuery") {
      interactionStream.write(message.message);
    }
    if (message.message.case === "execServerMessage" || 
        message.message.case === "execServerControlMessage") {
      execStream.write(message.message.value);
    }
    if (message.message.case === "conversationCheckpointUpdate") {
      checkpointStream.write(message.message.value);
    }
    if (message.message.case === "kvServerMessage") {
      kvStream.write(message.message.value);
    }
  }
}
```

### KV Blob Protocol

**Messages** (`kv_pb.js`):

| Message | Fields | Purpose |
|---------|--------|---------|
| `KvServerMessage` | `id`, `get_blob_args` OR `set_blob_args` | Server requests blob get/set |
| `KvClientMessage` | `id`, `get_blob_result` OR `set_blob_result` | Client responds |
| `GetBlobArgs` | `blob_id` (bytes) | Request to fetch blob |
| `GetBlobResult` | `blob_data` (bytes, optional) | Blob content or empty |
| `SetBlobArgs` | `blob_id`, `blob_data` (bytes) | Store blob |
| `SetBlobResult` | `error` (optional) | Confirmation or error |

**Blob ID Generation**: SHA-256 hash of blob content (`blob-store.js:28-32`)

**Reference**: `controlled.js:146-201`

```javascript
// ControlledKvManager handles KV requests
switch (message.message.case) {
  case "getBlobArgs":
    const response = await blobStore.getBlob(ctx, message.message.value.blobId);
    await clientStream.write(new KvClientMessage({
      id: message.id,
      message: {
        case: "getBlobResult",
        value: { blobData: response ? new Uint8Array(response) : undefined }
      }
    }));
    break;
    
  case "setBlobArgs":
    await blobStore.setBlob(ctx, message.message.value.blobId, message.message.value.blobData);
    await clientStream.write(new KvClientMessage({
      id: message.id,
      message: { case: "setBlobResult", value: { error: undefined } }
    }));
    break;
}
```

### InteractionUpdate Message Types

**Reference**: `agent_pb.js` InteractionUpdate.fields

| Field # | Name | Type | Description |
|---------|------|------|-------------|
| 1 | `text_delta` | TextDeltaUpdate | Streamed text content |
| 2 | `tool_call_started` | ToolCallStartedUpdate | Tool call begins |
| 3 | `tool_call_completed` | ToolCallCompletedUpdate | Tool call ends |
| 4 | `thinking_delta` | ThinkingDeltaUpdate | Thinking/reasoning text |
| 5 | `thinking_completed` | ThinkingCompletedUpdate | Thinking ends |
| 6 | `user_message_appended` | UserMessageAppendedUpdate | User message added |
| 7 | `partial_tool_call` | PartialToolCallUpdate | Tool call args streaming |
| 8 | `token_delta` | TokenDeltaUpdate | Token count update |
| 14 | `turn_ended` | (empty) | Turn complete signal |
| 15 | `tool_call_delta` | ToolCallDeltaUpdate | Tool call update |

### Conversation State Storage

**Reference**: `agent-store.js:102-182`

Conversation turns are stored as blob IDs in `ConversationStateStructure.turns`. To reconstruct:

```javascript
async getFullConversation(ctx) {
  const turns = [];
  for (const turnBlobId of this.conversationStateStructure.turns) {
    const turnBlob = await blobStore.getBlob(ctx, turnBlobId);
    const turnStructure = deserialize(turnBlob);
    
    switch (turnStructure.turn.case) {
      case "agentConversationTurn":
        // Fetch userMessage blob, steps blobs
        const userMessageBlob = await blobStore.getBlob(ctx, turnStructure.turn.value.userMessage);
        // ... reconstruct turn
        break;
      case "shellConversationTurn":
        // Fetch shellCommand, shellOutput blobs
        break;
    }
    turns.push(conversationTurn);
  }
  return { turns, todos, summary };
}
```

### Tool Result Sending

**Reference**: `agent-client/dist/exec-controller.js:116-243`, `connect.js:402-420`

Tool results are wrapped in `AgentClientMessage`:

```javascript
// ExecClientMessage structure
{
  id: number,           // Matches ExecServerMessage.id
  exec_id: string,      // Matches ExecServerMessage.exec_id
  message: {
    case: "shellResult" | "writeResult" | "readResult" | "grepResult" | ...,
    value: { ... result data ... }
  }
}

// Wrapped in AgentClientMessage
{
  message: {
    case: "execClientMessage",
    value: ExecClientMessage
  }
}
```

## Implementation Plan

### Phase 1: Environment Flag

Add `CURSOR_SESSION_REUSE=1` environment variable to enable experimental session reuse.

```typescript
const SESSION_REUSE_ENABLED = process.env.CURSOR_SESSION_REUSE === "1";
```

### Phase 2: Proper KV Blob Handling

Currently we handle `set_blob_args` by storing blobs and responding. We need to:

1. **Track assistant response blobs**: When `set_blob_args` contains JSON with `role: "assistant"`, save the blob ID
2. **Detect KV-stored responses**: If stream ends without `text_delta` but we have assistant blob, extract text
3. **Emit extracted text**: Convert blob content to OpenAI stream chunks

```typescript
// Detect assistant response in blob
if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobData) {
  try {
    const text = new TextDecoder().decode(kvMsg.blobData);
    const json = JSON.parse(text);
    if (json.role === "assistant" && json.content) {
      // Store for later extraction
      pendingAssistantBlob = { blobId: kvMsg.blobId, content: json.content };
    }
  } catch {}
}
```

### Phase 3: Turn End Detection

The Cursor CLI expects `turn_ended` (field 14) to signal completion. If we receive this after tool execution without streamed text, check for KV-stored response.

```typescript
if (chunk.type === "turn_ended") {
  if (!hasStreamedText && pendingAssistantBlob) {
    // Emit the KV-stored response as streamed chunks
    emitTextFromBlob(pendingAssistantBlob.content);
  }
  // Emit finish_reason: "stop"
}
```

### Phase 4: Edit Flow in Session Context

Apply the same edit flow fix (internal read handling) to the session-based code path:

```typescript
// In streamCursorSession()
if (chunk.type === "tool_call_started" && chunk.toolCall) {
  if (chunk.toolCall.name === "edit" || chunk.toolCall.name === "apply_diff") {
    pendingEditToolCall = chunk.toolCall.callId;
  }
}

// When processing exec_request
if (execReq.type === "read" && pendingEditToolCall) {
  // Execute read locally, send result via BidiAppend
  await client.sendReadResult(...);
  continue; // Don't emit to OpenCode
}
```

## Known Issues & Unknowns

### Why KV Blobs Instead of Streaming?

Hypothesis: The Cursor server may use different response modes based on:
1. **Client headers**: `x-cursor-client-version`, `x-cursor-client-type`
2. **Request context**: Some flag in the BidiAppend that signals "CLI mode"
3. **Session state**: First request streams, continuations use KV

### Missing Protocol Details

1. How does `turn_ended` relate to text being in KV vs streamed?
2. Is there a `response_mode` field we're missing?
3. Does the checkpoint contain hints about where response is stored?

## Testing Strategy

1. **Enable flag**: `CURSOR_SESSION_REUSE=1 bun run src/server.ts`
2. **Make request with tools**: Should get `tool_calls`, session stays open
3. **Send tool result**: Via session continuation (BidiAppend)
4. **Send ResumeAction**: After tool result, call `client.sendResumeAction()`
5. **Observe**: Does text stream instead of going to KV blob?
6. **Extract if needed**: If KV blob, extract and emit

## Next Steps

1. **Integration**: Update the session reuse code path in `src/server.ts` or OpenCode handler to call `sendResumeAction()` after each tool result
2. **Test with live API**: Run `CURSOR_SESSION_REUSE=1` and verify streaming resumes after ResumeAction
3. **Handle edge cases**: Multiple tool calls in sequence, timeouts, connection loss

## References

- Cursor CLI source: `cursor-agent-restored-source-code/`
- Our implementation: `src/server.ts`, `src/lib/api/agent-service.ts`
- KV handling: `src/lib/api/agent-service.ts:handleKvMessage()`
- ResumeAction encoding: `src/lib/api/proto/agent-messages.ts`
- Unit tests: `tests/unit/bidi-encoding.test.ts`
