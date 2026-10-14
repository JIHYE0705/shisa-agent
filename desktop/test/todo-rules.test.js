import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeRules, rulesChip, overlayRules, hitsLabel, readBacklogOpen, writeBacklogOpen, isCollapsed, BACKLOG_KEY,
  sanitizeRulePatch, okRuleId, sanitizeAskRule, ruleBlock, ruleOverlay,
} from '../src/todo-rules.js';
import { groupTodos, shapeDashboard, priorityLabel } from '../src/dashboard.js';
import { dropTarget, keyMove, reorderLocal } from '../src/todo-rows.js';
import { askReducer, canApply, openAsk, fieldText, diffBlocks } from '../src/todo-ask.js';
import { clampPriority, sanitizeTodoPatch, overlayTodos, PRIORITIES } from '../src/todos.js';

const RULES = [
  { id: 'rule:a', text: '앞으로 뉴스레터는 백로그로', summary: '제목에 "뉴스레터" → 언젠가·백로그(P4)', enabled: true, hits: 2, created: '2026-10-01T00:00:00Z' },
  { id: 'rule:b', text: '세미나는 백로그', summary: '', enabled: false, hits: 0, created: '2026-10-08T00:00:00Z' },
  { id: '', text: '깨진 것' }, null, { id: 'rule:c' },
];

test('shapeRules·rulesChip·overlayRules: 최근 것 먼저, 깨진 건 빼고, 꺼진 건 칩 수에서 뺀다', () => {
  const rs = shapeRules(RULES);
  assert.deepEqual(rs.map((r) => r.id), ['rule:b', 'rule:a']);
  assert.equal(rulesChip(rs), '규칙 1/2');
  assert.equal(rulesChip(rs.filter((r) => r.enabled)), '규칙 1');
  assert.equal(rulesChip([]), '규칙 0');
  assert.deepEqual(shapeRules(null), []);
  const pend = new Map([['rule:a', 'delete'], ['rule:b', { enabled: true }]]);
  assert.deepEqual(overlayRules(rs, pend).map((r) => [r.id, r.enabled]), [['rule:b', true]]);
  assert.equal(overlayRules(rs, new Map()), rs);
  assert.equal(hitsLabel(0), '미적용');
  assert.equal(hitsLabel(3), '3번 적용');
});

test('백로그 접힘: 기본 접힘, 저장소에 기억, 저장소가 없거나 깨져도 안전', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readBacklogOpen(storage), false);
  writeBacklogOpen(storage, true);
  assert.equal(mem.get(BACKLOG_KEY), '1');
  assert.equal(readBacklogOpen(storage), true);
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(readBacklogOpen(broken), false);
  writeBacklogOpen(broken, true);
  assert.equal(readBacklogOpen(undefined), false);
  assert.equal(isCollapsed(4, false), true);
  assert.equal(isCollapsed(4, true), false);
  assert.equal(isCollapsed(3, false), false);
});

test('P4 묶음 모델: 네 번째 묶음 "백로그", 열린 수·P1 수에서 빠지고 따로 셈, 규칙 표시', () => {
  const vm = shapeDashboard({
    todos: [
      { id: 'a', title: 'P1', priority: 1 }, { id: 'b', title: '나중', priority: 4, appliedRule: { id: 'rule:a', text: '뉴스레터는 백로그' } },
      { id: 'c', title: 'P3', priority: 3, progress: 'PR 올림 · 리뷰 대기', progressAt: '2026-10-13T06:00:00Z' }, { id: 'd', title: '또 나중', priority: 4, progress: 3 }, { id: 'e', title: '이상', priority: 7 },
    ],
    todoRules: RULES,
  });
  assert.deepEqual(vm.todoGroups.map((g) => [g.priority, g.label, g.items.length]), [[1, 'P1', 1], [3, 'P3', 1], [4, '백로그', 2], [9, '기타', 1]]);
  assert.equal(vm.stats.openTodos, 3);
  assert.equal(vm.stats.p1Todos, 1);
  assert.equal(vm.stats.backlogTodos, 2);
  assert.deepEqual(vm.todoGroups[2].items[0].appliedRule, { id: 'rule:a', text: '뉴스레터는 백로그' });
  assert.equal('appliedRule' in vm.todoGroups[2].items[1], false);
  assert.deepEqual([vm.todoGroups[1].items[0].progress, vm.todoGroups[1].items[0].progressAt], ['PR 올림 · 리뷰 대기', '2026-10-13T06:00:00Z']); // 진행 확인 한 줄
  assert.equal('progress' in vm.todoGroups[2].items[1], false); // 글자가 아니면 버림
  assert.equal(vm.todoRules.length, 2);
  assert.equal(priorityLabel(4), '백로그');
  assert.deepEqual(groupTodos([{ id: 'x', title: 'x', priority: 4 }])[0].priority, 4);
});

test('끌기·키보드: 백로그로/에서 옮기기(Alt+4), 접힌 백로그 칸도 놓을 자리', () => {
  const groups = [
    { priority: 3, top: 0, bottom: 100, rows: [{ id: 'c', top: 30, bottom: 60 }] },
    { priority: 4, top: 110, bottom: 150, rows: [] }, // 접힘: 줄 없이 칸만
  ];
  assert.deepEqual(dropTarget(130, groups, 'c'), { priority: 4, beforeId: null, y: 118 });
  const todos = [{ id: 'a', priority: 1 }, { id: 'c', priority: 3 }, { id: 'd', priority: 4 }];
  assert.deepEqual(keyMove(todos, 'a', '4'), { priority: 4, beforeId: null });
  assert.deepEqual(keyMove(todos, 'd', '2'), { priority: 2, beforeId: null });
  assert.equal(keyMove(todos, 'd', '4'), null);
  assert.deepEqual(reorderLocal(todos, 'a', 4, null).map((t) => [t.id, t.priority]), [['c', 3], ['d', 4], ['a', 4]]);
  assert.equal(clampPriority(4), 4);
  assert.deepEqual(PRIORITIES.at(-1), { value: 4, label: '백로그' });
  assert.deepEqual(sanitizeTodoPatch({ priority: 4 }), { priority: 4 });
  assert.equal(sanitizeTodoPatch({ priority: 5 }), null);
});

const RULE_PREVIEW = {
  proposal: { text: '앞으로 모든 세미나는 우선순위 매우 낮음', match: { keywords: ['세미나'], description: '세미나' }, effect: { backlog: true, priority: 4 } },
  summary: '제목에 "세미나" → 언젠가·백로그(P4)',
  changes: [
    { id: 'm2', title: '제135회 세미나 신청', before: { priority: 3, note: null }, after: { priority: 4, note: null } },
    { id: 'm3', title: '세미나 메모만', before: { priority: 4, note: null }, after: { priority: 4, note: '규칙' } },
    { id: 'bad' },
  ],
  skipped: [{ id: 'k', title: '세미나 발표', reason: '우선순위를 직접 정한 할 일' }],
};

test('팝오버 규칙 블록: 새 규칙 + 맞는 할 일 전부 전/후, 건너뛴 것, 낙관적 겹침(직접 수정 표시 없이)', () => {
  const b = ruleBlock(RULE_PREVIEW);
  assert.equal(b.text, '앞으로 모든 세미나는 우선순위 매우 낮음');
  assert.deepEqual(b.changes, [
    { id: 'm2', title: '제135회 세미나 신청', fields: [{ key: 'priority', label: '우선순위', old: 'P3', new: '백로그' }] },
    { id: 'm3', title: '세미나 메모만', fields: [{ key: 'note', label: '메모', old: null, new: '규칙' }] },
  ]);
  assert.deepEqual(b.skipped.map((x) => x.id), ['k']);
  assert.equal(ruleBlock(null), null);
  assert.equal(ruleBlock({ proposal: {} }), null);
  const ov = ruleOverlay(RULE_PREVIEW);
  assert.deepEqual(ov, [{ kind: 'edit', id: 'm2', patch: { priority: 4 }, rule: true }, { kind: 'edit', id: 'm3', patch: { note: '규칙' }, rule: true }]);
  const after = overlayTodos([{ id: 'm2', title: 'x', priority: 3, userEdited: false }], ov);
  assert.deepEqual(after[0], { id: 'm2', title: 'x', priority: 4, userEdited: false, pending: true });
  assert.equal(fieldText('priority', 4), '백로그');
  assert.deepEqual(diffBlocks([{ id: 'f', kind: 'edit', before: { title: 't', priority: 2, status: 'open' }, after: { title: 't', priority: 4, status: 'open' } }])[0].fields,
    [{ key: 'priority', label: '우선순위', old: 'P2', new: '백로그' }]);
});

test('팝오버 상태: 규칙만 있어도(ops 없음) ✓ 가능, 새로 물으면 규칙 지움, stale은 규칙도 갱신', () => {
  let s = askReducer(null, { type: 'open', todo: { id: 'f', title: '세미나' } });
  assert.equal(s.rule, null);
  s = askReducer(s, { type: 'ask', text: '앞으로 세미나는 백로그' });
  s = askReducer(s, { type: 'answer', seq: s.seq, reply: '보낼까?', ops: [], preview: [], rev: 'r1', rule: RULE_PREVIEW });
  assert.equal(s.rule, RULE_PREVIEW);
  assert.equal(canApply(s), true);
  s = askReducer(s, { type: 'apply' });
  assert.equal(s.status, 'applying');
  s = askReducer(s, { type: 'stale', ops: [], preview: [], rev: 'r2', rule: { ...RULE_PREVIEW, changes: [] } });
  assert.equal(s.status, 'proposal');
  assert.deepEqual(s.rule.changes, []);
  s = askReducer(s, { type: 'ask', text: '다시' });
  assert.equal(s.rule, null);
  // 잘못된 규칙 미리보기는 무시 → 적용할 게 없으면 ✓ 불가
  s = askReducer(s, { type: 'answer', seq: s.seq, reply: '음', ops: [], preview: [], rev: 'r3', rule: { proposal: null } });
  assert.equal(s.rule, null);
  assert.equal(canApply(s), false);
  assert.equal(openAsk({ id: 'x' }).rule, null);
});

test('IPC 거르기: 규칙 패치·id·팝오버 규칙(모양·크기만)', () => {
  assert.deepEqual(sanitizeRulePatch({ enabled: false, evil: 1 }), { enabled: false });
  assert.deepEqual(sanitizeRulePatch({ text: '  새  글 ' }), { text: '새 글' });
  for (const bad of [null, [], {}, { enabled: 'no' }, { text: '' }]) assert.equal(sanitizeRulePatch(bad), null, JSON.stringify(bad));
  assert.equal(okRuleId('rule:ab12cd34'), true);
  for (const bad of ['', 'rule:', 'x:1', 'rule:../a', 1, null]) assert.equal(okRuleId(bad), false);
  assert.equal(sanitizeAskRule(null), null);
  assert.equal(sanitizeAskRule(undefined), null);
  assert.deepEqual(sanitizeAskRule({ ...RULE_PREVIEW.proposal, extra: 1 }), RULE_PREVIEW.proposal);
  for (const bad of ['x', [], { text: 1, match: {}, effect: {} }, { text: 't', match: {} }, { text: 't', match: { keywords: ['x'.repeat(5000)] }, effect: {} }]) {
    assert.equal(sanitizeAskRule(bad), undefined, JSON.stringify(bad).slice(0, 60));
  }
});
