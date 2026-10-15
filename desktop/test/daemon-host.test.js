import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDaemonHost, WATCH_MS, KILL_AFTER_MS } from '../src/daemon-host.js';

// 가짜 시계·프로세스
function harness({ alive = [false] } = {}) {
  let now = 0;
  let seq = 100;
  const timers = new Map();
  let tid = 0;
  const children = [];
  const logs = [];
  const probes = [...alive];
  const h = {
    children, logs, timers,
    get now() { return now; },
    deps: {
      spawn: () => {
        const c = new EventEmitter();
        c.pid = seq++;
        c.signals = [];
        c.kill = (sig) => { c.signals.push(sig); if (c.dieOn?.includes(sig)) setImmediate(() => c.emit('exit', null, sig)); };
        c.dieOn = ['SIGTERM', 'SIGKILL'];
        children.push(c);
        return c;
      },
      probe: async () => (probes.length > 1 ? probes.shift() : probes[0]),
      now: () => now,
      setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: now + ms, ms }); return id; },
      clearTimeout: (id) => { timers.delete(id); },
      log: (m) => logs.push(m),
    },
    // 시계를 ms 만큼 돌리며 때가 된 타이머를 부른다
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      now = until;
    },
  };
  return h;
}

test('포트가 비어 있으면 띄우고, 죽으면 1·2·4초… 간격으로 다시 띄운다', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'child');
  assert.equal(h.children.length, 1);
  assert.equal(host.pid, 100);

  // 오래 살다 죽음 → 1초 뒤
  await h.advance(120_000);
  h.children[0].emit('exit', 1, null);
  assert.equal(host.mode, 'waiting');
  assert.equal([...h.timers.values()][0].ms, 1000);
  await h.advance(1000);
  assert.equal(h.children.length, 2);

  // 바로 또 죽음 → 2초, 그다음 4초
  h.children[1].emit('exit', 1, null);
  assert.equal([...h.timers.values()][0].ms, 2000);
  await h.advance(2000);
  h.children[2].emit('exit', null, 'SIGKILL');
  assert.equal([...h.timers.values()][0].ms, 4000);
  await h.advance(4000);
  assert.equal(h.children.length, 4);
  assert.equal(host.restarts, 3);
});

test('이미 그 포트에 데몬이 있으면 띄우지 않고 지켜보다, 사라지면 그때 띄운다', async () => {
  const h = harness({ alive: [true, true, false] });
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'external');
  assert.equal(h.children.length, 0);
  await h.advance(WATCH_MS);
  assert.equal(host.mode, 'external');
  await h.advance(WATCH_MS);
  assert.equal(host.mode, 'child');
  assert.equal(h.children.length, 1);
});

test('다시 띄우기 전에 누가 그 포트를 차지했으면 그쪽을 쓴다', async () => {
  const h = harness({ alive: [false, true] });
  const host = createDaemonHost(h.deps);
  await host.start();
  h.children[0].emit('exit', 0, null);
  await h.advance(2000); // 곧바로 죽음 → 2초
  assert.equal(h.children.length, 1);
  assert.equal(host.mode, 'external');
});

test('stop: SIGTERM 으로 끄고, 그 뒤로는 다시 띄우지 않는다', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  const c = h.children[0];
  await host.stop();
  assert.deepEqual(c.signals, ['SIGTERM']);
  assert.equal(host.mode, 'stopped');
  assert.equal(host.pid, null);
  await h.advance(600_000);
  assert.equal(h.children.length, 1);
});

test('stop: IPC 로 띄웠으면(윈도우) 신호 대신 "shutdown" 메시지, 안 꺼지면 SIGKILL', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  const c = h.children[0];
  c.connected = true;
  c.sent = [];
  c.send = (m) => { c.sent.push(m); setImmediate(() => c.emit('exit', 0, null)); };
  await host.stop();
  assert.deepEqual(c.sent, ['shutdown']);
  assert.deepEqual(c.signals, []);
  assert.equal(host.mode, 'stopped');

  const h2 = harness();
  const host2 = createDaemonHost(h2.deps);
  await host2.start();
  const c2 = h2.children[0];
  Object.assign(c2, { connected: true, send: () => {}, dieOn: [] }); // 메시지에 안 꺼짐
  const p = host2.stop();
  await h2.advance(KILL_AFTER_MS);
  await p;
  assert.deepEqual(c2.signals, ['SIGKILL']);
});

test('stop: SIGTERM 에 안 꺼지면 기다렸다 SIGKILL', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  const c = h.children[0];
  c.dieOn = []; // 안 꺼짐
  const p = host.stop();
  await h.advance(KILL_AFTER_MS);
  await p;
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(host.mode, 'stopped');
});

test('띄우기가 실패하면(spawn 예외·pid 없는 error) 간격을 두고 다시 해 본다', async () => {
  const h = harness();
  let fail = 1;
  const spawn = h.deps.spawn;
  h.deps.spawn = () => { if (fail-- > 0) throw new Error('EACCES'); return spawn(); };
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'waiting');
  await h.advance(2000);
  assert.equal(host.mode, 'child');
  // pid 없이 error 만 오는 경우
  const c = h.children[0];
  c.pid = undefined;
  c.emit('error', new Error('ENOENT'));
  assert.equal(host.mode, 'waiting');
  assert.ok(h.logs.some((m) => m.includes('ENOENT')));
});

test('stop 은 아무것도 안 띄웠어도 바로 끝난다', async () => {
  const h = harness({ alive: [true] });
  const host = createDaemonHost(h.deps);
  await host.start();
  await host.stop();
  assert.equal(host.mode, 'stopped');
  await h.advance(WATCH_MS * 3);
  assert.equal(h.children.length, 0);
});
