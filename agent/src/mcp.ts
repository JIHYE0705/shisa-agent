// Claude Code에 등록한 사용자 범위 MCP 서버(`~/.claude.json`의 mcpServers)를 찾는다.
// 커넥터 mode: "mcp" 일 때 서버 존재 확인·경량 릴레이(캘린더 동기화)가 이 설정을 쓴다.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ~/.claude.json 에 그 이름의 사용자 범위 MCP 서버가 등록돼 있는지(stdio·http 모두)
export function hasUserMcpServer(name: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    return !!j?.mcpServers?.[name];
  } catch { return false; }
}

// ~/.claude.json 의 사용자 범위 MCP 서버 설정(url 이 있는 것만)
export function userMcpServer(name: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const s = j?.mcpServers?.[name];
    return s && typeof s === "object" && typeof s.url === "string" ? s : undefined;
  } catch { return undefined; }
}

// 경량 릴레이용 SDK 옵션: 그 서버 하나만(strict) 붙이거나, 설정을 못 찾으면 사용자 설정 전체를 읽는다
export function serverOptions(name: string, url?: string):
  | { settingSources: []; strictMcpConfig: true; mcpServers: Record<string, any> }
  | { settingSources: ["user"] } {
  const server = url ? { type: "http", url } : userMcpServer(name);
  return server
    ? { settingSources: [], strictMcpConfig: true, mcpServers: { [name]: server } }
    : { settingSources: ["user"] };
}

// ~/.claude.json 에 등록된 MCP 서버 이름 전부(사용자 범위 + 폴더별 로컬 범위). 브리핑·채팅에서 숨길 서버를 고를 때 쓴다
export function registeredMcpServerNames(path = join(homedir(), ".claude.json")): string[] {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const out = new Set<string>(Object.keys(j?.mcpServers ?? {}));
    for (const p of Object.values((j?.projects ?? {}) as Record<string, any>)) for (const k of Object.keys(p?.mcpServers ?? {})) out.add(k);
    return [...out];
  } catch { return []; }
}
