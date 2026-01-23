import { parseProtoFields } from "./decoding";
import type { ParsedToolCall, ParsedToolCallStarted, ParsedPartialToolCall } from "./types";

export const TOOL_FIELD_MAP: Record<number, { type: string; name: string }> = {
  1: { type: "shell_tool_call", name: "bash" },
  3: { type: "delete_tool_call", name: "delete" },
  4: { type: "glob_tool_call", name: "glob" },
  5: { type: "grep_tool_call", name: "grep" },
  8: { type: "read_tool_call", name: "read" },
  9: { type: "update_todos_tool_call", name: "todowrite" },
  10: { type: "read_todos_tool_call", name: "todoread" },
  12: { type: "edit_tool_call", name: "edit" },
  13: { type: "ls_tool_call", name: "list" },
  14: { type: "read_lints_tool_call", name: "read_lints" },
  15: { type: "mcp_tool_call", name: "mcp" },
  16: { type: "sem_search_tool_call", name: "semantic_search" },
  17: { type: "create_plan_tool_call", name: "create_plan" },
  18: { type: "web_search_tool_call", name: "web_search" },
  19: { type: "task_tool_call", name: "task" },
  20: { type: "list_mcp_resources_tool_call", name: "list_mcp_resources" },
  21: { type: "read_mcp_resource_tool_call", name: "read_mcp_resource" },
  22: { type: "apply_agent_diff_tool_call", name: "apply_diff" },
  23: { type: "ask_question_tool_call", name: "ask_question" },
  24: { type: "fetch_tool_call", name: "webfetch" },
  25: { type: "switch_mode_tool_call", name: "switch_mode" },
  26: { type: "exa_search_tool_call", name: "exa_search" },
  27: { type: "exa_fetch_tool_call", name: "exa_fetch" },
  28: { type: "generate_image_tool_call", name: "generate_image" },
  29: { type: "record_screen_tool_call", name: "record_screen" },
  30: { type: "computer_use_tool_call", name: "computer_use" },
};

export const TOOL_ARG_SCHEMA: Record<string, Record<number, string>> = {
  shell_tool_call: { 1: "command", 2: "description", 3: "working_directory" },
  delete_tool_call: { 1: "filePath" },
  glob_tool_call: { 1: "pattern", 2: "path" },
  grep_tool_call: { 1: "pattern", 2: "path", 3: "include" },
  read_tool_call: { 1: "filePath", 2: "offset", 3: "limit" },
  update_todos_tool_call: { 1: "todos" },
  read_todos_tool_call: {},
  edit_tool_call: { 1: "filePath", 2: "oldString", 3: "newString", 4: "replaceAll" },
  ls_tool_call: { 1: "path", 2: "ignore" },
  read_lints_tool_call: {},
  mcp_tool_call: { 1: "provider_identifier", 2: "tool_name", 3: "tool_call_id", 4: "args" },
  sem_search_tool_call: { 1: "query", 2: "path" },
  create_plan_tool_call: { 1: "plan" },
  web_search_tool_call: { 1: "query" },
  task_tool_call: { 1: "description", 2: "prompt", 3: "subagent_type" },
  list_mcp_resources_tool_call: { 1: "provider_identifier" },
  read_mcp_resource_tool_call: { 1: "provider_identifier", 2: "uri" },
  apply_agent_diff_tool_call: { 1: "filePath", 2: "diff" },
  ask_question_tool_call: { 1: "question" },
  fetch_tool_call: { 1: "url", 2: "format" },
  switch_mode_tool_call: { 1: "mode" },
  exa_search_tool_call: { 1: "query" },
  exa_fetch_tool_call: { 1: "url" },
  generate_image_tool_call: { 1: "prompt" },
  record_screen_tool_call: { 1: "duration" },
  computer_use_tool_call: { 1: "action", 2: "text", 3: "coordinate" },
};

export function parseToolCall(data: Uint8Array): ParsedToolCall {
  const fields = parseProtoFields(data);
  let toolType = "unknown";
  let name = "unknown";
  const args: Record<string, unknown> = {};

  for (const field of fields) {
    const toolInfo = TOOL_FIELD_MAP[field.fieldNumber];
    if (toolInfo && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolType = toolInfo.type;
      name = toolInfo.name;

      const argSchema = TOOL_ARG_SCHEMA[toolType] || {};
      const toolFields = parseProtoFields(field.value);

      for (const tf of toolFields) {
        const argName = argSchema[tf.fieldNumber] || `field_${tf.fieldNumber}`;

        if (tf.wireType === 2 && tf.value instanceof Uint8Array) {
          try {
            let strValue = new TextDecoder().decode(tf.value);

            if (tf.value.length > 2 && tf.value[0] === 0x0a) {
              const nestedFields = parseProtoFields(tf.value);
              for (const nf of nestedFields) {
                if (nf.fieldNumber === 1 && nf.wireType === 2 && nf.value instanceof Uint8Array) {
                  strValue = new TextDecoder().decode(nf.value);
                  break;
                }
              }
            }

            args[argName] = strValue;
          } catch {
            args[argName] = `<binary:${tf.value.length}bytes>`;
          }
        } else if (tf.wireType === 0) {
          if (argName === "replaceAll") {
            args[argName] = tf.value === 1;
          } else {
            args[argName] = tf.value;
          }
        }
      }
      break;
    }
  }

  // Ensure bash tool calls have a description (required by OpenCode)
  if (name === "bash" && !args.description) {
    args.description = "Execute shell command";
  }

  return { toolType, name, arguments: args };
}

export function parseToolCallStartedUpdate(data: Uint8Array): ParsedToolCallStarted {
  const fields = parseProtoFields(data);
  let callId = "";
  let modelCallId = "";
  let toolCall: ParsedToolCall | null = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      callId = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolCall = parseToolCall(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      modelCallId = new TextDecoder().decode(field.value);
    }
  }

  return { callId, modelCallId, toolCall };
}

export function parsePartialToolCallUpdate(data: Uint8Array): ParsedPartialToolCall {
  const fields = parseProtoFields(data);
  let callId = "";
  let modelCallId = "";
  let argsTextDelta = "";
  let toolCall: ParsedToolCall | null = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      callId = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      toolCall = parseToolCall(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      argsTextDelta = new TextDecoder().decode(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
      modelCallId = new TextDecoder().decode(field.value);
    }
  }

  return { callId, modelCallId, argsTextDelta, toolCall };
}
