import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFileLog, redactLog } from "./log.ts";

test("데몬 로그는 토큰을 가린다", () => {
  const s = redactLog("ok xoxb-123456789012-abcdefghijk sk-abcdefghijklmnopqrstuvwxyz0123456789 https://x/a.ics?k=1");
  assert.match(s, /ok /);
  assert.equal(s.includes("xoxb-123456789012"), false);
  assert.equal(s.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(s.includes("a.ics"), false);
});

test("installFileLog: 파일에 남기고 토큰은 안 쓴다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-daemon-log-"));
  const restore = installFileLog(dir);
  try {
    console.log("hello xoxp-111-222-333-abcdefgh");
    const text = readFileSync(join(dir, "daemon.log"), "utf8");
    assert.match(text, /hello/);
    assert.equal(text.includes("xoxp-111-222-333-abcdefgh"), false);
  } finally {
    restore();
  }
});

test("installFileLog: 커지면 이전 파일로 돌린다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-daemon-rot-"));
  writeFileSync(join(dir, "daemon.log"), "x".repeat(256 * 1024 + 10));
  const restore = installFileLog(dir);
  try {
    console.warn("rotated");
    assert.equal(existsSync(join(dir, "daemon.log.1")), true);
    assert.match(readFileSync(join(dir, "daemon.log"), "utf8"), /rotated/);
  } finally {
    restore();
  }
});
