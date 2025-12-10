import { FileCredentialManager } from "../src/lib/storage";

async function main() {
  const cm = new FileCredentialManager('cursor');
  const token = await cm.getAccessToken();
  if (!token) {
    console.log('No token found');
    return;
  }
  
  // Fetch models
  const requestBody = new Uint8Array([]);
  const framedBody = new Uint8Array(5 + requestBody.length);
  framedBody[0] = 0;
  const len = requestBody.length;
  framedBody[1] = (len >> 24) & 0xff;
  framedBody[2] = (len >> 16) & 0xff;
  framedBody[3] = (len >> 8) & 0xff;
  framedBody[4] = len & 0xff;
  framedBody.set(requestBody, 5);
  
  const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/GetUsableModels', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      'Authorization': `Bearer ${token}`,
      'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
      'x-ghost-mode': 'false',
      'x-request-id': crypto.randomUUID(),
    },
    body: framedBody,
  });
  
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  
  // Skip 5-byte frame header and parse
  const messageData = bytes.slice(5);
  
  // Simple proto parsing - just extract strings
  let pos = 0;
  const models: {modelId: string, displayModelId: string, displayName: string}[] = [];
  
  function decodeVarint(bytes: Uint8Array, offset: number) {
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
  
  function decodeString(bytes: Uint8Array, offset: number) {
    const { value: length, newOffset: dataStart } = decodeVarint(bytes, offset);
    const value = new TextDecoder().decode(bytes.slice(dataStart, dataStart + length));
    return { value, newOffset: dataStart + length };
  }
  
  while (pos < messageData.length) {
    const { value: tag, newOffset: afterTag } = decodeVarint(messageData, pos);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    pos = afterTag;
    
    if (fieldNumber === 1 && wireType === 2) {
      // This is a model message
      const { value: length, newOffset: dataStart } = decodeVarint(messageData, pos);
      const modelEnd = dataStart + length;
      
      // Parse model fields
      let modelPos = dataStart;
      let modelId = '', displayModelId = '', displayName = '';
      
      while (modelPos < modelEnd) {
        const { value: mTag, newOffset: mAfterTag } = decodeVarint(messageData, modelPos);
        const mFieldNumber = mTag >>> 3;
        const mWireType = mTag & 0x7;
        modelPos = mAfterTag;
        
        if (mWireType === 2) {
          const { value: str, newOffset } = decodeString(messageData, modelPos);
          modelPos = newOffset;
          if (mFieldNumber === 1) modelId = str;
          if (mFieldNumber === 3) displayModelId = str;
          if (mFieldNumber === 4) displayName = str;
        } else if (mWireType === 0) {
          const { newOffset } = decodeVarint(messageData, modelPos);
          modelPos = newOffset;
        }
      }
      
      if (modelId || displayModelId) {
        models.push({ modelId, displayModelId, displayName });
      }
      
      pos = modelEnd;
    } else if (wireType === 2) {
      const { value: length, newOffset } = decodeVarint(messageData, pos);
      pos = newOffset + length;
    } else if (wireType === 0) {
      const { newOffset } = decodeVarint(messageData, pos);
      pos = newOffset;
    }
  }
  
  console.log('Available Models:');
  console.log('=================');
  models.forEach(m => {
    console.log(`- ${m.displayModelId || m.modelId} (${m.displayName})`);
  });
}

main().catch(console.error);
