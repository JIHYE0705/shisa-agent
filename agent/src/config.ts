// 설정: 환경변수 > ~/.cy-agent/config.json > 기본값. 비밀값(토큰)은 레포 밖에만 둔다.
// 설정 창(PUT /settings, settings.ts)이 models·briefing·phrases·autoMerge 를 config.json 에 합쳐 쓰고 메모리의 cfg 도 바로 바꾼다.
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveConnectors, type Connectors } from "./connectors.ts";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { phraseLines } from "./phrases.ts";
import { autoMergeList } from "./auto-merge.ts";
import { todayReminderOf, type TodayReminder } from "./daily-plan.ts";

export const HOME_DIR = process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent");

export type Config = {
  port: number;
  dbPath: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackUserId?: string; // DM 받을 내 Slack user id (U…)
  briefingIntervalMin: number;
  ingestIntervalMin: number;
  slackIngestIntervalMin: number;
  // 할 일 진행 확인 간격(분, todo-progress.ts — 작업 세션을 읽고 끝난 일 자동 완료·진척 한 줄). 0 이면 끔
  progressCheckMin?: number;
  // 일 종류별 모델: 코딩(수정 실행기)·일반(브리핑·채팅·개인화)·경량(도구만 순서대로 부르는 수집)
  // quick: 캐릭터 더블클릭 빠른 대화(스레드 kind hover) 전용 — 패널 모델 선택과 따로. 설정 창에서 바꾼다.
  // loadConfig 는 늘 채운다(기본 Sonnet). 손으로 만든 cfg(시험)에 없으면 hover 도 general
  models: { code: string; general: string; light: string; quick?: string };
  // 브리핑에서 뺄 출처(settings.ts BRIEFING_SOURCES 의 id: mail·calendar·slack·issues·sessions). 설정 창에서 끈다
  briefing?: { exclude: string[] };
  // 고친 고정 문구(phrases.ts 키 → 줄들, 여러 줄이면 하나를 무작위로). 없으면 기본. 설정 창 「문구」에서 고친다
  phrases?: Record<string, string[]>;
  // ✓ 없이 머지까지 하는 레포(owner/name, auto-merge.ts). 채팅에서 「이 레포는 알아서 머지까지 해」·설정 창에서 고친다.
  // config.json 에 없으면 빈 목록. loadConfig 는 늘 채운다
  autoMerge?: string[];
  // 오늘 할 일 알림(설정 창 「오늘 할 일 알림」). 없으면 영업일 아침 한 번(daily-plan.ts DEFAULT_TODAY_REMINDER)
  todayReminder?: TodayReminder;
  // 지식그래프 2단계(엔티티·관계 추출) 모델. 1단계(업무 판정)는 늘 경량. 기본은 경량(대량 작업이라 비용 우선)
  kgModel: string;
  // 대화 에이전트의 로컬 도구(Bash·Edit/Write·파일 읽기)를 승인 카드 없이 허용(permissions.ts 2-1). 하드 차단은 그대로. 기본 켜짐
  localAutoAllow: boolean;
  // 자동 수정이 허용된 레포 루트들. 이 밖의 경로는 제안하지도 실행하지도 않는다.
  repoRoots: string[];
  // 내 커밋을 알아보고(대시보드), 자동 수정 커밋에 쓰는 작성자. 기본: CY_AGENT_GIT_NAME/EMAIL > config.gitAuthor > `git config --global user.*`
  gitAuthor: { name: string; email: string };
  // 지식그래프에서 "나"로 볼 이름들(실명·영문명·Slack 표시명 등). 기본 비어 있음
  user: { name?: string; aliases: string[] };
  // 기능별 데이터 원천(connectors.ts): slack·calendar·mail·issues 마다 api | mcp | off
  connectors: Connectors;
  // 브리핑·채팅 뇌. 환경변수 CY_AGENT_BRAIN 이 파일보다 우선. 코드 자동 수정(fixer)은 이 설정과 무관하게 Claude Code 경로를 쓴다.
  brain: BrainConfig;
  // 읽기 전용 GitHub 도구(gh CLI). enabled 를 안 정하면 시작 때 gh auth status 가 되면 켠다. bin: gh 경로
  github?: { enabled?: boolean; bin?: string };
  // 업무 맥락 넣는 법(ctx-tools.ts): tools = 작은 머리말 + 필요할 때 부르는 읽기 전용 cy 도구(기본) ·
  // inline = 예전처럼 큰 맥락 블록(프로필·KG·Slack 미답·48시간 세션·할 일·대시보드 요약)을 매 턴 프롬프트에(되돌리기용).
  // env CY_AGENT_CONTEXT_MODE > config.json contextMode. 데몬을 다시 켜면 바뀐다(배포 불필요)
  contextMode?: "tools" | "inline"; // 없으면 tools
};

export const BRAIN_PROVIDERS = ["claude-code", "codex", "anthropic", "gemini", "openai", "local"] as const;
export type BrainProvider = (typeof BRAIN_PROVIDERS)[number];
export type BrainConfig = {
  provider: BrainProvider;
  geminiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string; // Claude API 키(Claude Code 없이 Claude 와 이야기 — providers.ts anthropicJson)
};

export const DEFAULT_GENERAL_MODEL = "claude-sonnet-5-5";

function nonempty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

// provider 오타에 키를 넣은 경우에도 문장에 키를 남기지 않는다
function safeLabel(raw: string): string {
  if (raw.length > 40 || /sk-|AIza|key-|bearer/i.test(raw)) return "(값은 숨겼어요)";
  return raw;
}

export function pickBrain(env: NodeJS.ProcessEnv, file: Record<string, unknown>): BrainConfig {
  const rawBrain = (file.brain ?? {}) as { provider?: unknown; geminiApiKey?: unknown; openaiApiKey?: unknown; anthropicApiKey?: unknown };
  const providerRaw = nonempty(env.CY_AGENT_BRAIN) ?? nonempty(rawBrain.provider) ?? "claude-code";
  if (!(BRAIN_PROVIDERS as readonly string[]).includes(providerRaw)) {
    throw new Error(`알 수 없는 brain.provider예요: ${safeLabel(providerRaw)}`);
  }
  // 키: 이름 있는 환경변수 > 일반 환경변수 > 파일. 빈 문자열은 없는 것과 같다
  const geminiApiKey = nonempty(env.CY_AGENT_GEMINI_API_KEY) ?? nonempty(env.GEMINI_API_KEY) ?? nonempty(rawBrain.geminiApiKey);
  const openaiApiKey = nonempty(env.CY_AGENT_OPENAI_API_KEY) ?? nonempty(env.OPENAI_API_KEY) ?? nonempty(rawBrain.openaiApiKey);
  // ANTHROPIC_API_KEY 는 Claude Code 도 쓰는 이름이라 일부러 안 읽는다(뇌를 anthropic 으로 고른 사람만 키를 넣는다)
  const anthropicApiKey = nonempty(env.CY_AGENT_ANTHROPIC_API_KEY) ?? nonempty(rawBrain.anthropicApiKey);
  return {
    provider: providerRaw as BrainProvider,
    ...(geminiApiKey ? { geminiApiKey } : {}),
    ...(openaiApiKey ? { openaiApiKey } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
  };
}

// git config --global 값. 키마다 한 번만 읽는다(git 이 없거나 멈춰도 3초 뒤 포기)
const gitGlobalCache = new Map<string, string | undefined>();
function gitGlobal(key: string): string | undefined {
  if (gitGlobalCache.has(key)) return gitGlobalCache.get(key);
  let v: string | undefined;
  try { v = execFileSync("git", ["config", "--global", key], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { v = undefined; }
  gitGlobalCache.set(key, v);
  return v;
}
export type GitIdentity = { name?: string; email?: string };
export function gitGlobalIdentity(): GitIdentity {
  const name = gitGlobal("user.name"), email = gitGlobal("user.email");
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

// "나"를 가리키는 이름들(지식그래프 병합용). 설정 파일의 user.name·user.aliases
export function userAliases(): string[] {
  const u = (readFileConfig().user ?? {}) as { name?: string; aliases?: string[] };
  return [u.name, ...(Array.isArray(u.aliases) ? u.aliases : [])].filter((x): x is string => typeof x === "string" && !!x.trim());
}

// 비서가 부르는 사용자 이름(머리말 「사용자: …」·지식그래프 「나」 노드 이름).
// 설정 user.name > env CY_AGENT_USER_NAME > git config --global user.name. 없으면 undefined(이름 없이)
export function displayUserName(user: { name?: string } | undefined, env: NodeJS.ProcessEnv = process.env, git: GitIdentity = gitGlobalIdentity()): string | undefined {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return pick(user?.name) ?? pick(env.CY_AGENT_USER_NAME) ?? pick(git.name);
}

// 지식그래프에서 "나"로 볼 이름들: 설정(user.name·aliases) + env CY_AGENT_USER_NAME + 이 PC 의 git 이름·이메일 아이디·계정 이름.
// 설정을 안 채운 새 사용자도 자기 이름이 다른 사람으로 잡히지 않게 한다
export function defaultSelfNames(opts: { aliases?: string[]; env?: NodeJS.ProcessEnv; git?: GitIdentity; username?: string | null } = {}): string[] {
  const out = [...(opts.aliases ?? userAliases())];
  const env = opts.env ?? process.env;
  if (env.CY_AGENT_USER_NAME?.trim()) out.push(env.CY_AGENT_USER_NAME.trim());
  const git = opts.git ?? gitGlobalIdentity();
  if (git.name) out.push(git.name);
  if (git.email) out.push(git.email.split("@")[0]!);
  let u = opts.username;
  if (u === undefined) { try { u = userInfo().username; } catch { u = null; } }
  if (u) out.push(u);
  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}

function readFileConfig(): Partial<Config> & Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(HOME_DIR, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

// env CY_AGENT_GITHUB=0/1 > config.json github(또는 connectors.github): true/false 또는 { enabled, bin }
function githubConfig(env: NodeJS.ProcessEnv, raw: unknown): Config["github"] {
  const o = typeof raw === "boolean" ? { enabled: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fromEnv = env.CY_AGENT_GITHUB;
  const enabled = fromEnv !== undefined && fromEnv !== "" ? !/^(0|false|off|no)$/i.test(fromEnv) : typeof o.enabled === "boolean" ? o.enabled : undefined;
  return { ...(enabled !== undefined ? { enabled } : {}), ...(typeof o.bin === "string" && o.bin ? { bin: o.bin } : {}) };
}

// 모르는 값은 기본(tools)
export function contextModeOf(v: unknown): "tools" | "inline" {
  return typeof v === "string" && v.trim().toLowerCase() === "inline" ? "inline" : "tools";
}

// config.json phrases: 키 → 글(여러 줄) 또는 줄 배열. 이상한 값은 건너뛴다(모르는 키는 phrases.ts 가 무시)
function phrasesOf(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const lines = phraseLines(v);
    if (lines.length) out[k] = lines;
  }
  return out;
}

// f: config.json 내용(시험은 직접 넣는다)
export function loadConfig(env = process.env, f: Partial<Config> & Record<string, unknown> = readFileConfig()): Config {
  mkdirSync(HOME_DIR, { recursive: true });
  return {
    port: Number(env.CY_AGENT_PORT ?? f.port ?? 47823),
    dbPath: env.CY_AGENT_DB ?? (f.dbPath as string) ?? join(HOME_DIR, "cy.db"),
    claudeProjectsDir: (f.claudeProjectsDir as string) ?? join(homedir(), ".claude", "projects"),
    codexSessionsDir: (f.codexSessionsDir as string) ?? join(homedir(), ".codex", "sessions"),
    slackBotToken: env.SLACK_BOT_TOKEN ?? (f.slackBotToken as string),
    slackAppToken: env.SLACK_APP_TOKEN ?? (f.slackAppToken as string),
    slackUserId: env.SLACK_USER_ID ?? (f.slackUserId as string),
    briefingIntervalMin: Number(f.briefingIntervalMin ?? 60),
    ingestIntervalMin: Number(f.ingestIntervalMin ?? 10),
    slackIngestIntervalMin: Number(f.slackIngestIntervalMin ?? 5),
    progressCheckMin: Number(f.progressCheckMin ?? f.slackIngestIntervalMin ?? 5), // 세션 진행 확인 — 슬랙 수집과 같은 간격(새 세션이 없으면 모델 안 부름)
    models: {
      code: env.CY_AGENT_MODEL_CODE ?? (f.models as any)?.code ?? "claude-opus-5-5",
      general: env.CY_AGENT_MODEL_GENERAL ?? (f.models as any)?.general ?? DEFAULT_GENERAL_MODEL,
      light: env.CY_AGENT_MODEL_LIGHT ?? (f.models as any)?.light ?? "claude-haiku-5-5",
      quick: env.CY_AGENT_MODEL_QUICK ?? (f.models as any)?.quick ?? "claude-sonnet-5-5",
    },
    briefing: { exclude: Array.isArray((f.briefing as any)?.exclude) ? ((f.briefing as any).exclude as unknown[]).filter((x): x is string => typeof x === "string") : [] },
    phrases: phrasesOf(f.phrases),
    autoMerge: autoMergeList(f.autoMerge),
    todayReminder: todayReminderOf(f.todayReminder),
    kgModel: env.CY_AGENT_KG_MODEL ?? (f.kgModel as string) ?? (env.CY_AGENT_MODEL_LIGHT ?? (f.models as any)?.light ?? "claude-haiku-5-5"),
    localAutoAllow: env.CY_AGENT_LOCAL_ASK === "1" ? false : f.localAutoAllow !== false,
    repoRoots: (f.repoRoots as string[]) ?? [join(homedir(), "code")],
    github: githubConfig(env, f.github ?? (f.connectors as any)?.github),
    contextMode: contextModeOf(env.CY_AGENT_CONTEXT_MODE ?? f.contextMode),
    gitAuthor: {
      name: env.CY_AGENT_GIT_NAME ?? (f.gitAuthor as any)?.name ?? gitGlobal("user.name") ?? "cy-agent",
      email: env.CY_AGENT_GIT_EMAIL ?? (f.gitAuthor as any)?.email ?? gitGlobal("user.email") ?? "cy-agent@localhost",
    },
    user: {
      name: (f.user as any)?.name,
      aliases: Array.isArray((f.user as any)?.aliases) ? (f.user as any).aliases : [],
    },
    connectors: resolveConnectors(env, f as any),
    brain: pickBrain(env, f),
  };
}
