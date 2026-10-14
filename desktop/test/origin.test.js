// 작업 세션 "원래 화면": origin 거르기 · 패널이 열 곳 · 팝오버 지난 문답 다시 띄우기 · 세션 창 입력창 → 원래 대화 · IPC 배선
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanOrigin, chatTarget, originKey, originLabel, originPlan, todoPlan } from '../src/origin.js';
import { askReducer, restoreAsk, canApply, chatHandoff } from '../src/todo-ask.js';
import { composerMode, threadSendBodies } from '../src/session.js';

test('cleanOrigin: 세 모양만, 모르는 키·잘못된 id 는 버림', () => {
  assert.deepEqual(cleanOrigin({ type: 'thread', threadId: 't-1', x: 1 }), { type: 'thread', threadId: 't-1' });
  assert.deepEqual(cleanOrigin({ type: 'todo', todoId: 'mail:1', threadId: 't-1' }), { type: 'todo', todoId: 'mail:1', threadId: 't-1' });
  assert.deepEqual(cleanOrigin({ type: 'todo', todoId: 'mail:1', threadId: '../x' }), { type: 'todo', todoId: 'mail:1' });
  assert.deepEqual(cleanOrigin({ type: 'proposal', proposalId: 'abc123' }), { type: 'proposal', proposalId: 'abc123' });
  for (const bad of [null, undefined, 'thread', {}, { type: 'thread' }, { type: 'thread', threadId: 'a/b' }, { type: 'todo', todoId: '' }, { type: 'todo', todoId: 'x'.repeat(501) }, { type: 'proposal', proposalId: 'a b' }, { type: 'run', id: 'x' }]) {
    assert.equal(cleanOrigin(bad), null, JSON.stringify(bad));
  }
  assert.equal(originLabel({ type: 'todo', todoId: 'a' }), '할 일 팝오버');
  assert.equal(originLabel({ type: 'thread', threadId: 't' }), '채팅');
  assert.equal(originLabel(null), '');
});

test('originKey: ⌘O / Ctrl+O 만(한글 조합·Shift·Alt 제외)', () => {
  assert.equal(originKey({ key: 'o', metaKey: true }), true);
  assert.equal(originKey({ key: 'O', ctrlKey: true }), true);
  assert.equal(originKey({ key: 'o' }), false);
  assert.equal(originKey({ key: 'o', metaKey: true, shiftKey: true }), false);
  assert.equal(originKey({ key: 'o', metaKey: true, isComposing: true }), false);
});

test('originPlan: 대화 → 채팅 탭, 할 일 → 팝오버(지난 문답 받아서), 제안 → 그 대화가 있으면 대화, 없으면 개요', () => {
  assert.deepEqual(originPlan({ type: 'thread', threadId: 't1' }), { action: 'thread', threadId: 't1' });
  assert.deepEqual(originPlan({ type: 'todo', todoId: 'a', threadId: 't2' }), { action: 'todo', todoId: 'a', threadId: 't2' });
  assert.deepEqual(originPlan({ type: 'proposal', proposalId: 'p1', threadId: 't3' }), { action: 'thread', threadId: 't3' });
  assert.deepEqual(originPlan({ type: 'proposal', proposalId: 'p1' }), { action: 'proposal', proposalId: 'p1' });
  assert.equal(originPlan({ type: 'nope' }), null);
});

test('todoPlan: 휴지통·지워짐(404) → 그 할 일의 대화 + 안내, 대화도 없으면 할 일 탭만, 끝난 할 일 → 대화, 그 밖 → 팝오버', () => {
  const o = { type: 'todo', todoId: 'mail:1', threadId: 't-old' };
  const trashed = todoPlan(o, { ok: false, status: 404, data: { error: 'no such todo', threadId: 't-1', trashed: true } });
  assert.equal(trashed.action, 'thread');
  assert.equal(trashed.threadId, 't-1'); // 데몬이 준 지금 스레드 우선
  assert.match(trashed.note, /휴지통/);
  const gone = todoPlan(o, { ok: false, status: 404, data: { error: 'no such todo', trashed: false } });
  assert.deepEqual([gone.action, gone.threadId], ['thread', 't-old']);
  assert.match(gone.note, /지워졌어요/);
  const none = todoPlan({ type: 'todo', todoId: 'mail:1' }, { ok: false, status: 404, data: { trashed: true } });
  assert.equal(none.action, 'todos');
  assert.match(none.note, /휴지통/);
  const offline = todoPlan(o, { ok: false, error: 'ECONNREFUSED' });
  assert.deepEqual([offline.action, offline.threadId], ['thread', 't-old']);
  const done = todoPlan(o, { ok: true, status: 200, data: { todo: { id: 'mail:1', title: 'A', status: 'done' }, threadId: 't-1', exchange: null, actions: [] } });
  assert.deepEqual([done.action, done.threadId], ['thread', 't-1']);
  const ex = { question: 'q', reply: 'r', outcome: 'answered', ops: [], preview: [], rule: null, at: '2026-10-12T00:00:00Z' };
  const pop = todoPlan(o, { ok: true, status: 200, data: { todo: { id: 'mail:1', title: 'A', status: 'open' }, threadId: 't-1', exchange: ex, actions: [{ id: 'a1' }] } });
  assert.deepEqual([pop.action, pop.todo.id, pop.threadId, pop.exchange, pop.actions.length], ['popover', 'mail:1', 't-1', ex, 1]);
  assert.equal(todoPlan({ type: 'thread', threadId: 't' }, { ok: true }), null);
});

const TODO = { id: 'mail:1', title: '견적 회신' };
const PREVIEW = [{ id: 'mail:1', kind: 'edit', before: { title: '견적 회신', priority: 2, note: null, link: null, status: 'open' }, after: { title: '견적 회신', priority: 3, note: null, link: null, status: 'open' } }];

test('restoreAsk: 아직 유효한 제안 → diff 그대로 ✓ 가능, 지난 제안 → 물음·답 + 결과 한 줄만, 문답 없음 → 빈 팝오버', () => {
  const live = restoreAsk(TODO, { question: '미뤄', reply: 'P3으로 내릴까요?', outcome: 'pending', ops: [{ op: 'edit', id: 'mail:1', priority: 3 }], preview: PREVIEW, rev: 'r1', rule: null, at: 'x' }, 't-1');
  assert.equal(live.status, 'proposal');
  assert.equal(live.restored, true);
  assert.deepEqual([live.question, live.reply, live.rev, live.preview.length, live.result, live.threadId], ['미뤄', 'P3으로 내릴까요?', 'r1', 1, null, 't-1']);
  assert.equal(canApply(live), true);
  const stale = restoreAsk(TODO, { question: '미뤄', reply: 'P3으로 내릴까요?', outcome: 'stale', ops: [], preview: [], rule: null, result: '그 뒤에 할 일이 바뀌어서 그때 제안은 지났어요 — 다시 물어보세요.' }, 't-1');
  assert.deepEqual([stale.status, stale.ops, stale.preview, stale.rev, canApply(stale)], ['proposal', [], [], null, false]);
  assert.match(stale.result, /지났어요/);
  // 데몬이 pending 이라 해도 rev 가 없으면(모양이 이상하면) ✓ 못 함
  assert.equal(canApply(restoreAsk(TODO, { question: 'q', reply: 'r', outcome: 'pending', ops: [{ op: 'done', id: 'mail:1' }], preview: PREVIEW })), false);
  const applied = restoreAsk(TODO, { question: '끝났어', reply: '완료할까요?', outcome: 'applied', ops: [], preview: [], rule: null, result: '✓ 적용: 완료: 견적 회신' });
  assert.equal(applied.result, '✓ 적용: 완료: 견적 회신');
  const empty = restoreAsk(TODO, null, 't-1');
  assert.deepEqual([empty.status, empty.restored, empty.threadId], ['idle', false, 't-1']);
  assert.equal(restoreAsk({ id: '' }, null), null);
});

test('askReducer restore → 이어 물으면 보통 팝오버(결과 줄 지움), 생각 중이면 덮어쓰지 않음, 채팅으로 넘기면 같은 대화', () => {
  let s = askReducer(null, { type: 'restore', todo: TODO, exchange: { question: 'q', reply: 'r', outcome: 'answered', result: '✗ 버림: 제안' }, threadId: 't-1' });
  assert.equal(s.result, '✗ 버림: 제안');
  s = askReducer(s, { type: 'ask', text: '다시' });
  assert.deepEqual([s.status, s.result, s.restored, s.threadId], ['thinking', null, false, 't-1']);
  assert.equal(askReducer(s, { type: 'restore', todo: TODO, exchange: { question: 'x', reply: 'y' } }), s);
  s = askReducer(s, { type: 'answer', seq: s.seq, reply: '답', ops: [] });
  assert.equal(s.status, 'proposal');
  const r = askReducer(null, { type: 'restore', todo: TODO, exchange: { question: 'q', reply: 'r', outcome: 'answered' }, threadId: 't-1' });
  assert.deepEqual(chatHandoff(r, ''), { todoId: 'mail:1', draft: '' }); // 이미 그 대화에 있으니 다시 옮기지 않는다
});

test('세션 창 입력창: 원래 대화가 있는 run → 그 대화로(thread), 수정 run 은 그대로, 없으면 물어보기', () => {
  const chat = { id: 'run-1', kind: 'chat', status: 'done', origin: { type: 'thread', threadId: 't-1' } };
  const todo = { id: 'run-2', kind: 'chat', status: 'done', origin: { type: 'todo', todoId: 'mail:1', threadId: 't-2' } };
  const action = { id: 'run-3', kind: 'action', status: 'done', origin: { type: 'todo', todoId: 'mail:1' } };
  const fixDone = { id: 'run-4', kind: 'fix', status: 'done', origin: { type: 'proposal', proposalId: 'p1', threadId: 't-1' } };
  const fixRunning = { ...fixDone, status: 'running', interactive: true };
  const plain = { id: 'run-5', kind: 'briefing', status: 'done' };
  const prop = { id: 'run-6', kind: 'other', status: 'done', origin: { type: 'proposal', proposalId: 'p1', threadId: 't-1' } };
  assert.equal(composerMode(chat).mode, 'thread');
  assert.deepEqual(composerMode(chat).target, { threadId: 't-1' });
  assert.equal(composerMode(todo).mode, 'thread');
  assert.match(composerMode(todo).placeholder, /할 일/);
  assert.equal(composerMode({ ...chat, status: 'running' }).mode, 'thread'); // 도는 중에도(대화는 줄 서서)
  assert.equal(composerMode(fixDone).mode, 'continue');
  assert.equal(composerMode(fixRunning).mode, 'inject');
  assert.equal(composerMode(plain).mode, 'followup');
  assert.equal(composerMode(prop).mode, 'followup'); // 제안 origin 은 대화로 보내지 않는다
  assert.equal(composerMode({ ...chat, origin: { type: 'thread', threadId: 'bad id' } }).mode, 'followup');
  assert.deepEqual(threadSendBodies(chat, 'hi'), [{ text: 'hi', threadId: 't-1', parentRunId: 'run-1' }]);
  // 할 일 집어 들고 → 그 할 일이 없어졌으면(404) 대화만
  assert.deepEqual(threadSendBodies(todo, 'hi'), [{ text: 'hi', todoId: 'mail:1', threadId: 't-2', parentRunId: 'run-2' }, { text: 'hi', threadId: 't-2', parentRunId: 'run-2' }]);
  assert.deepEqual(threadSendBodies(action, 'hi'), [{ text: 'hi', todoId: 'mail:1', parentRunId: 'run-3' }]);
  assert.deepEqual(threadSendBodies(plain, 'hi'), []);
  assert.deepEqual(chatTarget(fixDone.origin), null);
});

test('IPC 배선: 세션 창 open-origin·session-chat → 메인 → 패널 open-origin·todo-last-ask(같은 채널 이름, 메인은 cleanOrigin 으로 거름)', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('main.js'), ps = read('preload-session.cjs'), pp = read('preload-panel.cjs'), panel = read('renderer/panel.js'), sess = read('renderer/session.js');
  assert.match(ps, /openOrigin: \(origin\) => ipcRenderer\.send\('open-origin'/);
  assert.match(ps, /chatSend: \(body\) => ipcRenderer\.invoke\('session-chat'/);
  assert.match(main, /ipcMain\.on\('open-origin', \(e, origin\) => \{ if \(fromOurs\(e\)\) showOrigin\(origin\); \}\)/);
  assert.match(main, /ipcMain\.handle\('session-chat'/);
  assert.match(main, /post\('\/chat', withModel\(\{ text: t, .*parentRunId: b\.parentRunId, \.\.\.withAtts\(atts\) \}, b\.model\)\)/);
  assert.match(main, /const o = cleanOrigin\(origin\);/);
  assert.match(main, /sendPanel\('open-origin', o\)/);
  assert.match(main, /if \(panelOrigin\) sendPanel\('open-origin', panelOrigin\)/); // 패널이 막 만들어졌으면 로드 뒤에
  assert.match(main, /ipcMain\.handle\('todo-last-ask'[\s\S]*?\/todos\/\$\{encodeURIComponent\(id\)\}\/thread\/last/);
  assert.match(pp, /onOpenOrigin: on\('open-origin'\)/);
  assert.match(pp, /todoLastAsk: \(id\) => ipcRenderer\.invoke\('todo-last-ask'/);
  assert.match(panel, /cy\.onOpenOrigin\?\.\(openOrigin\)/);
  assert.match(sess, /cy\.openOrigin\(o\)/);
});
