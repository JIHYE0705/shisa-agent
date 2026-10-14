// 작업 세션 창에서 고를 수 있는 모델 — 설정의 세 모델(코딩·일반·경량)만. 그 밖의 이름은 받지 않는다
import type { Config } from "./config.ts";

export type ModelChoice = { id: string; label: string; role: "code" | "general" | "light" };

// claude-opus-5-5 → "Opus 5.5" · 모르는 모양은 이름 그대로
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// 큰 것부터(코딩 → 일반 → 경량). 같은 모델이 두 역할이면 한 번만
export function modelChoices(cfg: Config): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const role of ["code", "general", "light"] as const) {
    const id = cfg.models[role];
    if (id && !out.some((c) => c.id === id)) out.push({ id, label: modelLabel(id), role });
  }
  return out;
}
