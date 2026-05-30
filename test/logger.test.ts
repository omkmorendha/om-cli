import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, nullLogger } from "../src/util/logger.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "om-log-"));
}

describe("logger", () => {
  test("writes JSONL records to the session file", async () => {
    const dir = tmpDir();
    const log = createLogger({ sessionId: "s1", dir, level: "silent" });
    log.info("hello", { a: 1 });
    log.warn("careful");
    await log.close();

    const path = join(dir, "s1.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.level).toBe("info");
    expect(first.scope).toBe("om");
    expect(first.msg).toBe("hello");
    expect(first.data).toEqual({ a: 1 });
    expect(typeof first.ts).toBe("string");

    const second = JSON.parse(lines[1]!);
    expect(second.level).toBe("warn");
  });

  test("child loggers compose their scope", async () => {
    const dir = tmpDir();
    const log = createLogger({ sessionId: "s2", dir, level: "silent" });
    log.child("tool").child("read").debug("x");
    await log.close();

    const rec = JSON.parse(readFileSync(join(dir, "s2.jsonl"), "utf8").trim());
    expect(rec.scope).toBe("om:tool:read");
  });

  test("redacts secret-looking keys", async () => {
    const dir = tmpDir();
    const log = createLogger({ sessionId: "s3", dir, level: "silent" });
    log.info("auth", { ANTHROPIC_API_KEY: "sk-secret", apiKey: "x", token: "t", path: "/ok" });
    await log.close();

    const rec = JSON.parse(readFileSync(join(dir, "s3.jsonl"), "utf8").trim());
    expect(rec.data.ANTHROPIC_API_KEY).toBe("«redacted»");
    expect(rec.data.apiKey).toBe("«redacted»");
    expect(rec.data.token).toBe("«redacted»");
    expect(rec.data.path).toBe("/ok");
  });

  test("console sink respects the level threshold", async () => {
    const dir = tmpDir();
    const lines: string[] = [];
    const log = createLogger({
      sessionId: "s4",
      dir,
      level: "warn",
      consoleSink: (l) => lines.push(l),
    });
    log.debug("nope");
    log.info("nope2");
    log.warn("yes");
    log.error("yes2");
    await log.close();

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("yes");
    expect(lines[1]).toContain("yes2");
  });

  test("nullLogger is a no-op and safe to close", async () => {
    const log = nullLogger();
    expect(() => {
      log.debug("x");
      log.child("y").error("z");
    }).not.toThrow();
    await log.close();
  });
});
