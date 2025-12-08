/**
 * Test script to check if interaction_query is received when requesting tool execution
 * Uses AGENT mode (1) instead of ASK mode (2)
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
import { generateChecksum, addConnectEnvelope } from '../src/lib/api/cursor-client.ts';
import { randomUUID } from 'node:crypto';

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

function encodeInt64Field(fieldNumber: number, value: bigint): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

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

// --- Proto Decoding Helpers ---
function decodeVarint(data: Uint8Array, offset: number): { value: bigint; bytesRead: number } {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;
  
  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    if (byte === undefined) break;
    value |= BigInt(byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  
  return { value, bytesRead };
}

interface ParsedField {
  fieldNumber: number;
  wireType: number;
  value: Uint8Array | bigint;
  offset: number;
  length: number;
}

function parseProtoFields(data: Uint8Array): ParsedField[] {
  const fields: ParsedField[] = [];
  let offset = 0;
  
  while (offset < data.length) {
    const startOffset = offset;
    const tagInfo = decodeVarint(data, offset);
    offset += tagInfo.bytesRead;
    
    const fieldNumber = Number(tagInfo.value >> 3n);
    const wireType = Number(tagInfo.value & 0x7n);
    
    if (wireType === 2) { // length-delimited
      const lengthInfo = decodeVarint(data, offset);
      offset += lengthInfo.bytesRead;
      const len = Number(lengthInfo.value);
      const value = data.slice(offset, offset + len);
      offset += len;
      fields.push({ fieldNumber, wireType, value, offset: startOffset, length: offset - startOffset });
    } else if (wireType === 0) { // varint
      const valueInfo = decodeVarint(data, offset);
      offset += valueInfo.bytesRead;
      fields.push({ fieldNumber, wireType, value: valueInfo.value, offset: startOffset, length: offset - startOffset });
    } else if (wireType === 1) { // 64-bit fixed
      const value = data.slice(offset, offset + 8);
      offset += 8;
      fields.push({ fieldNumber, wireType, value, offset: startOffset, length: 8 });
    } else if (wireType === 5) { // 32-bit fixed
      const value = data.slice(offset, offset + 4);
      offset += 4;
      fields.push({ fieldNumber, wireType, value, offset: startOffset, length: 4 });
    } else {
      console.log(`Unknown wire type ${wireType} at offset ${offset}`);
      break;
    }
  }
  
  return fields;
}

function printProtoFields(data: Uint8Array, indent = "", maxDepth = 5): void {
  if (maxDepth <= 0) {
    console.log(`${indent}(max depth reached)`);
    return;
  }
  
  const fields = parseProtoFields(data);
  
  for (const field of fields) {
    if (field.wireType === 2 && field.value instanceof Uint8Array) {
      // Try to decode as string first
      try {
        const str = new TextDecoder('utf-8', { fatal: true }).decode(field.value);
        if (str.length > 0 && /^[\x20-\x7E\n\r\t]*$/.test(str)) {
          console.log(`${indent}field ${field.fieldNumber} (string): "${str.slice(0, 200)}${str.length > 200 ? '...' : ''}"`);
          continue;
        }
      } catch {}
      
      // Try to decode as nested message
      const nestedFields = parseProtoFields(field.value);
      if (nestedFields.length > 0) {
        console.log(`${indent}field ${field.fieldNumber} (message):`);
        printProtoFields(field.value, indent + "  ", maxDepth - 1);
      } else {
        console.log(`${indent}field ${field.fieldNumber} (bytes): ${Buffer.from(field.value).toString('hex').slice(0, 100)}${field.value.length > 50 ? '...' : ''}`);
      }
    } else if (field.wireType === 0) {
      console.log(`${indent}field ${field.fieldNumber} (varint): ${field.value}`);
    } else {
      console.log(`${indent}field ${field.fieldNumber} (wire${field.wireType}): ${field.value}`);
    }
  }
}

// Field name mappings based on proto definitions
const AgentServerMessageFields: Record<number, string> = {
  1: 'interaction_update',
  2: 'exec_server_message',
  3: 'conversation_checkpoint_update',
  4: 'kv_server_message',
  5: 'exec_server_control_message',
  7: 'interaction_query',
};

const InteractionQueryFields: Record<number, string> = {
  1: 'web_search',
  2: 'ask_question',
  3: 'switch_mode',
  4: 'mcp_tool_call',
  5: 'apply_files',
  6: 'terminal_read',
  7: 'diff_history_check',
  8: 'context_query',
  9: 'generate_image',
  10: 'browser_action',
  11: 'hook_check',
};

async function main() {
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();
  if (!token) throw new Error('No token - please authenticate first');

  const checksum = generateChecksum(token);
  const requestId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  
  console.log('Request ID:', requestId);
  console.log('Conversation ID:', conversationId);
  console.log('Using AGENT mode (1) - should trigger tool execution');
  
  const headers = {
    "authorization": `Bearer ${token}`,
    "content-type": "application/grpc-web+proto",
    "user-agent": "connect-es/1.4.0",
    "x-cursor-checksum": checksum,
    "x-cursor-client-version": "cli-2025.11.25-d5b3271",
    "x-cursor-client-type": "cli",
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "x-ghost-mode": "true",
    "x-request-id": requestId,
  };
  
  // Build BidiRequestId
  const bidiRequestId = encodeStringField(1, requestId);
  
  // Build AgentClientMessage for chat with AGENT mode
  // The prompt explicitly asks for shell execution
  const userMessage = concatBytes(
    encodeStringField(1, "Run: echo 'Hello from Cursor'"),  // prompt
    encodeStringField(2, messageId),  // message_id
    encodeInt32Field(4, 1)  // mode = AGENT (1)
  );
  const userMessageAction = encodeMessageField(1, userMessage);
  const conversationAction = encodeMessageField(1, userMessageAction);
  const modelDetails = encodeStringField(1, "claude-3.5-sonnet");
  const emptyConvState = new Uint8Array(0);
  const agentRunRequest = concatBytes(
    encodeMessageField(1, emptyConvState),  // conversation_state
    encodeMessageField(2, conversationAction),  // conversation_action
    encodeMessageField(3, modelDetails),  // model_details
    encodeStringField(5, conversationId)  // conversation_id
  );
  const agentClientMessage = encodeMessageField(1, agentRunRequest);
  
  // Build BidiAppendRequest
  const hexData = Buffer.from(agentClientMessage).toString("hex");
  const bidiRequestIdForAppend = encodeStringField(1, requestId);
  const bidiAppendRequest = concatBytes(
    encodeStringField(1, hexData),
    encodeMessageField(2, bidiRequestIdForAppend),
    encodeInt64Field(3, 0n)
  );
  
  // Start SSE stream
  console.log('\n=== Starting RunSSE stream ===');
  const sseEnvelope = addConnectEnvelope(bidiRequestId);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.log('\n=== Timeout reached, aborting ===');
    controller.abort();
  }, 30000);  // 30 second timeout
  
  const ssePromise = fetch("https://api2.cursor.sh/agent.v1.AgentService/RunSSE", {
    method: "POST",
    headers,
    body: Buffer.from(sseEnvelope),
    signal: controller.signal,
  });
  
  // Send BidiAppend
  console.log('\n=== Sending BidiAppend ===');
  const appendResponse = await fetch("https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend", {
    method: "POST",
    headers,
    body: Buffer.from(addConnectEnvelope(bidiAppendRequest)),
  });
  
  console.log('BidiAppend status:', appendResponse.status);
  if (!appendResponse.ok) {
    const text = await appendResponse.text();
    console.log('BidiAppend error:', text);
  }
  
  // Wait for SSE response
  console.log('\n=== Waiting for SSE response ===');
  let gotInteractionQuery = false;
  let gotExecServerMessage = false;
  let gotInteractionUpdate = false;
  
  try {
    const sseResponse = await ssePromise;
    console.log('SSE status:', sseResponse.status);
    
    if (!sseResponse.body) {
      console.log('No body!');
      return;
    }
    
    const reader = sseResponse.body.getReader();
    let chunks = 0;
    let fullBuffer = new Uint8Array(0);
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('\nStream done!');
        break;
      }
      
      chunks++;
      
      // Append to full buffer
      const newBuffer = new Uint8Array(fullBuffer.length + value.length);
      newBuffer.set(fullBuffer);
      newBuffer.set(value, fullBuffer.length);
      fullBuffer = newBuffer;
      
      // Parse all frames in the buffer
      let offset = 0;
      while (offset + 5 <= fullBuffer.length) {
        const flags = fullBuffer[offset];
        const length = (fullBuffer[offset + 1]! << 24) | (fullBuffer[offset + 2]! << 16) | 
                       (fullBuffer[offset + 3]! << 8) | fullBuffer[offset + 4]!;
        
        if (offset + 5 + length > fullBuffer.length) {
          break;  // Incomplete frame
        }
        
        const frameData = fullBuffer.slice(offset + 5, offset + 5 + length);
        offset += 5 + length;
        
        if ((flags ?? 0) & 0x80) {
          // Trailer frame
          const trailer = new TextDecoder().decode(frameData);
          console.log(`\n--- Trailer frame (${length} bytes) ---`);
          console.log('Trailer:', trailer);
        } else {
          // Data frame - decode AgentServerMessage
          const serverMsgFields = parseProtoFields(frameData);
          for (const field of serverMsgFields) {
            const fieldName = AgentServerMessageFields[field.fieldNumber] ?? `unknown_${field.fieldNumber}`;
            
            // Highlight important message types
            if (field.fieldNumber === 7) {
              gotInteractionQuery = true;
              console.log(`\n========== INTERACTION_QUERY RECEIVED ==========`);
              console.log(`[${fieldName}] (field ${field.fieldNumber}):`);
              if (field.wireType === 2 && field.value instanceof Uint8Array) {
                console.log('  InteractionQuery contents:');
                const queryFields = parseProtoFields(field.value);
                for (const qf of queryFields) {
                  const qfName = InteractionQueryFields[qf.fieldNumber] ?? `unknown_${qf.fieldNumber}`;
                  console.log(`\n  [${qfName}] (field ${qf.fieldNumber}):`);
                  if (qf.wireType === 2 && qf.value instanceof Uint8Array) {
                    printProtoFields(qf.value, "    ");
                  } else {
                    console.log(`    value: ${qf.value}`);
                  }
                }
              }
              console.log('===============================================');
            } else if (field.fieldNumber === 2) {
              gotExecServerMessage = true;
              console.log(`\n========== EXEC_SERVER_MESSAGE RECEIVED ==========`);
              if (field.wireType === 2 && field.value instanceof Uint8Array) {
                printProtoFields(field.value, "  ");
              }
              console.log('=================================================');
            } else if (field.fieldNumber === 1) {
              gotInteractionUpdate = true;
              // Parse interaction_update to show text content
              if (field.wireType === 2 && field.value instanceof Uint8Array) {
                const updateFields = parseProtoFields(field.value);
                for (const uf of updateFields) {
                  if (uf.fieldNumber === 1 && uf.wireType === 2 && uf.value instanceof Uint8Array) {
                    // message field
                    const msgFields = parseProtoFields(uf.value);
                    for (const mf of msgFields) {
                      if (mf.fieldNumber === 1 && mf.wireType === 2 && mf.value instanceof Uint8Array) {
                        // text_delta
                        try {
                          const text = new TextDecoder('utf-8', { fatal: true }).decode(mf.value);
                          if (text.length > 0) {
                            process.stdout.write(text);
                          }
                        } catch {}
                      }
                    }
                  }
                }
              }
            } else if (field.fieldNumber === 4) {
              // KV message - just note it
              console.log(`\n[kv_server_message] received`);
            } else if (field.fieldNumber === 3) {
              // Checkpoint
              console.log(`\n[checkpoint] received`);
            }
          }
        }
      }
      
      fullBuffer = fullBuffer.slice(offset);
      
      if (chunks > 50) {
        console.log('\nMax chunks reached');
        break;
      }
    }
    
    reader.releaseLock();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log('Request aborted due to timeout');
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
  
  console.log('\n\n=== SUMMARY ===');
  console.log('Got interaction_update (field 1):', gotInteractionUpdate);
  console.log('Got exec_server_message (field 2):', gotExecServerMessage);
  console.log('Got interaction_query (field 7):', gotInteractionQuery);
  
  if (!gotInteractionQuery && !gotExecServerMessage) {
    console.log('\n*** No tool-related messages received ***');
    console.log('The server may not be triggering tool execution.');
    console.log('Possible causes:');
    console.log('1. Model is refusing to execute tools');
    console.log('2. Missing request context (workspace info)');
    console.log('3. Account/permission restrictions');
  }
}

main().catch(console.error);
