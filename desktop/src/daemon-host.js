// 앱 안에 든 데몬을 자식 프로세스로 띄우고 지킨다. 프로세스·시계·확인은 주입받는다(시험은 가짜로).
// 이미 그 포트에 데몬이 있으면 띄우지 않고 가끔 다시 본다(그 데몬이 사라지면 그때 띄운다).
// 죽으면 restartDelay 간격으로 다시 띄우고, stop() 은 SIGTERM → 기다려도 안 꺼지면 SIGKILL.
import { restartDelay, nextFailures } from './bundle.js';

export const WATCH_MS = 60_000; // 남의 데몬이 살아 있나 다시 보는 간격
export const KILL_AFTER_MS = 4000; // SIGTERM 뒤 이만큼 기다려도 안 꺼지면 SIGKILL

// deps: { spawn() → child(on('exit'), kill(sig), pid) · probe() → Promise<boolean> · now() · setTimeout · clearTimeout · log?(msg) · onSpawn?(child) }
export function createDaemonHost(deps) {
  const log = deps.log ?? (() => {});
  const st = { mode: 'idle', child: null, failures: 0, startedAt: 0, timer: null, stopping: false, restarts: 0 };

  const clear = () => { if (st.timer) { deps.clearTimeout(st.timer); st.timer = null; } };
  const later = (ms, fn) => { clear(); st.timer = deps.setTimeout(() => { st.timer = null; fn(); }, ms); };

  function launch() {
    if (st.stopping || st.child) return;
    let child;
    try {
      child = deps.spawn();
    } catch (e) {
      log(`데몬을 띄우지 못했어요: ${e?.message ?? e}`);
      st.failures = nextFailures(st.failures, 0);
      st.mode = 'waiting';
      later(restartDelay(st.failures), check);
      return;
    }
    st.child = child;
    st.mode = 'child';
    st.startedAt = deps.now();
    log(`데몬을 띄웠어요 (pid ${child.pid})`);
    deps.onSpawn?.(child);
    const gone = (code, signal) => {
      if (st.child !== child) return;
      st.child = null;
      if (st.stopping) { st.mode = 'stopped'; return; }
      const up = deps.now() - st.startedAt;
      st.failures = nextFailures(st.failures, up);
      const wait = restartDelay(st.failures);
      st.restarts += 1;
      st.mode = 'waiting';
      log(`데몬이 꺼졌어요 (${signal ?? `code ${code}`}, ${Math.round(up / 1000)}초 동안 켜짐). ${Math.round(wait / 1000)}초 뒤 다시 띄워요`);
      later(wait, check);
    };
    child.on('exit', gone);
    // 실행 파일을 못 찾는 등 띄우기 자체가 실패하면 exit 없이 error 만 온다
    child.on('error', (e) => { log(`데몬 프로세스 오류: ${e?.message ?? e}`); if (!child.pid) gone(null, null); });
  }

  // 띄우기 전에 그 포트를 본다: 누가 이미 떠 있으면 그쪽을 쓰고 지켜보기만
  async function check() {
    if (st.stopping || st.child) return;
    let alive = false;
    try { alive = await deps.probe(); } catch { alive = false; }
    if (st.stopping || st.child) return;
    if (alive) {
      if (st.mode !== 'external') log('이 포트에 이미 데몬이 떠 있어요. 그 데몬을 써요');
      st.mode = 'external';
      later(WATCH_MS, check);
      return;
    }
    launch();
  }

  function stop() {
    st.stopping = true;
    clear();
    const child = st.child;
    if (!child) { st.mode = 'stopped'; return Promise.resolve(); }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; deps.clearTimeout(kt); st.mode = 'stopped'; resolve(); };
      child.on('exit', finish);
      const kt = deps.setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 이미 꺼짐 */ } finish(); }, KILL_AFTER_MS);
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
  }

  return {
    start: () => check(),
    stop,
    get mode() { return st.mode; },
    get pid() { return st.child?.pid ?? null; },
    get restarts() { return st.restarts; },
    get failures() { return st.failures; },
  };
}
