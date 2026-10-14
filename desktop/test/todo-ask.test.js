import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askKey, askReducer, chatHandoff, canApply, cleanQuestion, commitOverlay, diffBlocks, fieldText, openAsk, placePopover, previewOverlay, sanitizeAskOps } from '../src/todo-ask.js';

const before = { title: '견적 회신', priority: 2, note: '금요일', link: null, status: 'open' };

test('diffBlocks: 바뀐 필드만 old→new, 삭제는 통째로, 추가는 새 줄, 완료는 ✓', () => {
  const b = diffBlocks([
    { id: 'mail:1', kind: 'edit', before, after: { ...before, priority: 3, note: '내일까지' } },
    { kind: 'add', after: { title: '견적 계산', priority: 1, note: null, link: null, status: 'open' } },
    { kind: 'add', after: { title: '' } }, // 제목 없음 → 버림
    { kind: 'nuke' },
    null,
  ]);
  assert.deepEqual(b, [
    { kind: 'edit', id: 'mail:1', title: '견적 회신', fields: [
      { key: 'priority', label: '우선순위', old: 'P2', new: 'P3' },
      { key: 'note', label: '메모', old: '금요일', new: '내일까지' },
    ] },
    { kind: 'add', title: '견적 계산', meta: 'P1' },
  ]);
  assert.deepEqual(diffBlocks([{ id: 'mail:1', kind: 'delete', before }]), [{ kind: 'delete', id: 'mail:1', title: '견적 회신', meta: 'P2 · 메모: 금요일' }]);
  const done = diffBlocks([{ id: 'mail:1', kind: 'done', before, after: { ...before, status: 'done', note: null } }]);
  assert.deepEqual(done[0].fields, [
    { key: 'status', label: '상태', old: '열림', new: '✓ 완료' },
    { key: 'note', label: '메모', old: '금요일', new: null }, // 지움 → new 없음
  ]);
  assert.deepEqual(diffBlocks([{ id: 'x', kind: 'edit', before, after: before }]), []); // 안 바뀜
  assert.deepEqual(diffBlocks('x'), []);
  assert.equal(fieldText('link', ''), null);
});

test('askReducer: idle → thinking → proposal → applying → applied, 늦게 온 답은 무시, 다시 묻기는 교체', () => {
  let s = askReducer(null, { type: 'open', todo: { id: 'mail:1', title: '견적 회신' } });
  assert.equal(s.status, 'idle');
  assert.equal(askReducer(s, { type: 'open', todo: { id: 'mail:1' } }), s); // 같은 할 일이면 그대로
  assert.equal(askReducer(s, { type: 'ask', text: '  ' }), s);
  s = askReducer(s, { type: 'ask', text: ' 내일로 미뤄 ' });
  assert.deepEqual([s.status, s.question, s.seq], ['thinking', '내일로 미뤄', 1]);
  assert.equal(askReducer(s, { type: 'ask', text: '또' }), s, '생각 중엔 새로 못 물음');
  assert.equal(askReducer(s, { type: 'answer', seq: 0, reply: 'x', ops: [] }), s, '이전 seq');
  s = askReducer(s, { type: 'answer', seq: 1, reply: '미룰까?', ops: [{ op: 'edit' }], preview: [{ kind: 'edit' }], rev: 'r1' });
  assert.deepEqual([s.status, s.reply, s.rev, canApply(s)], ['proposal', '미룰까?', 'r1', true]);
  const re = askReducer(s, { type: 'ask', text: '아니 지워' }); // 다시 묻기 → 이전 제안 버림
  assert.deepEqual([re.status, re.ops, re.seq], ['thinking', [], 2]);
  s = askReducer(s, { type: 'apply' });
  assert.equal(s.status, 'applying');
  const stale = askReducer(s, { type: 'stale', preview: [{ kind: 'edit', x: 1 }], rev: 'r2' });
  assert.deepEqual([stale.status, stale.rev, !!stale.notice], ['proposal', 'r2', true]);
  const fail = askReducer(s, { type: 'applyFail', message: 'HTTP 500' });
  assert.deepEqual([fail.status, fail.retry], ['error', 'apply']);
  assert.equal(askReducer(fail, { type: 'retryApply' }).status, 'proposal');
  assert.equal(askReducer(s, { type: 'gone' }), s, '적용 중엔 사라져도 유지');
  s = askReducer(s, { type: 'applied' });
  assert.equal(s.status, 'applied');
  assert.equal(askReducer(s, { type: 'close' }), null);
  assert.equal(askReducer(null, { type: 'answer', seq: 1 }), null);
  assert.equal(openAsk({ id: '' }), null);
});

test('askReducer: 빈 제안은 적용 불가, 묻기 실패는 retry=ask', () => {
  let s = askReducer(askReducer(openAsk({ id: 'a', title: 'A' }), { type: 'ask', text: '누가 줬어?' }), { type: 'answer', seq: 1, reply: '메일', ops: [] });
  assert.equal(canApply(s), false);
  assert.equal(askReducer(s, { type: 'apply' }), s);
  assert.equal(askReducer(s, { type: 'gone' }), null);
  s = askReducer(askReducer(s, { type: 'ask', text: '다시' }), { type: 'askFail', seq: 2, message: '가짜 실패' });
  assert.deepEqual([s.status, s.retry, s.error, s.question], ['error', 'ask', '가짜 실패', '다시']);
});

test('askKey: Enter 보내기, ⌘/Ctrl+Enter 적용, Esc 버림, 한글 조합 중엔 무시', () => {
  assert.equal(askKey({ key: 'Enter' }), 'send');
  assert.equal(askKey({ key: 'Enter', metaKey: true }), 'apply');
  assert.equal(askKey({ key: 'Enter', ctrlKey: true }), 'apply');
  assert.equal(askKey({ key: 'Enter', shiftKey: true }), null); // ⌘⇧Enter 는 채팅 창(아래)
  assert.equal(askKey({ key: 'Escape' }), 'discard');
  assert.equal(askKey({ key: 'Enter', isComposing: true }), null);
  assert.equal(askKey({ key: 'Escape', keyCode: 229 }), null);
  assert.equal(askKey({ key: 'a' }), null);
});

test('placePopover: 아래 우선, 아래 모자라면 위로 뒤집기, 좌우는 창 안, 화살표는 누른 곳', () => {
  const view = { width: 800, height: 600 };
  const size = { width: 380, height: 200 };
  const below = placePopover({ anchor: { top: 100, bottom: 132, left: 200, right: 760 }, size, view, pointX: 300 });
  assert.deepEqual(below, { top: 142, left: 252, width: 380, placement: 'below', arrowX: 48 });
  const above = placePopover({ anchor: { top: 480, bottom: 512, left: 200, right: 760 }, size, view, pointX: 300 });
  assert.equal(above.placement, 'above');
  assert.equal(above.top, 480 - 10 - 200);
  // 오른쪽 끝을 누르면 창 안으로 밀리고 화살표가 따라간다
  const right = placePopover({ anchor: { top: 100, bottom: 132, left: 200, right: 790 }, size, view, pointX: 785 });
  assert.equal(right.left, 800 - 8 - 380);
  assert.equal(right.arrowX, 380 - 18);
  // 둘 다 안 들어가면 넓은 쪽, 창 안으로
  const tight = placePopover({ anchor: { top: 250, bottom: 280, left: 10, right: 400 }, size: { width: 380, height: 500 }, view, pointX: undefined });
  assert.equal(tight.placement, 'below');
  assert.ok(tight.top >= 8 && tight.top + 500 <= 600 || tight.top === 8);
  // 좁은 창: 폭이 줄어든다
  assert.equal(placePopover({ anchor: { top: 10, bottom: 40, left: 0, right: 300 }, size, view: { width: 300, height: 600 } }).width, 284);
});

test('previewOverlay·commitOverlay: 수정·삭제·완료·추가 낙관적 반영, 성공하면 서버 id로 확정', () => {
  const todos = [{ id: 'mail:1', title: '견적 회신', priority: 2, note: '금요일', source: 'mail' }, { id: 'b', title: 'B', priority: 1 }];
  const edit = previewOverlay([{ id: 'mail:1', kind: 'edit', before, after: { ...before, priority: 3, note: null } }]);
  assert.deepEqual(edit, [{ kind: 'edit', id: 'mail:1', patch: { priority: 3, note: null } }]);
  assert.deepEqual(previewOverlay([{ id: 'mail:1', kind: 'delete', before }]), [{ kind: 'remove', id: 'mail:1' }]);
  assert.deepEqual(previewOverlay([{ id: 'mail:1', kind: 'done', before, after: { ...before, status: 'done' } }]), [{ kind: 'remove', id: 'mail:1' }]);
  const split = previewOverlay([
    { id: 'mail:1', kind: 'delete', before },
    { kind: 'add', after: { title: '견적 계산', priority: 1, note: null, link: null, status: 'open' } },
    { kind: 'add', after: { title: '회신 메일', priority: 2, note: 'x', link: null, status: 'open' } },
  ], 'tmp:q');
  assert.deepEqual(split.map((o) => o.tempId ?? o.id), ['mail:1', 'tmp:q:1', 'tmp:q:2']);
  const committed = commitOverlay(todos, split, [{ id: 'user:a' }, { id: 'user:b' }]);
  assert.deepEqual(committed.map((t) => t.id), ['user:b', 'user:a', 'b']);
  assert.ok(committed.every((t) => !t.pending));
  const e = commitOverlay(todos, edit, []);
  assert.deepEqual(e[0], { id: 'mail:1', title: '견적 회신', priority: 3, source: 'mail', userEdited: true });
});

test('sanitizeAskOps·cleanQuestion: IPC 인자 거르기', () => {
  assert.deepEqual(sanitizeAskOps([{ op: 'edit', id: 'a', priority: 3, note: null, evil: 1 }]), [{ op: 'edit', id: 'a', priority: 3, note: null }]);
  for (const bad of [null, 'x', [], [{ op: 'nuke' }], [null], Array(21).fill({ op: 'done' })]) assert.equal(sanitizeAskOps(bad), null);
  assert.deepEqual(sanitizeAskOps([], { allowEmpty: true }), []);
  assert.equal(cleanQuestion('  끝났어 '), '끝났어');
  assert.equal(cleanQuestion(''), null);
  assert.equal(cleanQuestion('x'.repeat(50000)).length, 50000);
});

test('팝오버 → 채팅 창: ⌘⇧Enter, 데몬이 이미 남긴 문답은 다시 안 옮기고 입력 중인 글만, 안 남은 물음은 한 번 입력창으로', () => {
  assert.equal(askKey({ key: 'Enter', metaKey: true, shiftKey: true }), 'chat');
  assert.equal(askKey({ key: 'Enter', ctrlKey: true, shiftKey: true }), 'chat');
  assert.equal(askKey({ key: 'Enter', metaKey: true, shiftKey: true, isComposing: true }), null);
  const todo = { id: 'mail:1', title: '견적 회신' };
  let s = askReducer(null, { type: 'open', todo });
  assert.deepEqual(chatHandoff(s, ''), { todoId: 'mail:1', draft: '' });
  assert.deepEqual(chatHandoff(s, '  이 레포에서 견적 계산 코드 어디 있어?  '), { todoId: 'mail:1', draft: '이 레포에서 견적 계산 코드 어디 있어?' });
  s = askReducer(s, { type: 'ask', text: '내일로 미뤄' });
  // 기록된 답(threadId) → 옮길 것 없음
  const logged = askReducer(s, { type: 'answer', seq: s.seq, threadId: 'th1', reply: '미룰까요?', ops: [], preview: [] });
  assert.equal(logged.threadId, 'th1');
  assert.deepEqual(chatHandoff(logged, ''), { todoId: 'mail:1', draft: '' });
  // 옛 데몬(threadId 없음)·못 물어봄 → 물은 말을 입력창으로
  const old = askReducer(s, { type: 'answer', seq: s.seq, reply: '미룰까요?', ops: [], preview: [] });
  assert.deepEqual(chatHandoff(old, ''), { todoId: 'mail:1', draft: '내일로 미뤄' });
  const failed = askReducer(s, { type: 'askFail', seq: s.seq, message: 'x' });
  assert.deepEqual(chatHandoff(failed, ''), { todoId: 'mail:1', draft: '내일로 미뤄' });
  // 생각 중이면 데몬이 곧 남긴다 → 옮기지 않음
  assert.deepEqual(chatHandoff(s, ''), { todoId: 'mail:1', draft: '' });
  assert.equal(chatHandoff(null, 'x'), null);
});
