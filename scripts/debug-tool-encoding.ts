/**
 * Debug script to examine tool encoding
 */

// Simple encoding helpers (copied from agent-service.ts)
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
  if (!value) return new Uint8Array(0);
  const fieldTag = (fieldNumber << 3) | 2;
  const encoded = new TextEncoder().encode(value);
  const length = encodeVarint(encoded.length);
  const result = new Uint8Array(1 + length.length + encoded.length);
  result[0] = fieldTag;
  result.set(length, 1);
  result.set(encoded, 1 + length.length);
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

function encodeBoolField(fieldNumber: number, value: boolean): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 0;
  return new Uint8Array([fieldTag, value ? 1 : 0]);
}

function encodeDoubleField(fieldNumber: number, value: number): Uint8Array {
  const fieldTag = (fieldNumber << 3) | 1;
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, fieldTag);
  view.setFloat64(1, value, true);
  return new Uint8Array(buffer);
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

function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  const fieldTag = (fieldNumber << 3) | 0;
  const encoded = encodeVarint(value);
  const result = new Uint8Array(1 + encoded.length);
  result[0] = fieldTag;
  result.set(encoded, 1);
  return result;
}

// Encode google.protobuf.Value
function encodeProtobufValue(value: any): Uint8Array {
  if (value === null || value === undefined) {
    return encodeUint32Field(1, 0);
  }
  
  if (typeof value === "number") {
    return encodeDoubleField(2, value);
  }
  
  if (typeof value === "string") {
    return encodeStringField(3, value);
  }
  
  if (typeof value === "boolean") {
    return encodeBoolField(4, value);
  }
  
  if (Array.isArray(value)) {
    const listBytes: Uint8Array[] = [];
    for (const item of value) {
      const itemValue = encodeProtobufValue(item);
      listBytes.push(encodeMessageField(1, itemValue));
    }
    const listValue = concatBytes(...listBytes);
    return encodeMessageField(6, listValue);
  }
  
  if (typeof value === "object") {
    const structBytes: Uint8Array[] = [];
    for (const [key, val] of Object.entries(value)) {
      const keyBytes = encodeStringField(1, key);
      const valBytes = encodeMessageField(2, encodeProtobufValue(val));
      const mapEntry = concatBytes(keyBytes, valBytes);
      structBytes.push(encodeMessageField(1, mapEntry));
    }
    const structValue = concatBytes(...structBytes);
    return encodeMessageField(5, structValue);
  }
  
  return encodeStringField(3, String(value));
}

// Encode McpToolDefinition
function encodeMcpToolDefinition(name: string, description: string, inputSchema: any, providerIdentifier: string, toolName: string): Uint8Array {
  const parts: Uint8Array[] = [
    encodeStringField(1, name),
    encodeStringField(2, description),
  ];
  
  if (inputSchema) {
    const schemaValue = encodeProtobufValue(inputSchema);
    parts.push(encodeMessageField(3, schemaValue));
  }
  
  parts.push(encodeStringField(4, providerIdentifier));
  parts.push(encodeStringField(5, toolName));
  
  return concatBytes(...parts);
}

// Test encoding
const tool = {
  name: "opencode-bash",
  description: "Execute a bash command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" }
    },
    required: ["command"]
  }
};

console.log("=== Tool Definition ===");
console.log(JSON.stringify(tool, null, 2));

console.log("\n=== Input Schema (as protobuf Value) ===");
const schemaValue = encodeProtobufValue(tool.parameters);
console.log("Schema value bytes:", Buffer.from(schemaValue).toString('hex'));
console.log("Schema value length:", schemaValue.length);

console.log("\n=== Full McpToolDefinition ===");
const mcpTool = encodeMcpToolDefinition(
  "opencode-bash",
  tool.description,
  tool.parameters,
  "opencode",
  "bash"
);
console.log("Full tool bytes:", Buffer.from(mcpTool).toString('hex'));
console.log("Full tool length:", mcpTool.length);

// Decode for verification
function hexDump(data: Uint8Array, prefix = "") {
  const hex = Buffer.from(data).toString('hex');
  let offset = 0;
  while (offset < hex.length) {
    console.log(prefix + hex.slice(offset, offset + 64));
    offset += 64;
  }
}

console.log("\n=== Hex Dump ===");
hexDump(mcpTool);

// Try to parse back
function decodeVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytesRead };
}

console.log("\n=== Parse Back ===");
let pos = 0;
while (pos < mcpTool.length) {
  const tagInfo = decodeVarint(mcpTool, pos);
  pos += tagInfo.bytesRead;
  const fieldNumber = tagInfo.value >> 3;
  const wireType = tagInfo.value & 0x7;
  
  if (wireType === 2) {
    const lengthInfo = decodeVarint(mcpTool, pos);
    pos += lengthInfo.bytesRead;
    const fieldData = mcpTool.slice(pos, pos + lengthInfo.value);
    pos += lengthInfo.value;
    
    const asString = new TextDecoder().decode(fieldData);
    const isPrintable = /^[\x20-\x7e]*$/.test(asString);
    
    console.log(`field ${fieldNumber} (len-delimited): length=${lengthInfo.value}`);
    if (isPrintable && fieldNumber <= 2) {
      console.log(`  -> string: "${asString}"`);
    } else if (fieldNumber === 3) {
      console.log(`  -> input_schema (protobuf Value)`);
      console.log(`  -> hex: ${Buffer.from(fieldData).toString('hex').slice(0, 100)}...`);
    } else {
      console.log(`  -> string: "${asString}"`);
    }
  } else if (wireType === 0) {
    const valueInfo = decodeVarint(mcpTool, pos);
    pos += valueInfo.bytesRead;
    console.log(`field ${fieldNumber} (varint): ${valueInfo.value}`);
  } else {
    console.log(`field ${fieldNumber}: unknown wire type ${wireType}`);
    break;
  }
}
