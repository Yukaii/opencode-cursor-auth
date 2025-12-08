/**
 * Test script to verify exec flow with proper RequestContext handling
 * 
 * Structure:
 * - RequestContextResult { result: oneof { success(1), error(2), rejected(3) } }
 * - RequestContextSuccess { request_context(1) }
 * - RequestContext { env(4), tools(7), etc. }
 * - RequestContextEnv { os_version(1), workspace_paths(2), shell(3), time_zone(10), etc. }
 */
import { FileCredentialManager } from '../src/lib/storage.ts';
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
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

function encodeBoolField(fieldNumber: number, value: boolean): Uint8Array {
  if (!value) return new Uint8Array(0);
  const fieldTag = (fieldNumber << 3) | 0;
  return new Uint8Array([fieldTag, 1]);
}

function encodeInt64Field(fieldNumber: number, value: bigint): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

function encodeMessageField(fieldNumber: number, data: Uint8Array, skipIfEmpty = false): Uint8Array {
  // By default, always include the field even if empty (required by Cursor API)
  if (skipIfEmpty && data.length === 0) return new Uint8Array(0);
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
      try {
        const str = new TextDecoder('utf-8', { fatal: true }).decode(field.value);
        if (str.length > 0 && /^[\x20-\x7E\n\r\t]*$/.test(str)) {
          console.log(`${indent}field ${field.fieldNumber} (string): "${str.slice(0, 200)}${str.length > 200 ? '...' : ''}"`);
          continue;
        }
      } catch {}
      
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

// ExecServerMessage field mapping
const ExecServerMessageFields: Record<number, string> = {
  1: 'id',
  2: 'shell_args',
  3: 'write_args',
  4: 'delete_args',
  5: 'grep_args',
  7: 'read_args',
  8: 'ls_args',
  9: 'diagnostics_args',
  10: 'request_context_args',
  11: 'mcp_args',
  14: 'shell_stream_args',
  15: 'exec_id',
  16: 'background_shell_spawn_args',
  17: 'list_mcp_resources_exec_args',
  18: 'read_mcp_resource_exec_args',
  19: 'span_context',
  20: 'fetch_args',
  21: 'record_screen_args',
  22: 'computer_use_args',
};

interface ExecRequest {
  id: number;
  execId: string;
  type: string;
  args?: any;
}

function parseExecServerMessage(data: Uint8Array): ExecRequest | null {
  const fields = parseProtoFields(data);
  const result: ExecRequest = { id: 0, execId: '', type: 'unknown' };
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = Number(field.value);
    } else if (field.fieldNumber === 15 && field.wireType === 2 && field.value instanceof Uint8Array) {
      try {
        result.execId = new TextDecoder().decode(field.value);
      } catch {}
    } else if (field.fieldNumber >= 2 && field.fieldNumber !== 15 && field.fieldNumber !== 19) {
      result.type = ExecServerMessageFields[field.fieldNumber] || `field_${field.fieldNumber}`;
      if (field.wireType === 2 && field.value instanceof Uint8Array) {
        result.args = parseProtoFields(field.value);
      }
    }
  }
  
  return result;
}

/**
 * Build proper RequestContextResult with nested structure:
 * RequestContextResult {
 *   result: oneof {
 *     success(1): RequestContextSuccess {
 *       request_context(1): RequestContext {
 *         env(4): RequestContextEnv { ... }
 *         tools(7): repeated McpToolDefinition
 *       }
 *     }
 *   }
 * }
 */
function encodeRequestContextResult(id: number, execId: string): Uint8Array {
  const cwd = process.cwd();
  const homeDir = os.homedir();
  const userShell = process.env.SHELL || '/bin/bash';
  const osVersion = `${os.platform()} ${os.release()}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  
  // RequestContextEnv
  // no: 1, name: "os_version"
  // no: 2, name: "workspace_paths" (repeated)
  // no: 3, name: "shell"
  // no: 5, name: "sandbox_enabled"
  // no: 10, name: "time_zone"
  const requestContextEnv = concatBytes(
    encodeStringField(1, osVersion),
    encodeStringField(2, cwd),  // workspace_paths (repeated, each as separate field)
    encodeStringField(3, userShell),
    encodeBoolField(5, false),  // sandbox_enabled = false
    encodeStringField(10, timeZone),
  );
  
  // RequestContext
  // no: 4, name: "env"
  const requestContext = encodeMessageField(4, requestContextEnv);
  
  // RequestContextSuccess
  // no: 1, name: "request_context"
  const requestContextSuccess = encodeMessageField(1, requestContext);
  
  // RequestContextResult
  // no: 1, name: "success" (oneof result)
  const requestContextResult = encodeMessageField(1, requestContextSuccess);
  
  // ExecClientMessage
  // no: 1, name: "id"
  // no: 15, name: "exec_id"
  // no: 10, name: "request_context_result" (oneof message)
  const execClientMessage = concatBytes(
    encodeUint32Field(1, id),
    execId ? encodeStringField(15, execId) : new Uint8Array(0),
    encodeMessageField(10, requestContextResult),
  );
  
  // AgentClientMessage
  // no: 2, name: "exec_client_message"
  return encodeMessageField(2, execClientMessage);
}

/**
 * Build shell result
 */
function encodeShellResult(id: number, execId: string, output: string, exitCode: number): Uint8Array {
  // ShellResult
  // no: 1, name: "stdout"
  // no: 2, name: "exit_code"
  const shellResult = concatBytes(
    encodeStringField(1, output),
    encodeInt32Field(2, exitCode),
  );
  
  // ExecClientMessage
  // no: 1, name: "id"
  // no: 15, name: "exec_id"
  // no: 2, name: "shell_result" (oneof message)
  const execClientMessage = concatBytes(
    encodeUint32Field(1, id),
    execId ? encodeStringField(15, execId) : new Uint8Array(0),
    encodeMessageField(2, shellResult),
  );
  
  // AgentClientMessage
  // no: 2, name: "exec_client_message"
  return encodeMessageField(2, execClientMessage);
}

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
  
  // Build RequestContextEnv (required in initial message!)
  // field 1: os_version, field 2: workspace_paths (repeated), field 3: shell,
  // field 10: time_zone, field 11: project_folder
  const workspacePath = process.cwd();
  const requestContextEnv = concatBytes(
    encodeStringField(1, `${os.platform()} ${os.release()}`),  // os_version
    encodeStringField(2, workspacePath),                        // workspace_paths
    encodeStringField(3, process.env.SHELL || '/bin/zsh'),      // shell
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),  // time_zone
    encodeStringField(11, workspacePath),                        // project_folder
  );
  
  // Build RequestContext (field 4: env)
  const requestContext = encodeMessageField(4, requestContextEnv);
  
  // Build AgentClientMessage for chat with AGENT mode
  const userMessage = concatBytes(
    encodeStringField(1, "List the files in the current directory using the shell."),  // Request tool execution
    encodeStringField(2, messageId),  // message_id
    encodeInt32Field(4, 1)  // mode = AGENT (1)
  );
  
  // UserMessageAction includes BOTH UserMessage (field 1) AND RequestContext (field 2)
  const userMessageAction = concatBytes(
    encodeMessageField(1, userMessage),
    encodeMessageField(2, requestContext)  // This was missing!
  );
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
  
  // Debug: show the message bytes
  console.log('\nAgentClientMessage hex:');
  console.log(Buffer.from(agentClientMessage).toString('hex'));
  console.log(`Total length: ${agentClientMessage.length}`);
  console.log(`First few bytes: ${Array.from(agentClientMessage.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  
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
  }, 90000);  // 90 second timeout
  
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
  
  // Track sequence number for BidiAppend
  let seqNum = 1n;
  
  // Helper function to send BidiAppend
  async function sendBidiAppend(agentClientMsg: Uint8Array) {
    const hexData = Buffer.from(agentClientMsg).toString("hex");
    const bidiRequestIdForAppend = encodeStringField(1, requestId);
    const bidiAppendRequest = concatBytes(
      encodeStringField(1, hexData),
      encodeMessageField(2, bidiRequestIdForAppend),
      encodeInt64Field(3, seqNum)
    );
    seqNum++;
    
    console.log(`[DEBUG] Sending BidiAppend seqNum=${seqNum-1n}, data length=${agentClientMsg.length}`);
    
    const appendResponse = await fetch("https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend", {
      method: "POST",
      headers,
      body: Buffer.from(addConnectEnvelope(bidiAppendRequest)),
    });
    
    return appendResponse.ok;
  }
  
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
    let textOutput = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('\nStream done!');
        break;
      }
      
      chunks++;
      console.log(`\n[CHUNK ${chunks}] Received ${value.length} bytes`);  // Debug: show every chunk
      
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
          break;
        }
        
        const frameData = fullBuffer.slice(offset + 5, offset + 5 + length);
        offset += 5 + length;
        
        console.log(`  [FRAME] flags=0x${(flags ?? 0).toString(16)}, len=${length}, first bytes: ${Array.from(frameData.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        
        if ((flags ?? 0) & 0x80) {
          const trailer = new TextDecoder().decode(frameData);
          console.log(`\n--- Trailer frame ---`);
          console.log('Trailer:', trailer);
        } else {
          const serverMsgFields = parseProtoFields(frameData);
          for (const field of serverMsgFields) {
            if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
              // exec_server_message
              const execRequest = parseExecServerMessage(field.value);
              if (execRequest) {
                console.log(`\n========== EXEC_SERVER_MESSAGE ==========`);
                console.log(`Type: ${execRequest.type}`);
                console.log(`ID: ${execRequest.id}`);
                console.log(`ExecID: ${execRequest.execId || '(empty)'}`);
                
                if (execRequest.type === 'request_context_args') {
                  console.log('\n>>> Server requesting workspace context, sending response...');
                  const contextResponse = encodeRequestContextResult(execRequest.id, execRequest.execId);
                  console.log(`>>> Response bytes: ${Buffer.from(contextResponse).toString('hex')}`);
                  const success = await sendBidiAppend(contextResponse);
                  console.log(`>>> Request context response sent: ${success ? 'OK' : 'FAILED'}`);
                } else if (execRequest.type === 'shell_args' || execRequest.type === 'shell_stream_args') {
                  console.log('\n>>> Server requesting SHELL EXECUTION!');
                  
                  // Parse shell args to get command and cwd
                  let command = '';
                  let cwd = process.cwd();
                  
                  if (execRequest.args) {
                    for (const arg of execRequest.args) {
                      if (arg.wireType === 2 && arg.value instanceof Uint8Array) {
                        try {
                          const str = new TextDecoder().decode(arg.value);
                          if (arg.fieldNumber === 1) command = str;  // command
                          else if (arg.fieldNumber === 2) cwd = str;  // working directory
                          console.log(`  field ${arg.fieldNumber}: "${str}"`);
                        } catch {
                          console.log(`  field ${arg.fieldNumber}: (binary)`);
                        }
                      } else {
                        console.log(`  field ${arg.fieldNumber}: ${arg.value}`);
                      }
                    }
                  }
                  
                  // Execute the command
                  console.log(`\n>>> Executing: ${command} in ${cwd}`);
                  let output = '';
                  let exitCode = 0;
                  try {
                    const proc = Bun.spawn(['sh', '-c', command], {
                      cwd,
                      stdout: 'pipe',
                      stderr: 'pipe',
                    });
                    const stdout = await new Response(proc.stdout).text();
                    const stderr = await new Response(proc.stderr).text();
                    output = stdout + stderr;
                    exitCode = await proc.exited;
                    console.log(`>>> Output (${output.length} chars, exit=${exitCode}):\n${output.slice(0, 500)}`);
                  } catch (e: any) {
                    output = `Error: ${e.message}`;
                    exitCode = 1;
                    console.log(`>>> Execution error: ${e.message}`);
                  }
                  
                  console.log('\n>>> Sending shell result...');
                  const shellResponse = encodeShellResult(execRequest.id, execRequest.execId, output, exitCode);
                  const success = await sendBidiAppend(shellResponse);
                  console.log(`>>> Shell result sent: ${success ? 'OK' : 'FAILED'}`);
                } else if (execRequest.type === 'ls_args') {
                  console.log('\n>>> Server requesting LS (directory listing)!');
                  
                  // Parse ls_args - field 8 contains LsArgs
                  let lsPath = process.cwd();
                  if (execRequest.args) {
                    for (const arg of execRequest.args) {
                      if (arg.wireType === 2 && arg.value instanceof Uint8Array) {
                        try {
                          const str = new TextDecoder().decode(arg.value);
                          if (arg.fieldNumber === 1) lsPath = str;  // path
                          console.log(`  field ${arg.fieldNumber}: "${str}"`);
                        } catch {
                          console.log(`  field ${arg.fieldNumber}: (binary)`);
                        }
                      }
                    }
                  }
                  
                  // Execute ls command
                  console.log(`>>> Listing: ${lsPath}`);
                  let output = '';
                  try {
                    const proc = Bun.spawn(['ls', '-la'], {
                      cwd: lsPath,
                      stdout: 'pipe',
                      stderr: 'pipe',
                    });
                    output = await new Response(proc.stdout).text();
                    await proc.exited;
                    console.log(`>>> Output (${output.length} chars):\n${output.slice(0, 500)}`);
                  } catch (e: any) {
                    output = `Error: ${e.message}`;
                    console.log(`>>> LS error: ${e.message}`);
                  }
                  
                  // Send LsResult as success with string content
                  // For simplicity, encode as LsResult { success { files_string: "..." } }
                  const lsSuccess = encodeStringField(1, output);  // files_string field
                  const lsResult = encodeMessageField(1, lsSuccess);  // success oneof field
                  
                  const execClientMessage = concatBytes(
                    encodeUint32Field(1, execRequest.id),
                    execRequest.execId ? encodeStringField(15, execRequest.execId) : new Uint8Array(0),
                    encodeMessageField(8, lsResult),  // field 8 = ls_result
                  );
                  
                  const agentClientMsg = encodeMessageField(2, execClientMessage);
                  const success = await sendBidiAppend(agentClientMsg);
                  console.log(`>>> LS result sent: ${success ? 'OK' : 'FAILED'}`);
                } else {
                  console.log('Full exec message:');
                  printProtoFields(field.value, "  ");
                }
                console.log('=========================================');
              }
            } else if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
              // interaction_update
              const updateFields = parseProtoFields(field.value);
              for (const uf of updateFields) {
                if (uf.fieldNumber === 1 && uf.wireType === 2 && uf.value instanceof Uint8Array) {
                  const msgFields = parseProtoFields(uf.value);
                  for (const mf of msgFields) {
                    if (mf.fieldNumber === 1 && mf.wireType === 2 && mf.value instanceof Uint8Array) {
                      try {
                        const text = new TextDecoder('utf-8', { fatal: true }).decode(mf.value);
                        if (text.length > 0) {
                          textOutput += text;
                          process.stdout.write(text);
                        }
                      } catch {}
                    }
                  }
                } else if (uf.fieldNumber === 8 && uf.wireType === 2 && uf.value instanceof Uint8Array) {
                  // token_delta
                  const tokenFields = parseProtoFields(uf.value);
                  for (const tf of tokenFields) {
                    if (tf.fieldNumber === 1 && tf.wireType === 2 && tf.value instanceof Uint8Array) {
                      try {
                        const text = new TextDecoder().decode(tf.value);
                        process.stdout.write(text);
                        textOutput += text;
                      } catch {}
                    }
                  }
                } else if (uf.fieldNumber === 13) {
                  // heartbeat - ignore
                } else if (uf.fieldNumber === 14) {
                  console.log('\n[turn_ended]');
                }
              }
            } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
              // kv_server_message - handle blob storage
              const kvFields = parseProtoFields(field.value);
              let kvId = 0;
              let kvType = 'unknown';
              let blobId: Uint8Array | null = null;
              let blobData: Uint8Array | null = null;
              
              for (const kf of kvFields) {
                if (kf.fieldNumber === 1 && kf.wireType === 0) {
                  kvId = Number(kf.value);
                } else if (kf.fieldNumber === 2 && kf.wireType === 2 && kf.value instanceof Uint8Array) {
                  kvType = 'get_blob_args';
                  const argsFields = parseProtoFields(kf.value);
                  for (const af of argsFields) {
                    if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
                      blobId = af.value;
                    }
                  }
                } else if (kf.fieldNumber === 3 && kf.wireType === 2 && kf.value instanceof Uint8Array) {
                  kvType = 'set_blob_args';
                  const argsFields = parseProtoFields(kf.value);
                  for (const af of argsFields) {
                    if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
                      blobId = af.value;
                    } else if (af.fieldNumber === 2 && af.wireType === 2 && af.value instanceof Uint8Array) {
                      blobData = af.value;
                    }
                  }
                }
              }
              
              console.log(`\n[kv_server_message] type=${kvType}, id=${kvId}`);
              
              // Respond to KV requests
              if (kvType === 'get_blob_args') {
                // Return empty result (blob not found)
                const getBlobResult = new Uint8Array(0);
                const kvClientMsg = concatBytes(
                  encodeUint32Field(1, kvId),
                  encodeMessageField(2, getBlobResult)  // field 2 = get_blob_result
                );
                const agentClientMsg = encodeMessageField(3, kvClientMsg);  // field 3 = kv_client_message
                await sendBidiAppend(agentClientMsg);
                console.log('  -> Sent GetBlobResult (empty)');
              } else if (kvType === 'set_blob_args' && blobId && blobData) {
                // Store blob in memory (for testing)
                const setBlobResult = new Uint8Array(0);  // No error
                const kvClientMsg = concatBytes(
                  encodeUint32Field(1, kvId),
                  encodeMessageField(3, setBlobResult)  // field 3 = set_blob_result
                );
                const agentClientMsg = encodeMessageField(3, kvClientMsg);  // field 3 = kv_client_message
                await sendBidiAppend(agentClientMsg);
                console.log(`  -> Sent SetBlobResult (stored ${blobData.length} bytes)`);
              }
            } else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
              console.log(`\n========== INTERACTION_QUERY ==========`);
              printProtoFields(field.value, "  ");
              console.log('=======================================');
            } else if (field.fieldNumber === 3) {
              console.log('\n[checkpoint received]');
            }
          }
        }
      }
      
      fullBuffer = fullBuffer.slice(offset);
      
      if (chunks > 200) {
        console.log('\nMax chunks reached');
        break;
      }
    }
    
    reader.releaseLock();
    
    console.log('\n\n=== TEXT OUTPUT ===');
    console.log(textOutput || '(no text received)');
    
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log('Request aborted due to timeout');
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(console.error);
