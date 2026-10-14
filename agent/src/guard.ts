import { CAPABILITIES, CONNECTORS, READ_WORDS, WRITE_WORDS, isWriteName, type Connectors } from "./connectors.ts";

// 브리핑/대화용 에이전트는 읽기 전용이다. 메일 발송·Slack 게시·결재 같은 쓰기는
// 사용자 설정의 allow 규칙과 무관하게 PreToolUse 훅에서 막는다.
// 무엇을 읽을 수 있는지는 커넥터(connectors.ts)가 정한다:
//  - mcp: 그 서버의 매핑된 도구(매핑이 비었으면 읽기 이름) — 쓰기 이름은 매핑에 있어도 막는다

import { GH_SERVER, GH_TOOL_NAMES } from "./gh.ts";

// gh 서버(gh.ts)는 읽기 전용 도구만 만든다 — 그 이름들은 통과
const GH_TOOLS = new Set(GH_TOOL_NAMES.map((n) => `mcp__${GH_SERVER}__${n}`));
// 맥락 도구(ctx-tools.ts, 인프로세스 MCP "cy"): 로컬 DB(할 일·지식그래프·세션·Slack 미답·프로필)를 읽기만 한다 — 그 이름들은 통과.
// 이름은 여기 둔다(ctx-tools 가 ingest/slack 을 읽고, ingest/slack 이 guard 를 읽어서 — 순환 import 를 피한다)
export const CTX_SERVER = "cy";
export const CTX_TOOL_NAMES = ["kg_search", "kg_node", "kg_overview", "profile_get", "todos_list", "sessions_recent", "session_get", "slack_unanswered", "dashboard_summary", "projects_recent", "meetings_upcoming"] as const;
const CTX_TOOLS = new Set(CTX_TOOL_NAMES.map((n) => `mcp__${CTX_SERVER}__${n}`));

export type Verdict = { allow: true } | { allow: false; reason: string };

const prefixOf = (server: string) => `mcp__${server}__`;

export function isReadOnlyCall(toolName: string, input: unknown, conns: Connectors = CONNECTORS): Verdict {
  if (toolName === "ToolSearch" || toolName === "StructuredOutput") return { allow: true }; // StructuredOutput: 최종 결과 반환용 내장 도구
  if (GH_TOOLS.has(toolName) || CTX_TOOLS.has(toolName)) return { allow: true };
  const deny = (why: string): Verdict => ({ allow: false, reason: `읽기 전용 모드: ${why}` });
  const readCheck = (tool: string): Verdict => {
    if (WRITE_WORDS.test(tool)) return deny(`${tool} 은(는) 쓰기 도구`);
    if (READ_WORDS.test(tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))) return { allow: true }; // camelCase(searchJiraIssues)도
    return deny(`${tool} 이(가) 읽기 도구인지 확실하지 않음`);
  };

  // 전용 MCP 서버(같은 서버를 여러 기능이 같이 쓰면 매핑을 합친다)
  const mine = CAPABILITIES.map((cap) => conns[cap]).filter((c) => c.mode === "mcp" && toolName.startsWith(prefixOf(c.server)));
  if (mine.length) {
    const t = toolName.slice(prefixOf((mine[0] as { server: string }).server).length);
    if (t === "invoke" || isWriteName(t)) return deny(`${t} 은(는) 쓰기 도구`);
    const open = mine.some((c) => !Object.keys((c as { tools: object }).tools).length);
    if (open) return readCheck(t);
    const mapped = mine.flatMap((c) => Object.values((c as { tools: Record<string, string> }).tools));
    return mapped.includes(t) ? { allow: true } : deny(`${t} 은(는) 매핑에 없는 도구`);
  }
  return deny(`${toolName} 사용 불가`);
}
