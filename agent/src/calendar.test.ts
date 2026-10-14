import { test } from "node:test";
import assert from "node:assert/strict";
import { isBusinessDay, kstDate, kstMinutes, msUntilNext, prevBusinessDay } from "./calendar.ts";

const at = (iso: string) => new Date(iso);

test("kstDate·kstMinutes: UTC 15시는 KST 다음날 0시", () => {
  assert.equal(kstDate(at("2026-10-07T15:00:00Z")), "2026-10-08");
  assert.equal(kstDate(at("2026-10-07T14:59:59Z")), "2026-10-07");
  assert.equal(kstMinutes(at("2026-10-08T01:30:00Z")), 10 * 60 + 30);
});

test("isBusinessDay: 주말·공휴일·대체공휴일·추가 휴일", () => {
  assert.equal(isBusinessDay("2026-10-08"), true); // 목
  assert.equal(isBusinessDay("2026-10-09"), false); // 한글날
  assert.equal(isBusinessDay("2026-10-10"), false); // 토
  assert.equal(isBusinessDay("2026-10-05"), false); // 개천절 대체
  assert.equal(isBusinessDay("2026-07-17"), false); // 제헌절(2026 복귀)
  assert.equal(isBusinessDay("2026-06-08"), true); // 현충일은 대체 없음
  assert.equal(isBusinessDay("2027-02-09"), false); // 설날 대체
  assert.equal(isBusinessDay("2027-12-27"), false); // 성탄절 대체
  assert.equal(isBusinessDay("2026-10-08", ["2026-10-08"]), false);
  assert.equal(isBusinessDay(at("2026-10-09T00:00:00Z")), false); // Date도 KST로 본다
});

test("prevBusinessDay: 월요일 → 금요일, 연휴 건너뜀", () => {
  assert.equal(prevBusinessDay("2026-10-12"), "2026-10-08"); // 월 → (금 한글날, 주말) → 목
  assert.equal(prevBusinessDay("2026-10-06"), "2026-10-02"); // 화 → (월 대체, 주말) → 금
  assert.equal(prevBusinessDay("2026-09-29"), "2026-09-28");
});

test("msUntilNext: 오늘 전이면 오늘, 지났으면 다음 영업일", () => {
  // 목 10:00 KST → 오늘 10:30
  assert.equal(msUntilNext(10, 30, at("2026-10-08T01:00:00Z")), 30 * 60e3);
  // 목 10:30 정각 → 다음 영업일(금 한글날·주말 건너 월 10/12)
  const ms = msUntilNext(10, 30, at("2026-10-08T01:30:00Z"));
  assert.equal(new Date(at("2026-10-08T01:30:00Z").getTime() + ms).toISOString(), "2026-10-12T01:30:00.000Z");
  // 추석 연휴 직전(9/23 수 11시) → 9/28 월
  const ms2 = msUntilNext(10, 30, at("2026-09-23T02:00:00Z"));
  assert.equal(kstDate(new Date(at("2026-09-23T02:00:00Z").getTime() + ms2)), "2026-09-28");
});
