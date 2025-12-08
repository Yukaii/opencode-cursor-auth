/**
 * Debug script to compare message structures between the two test files
 */
import { generateChecksum, addConnectEnvelope } from '../src/lib/api/cursor-client.ts';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';

// --- Protobuf Encoding Helpers ---
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

function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

// Version that always includes field even if empty
function encodeMessageField(fieldNumber: number, data: Uint8Array): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 2;
  const length = encodeVarint(data.length);
  const result = new Uint8Array(1 + length.length + data.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(data, 1 + length.length);
  return result;
}

// Version that skips empty messages (what test-exec-flow.ts uses)
function encodeMessageFieldSkipEmpty(fieldNumber: number, data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
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

const conversationId = randomUUID();
const messageId = randomUUID();
const workspacePath = process.cwd();

console.log('=== test-bidi-chat.ts style (WORKS) ===');
// Build RequestContextEnv
const requestContextEnv1 = concatBytes(
  encodeStringField(1, `darwin 24.0.0`),           
  encodeStringField(2, workspacePath),             
  encodeStringField(3, '/bin/zsh'),                
  encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),  
  encodeStringField(11, workspacePath),            
);

const requestContext1 = encodeMessageField(4, requestContextEnv1);

const userMessage1 = concatBytes(
  encodeStringField(1, "Write a haiku about programming."),
  encodeStringField(2, messageId),
  encodeInt32Field(4, 1)  // mode = AGENT
);

const userMessageAction1 = concatBytes(
  encodeMessageField(1, userMessage1),
  encodeMessageField(2, requestContext1)
);

const conversationAction1 = encodeMessageField(1, userMessageAction1);
const modelDetails1 = encodeStringField(1, "gpt-4o");
const emptyConvState1 = new Uint8Array(0);

// This is the key difference - test-bidi-chat does NOT skip empty field 1!
const agentRunRequest1 = concatBytes(
  encodeMessageField(1, emptyConvState1),  // Uses non-skipping encodeMessageField!
  encodeMessageField(2, conversationAction1),
  encodeMessageField(3, modelDetails1),
  encodeStringField(5, conversationId)
);
const agentClientMessage1 = encodeMessageField(1, agentRunRequest1);

console.log('AgentClientMessage hex (first 200 chars):');
console.log(Buffer.from(agentClientMessage1).toString('hex').slice(0, 200));
console.log(`Total length: ${agentClientMessage1.length}`);

console.log('\n=== test-exec-flow.ts style (OLD - skipping empty) ===');

// Same structures but using skip-empty for field 1
const agentRunRequest2 = concatBytes(
  encodeMessageFieldSkipEmpty(1, emptyConvState1),  // Skips empty field 1!
  encodeMessageField(2, conversationAction1),
  encodeMessageField(3, modelDetails1),
  encodeStringField(5, conversationId)
);
const agentClientMessage2 = encodeMessageField(1, agentRunRequest2);

console.log('AgentClientMessage hex (first 200 chars):');
console.log(Buffer.from(agentClientMessage2).toString('hex').slice(0, 200));
console.log(`Total length: ${agentClientMessage2.length}`);

console.log('\n=== Difference analysis ===');
console.log(`Length diff: ${agentClientMessage1.length - agentClientMessage2.length} bytes`);
console.log('First few bytes of each:');
console.log('  Works: ', Array.from(agentClientMessage1.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' '));
console.log('  Fails: ', Array.from(agentClientMessage2.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' '));
