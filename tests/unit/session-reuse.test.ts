import { describe, expect, test } from "bun:test";
import type { ExecRequest } from "../../src/lib/api/agent-service";
import {
  cleanupExpiredSessions,
  collectToolMessages,
  createSessionId,
  findSessionIdInMessages,
  makeToolCallId,
  mapExecRequestToTool,
  parseSessionIdFromToolCallId,
  selectCallBase,
  sendToolResultsToCursor,
  type SessionLike,
} from "../../src/lib/session-reuse";

function makeIterator(onReturn: () => void): AsyncIterator<any> {
  return {
    async next() {
      return { done: true, value: undefined };
    },
    async return() {
      onReturn();
      return { done: true, value: undefined };
    },
  };
}

describe("session id helpers", () => {
  test("tool_call id round-trip", () => {
    const sid = createSessionId();
    const tcid = makeToolCallId(sid, "abc123");
    expect(parseSessionIdFromToolCallId(tcid)).toBe(sid);
  });

  test("find session id prefers latest tool message", () => {
    const sid = "sess123";
    const messages = [
      { role: "assistant" as const, content: null, tool_calls: [{ id: "sess_old__call_x", function: {} }] },
      { role: "tool" as const, content: "ok", tool_call_id: `sess_${sid}__call_y` },
    ];
    expect(findSessionIdInMessages(messages)).toBe(sid);
  });

  test("collectToolMessages filters tool roles", () => {
    const toolMsg = { role: "tool" as const, content: "res", tool_call_id: "sess_x__call_1" };
    const messages = [{ role: "user" as const, content: "hi" }, toolMsg];
    expect(collectToolMessages(messages)).toEqual([toolMsg]);
  });
});

describe("exec mapping helpers", () => {
  test("selectCallBase strips non-alnum and truncates", () => {
    const execReq: ExecRequest = { type: "shell", id: 1, command: "echo hi", execId: "abc-123-xyz" } as any;
    const base = selectCallBase(execReq);
    expect(base).toBe("abc123xyz");
  });

  test("mapExecRequestToTool handles grep vs glob", () => {
    const grepReq: ExecRequest = { type: "grep", id: 1, pattern: "foo", path: "/tmp" } as any;
    const globReq: ExecRequest = { type: "grep", id: 2, glob: "**/*.ts", path: "/tmp" } as any;
    expect(mapExecRequestToTool(grepReq)).toEqual({ toolName: "grep", toolArgs: { pattern: "foo", path: "/tmp" } });
    expect(mapExecRequestToTool(globReq)).toEqual({ toolName: "glob", toolArgs: { pattern: "**/*.ts", path: "/tmp" } });
  });

  test("selectCallBase falls back to uuid when missing ids", () => {
    const execReq: ExecRequest = { type: "read", id: undefined as any, path: "/tmp/a" } as any;
    const base = selectCallBase(execReq);
    expect(base.length).toBeGreaterThan(0);
  });
});

describe("unknown exec requests", () => {
  test("mapExecRequestToTool returns nulls for unknown type", () => {
    const req: ExecRequest = { type: "custom" as any, id: 1 } as any;
    expect(mapExecRequestToTool(req)).toEqual({ toolName: null, toolArgs: null });
  });
});

describe("tool result forwarding", () => {
  test("sendToolResultsToCursor forwards shell results and clears pending", async () => {
    const now = Date.now();
    const toolCallId = "sess_demo__call_1";
    const execReq: ExecRequest = { type: "shell", id: 7, command: "echo hi", cwd: "/tmp" } as any;
    let called = false;

    const session: SessionLike = {
      id: "demo",
      iterator: makeIterator(() => {}),
      pendingExecs: new Map([[toolCallId, execReq]]),
      createdAt: now,
      lastActivity: now,
      state: "waiting_tool",
      client: {
        async sendToolResult() {
          throw new Error("should not be called");
        },
        async sendShellResult(_id, _execId, _cmd, _cwd, stdout, stderr, exitCode) {
          expect(stdout).toBe("ok");
          expect(stderr).toBe("");
          expect(exitCode).toBe(0);
          called = true;
        },
        async sendReadResult() {
          throw new Error("unexpected read");
        },
        async sendLsResult() {
          throw new Error("unexpected ls");
        },
        async sendGrepResult() {
          throw new Error("unexpected grep");
        },
        async sendWriteResult() {
          throw new Error("unexpected write");
        },
      },
    };

    const toolMessages = [
      {
        role: "tool" as const,
        tool_call_id: toolCallId,
        content: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }),
      },
    ];

    const ok = await sendToolResultsToCursor(session, toolMessages);
    expect(ok).toBe(true);
    expect(called).toBe(true);
    expect(session.pendingExecs.size).toBe(0);
    expect(session.state).toBe("running");
  });

  test("sendToolResultsToCursor ignores tool messages that do not match pending execs", async () => {
    const now = Date.now();
    const toolCallId = "sess_demo__call_1";
    const execReq: ExecRequest = { type: "shell", id: 7, command: "echo hi" } as any;
    const session: SessionLike = {
      id: "demo",
      iterator: makeIterator(() => {}),
      pendingExecs: new Map([[toolCallId, execReq]]),
      createdAt: now,
      lastActivity: now,
      state: "waiting_tool",
      client: {
        async sendToolResult() { throw new Error("unexpected"); },
        async sendShellResult() { throw new Error("unexpected"); },
        async sendReadResult() { throw new Error("unexpected"); },
        async sendLsResult() { throw new Error("unexpected"); },
        async sendGrepResult() { throw new Error("unexpected"); },
        async sendWriteResult() { throw new Error("unexpected"); },
      },
    };

    const toolMessages = [
      { role: "tool" as const, tool_call_id: "sess_other__call_1", content: "x" },
    ];

    const ok = await sendToolResultsToCursor(session, toolMessages);
    expect(ok).toBe(false);
    expect(session.pendingExecs.size).toBe(1);
    expect(session.state).toBe("waiting_tool");
    expect(session.lastActivity).toBe(now);
  });

  test("sendToolResultsToCursor processes matching tool messages even when unknown are present", async () => {
    const now = Date.now();
    const toolCallId = "sess_demo__call_1";
    const execReq: ExecRequest = { type: "shell", id: 7, command: "echo hi" } as any;
    let called = false;

    const session: SessionLike = {
      id: "demo",
      iterator: makeIterator(() => {}),
      pendingExecs: new Map([[toolCallId, execReq]]),
      createdAt: now,
      lastActivity: now,
      state: "waiting_tool",
      client: {
        async sendToolResult() {
          throw new Error("unexpected");
        },
        async sendShellResult(_id, _execId, _cmd, _cwd, stdout) {
          expect(stdout).toBe("ok");
          called = true;
        },
        async sendReadResult() {
          throw new Error("unexpected");
        },
        async sendLsResult() {
          throw new Error("unexpected");
        },
        async sendGrepResult() {
          throw new Error("unexpected");
        },
        async sendWriteResult() {
          throw new Error("unexpected");
        },
      },
    };

    const toolMessages = [
      { role: "tool" as const, tool_call_id: "sess_other__call_1", content: "ignored" },
      {
        role: "tool" as const,
        tool_call_id: toolCallId,
        content: JSON.stringify({ stdout: "ok" }),
      },
    ];

    const ok = await sendToolResultsToCursor(session, toolMessages);
    expect(ok).toBe(true);
    expect(called).toBe(true);
    expect(session.pendingExecs.size).toBe(0);
    expect(session.state).toBe("running");
    expect(session.lastActivity).toBeGreaterThanOrEqual(now);
  });

});

describe("cleanupExpiredSessions", () => {
  test("closes and removes expired sessions", async () => {
    let returned = false;
    const map = new Map<string, { iterator?: AsyncIterator<any>; lastActivity: number; createdAt?: number }>();
    map.set("old", { iterator: makeIterator(() => { returned = true; }), lastActivity: 0, createdAt: 0 });
    map.set("fresh", { iterator: makeIterator(() => {}), lastActivity: Date.now(), createdAt: Date.now() });

    await cleanupExpiredSessions(map as any, 1000, 2000);

    expect(map.has("old")).toBe(false);
    expect(map.has("fresh")).toBe(true);
    expect(returned).toBe(true);
  });
});
