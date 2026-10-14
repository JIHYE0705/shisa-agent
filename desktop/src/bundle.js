// 앱(dmg)으로 깐 시사와 레포에서 띄운 시사를 가르는 판단. 순수 로직(파일·환경은 main.js 가 읽어서 넘긴다).
//  - 앱 번들: Contents/Resources/agent(데몬 소스 + 런타임 의존성), Contents/Resources/assets(캐릭터 그림·영상)
//  - 개발(npm start): 번들 데몬을 쓰지 않는다. CY_BUNDLED_DAEMON=1 이면 레포 agent/ 를 같은 방식으로 띄운다
//  - 터미널 설치(ops/install.sh): launchd 가 데몬을 켜고 지킨다(CY_AGENT_SUPERVISED=1). 앱은 손대지 않는다

export const DEFAULT_PORT = 47823;
export const LAUNCHD_DAEMON = 'com.cy-agent.daemon';
// 데몬의 stdout·stderr(launchd 설치와 같은 이름). 데몬 자신의 기록은 따로 logs/daemon.log 에 남는다
export const DAEMON_LOG = 'com.cy-agent.daemon.log';
// 데몬이 찾는 CLI(claude·codex·gh·git)가 있는 곳. Finder 로 연 앱은 PATH 가 /usr/bin:/bin 정도라 채워 준다(install.sh 와 같은 순서)
export const PATH_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
// 이만큼 살아 있었으면 정상으로 보고 재시작 간격을 처음부터
export const STABLE_MS = 60_000;

const posixJoin = (...parts) => parts.join('/').replace(/\/+/g, '/');

const portOf = (env) => Number(env?.CY_AGENT_PORT) || DEFAULT_PORT;

// 데몬·그림을 어디서 찾나 → { daemonDir, assetsDir } (없으면 null)
// packaged: app.isPackaged · resourcesPath: process.resourcesPath · appDir: main.js 가 있는 폴더(개발: 레포 desktop/)
export function bundlePaths({ packaged, resourcesPath, appDir, env = {} }, join = posixJoin) {
  if (packaged) {
    const res = resourcesPath || null;
    return {
      daemonDir: res && env.CY_BUNDLED_DAEMON !== '0' ? join(res, 'agent') : null,
      assetsDir: res ? join(res, 'assets') : null,
    };
  }
  return {
    daemonDir: appDir && env.CY_BUNDLED_DAEMON === '1' ? join(appDir, '..', 'agent') : null,
    assetsDir: appDir ? join(appDir, '..', 'assets') : null,
  };
}

// launchd 로 등록된 데몬(터미널 설치)이 이 포트·데이터 폴더를 맡고 있나.
// plist 는 기본 포트·기본 홈(~/.cy-agent)으로만 띄우니, 다른 포트·홈으로 띄운 시험 실행과는 상관없다
export function launchdOwns({ plistExists, env = {} }) {
  return !!plistExists && !env.CY_AGENT_HOME && portOf(env) === DEFAULT_PORT;
}

// 데몬을 앱이 띄울까 → { spawn, reason }
//  hasEntry: daemonDir/src/main.ts 가 있나 · alive: 그 포트에 데몬이 이미 응답하나 · launchd: launchdOwns(...)
export function spawnDecision({ daemonDir, hasEntry, env = {}, launchd = false, alive = false }) {
  if (!daemonDir || !hasEntry) return { spawn: false, reason: 'no-bundle' };
  if (env.CY_AGENT_SUPERVISED === '1') return { spawn: false, reason: 'launchd' }; // 앱도 launchd 가 띄웠다
  if (launchd) return { spawn: false, reason: 'launchd' };
  if (alive) return { spawn: false, reason: 'running' };
  return { spawn: true, reason: 'spawn' };
}

// 데몬 자식 프로세스의 환경. 앱이 받은 CY_AGENT_HOME·CY_AGENT_PORT 등은 그대로 넘기고,
// ELECTRON_RUN_AS_NODE 로 앱 실행 파일을 Node 로 쓰며, CY_AGENT_SUPERVISED 로 "연결이 바뀌면 스스로 다시 켜기"를 켠다(앱이 다시 띄운다)
export function daemonEnv(env = {}, { port, home } = {}) {
  const out = { ...env, ELECTRON_RUN_AS_NODE: '1', CY_AGENT_SUPERVISED: '1', CY_AGENT_PORT: String(port || portOf(env)) };
  const have = String(env.PATH ?? '').split(':').filter(Boolean);
  const extra = PATH_DIRS.map((d) => (d.startsWith('~/') ? (home ? posixJoin(home, d.slice(2)) : null) : d)).filter(Boolean);
  out.PATH = [...new Set([...have, ...extra])].join(':');
  return out;
}

// 죽은 데몬을 다시 띄우기까지 기다릴 시간: 1초, 2초, 4초 … 최대 1분
export function restartDelay(failures, { base = 1000, max = 60_000 } = {}) {
  const n = Number.isInteger(failures) && failures > 0 ? failures : 0;
  return Math.min(max, base * 2 ** Math.min(n, 30));
}

// 방금 죽은 데몬이 얼마나 살았나로 연속 실패 수를 센다. 오래 살았으면(정상 재시작 포함) 0부터
export function nextFailures(prev, uptimeMs, stableMs = STABLE_MS) {
  return uptimeMs >= stableMs ? 0 : (Number.isInteger(prev) && prev >= 0 ? prev : 0) + 1;
}

// 로그인할 때 자동 실행을 앱이 다룰까 → { manage, reason, openAtLogin }
//  pref: 사용자가 정한 값(state.json openAtLogin). 아직 없으면(마법사 전) 건드리지 않는다
//  reason: 'platform' · 'dev'(레포에서 실행) · 'launchd'(터미널 설치) · 'test'(임시 홈·다른 포트·CY_NO_LOGIN_ITEM) · 'unset' · 'ok'
export function loginItemPlan({ platform = 'darwin', packaged, launchd = false, env = {}, pref }) {
  if (platform !== 'darwin') return { manage: false, reason: 'platform' };
  if (!packaged) return { manage: false, reason: 'dev' };
  if (launchd || env.CY_AGENT_SUPERVISED === '1') return { manage: false, reason: 'launchd' };
  if (env.CY_AGENT_HOME || portOf(env) !== DEFAULT_PORT || env.CY_NO_LOGIN_ITEM === '1') return { manage: false, reason: 'test' };
  if (typeof pref !== 'boolean') return { manage: true, reason: 'unset' };
  return { manage: true, reason: 'ok', openAtLogin: pref };
}

// 설정 창에 보일 한 줄(켜고 끌 수 없을 때 이유)
export function loginItemHint(reason) {
  if (reason === 'launchd') return '터미널로 설치한 시사는 launchd 가 로그인할 때 켜 줘요. 여기서는 바꾸지 않아요.';
  if (reason === 'dev') return '레포에서 띄운 개발용 실행이라 여기서는 바꾸지 않아요.';
  if (reason === 'test') return '시험용 실행(다른 데이터 폴더·포트)이라 여기서는 바꾸지 않아요.';
  if (reason === 'platform') return '이 컴퓨터에서는 지원하지 않아요.';
  return '';
}

// 마법사를 마쳤을 때(또는 마친 뒤 처음 켤 때) 기본값: 정한 적 없으면 켬
export function defaultLoginPref(pref, onboarded) {
  if (typeof pref === 'boolean') return pref;
  return onboarded ? true : undefined;
}
