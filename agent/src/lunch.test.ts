import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LunchAlert, lunchAlertOf } from "./lunch.ts";
import { loadConfig } from "./config.ts";
import { Settings } from "./settings.ts";
import { Bus } from "./bus.ts";
import { characterClips, installCharacters, setCharacter } from "./characters.ts";
import { localLine } from "./local-mode.ts";

afterEach(() => { installCharacters({}); setCharacter("shisa"); });
const tmp = () => mkdtempSync(join(tmpdir(), "cy-lunch-"));
// 테스트는 TZ=Asia/Seoul(scripts/test.mjs)
const at = (iso: string) => new Date(iso);

test("점심시간 알림: 12시대에 하루 한 번, 다시 켜도 같은 날은 또 안 뜬다, 끄면 안 뜬다", () => {
  const dir = tmp();
  const path = join(dir, "lunch.json");
  let now = at("2026-10-17T11:59:00+09:00");
  const a = new LunchAlert(path, { now: () => now });
  assert.equal(a.due(true), null, "11시 59분");
  now = at("2026-10-17T12:05:00+09:00");
  assert.equal(a.due(false), null, "끔");
  assert.equal(a.due(true), "2026-10-17");
  assert.equal(a.due(true), null, "같은 날 두 번 안 뜬다");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { last: "2026-10-17" });
  now = at("2026-10-17T12:59:00+09:00");
  assert.equal(new LunchAlert(path, { now: () => now }).due(true), null, "데몬을 다시 켜도 같은 날은 안 뜬다");
  now = at("2026-10-17T13:00:00+09:00");
  now = at("2026-10-18T13:00:00+09:00");
  assert.equal(a.due(true), null, "다음 날이라도 점심시간이 지나면 안 뜬다");
  now = at("2026-10-19T12:00:00+09:00");
  assert.equal(a.due(true), "2026-10-19");
  // 화면 확인용 시(CY_LUNCH_HOUR)
  now = at("2026-10-20T15:10:00+09:00");
  assert.equal(new LunchAlert(join(dir, "x.json"), { now: () => now, hour: 15 }).due(true), "2026-10-20");
  assert.equal(new LunchAlert(join(dir, "y.json"), { now: () => now, hour: 99 }).due(true), null, "이상한 시는 무시(12시대)");
});

test("점심 설정: 기본 켬, 설정 창에서 끄면 config.json 에도, 이상한 값은 거절", () => {
  assert.equal(lunchAlertOf(undefined), true);
  assert.equal(lunchAlertOf(false), false);
  assert.equal(loadConfig({}, {}).lunchAlert, true);
  assert.equal(loadConfig({}, { lunchAlert: false }).lunchAlert, false);
  const path = join(tmp(), "config.json");
  const cfg = loadConfig({}, {});
  const s = new Settings(cfg, { path, env: {} });
  assert.equal(s.view().lunchAlert, true);
  assert.equal(s.put({ lunchAlert: "no" }).ok, false);
  const r = s.put({ lunchAlert: false });
  assert.ok(r.ok);
  assert.equal(cfg.lunchAlert, false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).lunchAlert, false);
  assert.equal(s.view().lunchAlert, false);
});

test("점심 영상: 먹는 영상이 있으면 그것, 없으면(모몽가) 그 캐릭터의 일정 알림 영상, 대사는 점심 인사", () => {
  const bus = new Bus();
  for (const id of ["shisa", "hachi", "rakko", "momonga", "usagi", "kani", "chiikawa", "kuri"]) {
    setCharacter(id);
    if (id !== "momonga") assert.deepEqual(characterClips("lunch").map((x) => x.file), ["lunch"], `${id}: 먹는 영상`);
    else assert.deepEqual(characterClips("lunch").map((x) => x.file), characterClips("plan").map((x) => x.file), id);
    const d = bus.activity.play(1000, "lunch");
    assert.equal(bus.state().danceClip, "lunch");
    assert.equal(d.say, undefined, `${id}: 점심 인사(local lunch)`);
    assert.ok(localLine("lunch").length > 0);
  }
  // 사용자 캐릭터: 점심 칸에 넣은 영상의 한마디
  installCharacters({ users: [{ id: "u-lunch000", lines: { name: "까망" }, clips: { plan: [{ file: "plan-aaaaaaaa.gif" }], lunch: [{ file: "lunch-aaaaaaaa.gif", say: "밥 먹자!" }] } }] });
  setCharacter("u-lunch000");
  assert.equal(bus.activity.play(1000, "lunch").say, "밥 먹자!");
  installCharacters({ users: [{ id: "u-lunch000", lines: { name: "까망" }, clips: { plan: [{ file: "plan-aaaaaaaa.gif" }] } }] });
  assert.deepEqual(characterClips("lunch").map((x) => x.file), ["plan-aaaaaaaa.gif"], "점심 칸이 비면 일정 알림");
  bus.activity.stop();
});
