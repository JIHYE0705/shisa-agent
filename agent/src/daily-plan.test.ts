import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { DailyPlanService, parsePlanItems } from "./daily-plan.ts";

const WED = () => new Date("2026-10-07T01:00:00Z"); // KST 수요일 10:00

test("parsePlanItems: 빈 제목은 건너뛰고, 잘못된 값은 거절", () => {
  assert.deepEqual((parsePlanItems([{ title: "  회의 준비  " }]) as any).items?.[0].title, "회의 준비");
  assert.equal((parsePlanItems("x") as any).error, "items must be an array");
  assert.ok((parsePlanItems([{ title: "a", extra: 1 }]) as any).error);
});

test("DailyPlanService: 저장·토글·아침 질문은 영업일 한 번", () => {
  const store = new Store(":memory:");
  const p = new DailyPlanService(store, { now: WED });
  assert.equal(p.state().items.length, 0);
  const asked = p.askMorning();
  assert.ok(asked);
  assert.equal(p.askMorning(), null, "같은 날 두 번 안 묻는다");
  const r = p.save([{ id: "a", title: "리뷰", done: false }]);
  assert.equal(r.ok, true);
  const ops = p.applyOps([{ op: "add", title: "메일 답장" }, { op: "toggle", id: "a" }]);
  assert.equal(ops.plan.items.length, 2);
  assert.equal(ops.plan.items.find((x) => x.id === "a")?.done, true);
});
