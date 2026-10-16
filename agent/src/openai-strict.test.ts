import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";
import { ask, REQUEST_SCHEMA, SCHEMA, TEXT_SCHEMA } from "./brain.ts";
import { CHAT_SCHEMA, TITLE_SCHEMA } from "./chat.ts";
import { ASK_SCHEMA } from "./todo-ask.ts";
import { MERGE_ASK_SCHEMA } from "./reactions.ts";
import { DESC_SCHEMA } from "./todo-source.ts";
import { opPatch, TODO_OPS_SCHEMA, type TodoOp } from "./todos.ts";
import { CLEAR, STRICT_KEYWORDS, stripAddedNulls, toOpenAiStrict } from "./openai-strict.ts";
import { OPENAI_URL, type FetchLike } from "./providers.ts";

// 뇌 ask 로 실제 넘어가는 스키마 전부(정기 브리핑·DM·채팅·제목·팝오버·머지 질문·할 일 설명·슬래시 명령 글)
const BRAIN_SCHEMAS: Record<string, unknown> = { SCHEMA, REQUEST_SCHEMA, TEXT_SCHEMA, CHAT_SCHEMA, TITLE_SCHEMA, ASK_SCHEMA, MERGE_ASK_SCHEMA, DESC_SCHEMA };

// strict 규칙 위반을 경로와 함께 모은다
function strictErrors(s: unknown, path = "$", out: string[] = []): string[] {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return out;
  const o = s as Record<string, any>;
  for (const k of Object.keys(o)) if (!STRICT_KEYWORDS.has(k)) out.push(`${path}: 지원 안 하는 키워드 ${k}`);
  const isObject = o.type === "object" || (Array.isArray(o.type) && o.type.includes("object")) || o.properties;
  if (isObject) {
    if (o.additionalProperties !== false) out.push(`${path}: additionalProperties 가 false 가 아님`);
    const keys = Object.keys(o.properties ?? {}).sort();
    const req = [...(o.required ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(req)) out.push(`${path}: required ${req} ≠ properties ${keys}`);
  }
  for (const [k, v] of Object.entries(o.properties ?? {})) strictErrors(v, `${path}.${k}`, out);
  if (o.items) strictErrors(o.items, `${path}[]`, out);
  for (const [i, v] of (o.anyOf ?? []).entries()) strictErrors(v, `${path}|${i}`, out);
  for (const [k, v] of Object.entries(o.$defs ?? {})) strictErrors(v, `${path}$${k}`, out);
  return out;
}

test("toOpenAiStrict: 뇌에 넘어가는 스키마 전부 strict 규칙에 맞는다(원본은 그대로)", () => {
  for (const [name, s] of Object.entries(BRAIN_SCHEMAS)) {
    const before = JSON.stringify(s);
    const conv = toOpenAiStrict(s) as any;
    assert.equal(conv.type, "object", name);
    assert.deepEqual(strictErrors(conv), [], name);
    assert.equal(JSON.stringify(s), before, `${name} 원본이 바뀌면 안 된다`);
  }
  // 원본은 strict 규칙에 안 맞았다(400 원인) — 회귀 확인
  assert.ok(strictErrors(REQUEST_SCHEMA).length > 0);
  assert.ok(strictErrors(CHAT_SCHEMA).length > 0);
});

test("toOpenAiStrict: 선택 필드는 null 허용, 설명은 남기고 범위 키워드는 뺀다", () => {
  const c = toOpenAiStrict(SCHEMA) as any;
  const todo = c.properties.todos.items;
  assert.deepEqual(todo.properties.link.type, ["string", "null"]);
  assert.equal(todo.properties.key.type, "string", "원래 required 는 그대로");
  assert.equal(todo.properties.priority.minimum, undefined);
  assert.match(todo.properties.priority.description, /오늘 꼭/);
  assert.deepEqual(c.properties.plan_ops.anyOf.at(-1), { type: "null" });
  assert.match(c.properties.plan_ops.description, /오늘 할 일/);
  const mem = (toOpenAiStrict(REQUEST_SCHEMA) as any).properties.memory_ops.items.properties.category;
  assert.deepEqual(mem.type, ["string", "null"]);
  assert.equal(mem.enum.at(-1), null, "enum 에도 null");
  const ops = (toOpenAiStrict(TODO_OPS_SCHEMA) as any).items.properties;
  // 원래 null(지우기)을 받는 필드는 문자열만: 그대로 = 빈 문자열, 지우기 = CLEAR
  assert.deepEqual(ops.link.type, "string");
  assert.equal(ops.link.anyOf, undefined);
  assert.match(ops.link.description, /빈 문자열/);
  assert.ok(ops.link.description.includes(`"${CLEAR}"`));
  assert.doesNotMatch(ops.link.description, /null/);
  assert.match(ops.note.description, /^메모\./);
  assert.equal(TODO_OPS_SCHEMA.items.properties.link.anyOf.length, 2, "원본(Gemini·Claude)은 그대로 null 허용");
  const rule = (toOpenAiStrict(CHAT_SCHEMA) as any).properties.rule.anyOf[1];
  assert.deepEqual(rule.required.sort(), ["effect", "match", "text"]);
  assert.deepEqual(rule.properties.effect.required.sort(), ["backlog", "note", "priority", "skip"]);
  assert.deepEqual(toOpenAiStrict({ type: "object", properties: { a: { oneOf: [{ type: "string" }, { type: "integer" }] } } }),
    { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] } }, required: ["a"], additionalProperties: false });
});

test("stripAddedNulls: 덧붙인 null 만 빼고, 지우기(CLEAR)는 null 로", () => {
  const out = stripAddedNulls({
    reply_md: "r", bubble: "b", show: null, rule: null, guideline: null,
    todo_ops: [{ op: "edit", id: "t1", title: null, priority: null, link: CLEAR, note: "", description: null, source_ref: null }],
    memory_ops: [{ op: "remember", text: "x", category: null, id: null }],
    proposals: [{ repo: "/r", title: "t", plan: "p", base: null }],
  }, CHAT_SCHEMA);
  assert.deepEqual(out, {
    reply_md: "r", bubble: "b", show: null, rule: null, guideline: null,
    todo_ops: [{ op: "edit", id: "t1", link: null, note: "" }],
    memory_ops: [{ op: "remember", text: "x" }],
    proposals: [{ repo: "/r", title: "t", plan: "p" }],
  });
  const rule = stripAddedNulls({ rule: { text: "t", match: { description: "d", keywords: ["a"], sources: null, titleRegex: null }, effect: { priority: 4, backlog: null, skip: null, note: null } } }, ASK_SCHEMA);
  assert.deepEqual(rule, { rule: { text: "t", match: { description: "d", keywords: ["a"] }, effect: { priority: 4 } } });
  // 원래 required 인 키는 null 이어도 건드리지 않는다(검증은 받는 쪽에서)
  assert.deepEqual(stripAddedNulls({ bubble: null }, SCHEMA), { bubble: null });
});

test("openai todo_ops: 빈 문자열·null 은 링크·메모를 안 바꾸고, CLEAR 만 지운다", () => {
  const patch = (o: Record<string, unknown>) => {
    const [op] = stripAddedNulls([{ op: "edit", id: "t1", title: "", priority: null, link: "", note: "", description: "", source_ref: "", ...o }], TODO_OPS_SCHEMA) as TodoOp[];
    const p = opPatch(op);
    assert.ok(p.ok);
    return p.value;
  };
  assert.deepEqual(patch({}), {}, "빈 문자열은 그대로 두기");
  assert.deepEqual(patch({ link: null, note: null }), {}, "모델의 null 은 지우기가 아니다");
  assert.deepEqual(patch({ link: CLEAR }), { link: null });
  assert.deepEqual(patch({ note: CLEAR, link: "https://x.test/a" }), { note: null, link: "https://x.test/a" });
  assert.deepEqual(patch({ note: "새 메모" }), { note: "새 메모" });
  // Gemini·Claude 경로(stripAddedNulls 안 거침)는 그대로 null = 지우기
  const g = opPatch({ op: "edit", id: "t1", link: null, note: "" } as TodoOp);
  assert.ok(g.ok);
  assert.deepEqual(g.value, { link: null });
});

test("stripAddedNulls: __proto__·constructor·prototype 키는 버린다(프로토타입 오염 없음)", () => {
  const raw = JSON.parse('{"reply_md":"r","__proto__":{"polluted":1},"constructor":{"x":1},"prototype":2,"todo_ops":[{"op":"done","id":"t","__proto__":{"polluted":1}}]}');
  const out = stripAddedNulls(raw, CHAT_SCHEMA) as any;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.polluted, undefined);
  assert.equal(Object.hasOwn(out, "constructor"), false);
  assert.equal(Object.hasOwn(out, "prototype"), false);
  assert.equal(Object.getPrototypeOf(out.todo_ops[0]), Object.prototype);
  assert.equal(out.todo_ops[0].polluted, undefined);
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(out, { reply_md: "r", todo_ops: [{ op: "done", id: "t" }] });
});

const OAI = "unit-test-openai-key";
const GKEY = "unit-test-gemini-key";
function cfgOf(provider: "gemini" | "openai") {
  const base = loadConfig({});
  return { ...base, brain: { provider }, models: { ...base.models, general: "claude-sonnet-5-5" } };
}

test("openai: 보내는 스키마가 strict 에 맞고, null 채운 답이 Gemini 와 같은 모양으로 돌아온다", async () => {
  const shape = {
    bubble: "안녕", reply_md: "본문", done_todo_ids: [], proposals: [],
    todos: [{ key: "slack:C1:1", title: "답장", source: "slack", priority: 2 }],
    todo_ops: [{ op: "edit", id: "t1", link: null, note: "" }], plan_ops: [], memory_ops: [], rule: null,
  };
  const filled = {
    ...shape,
    todos: [{ ...shape.todos[0], link: null, description: null, source_ref: null }],
    todo_ops: [{ op: "edit", id: "t1", title: null, priority: null, link: CLEAR, note: "", description: null, source_ref: null }],
  };
  let sent: any;
  const oai: FetchLike = async (url, init) => {
    assert.equal(url, OPENAI_URL);
    sent = JSON.parse(init?.body ?? "{}");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(filled) } }] }), { status: 200 });
  };
  let gsent: any;
  const gem: FetchLike = async (_url, init) => {
    gsent = JSON.parse(init?.body ?? "{}");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(shape) }] } }] }), { status: 200 });
  };
  const a = await ask(cfgOf("openai"), "x", REQUEST_SCHEMA, undefined, { deps: { fetch: oai, env: { OPENAI_API_KEY: OAI } } });
  const g = await ask(cfgOf("gemini"), "x", REQUEST_SCHEMA, undefined, { deps: { fetch: gem, env: { CY_AGENT_GEMINI_API_KEY: GKEY } } });
  const js = sent.response_format.json_schema;
  assert.equal(js.strict, true);
  assert.deepEqual(strictErrors(js.schema), []);
  assert.deepEqual(gsent.generationConfig.responseJsonSchema, JSON.parse(JSON.stringify(REQUEST_SCHEMA)), "Gemini 는 원래 스키마 그대로");
  assert.deepEqual(a, shape);
  assert.deepEqual(g, shape);
});
