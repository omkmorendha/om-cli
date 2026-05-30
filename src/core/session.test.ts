import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Session,
  generateSessionId,
  replayTranscript,
  type TranscriptRecord,
} from "./session.ts";
import type { Message, ToolCall } from "./types.ts";
import { ToolResult } from "./types.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "om-session-"));
}

function readRecords(path: string): TranscriptRecord[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as TranscriptRecord);
}

describe("generateSessionId", () => {
  test("is sortable by creation time and unique within a millisecond", () => {
    const a = generateSessionId(1000);
    const b = generateSessionId(2000);
    expect(a < b).toBe(true);

    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(generateSessionId(5000));
    // Same timestamp, distinct random suffixes => no collisions in practice.
    expect(ids.size).toBe(200);
    // All share the same sortable timestamp prefix.
    for (const id of ids) expect(id.startsWith("0000000005000-")).toBe(true);
  });
});

describe("Session.append", () => {
  test("builds the canonical text messages and tracks them in order", () => {
    const s = new Session({ transcriptDir: null, systemPrompt: "be brief" });
    s.appendUserText("hello");
    s.appendAssistantText("hi there");

    expect(s.systemPrompt).toBe("be brief");
    expect(s.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]);
  });

  test("append stores the exact message reference passed in", () => {
    const s = new Session({ transcriptDir: null });
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "let me read that" },
        { type: "tool_call", call: { id: "c1", name: "read", input: { path: "x" } } },
      ],
    };
    s.append(msg);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toBe(msg);
  });
});

describe("Session.appendToolResult", () => {
  test("appends a user message with a tool_result block keyed by callId", () => {
    const s = new Session({ transcriptDir: null });
    const call: ToolCall = { id: "call_42", name: "read", input: { path: "a.ts" } };
    const result = ToolResult.ok("142 lines");
    s.appendToolResult(call, result);

    expect(s.messages).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", callId: "call_42", result }],
      },
    ]);
  });

  test("denied/error results round-trip through the canonical block", () => {
    const s = new Session({ transcriptDir: null });
    const call: ToolCall = { id: "c9", name: "bash", input: { cmd: "rm -rf /" } };
    s.appendToolResult(call, ToolResult.denied(call, "too scary"));

    const block = s.messages[0]!.content[0]!;
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.callId).toBe("c9");
      expect(block.result.ok).toBe(false);
      expect(block.result.meta).toEqual({ denied: true });
    }
  });
});

describe("Session.addUsage", () => {
  test("accumulates usage across calls", () => {
    const s = new Session({ transcriptDir: null });
    expect(s.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    s.addUsage({ inputTokens: 10, outputTokens: 3 });
    s.addUsage({ inputTokens: 5, outputTokens: 7 });
    expect(s.usage).toEqual({ inputTokens: 15, outputTokens: 10 });
  });
});

describe("Session transcript", () => {
  test("writes a session header then one JSONL line per mutation", async () => {
    const dir = tmpDir();
    const s = new Session({
      sessionId: "sess1",
      transcriptDir: dir,
      systemPrompt: "sys",
    });
    s.appendUserText("hello");
    const call: ToolCall = { id: "t1", name: "read", input: { path: "a" } };
    s.appendToolResult(call, ToolResult.ok("ok"));
    s.addUsage({ inputTokens: 4, outputTokens: 2 });
    await s.close();

    const path = join(dir, "sess1.jsonl");
    expect(s.transcriptPath).toBe(path);
    expect(existsSync(path)).toBe(true);

    const recs = readRecords(path);
    // header + user message + tool_result message + usage
    expect(recs.map((r) => r.kind)).toEqual([
      "session",
      "message",
      "message",
      "usage",
    ]);

    const header = recs[0]!;
    expect(header.kind).toBe("session");
    if (header.kind === "session") {
      expect(header.sessionId).toBe("sess1");
      expect(header.systemPrompt).toBe("sys");
    }

    const usage = recs[3]!;
    expect(usage.kind).toBe("usage");
    if (usage.kind === "usage") {
      expect(usage.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
      expect(usage.total).toEqual({ inputTokens: 4, outputTokens: 2 });
    }

    for (const r of recs) expect(typeof r.ts).toBe("string");
  });

  test("can be disabled: no file is written and path is null", async () => {
    const dir = tmpDir();
    const s = new Session({ sessionId: "off", transcriptDir: null });
    s.appendUserText("nothing on disk");
    s.addUsage({ inputTokens: 1, outputTokens: 1 });
    await s.close();

    expect(s.transcriptPath).toBeNull();
    expect(existsSync(join(dir, "off.jsonl"))).toBe(false);
  });
});

describe("replayTranscript", () => {
  test("rebuilds the canonical message list, skipping header/usage records", async () => {
    const dir = tmpDir();
    const s = new Session({
      sessionId: "replay",
      transcriptDir: dir,
      systemPrompt: "sys",
    });
    s.appendUserText("first");
    s.appendAssistantText("second");
    const call: ToolCall = { id: "tc", name: "read", input: {} };
    s.appendToolResult(call, ToolResult.ok("done"));
    s.addUsage({ inputTokens: 9, outputTokens: 9 });
    await s.close();

    const rebuilt = await replayTranscript(join(dir, "replay.jsonl"));
    expect(rebuilt).toEqual(s.messages);
    expect(rebuilt).toHaveLength(3);
  });

  test("returns [] for a missing transcript file", async () => {
    const rebuilt = await replayTranscript(join(tmpDir(), "does-not-exist.jsonl"));
    expect(rebuilt).toEqual([]);
  });

  test("tolerates a torn final line", async () => {
    const dir = tmpDir();
    const path = join(dir, "torn.jsonl");
    const good: TranscriptRecord = {
      ts: "2026-05-30T00:00:00.000Z",
      kind: "message",
      message: { role: "user", content: [{ type: "text", text: "ok" }] },
    };
    await Bun.write(path, JSON.stringify(good) + "\n" + '{"kind":"message","mess');

    const rebuilt = await replayTranscript(path);
    expect(rebuilt).toEqual([good.message]);
  });
});
