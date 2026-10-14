// 로컬 개인 "오늘 할 일" 표. 서버에 올리지 않고 SQLite에만 둔다.
// 패널 표 + 에이전트 plan_ops 가 같이 쓴다. 영업일 아침 첫 실행에 작성을 요청한다.
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { isBusinessDay, kstDate } from "./calendar.ts";

export type PlanItem = { id: string; title: string; done: boolean };
export type DailyPlan = { date: string; items: PlanItem[]; asked: boolean };
export type PlanOp =
  | { op: "add"; title: string }
  | { op: "toggle"; id: string; done?: boolean }
  | { op: "edit"; id: string; title?: string; done?: boolean }
  | { op: "remove"; id: string };

const TITLE_MAX = 300;
const MAX_ITEMS = 80;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_plan (
  date TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL,
  PRIMARY KEY (date, id)
);
CREATE INDEX IF NOT EXISTS daily_plan_date ON daily_plan(date, sort);
CREATE TABLE IF NOT EXISTS daily_plan_meta (
  date TEXT PRIMARY KEY, asked INTEGER NOT NULL DEFAULT 0
);
`;

export const PLAN_OPS_SCHEMA = {
  type: "array",
  description: "오늘 할 일 표(패널 '오늘 할 일')를 바꿀 때. 할 일 탭(todos)이 아니라 오늘 표다. 일정·회의를 보고 오늘 할 일을 적어 달라면 add. 없으면 빈 배열.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["op"],
    properties: {
      op: { type: "string", enum: ["add", "toggle", "edit", "remove"] },
      id: { type: "string", description: "toggle·edit·remove 때 오늘 표의 id" },
      title: { type: "string", description: "add·edit 때 제목" },
      done: { type: "boolean" },
    },
  },
} as const;

const tidy = (v: string) => v.replace(/\s+/g, " ").trim();

export function parsePlanItems(raw: unknown): { items: PlanItem[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "items must be an array" };
  if (raw.length > MAX_ITEMS) return { error: `items: at most ${MAX_ITEMS}` };
  const out: PlanItem[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return { error: "item must be an object" };
    const extra = Object.keys(x).filter((k) => !["id", "title", "done"].includes(k));
    if (extra.length) return { error: `unknown item key: ${extra[0]}` };
    const title = typeof (x as any).title === "string" ? tidy((x as any).title) : "";
    if (!title) continue;
    if (title.length > TITLE_MAX) return { error: `title too long (max ${TITLE_MAX})` };
    let id = typeof (x as any).id === "string" ? (x as any).id.trim() : "";
    if (!id || id.length > 80) id = randomUUID().slice(0, 8);
    if (seen.has(id)) return { error: `duplicate id: ${id}` };
    seen.add(id);
    out.push({ id, title, done: (x as any).done === true });
  }
  return { items: out };
}

export class DailyPlanService {
  private store: Store;
  private now: () => Date;
  private holidays: string[];

  constructor(store: Store, opts: { now?: () => Date; holidays?: string[] } = {}) {
    this.store = store;
    this.now = opts.now ?? (() => new Date());
    this.holidays = opts.holidays ?? [];
    store.db.exec(SCHEMA);
  }

  private today() { return kstDate(this.now()); }

  state(date = this.today()): DailyPlan {
    const items = (this.store.db.prepare("SELECT id, title, done FROM daily_plan WHERE date = ? ORDER BY sort, id").all(date) as any[])
      .map((r) => ({ id: r.id, title: r.title, done: !!r.done }));
    const meta = this.store.db.prepare("SELECT asked FROM daily_plan_meta WHERE date = ?").get(date) as { asked?: number } | undefined;
    return { date, items, asked: !!meta?.asked };
  }

  save(items: PlanItem[], date = this.today()): { ok: true; plan: DailyPlan } | { ok: false; message: string } {
    if (items.length > MAX_ITEMS) return { ok: false, message: `오늘은 ${MAX_ITEMS}개까지예요` };
    const db = this.store.db;
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM daily_plan WHERE date = ?").run(date);
      const ins = db.prepare("INSERT INTO daily_plan (date, id, title, done, sort) VALUES (?, ?, ?, ?, ?)");
      items.forEach((it, i) => ins.run(date, it.id, it.title, it.done ? 1 : 0, i));
      db.prepare("INSERT INTO daily_plan_meta (date, asked) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET asked = 1").run(date);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return { ok: false, message: String((e as any)?.message ?? e).slice(0, 200) };
    }
    return { ok: true, plan: this.state(date) };
  }

  add(title: string, date = this.today()): { ok: true; item: PlanItem; plan: DailyPlan } | { ok: false; message: string } {
    const t = tidy(title);
    if (!t) return { ok: false, message: "제목이 비어 있어요" };
    if (t.length > TITLE_MAX) return { ok: false, message: "제목이 너무 길어요" };
    const cur = this.state(date);
    if (cur.items.length >= MAX_ITEMS) return { ok: false, message: `오늘은 ${MAX_ITEMS}개까지예요` };
    const item: PlanItem = { id: randomUUID().slice(0, 8), title: t, done: false };
    const r = this.save([...cur.items, item], date);
    if (!r.ok) return r;
    return { ok: true, item, plan: r.plan };
  }

  applyOps(ops: PlanOp[], date = this.today()): { applied: string[]; errors: string[]; plan: DailyPlan } {
    let items = this.state(date).items;
    const applied: string[] = [];
    const errors: string[] = [];
    for (const op of ops) {
      if (op.op === "add") {
        const t = tidy(op.title ?? "");
        if (!t) { errors.push("추가할 제목이 없어요"); continue; }
        if (items.length >= MAX_ITEMS) { errors.push("오늘 표가 가득 찼어요"); continue; }
        items = [...items, { id: randomUUID().slice(0, 8), title: t.slice(0, TITLE_MAX), done: false }];
        applied.push(`추가: ${t.slice(0, 40)}`);
        continue;
      }
      const i = items.findIndex((x) => x.id === op.id);
      if (i < 0) { errors.push(`오늘 표에서 "${op.id}"를 못 찾았어요`); continue; }
      if (op.op === "remove") {
        applied.push(`지움: ${items[i].title.slice(0, 40)}`);
        items = items.filter((_, j) => j !== i);
        continue;
      }
      if (op.op === "toggle") {
        const done = op.done !== undefined ? !!op.done : !items[i].done;
        items = items.map((x, j) => (j === i ? { ...x, done } : x));
        applied.push(done ? `끝냄: ${items[i].title.slice(0, 40)}` : `다시 열음: ${items[i].title.slice(0, 40)}`);
        continue;
      }
      const title = op.title !== undefined ? tidy(op.title) : items[i].title;
      if (!title) { errors.push("제목이 비어 있어요"); continue; }
      const done = op.done !== undefined ? !!op.done : items[i].done;
      items = items.map((x, j) => (j === i ? { ...x, title: title.slice(0, TITLE_MAX), done } : x));
      applied.push(`고침: ${title.slice(0, 40)}`);
    }
    this.save(items, date);
    return { applied, errors, plan: this.state(date) };
  }

  // 영업일, 그날 앱을 처음 열면 작성 요청. 이미 물었으면 조용히.
  askMorning(): DailyPlan | null {
    const date = this.today();
    if (!isBusinessDay(date, this.holidays)) return null;
    const s = this.state(date);
    if (s.asked) return null;
    this.store.db.prepare("INSERT INTO daily_plan_meta (date, asked) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET asked = 1").run(date);
    return this.state(date);
  }
}
