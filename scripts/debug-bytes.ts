/**
 * Generate the exact bytes that test-bidi-chat.ts would send
 */
import { randomUUID } from 'node:crypto';

// --- Protobuf Encoding Helpers (EXACTLY like test-bidi-chat.ts) ---
function encodeVarint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 2;
  const encoded = new TextEncoder().encode(value);
  const length = encodeVarint(encoded.length);
  const result = new Uint8Array(1 + length.length + encoded.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(encoded, 1 + length.length);
  return result;
}

function encodeInt32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

// THIS VERSION ALWAYS INCLUDES THE FIELD (like test-bidi-chat.ts)
function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 2;
  const length = encodeVarint(data.length);
  const result = new Uint8Array(1 + length.length + data.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(data, 1 + length.length);
  return result;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Use fixed UUIDs for comparison
const conversationId = "fixed-conv-id-1234";
const messageId = "fixed-msg-id-5678";
const workspacePath = "/Users/yukai/Projects/Personal/opencode-cursor-auth";

console.log('=== test-bidi-chat.ts style message ===');

// Build RequestContextEnv
const requestContextEnv = concatBytes(
  encodeStringField(1, `darwin 24.0.0`),           
  encodeStringField(2, workspacePath),             
  encodeStringField(3, '/bin/zsh'),                
  encodeStringField(10, "Asia/Taipei"),
  encodeStringField(11, workspacePath),
);

// Build RequestContext
const requestContext = encodeMessageField(4, requestContextEnv);

// Build UserMessage - test-bidi-chat.ts uses this prompt
const userMessage = concatBytes(
  encodeStringField(1, "Write a haiku about programming."),
  encodeStringField(2, messageId),
  encodeInt32Field(4, 1)  // mode = AGENT
);

// Build UserMessageAction - includes RequestContext as field 2
const userMessageAction = concatBytes(
  encodeMessageField(1, userMessage),
  encodeMessageField(2, requestContext)
);

// Build ConversationAction
const conversationAction = encodeMessageField(1, userMessageAction);
const modelDetails = encodeStringField(1, "gpt-4o");
const emptyConvState = new Uint8Array(0);

const agentRunRequest = concatBytes(
  encodeMessageField(1, emptyConvState),
  encodeMessageField(2, conversationAction),
  encodeMessageField(3, modelDetails),
  encodeStringField(5, conversationId)
);
const agentClientMessage = encodeMessageField(1, agentRunRequest);

console.log('AgentClientMessage:');
console.log('Length:', agentClientMessage.length);
console.log('Hex:', Buffer.from(agentClientMessage).toString('hex'));
console.log('First 20 bytes:', Array.from(agentClientMessage.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' '));

// Decode and show structure
console.log('\n=== Structure breakdown ===');
console.log('Outer message (AgentClientMessage):');
console.log(`  field ${agentClientMessage[0]! >> 3} (wire ${agentClientMessage[0]! & 7})`);

// Show raw bytes of conversation_state (field 1 of AgentRunRequest)
const innerStart = 2; // skip outer tag+length
console.log(`\nFirst inner field at offset ${innerStart}:`);
console.log(`  Tag byte: 0x${agentClientMessage[innerStart]?.toString(16).padStart(2, '0')}`);
console.log(`  Field: ${agentClientMessage[innerStart]! >> 3}, Wire: ${agentClientMessage[innerStart]! & 7}`);
if ((agentClientMessage[innerStart]! & 7) === 2) {
  const lenByte = agentClientMessage[innerStart + 1];
  console.log(`  Length byte: ${lenByte} (0x${lenByte?.toString(16).padStart(2, '0')})`);
}
