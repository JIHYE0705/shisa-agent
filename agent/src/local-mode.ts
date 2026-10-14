// 로컬 뇌. SDK·HTTP·CLI를 부르지 않고, 넘겨받은 시각과 할 일 목록만으로 Thought를 만든다.
// 말투는 TONE(존댓말)을 따르고, 가끔 ~요·감정 표시는 voice()만 붙인다. 할 일을 새로 짓지 않는다.
import { TONE, voice, type Mood } from "./voice.ts";

export type LocalTodo = { title: string; priority?: number };
export type DayPart = "morning" | "lunch" | "evening";

export type LocalThought = {
  bubble: string;
  reply_md: string;
  todos: [];
  done_todo_ids: [];
  proposals: [];
};

// 모델 프롬프트와 같은 말투 한 줄. 로컬 대사는 이 톤으로 쓰고 양념은 voice()에 맡긴다.
export const LOCAL_TONE = TONE;

export const LINES = {
  morning: "좋은 아침이에요.",
  lunch: "점심 시간이에요.",
  evening: "좋은 저녁이에요.",
  remind: "오늘 꼭 할 일을 다시 일깨워 드려요.",
  praise: "최근에 끝낸 일을 칭찬드려요.",
  empty: "우선순위 1·3 열린 할 일은 비어 있어요.",
} as const;

const BUBBLE_MAX = 40;

// Asia/Seoul. 아침 05–11시, 점심 11–17시, 그 밖(저녁·밤·새벽)은 저녁.
export function seoulHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hourCycle: "h23" })
    .formatToParts(now)
    .find((p) => p.type === "hour")?.value;
  const n = Number(hour);
  if (!Number.isInteger(n)) throw new Error("서울 시각을 읽지 못했어요.");
  return n === 24 ? 0 : n;
}

export function dayPart(now: Date): DayPart {
  const h = seoulHour(now);
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "lunch";
  return "evening";
}

function seoulDay(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function titles(list: LocalTodo[], priority?: number): string[] {
  return list
    .filter((t) => priority === undefined || t.priority === priority)
    .map((t) => cleanTitle(t.title))
    .filter(Boolean);
}

// 존댓말 문장에 voice() 양념만 붙인다
export function spoken(text: string, seed: string, mood: Mood = "happy"): string {
  void LOCAL_TONE;
  return voice(text, seed, { mood });
}

export function bubbleLine(text: string, seed: string, mood: Mood): string {
  const flavored = spoken(text, seed, mood);
  if (flavored.length <= BUBBLE_MAX && !flavored.includes("\n")) return flavored;
  if (text.length <= BUBBLE_MAX && !text.includes("\n")) return text;
  return text.slice(0, BUBBLE_MAX);
}

// 열린 할 일 중 우선순위 1·3 제목만. 둘 다 없으면 비어 있다고 말한다. 2·4는 넣지 않는다.
export function planReply(open: LocalTodo[]): string {
  const p1 = titles(open, 1);
  const p3 = titles(open, 3);
  if (!p1.length && !p3.length) return LINES.empty;
  const block = (heading: string, items: string[]) => [heading, ...(items.length ? items.map((t) => `- ${t}`) : ["- (비어 있어요)"])];
  return [...block("## 우선순위 1", p1), "", ...block("## 우선순위 3", p3)].join("\n");
}

function praiseReply(done: LocalTodo[], seed: string): string {
  const doneTitles = titles(done);
  const base = doneTitles.length ? `최근에 ${doneTitles.join(", ")}을 끝내셨어요. 잘하셨어요.` : LINES.praise;
  return spoken(base, `${seed}:praise`, "happy");
}

// 순수 함수. now·할 일 목록·seed만 본다. todos·done_todo_ids·proposals는 항상 빈 배열.
export function localThought(now: Date, open: LocalTodo[] = [], done: LocalTodo[] = [], seed = `local:${seoulDay(now)}`): LocalThought {
  const part = dayPart(now);
  const hasP1 = titles(open, 1).length > 0;
  const hasDone = titles(done).length > 0;
  const bubbleBase = hasP1 ? LINES.remind : hasDone ? LINES.praise : LINES[part];
  const bubbleMood: Mood = hasP1 ? "busy" : hasDone ? "happy" : "calm";
  const reply = [spoken(LINES[part], `${seed}:greet`, "calm"), "", planReply(open)];
  if (hasDone) reply.push("", praiseReply(done, seed));
  return {
    bubble: bubbleLine(bubbleBase, `${seed}:bubble`, bubbleMood),
    reply_md: reply.join("\n"),
    todos: [],
    done_todo_ids: [],
    proposals: [],
  };
}
