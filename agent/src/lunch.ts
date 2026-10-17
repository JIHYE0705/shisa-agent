// 점심시간 알림: 로컬 12시대(local-mode.ts dayPart 의 lunch 와 같은 기준)에 하루 한 번, 캐릭터가 점심 영상(칸 lunch — 없으면 그 캐릭터의 일정 알림 영상)과 함께
// 점심 인사(local lines 의 lunch, 그 영상에 한마디가 있으면 그 말)를 띄운다. 설정 lunchAlert(기본 켬, 설정 창 「점심시간 알림」).
// 하루 한 번은 파일(~/.cy-agent/lunch.json { last: "YYYY-MM-DD" })에 남겨 같은 날 다시 켜도 또 뜨지 않는다.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localDate } from "./calendar.ts";
import { dayPart } from "./local-mode.ts";

export const lunchAlertOf = (v: unknown): boolean => v !== false;

export class LunchAlert {
  private path: string;
  private now: () => Date;
  // 테스트·화면 확인용: 몇 시를 점심으로 볼지(없으면 dayPart 의 lunch = 12시대)
  private hour?: number;
  constructor(path: string, opts: { now?: () => Date; hour?: number } = {}) {
    this.path = path;
    this.now = opts.now ?? (() => new Date());
    if (Number.isInteger(opts.hour) && opts.hour! >= 0 && opts.hour! < 24) this.hour = opts.hour;
  }
  private last(): string | undefined {
    try { const v = JSON.parse(readFileSync(this.path, "utf8")); return typeof v?.last === "string" ? v.last : undefined; } catch { return undefined; }
  }
  // 지금 띄울 때인가: 켜져 있고, 점심시간이고, 오늘 아직 안 띄웠으면 오늘을 남기고 날짜를 돌려준다. 아니면 null
  due(enabled: boolean): string | null {
    if (!enabled) return null;
    const now = this.now();
    const lunch = this.hour === undefined ? dayPart(now) === "lunch" : now.getHours() === this.hour;
    if (!lunch) return null;
    const day = localDate(now);
    if (this.last() === day) return null;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ last: day }), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch { return null; } // 못 남기면 띄우지 않는다(1분마다 또 뜨지 않게)
    return day;
  }
}
