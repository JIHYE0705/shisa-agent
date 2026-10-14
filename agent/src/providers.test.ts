import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, loadConfig } from "./config.ts";
import { SCHEMA, ask, think } from "./brain.ts";
import { Store } from "./store.ts";
import {
  ANTHROPIC_URL, MISSING_ANTHROPIC_KEY, GEMINI_DEFAULT_MODEL, MISSING_CODEX, MISSING_GEMINI_KEY, MISSING_OPENAI_KEY, OPENAI_DEFAULT_MODEL, OPENAI_URL,
  type ExecFileLike, type FetchLike, parseCodexStdout, resolveHttpModel,
} from "./providers.ts";

const KEY = "unit-test-gemini-key";
const OAI = "unit-test-openai-key";

function thoughtJson(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ bubble: "안녕", reply_md: "본문", todos: [], done_todo_ids: [], proposals: [], ...extra });
}

function cfgOf(provider: "claude-code" | "codex" | "anthropic" | "gemini" | "openai" | "local", general = "claude-sonnet-5-5") {
  const base = loadConfig({});
  return { ...base, brain: { provider }, models: { ...base.models, general } };
}

test("loadConfig: 기본은 claude-code, 환경변수가 파일과 키보다 우선", () => {
  assert.ok(process.env.CY_AGENT_HOME && HOME_DIR === process.env.CY_AGENT_HOME && HOME_DIR.startsWith(tmpdir()), HOME_DIR);
  const path = join(HOME_DIR, "config.json");
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  const secret = "sk-test-not-a-real-key-1234567890abcdef";
  try {
    rmSync(path, { force: true });
    assert.equal(loadConfig({}).brain.provider, "claude-code");
    assert.equal(loadConfig({}).brain.geminiApiKey, undefined);
    assert.equal(loadConfig({}).models.general, "claude-sonnet-5-5");
    writeFileSync(path, JSON.stringify({ brain: { provider: "local", geminiApiKey: "file-gemini", openaiApiKey: "file-openai" }, models: { general: "claude-sonnet-5-5" } }));
    assert.equal(loadConfig({}).brain.provider, "local");
    assert.equal(loadConfig({ CY_AGENT_BRAIN: "openai" }).brain.provider, "openai");
    assert.equal(loadConfig({}).brain.geminiApiKey, "file-gemini");
    assert.equal(loadConfig({}).brain.openaiApiKey, "file-openai");
    assert.equal(loadConfig({ GEMINI_API_KEY: "env-gemini" }).brain.geminiApiKey, "env-gemini");
    assert.equal(loadConfig({ CY_AGENT_GEMINI_API_KEY: "ns-gemini", GEMINI_API_KEY: "env-gemini" }).brain.geminiApiKey, "ns-gemini");
    assert.equal(loadConfig({ CY_AGENT_GEMINI_API_KEY: "  " }).brain.geminiApiKey, "file-gemini");
    assert.equal(loadConfig({ OPENAI_API_KEY: "env-openai" }).brain.openaiApiKey, "env-openai");
    assert.equal(loadConfig({ CY_AGENT_OPENAI_API_KEY: "ns-openai", OPENAI_API_KEY: "env-openai" }).brain.openaiApiKey, "ns-openai");
    let hid = false;
    try { loadConfig({ CY_AGENT_BRAIN: secret }); } catch (e) {
      hid = true;
      assert.ok(e instanceof Error);
      assert.equal(e.message.includes(secret), false);
      assert.match(e.message, /brain\.provider/);
    }
    assert.equal(hid, true);
    assert.throws(() => loadConfig({ CY_AGENT_BRAIN: "nope" }), /nope/);
  } finally {
    if (prev === null) rmSync(path, { force: true });
    else writeFileSync(path, prev);
  }
});

test("HTTP 모델: general이 Claude 기본이면 싼 공식 모델, 직접 지정하면 그 이름", () => {
  assert.equal(resolveHttpModel("gemini", "claude-sonnet-5-5"), GEMINI_DEFAULT_MODEL);
  assert.equal(resolveHttpModel("openai", "claude-sonnet-5-5"), OPENAI_DEFAULT_MODEL);
  assert.equal(resolveHttpModel("gemini", "gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(resolveHttpModel("openai", "gpt-4.1"), "gpt-4.1");
  assert.equal(resolveHttpModel("gemini", "claude-sonnet-5-5", "gemini-2.0-flash"), "gemini-2.0-flash");
  assert.equal(GEMINI_DEFAULT_MODEL, "gemini-2.5-flash");
  assert.equal(OPENAI_DEFAULT_MODEL, "gpt-4.1-mini");
});

test("gemini: URL·헤더만, 도구 없음, 키는 오류에 없다", async () => {
  let calls = 0;
  const fetch: FetchLike = async (url, init) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(url.includes(KEY), false);
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers?.["x-goog-api-key"], KEY);
    const body = JSON.parse(init?.body ?? "{}");
    assert.equal(body.tools, undefined);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.ok(body.generationConfig.responseJsonSchema);
    assert.match(body.contents[0].parts[0].text, /브리핑 표식/);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: thoughtJson() }] } }] }), { status: 200 });
  };
  const out = await ask<{ reply_md: string }>(cfgOf("gemini"), "브리핑 표식", SCHEMA, undefined, { deps: { fetch, env: { CY_AGENT_GEMINI_API_KEY: KEY } } });
  assert.equal(calls, 1);
  assert.equal(out.reply_md, "본문");
});

test("gemini: 키가 없으면 한국어 오류, fetch도 local 폴백도 없다", async () => {
  let calls = 0;
  const fetch: FetchLike = async () => { calls++; return new Response("{}", { status: 200 }); };
  await assert.rejects(() => ask(cfgOf("gemini"), "안녕", SCHEMA, undefined, { deps: { fetch, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, MISSING_GEMINI_KEY);
    assert.equal(err.message.includes("안녕"), false);
    return true;
  });
  assert.equal(calls, 0);
});

test("gemini: 실패 본문과 예외 문자열에 키를 넣지 않는다", async () => {
  const boom: FetchLike = async () => { throw new Error(`network ${KEY}`); };
  await assert.rejects(() => ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: boom, env: { GEMINI_API_KEY: KEY } } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "Gemini 요청을 보내지 못했어요.");
    assert.equal(err.message.includes(KEY), false);
    return true;
  });
  const denied: FetchLike = async () => new Response(JSON.stringify({ error: KEY }), { status: 401 });
  await assert.rejects(() => ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: denied, env: { GEMINI_API_KEY: KEY } } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "Gemini 요청이 실패했어요 (HTTP 401).");
    assert.equal(err.message.includes(KEY), false);
    return true;
  });
});

test("openai: URL·Bearer·모델, 도구 없음", async () => {
  const fetch: FetchLike = async (url, init) => {
    assert.equal(url, OPENAI_URL);
    assert.equal(url.includes(OAI), false);
    assert.equal(init?.headers?.Authorization, `Bearer ${OAI}`);
    const body = JSON.parse(init?.body ?? "{}");
    assert.equal(body.model, "gpt-4.1-mini");
    assert.equal(body.tools, undefined);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    return new Response(JSON.stringify({ choices: [{ message: { content: thoughtJson() } }] }), { status: 200 });
  };
  const out = await ask<{ bubble: string }>(cfgOf("openai"), "채팅 표식", SCHEMA, undefined, { deps: { fetch, env: { OPENAI_API_KEY: OAI } } });
  assert.equal(out.bubble, "안녕");
});

test("anthropic(Claude API 키): Messages API · x-api-key · json_schema, 모델은 Claude 이름만, 도구 없음", async () => {
  const KEYA = "sk-ant-unit-test-key-1234567890";
  const seen: any[] = [];
  const fetch: FetchLike = async (url, init) => {
    assert.equal(url, ANTHROPIC_URL);
    assert.equal(init?.headers?.["x-api-key"], KEYA);
    assert.equal(init?.headers?.["anthropic-version"], "2023-06-01");
    const body = JSON.parse(init?.body ?? "{}");
    seen.push(body);
    assert.equal(body.tools, undefined);
    assert.equal(body.output_config.format.type, "json_schema");
    return new Response(JSON.stringify({ content: [{ type: "text", text: thoughtJson() }], stop_reason: "end_turn" }), { status: 200 });
  };
  const out = await ask<{ bubble: string }>(cfgOf("anthropic", "claude-haiku-5-5"), "채팅 표식", SCHEMA, undefined, { deps: { fetch, env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } });
  assert.equal(out.bubble, "안녕");
  assert.equal(seen[0].model, "claude-haiku-5-5");
  await ask(cfgOf("anthropic", "gemini-2.5-pro"), "x", SCHEMA, undefined, { deps: { fetch, env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } });
  assert.equal(seen[1].model, "claude-sonnet-5-5", "Claude 이름이 아니면 기본 Claude 모델");
  // 키가 없으면 한국어 오류 · fetch 없음, 실패에도 키는 없다
  let called = 0;
  await assert.rejects(ask(cfgOf("anthropic"), "x", SCHEMA, undefined, { deps: { fetch: async () => { called++; return new Response("", { status: 500 }); }, env: {} } }), (e: Error) => e.message === MISSING_ANTHROPIC_KEY);
  assert.equal(called, 0);
  await assert.rejects(ask(cfgOf("anthropic"), "x", SCHEMA, undefined, { deps: { fetch: async () => new Response(`bad ${KEYA}`, { status: 401 }), env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } }), (e: Error) => !e.message.includes(KEYA) && /401/.test(e.message));
  await assert.rejects(ask(cfgOf("anthropic"), "x", SCHEMA, undefined, { deps: { fetch: async () => new Response(JSON.stringify({ content: [], stop_reason: "refusal" }), { status: 200 }), env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } }), /답하지 않았어요/);
  // config: CY_AGENT_ANTHROPIC_API_KEY > 파일, ANTHROPIC_API_KEY 는 읽지 않는다
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-general" }).brain.anthropicApiKey, undefined);
  assert.equal(loadConfig({ CY_AGENT_ANTHROPIC_API_KEY: "sk-ant-ns" }).brain.anthropicApiKey, "sk-ant-ns");
  assert.equal(loadConfig({ CY_AGENT_BRAIN: "anthropic" }).brain.provider, "anthropic");
});

test("openai: 키가 없으면 한국어 오류", async () => {
  let calls = 0;
  const fetch: FetchLike = async () => { calls++; return new Response("{}", { status: 200 }); };
  await assert.rejects(() => ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, MISSING_OPENAI_KEY);
    assert.equal(err.message.includes(OAI), false);
    return true;
  });
  assert.equal(calls, 0);
});

test("codex: 없으면 한국어 오류이고 exec는 한 번도 없다", async () => {
  let execs = 0;
  const execFile: ExecFileLike = async () => { execs++; return { stdout: "" }; };
  await assert.rejects(() => ask(cfgOf("codex"), "x", SCHEMA, undefined, { deps: { commandExists: () => false, execFile, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, MISSING_CODEX);
    return true;
  });
  assert.equal(execs, 0);
});

test("codex: exec 한 번으로 JSONL Thought를 파싱하고 바이너리는 실행하지 않는다", async () => {
  const calls: { file: string; args: readonly string[]; input?: string }[] = [];
  const execFile: ExecFileLike = async (file, args, opts) => {
    calls.push({ file, args, input: opts?.input });
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: thoughtJson() } });
    return { stdout: `{"type":"thread.started"}\n${line}\n` };
  };
  const out = await ask<{ reply_md: string }>(cfgOf("codex"), "프롬프트-표식", SCHEMA, undefined, {
    deps: { commandExists: (name) => name === "codex", execFile, env: {} },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "codex");
  assert.ok(calls[0].args.includes("exec"));
  assert.ok(calls[0].args.includes("--json"));
  assert.ok(calls[0].args.includes("-"));
  assert.match(calls[0].input ?? "", /프롬프트-표식/);
  assert.equal(out.reply_md, "본문");
  assert.equal((parseCodexStdout(thoughtJson()) as { reply_md: string }).reply_md, "본문");
});

test("codex 출력이 JSON이 아니면 본문을 오류에 넣지 않는다", async () => {
  const secret = "codex-stdout-secret-value";
  const execFile: ExecFileLike = async () => ({ stdout: secret });
  await assert.rejects(() => ask(cfgOf("codex"), "x", SCHEMA, undefined, { deps: { commandExists: () => true, execFile, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "codex 출력에서 JSON을 읽지 못했어요.");
    assert.equal(err.message.includes(secret), false);
    return true;
  });
});

test("local think: 스토어의 1·3만 말하고 할 일을 만들지 않는다", async () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "a", title: "견적 회신", source: "other", priority: 1 });
  store.upsertTodo({ id: "b", title: "보면 좋은 글", source: "other", priority: 3 });
  store.upsertTodo({ id: "c", title: "나중 일", source: "other", priority: 2 });
  store.upsertTodo({ id: "d", title: "끝난 보고서", source: "other", priority: 2, status: "done" });
  const t = await think(cfgOf("local"), store, "정기 브리핑");
  assert.deepEqual(t.todos, []);
  assert.deepEqual(t.done_todo_ids, []);
  assert.deepEqual(t.proposals, []);
  assert.match(t.reply_md, /견적 회신/);
  assert.match(t.reply_md, /보면 좋은 글/);
  assert.match(t.reply_md, /끝난 보고서/);
  assert.doesNotMatch(t.reply_md, /나중 일/);
  assert.ok(t.bubble.length <= 40);
  assert.equal(t.bubble.includes("\n"), false);
});

test("local ask: 브리핑·채팅 스키마가 아니면 SDK 없이 거절한다", async () => {
  await assert.rejects(() => ask(cfgOf("local"), "설명", { type: "object", required: ["description"] }, undefined, { deps: { env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "로컬 뇌는 브리핑·채팅만 답해요.");
    return true;
  });
});
