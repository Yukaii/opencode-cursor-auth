import { describe, expect, test } from "bun:test";
import {
  encodeBidiRequestId,
  encodeBidiAppendRequest,
} from "../../src/lib/api/proto/bidi";
import {
  encodeResumeAction,
  encodeConversationActionWithResume,
  encodeAgentClientMessageWithConversationAction,
} from "../../src/lib/api/proto/agent-messages";
import {
  encodeVarint,
  encodeStringField,
  encodeMessageField,
  encodeInt64Field,
  encodeUint32Field,
  encodeBoolField,
  encodeDoubleField,
  encodeProtobufValue,
  concatBytes,
  hexDump,
} from "../../src/lib/api/proto/encoding";

describe("encoding primitives", () => {
  test("encodeVarint handles small values", () => {
    expect(encodeVarint(0)).toEqual(new Uint8Array([0x00]));
    expect(encodeVarint(1)).toEqual(new Uint8Array([0x01]));
    expect(encodeVarint(127)).toEqual(new Uint8Array([0x7f]));
  });

  test("encodeVarint handles multi-byte values", () => {
    // 128 = 0x80 = 10000000 -> encoded as [0x80, 0x01]
    expect(encodeVarint(128)).toEqual(new Uint8Array([0x80, 0x01]));
    // 300 = 0x12c = 256 + 44 -> encoded as [0xac, 0x02]
    expect(encodeVarint(300)).toEqual(new Uint8Array([0xac, 0x02]));
  });

  test("encodeVarint handles bigint", () => {
    expect(encodeVarint(1n)).toEqual(new Uint8Array([0x01]));
    expect(encodeVarint(300n)).toEqual(new Uint8Array([0xac, 0x02]));
  });

  test("encodeStringField encodes with field tag and length", () => {
    // Field 1, wire type 2 -> tag = 0x0a
    // "hi" = 2 bytes
    const result = encodeStringField(1, "hi");
    expect(result[0]).toBe(0x0a); // (1 << 3) | 2
    expect(result[1]).toBe(0x02); // length
    expect(result.slice(2)).toEqual(new TextEncoder().encode("hi"));
  });

  test("encodeStringField returns empty array for empty string", () => {
    expect(encodeStringField(1, "")).toEqual(new Uint8Array(0));
  });

  test("encodeMessageField wraps nested message", () => {
    const inner = new Uint8Array([0x01, 0x02, 0x03]);
    // Field 2, wire type 2 -> tag = 0x12
    const result = encodeMessageField(2, inner);
    expect(result[0]).toBe(0x12); // (2 << 3) | 2
    expect(result[1]).toBe(0x03); // length
    expect(result.slice(2)).toEqual(inner);
  });

  test("encodeInt64Field encodes bigint with field tag", () => {
    // Field 3, wire type 0 -> tag = 0x18
    const result = encodeInt64Field(3, 1n);
    expect(result[0]).toBe(0x18); // (3 << 3) | 0
    expect(result[1]).toBe(0x01);
  });

  test("encodeUint32Field skips zero values", () => {
    expect(encodeUint32Field(1, 0)).toEqual(new Uint8Array(0));
  });

  test("encodeUint32Field encodes non-zero values", () => {
    // Field 1, wire type 0 -> tag = 0x08
    const result = encodeUint32Field(1, 42);
    expect(result[0]).toBe(0x08); // (1 << 3) | 0
    expect(result[1]).toBe(42);
  });

  test("encodeBoolField encodes true/false", () => {
    // Field 4, wire type 0 -> tag = 0x20
    expect(encodeBoolField(4, true)).toEqual(new Uint8Array([0x20, 0x01]));
    expect(encodeBoolField(4, false)).toEqual(new Uint8Array([0x20, 0x00]));
  });

  test("encodeDoubleField encodes 64-bit float", () => {
    // Field 2, wire type 1 -> tag = 0x11
    const result = encodeDoubleField(2, 1.5);
    expect(result[0]).toBe(0x11); // (2 << 3) | 1
    expect(result.length).toBe(9); // 1 byte tag + 8 bytes double
  });

  test("concatBytes combines multiple arrays", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = new Uint8Array([6]);
    expect(concatBytes(a, b, c)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test("concatBytes handles empty arrays", () => {
    expect(concatBytes(new Uint8Array(0), new Uint8Array([1]))).toEqual(
      new Uint8Array([1])
    );
  });
});

describe("google.protobuf.Value encoding", () => {
  test("encodes null as empty (NullValue = 0 is omitted per protobuf convention)", () => {
    const result = encodeProtobufValue(null);
    expect(result.length).toBe(0);
  });

  test("encodes undefined as empty (same as null)", () => {
    const result = encodeProtobufValue(undefined);
    expect(result.length).toBe(0);
  });

  test("encodes number as double", () => {
    // Field 2 (number_value), wire type 1 -> tag = 0x11
    const result = encodeProtobufValue(42.5);
    expect(result[0]).toBe(0x11);
    expect(result.length).toBe(9);
  });

  test("encodes string", () => {
    // Field 3 (string_value), wire type 2 -> tag = 0x1a
    const result = encodeProtobufValue("test");
    expect(result[0]).toBe(0x1a); // (3 << 3) | 2
    expect(result[1]).toBe(4); // length
    expect(result.slice(2)).toEqual(new TextEncoder().encode("test"));
  });

  test("encodes boolean", () => {
    // Field 4 (bool_value), wire type 0 -> tag = 0x20
    const trueResult = encodeProtobufValue(true);
    expect(trueResult).toEqual(new Uint8Array([0x20, 0x01]));

    const falseResult = encodeProtobufValue(false);
    expect(falseResult).toEqual(new Uint8Array([0x20, 0x00]));
  });

  test("encodes array as ListValue", () => {
    // Field 6 (list_value), wire type 2 -> tag = 0x32
    const result = encodeProtobufValue([1, 2]);
    expect(result[0]).toBe(0x32); // (6 << 3) | 2
    // Contains nested structure with repeated Value messages
    expect(result.length).toBeGreaterThan(2);
  });

  test("encodes object as Struct", () => {
    // Field 5 (struct_value), wire type 2 -> tag = 0x2a
    const result = encodeProtobufValue({ key: "value" });
    expect(result[0]).toBe(0x2a); // (5 << 3) | 2
    expect(result.length).toBeGreaterThan(2);
  });
});

describe("BidiRequestId encoding", () => {
  test("encodeBidiRequestId encodes request_id as field 1 string", () => {
    const requestId = "req-abc-123";
    const result = encodeBidiRequestId(requestId);

    // Field 1, wire type 2 (string) -> tag = 0x0a
    expect(result[0]).toBe(0x0a);
    expect(result[1]).toBe(requestId.length);
    expect(result.slice(2)).toEqual(new TextEncoder().encode(requestId));
  });

  test("encodeBidiRequestId handles UUID-style ids", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = encodeBidiRequestId(uuid);

    expect(result[0]).toBe(0x0a);
    expect(result[1]).toBe(uuid.length);
    expect(new TextDecoder().decode(result.slice(2))).toBe(uuid);
  });
});

describe("BidiAppendRequest encoding", () => {
  test("encodeBidiAppendRequest encodes all three fields", () => {
    const data = "0a0b68656c6c6f"; // hex-encoded protobuf
    const requestId = "req-123";
    const seqno = 1n;

    const result = encodeBidiAppendRequest(data, requestId, seqno);

    // Should contain:
    // - Field 1 (data): string with hex content
    // - Field 2 (request_id): nested BidiRequestId message
    // - Field 3 (append_seqno): int64

    // Verify it's non-empty and starts with field 1 tag
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toBe(0x0a); // field 1, wire type 2

    // Verify hex dump produces valid output
    const hex = hexDump(result);
    expect(typeof hex).toBe("string");
    expect(hex.length).toBeGreaterThan(0);
  });

  test("encodeBidiAppendRequest handles multi-byte seqno", () => {
    const data = "aabb";
    const requestId = "req-456";
    const seqno = 300n; // requires 2 bytes to encode

    const result = encodeBidiAppendRequest(data, requestId, seqno);

    // Should encode successfully
    expect(result.length).toBeGreaterThan(10);
  });

  test("encodeBidiAppendRequest structure can be decoded conceptually", () => {
    const data = "deadbeef";
    const requestId = "test-req";
    const seqno = 42n;

    const result = encodeBidiAppendRequest(data, requestId, seqno);

    // Parse structure manually to verify format:
    // Field 1 (data string)
    expect(result[0]).toBe(0x0a); // (1 << 3) | 2
    const dataLen = result[1];
    expect(dataLen).toBe(data.length);

    // After data comes field 2 (request_id message)
    const field2Start = 2 + dataLen;
    expect(result[field2Start]).toBe(0x12); // (2 << 3) | 2

    // Field 3 (append_seqno) comes after the nested message
    // Just verify the result ends with the seqno encoding
    const hex = hexDump(result);
    expect(hex).toContain("18"); // field 3 tag in hex: (3 << 3) | 0 = 0x18
  });
});

describe("hexDump utility", () => {
  test("converts bytes to hex string", () => {
    expect(hexDump(new Uint8Array([0x00, 0xff, 0xab]))).toBe("00ffab");
  });

  test("handles empty array", () => {
    expect(hexDump(new Uint8Array(0))).toBe("");
  });
});

describe("ResumeAction encoding", () => {
  test("encodeResumeAction returns empty message", () => {
    const result = encodeResumeAction();
    expect(result.length).toBe(0);
  });

  test("encodeConversationActionWithResume wraps empty ResumeAction in field 2", () => {
    const result = encodeConversationActionWithResume();
    // ConversationAction.resume_action is field 2, wire type 2 -> tag = 0x12
    // Empty message has length 0
    expect(result[0]).toBe(0x12); // (2 << 3) | 2
    expect(result[1]).toBe(0x00); // length = 0
    expect(result.length).toBe(2);
  });

  test("encodeAgentClientMessageWithConversationAction wraps in field 4", () => {
    const conversationAction = encodeConversationActionWithResume();
    const result = encodeAgentClientMessageWithConversationAction(conversationAction);
    
    // AgentClientMessage.conversation_action is field 4, wire type 2 -> tag = 0x22
    expect(result[0]).toBe(0x22); // (4 << 3) | 2
    expect(result[1]).toBe(conversationAction.length); // length of nested message
    expect(Buffer.from(result.slice(2)).toString("hex")).toBe(Buffer.from(conversationAction).toString("hex"));
  });

  test("full ResumeAction message chain encodes correctly", () => {
    const resumeAction = encodeResumeAction();
    const conversationAction = encodeConversationActionWithResume();
    const agentClientMessage = encodeAgentClientMessageWithConversationAction(conversationAction);
    
    // Expected structure:
    // AgentClientMessage { conversation_action: ConversationAction { resume_action: ResumeAction {} } }
    // Hex: 22 02 12 00
    //   22 = field 4, wire type 2 (AgentClientMessage.conversation_action)
    //   02 = length 2
    //   12 = field 2, wire type 2 (ConversationAction.resume_action)
    //   00 = length 0 (empty ResumeAction)
    
    expect(hexDump(agentClientMessage)).toBe("22021200");
  });
});
