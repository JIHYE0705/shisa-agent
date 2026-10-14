// 데몬 파일 로그: ~/.cy-agent/logs/daemon.log (작음·돌아가며 이어 씀). 토큰은 쓰지 않는다.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX = 256 * 1024;
const NAME = "daemon.log";
const REDACT = "[숨김]";

const RULES: [RegExp, string][] = [
  [/\bxoxe\.[A-Za-z0-9-]+/g, REDACT],
  [/\bxox[pbsec]-[A-Za-z0-9-]{8,}/g, REDACT],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACT],
  [/\bsk-[A-Za-z0-9]{20,}/g, REDACT],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACT],
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, `Bearer ${REDACT}`],
  [/Authorization:\s*\S+/gi, `Authorization: ${REDACT}`],
  [/(?:webcal|https?):\/\/\S+?\.ics(?:\?\S*)?/gi, "[달력주소 숨김]"],
  [/\b[A-Za-z0-9_-]{72,}\b/g, REDACT],
];

export function redactLog(text: string): string {
  let s = String(text ?? "");
  for (const [re, rep] of RULES) {
    re.lastIndex = 0;
    s = s.replace(re, rep);
  }
  return s;
}

function argToString(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === "string") return a;
  if (typeof a === "number" || typeof a === "boolean" || a == null) return String(a);
  try { return JSON.stringify(a); } catch { return String(a); }
}

function rotate(file: string): void {
  try {
    if (statSync(file).size < MAX) return;
    renameSync(file, `${file}.1`);
  } catch { /* 아직 없거나 못 바꿈 */ }
}

export function installFileLog(dir = join(process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent"), "logs")): () => void {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 폴더를 못 만들어도 콘솔은 그대로 */ }
  const file = join(dir, NAME);
  const orig: Partial<Record<"log" | "warn" | "error", typeof console.log>> = {};
  const wrap = (level: "log" | "warn" | "error") => {
    orig[level] = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig[level]!(...args);
      try {
        rotate(file);
        const line = redactLog(`${new Date().toISOString()} [${level}] ${args.map(argToString).join(" ")}\n`);
        appendFileSync(file, line.slice(0, 8 * 1024));
      } catch { /* 디스크 오류는 조용히 */ }
    };
  };
  wrap("log");
  wrap("warn");
  wrap("error");
  return () => {
    if (orig.log) console.log = orig.log;
    if (orig.warn) console.warn = orig.warn;
    if (orig.error) console.error = orig.error;
  };
}
