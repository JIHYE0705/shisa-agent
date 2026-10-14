// 할 일 팝오버 — 순수 로직. 한 번 묻고(POST /todos/:id/ask) 제안 diff 를 보여주고 ✓(apply)·✗(reject).
// 상태 리듀서, diff 줄 만들기, 위치 계산, 낙관적 반영용 겹침, IPC 인자 거르기.
import { overlayTodos } from './todos.js';
import { ruleBlock } from './todo-rules.js';

const str = (v) => (typeof v === 'string' ? v : '');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const FIELD_LABELS = { title: '제목', priority: '우선순위', note: '메모', link: '링크', status: '상태' };
const FIELDS = ['title', 'priority', 'status', 'note', 'link'];
const KINDS = ['edit', 'delete', 'done', 'reopen', 'add'];

// 값 → 보이는 글자. 없음은 null
export function fieldText(key, v) {
  if (v === null || v === undefined || v === '') return null;
  if (key === 'priority') return [1, 2, 3].includes(v) ? `P${v}` : v === 4 ? '백로그' : null;
  if (key === 'status') return v === 'done' ? '✓ 완료' : '열림';
  return String(v);
}

function snap(v) {
  if (!v || typeof v !== 'object') return null;
  return {
    title: str(v.title),
    priority: [1, 2, 3, 4].includes(v.priority) ? v.priority : null,
    note: str(v.note) || null,
    link: str(v.link) || null,
    status: v.status === 'done' ? 'done' : 'open',
  };
}

function meta(s) {
  return [fieldText('priority', s.priority), s.note ? `메모: ${s.note}` : null].filter(Boolean).join(' · ');
}

// 서버 preview → 그릴 블록. 바뀐 필드만, 순서는 제목·우선순위·상태·메모·링크
//  { kind: 'edit'|'done'|'reopen', id, title, fields: [{ key, label, old, new }] }
//  { kind: 'delete', id, title, meta }   — 통째로 빨간 취소선
//  { kind: 'add', title, meta }          — 초록 새 줄
export function diffBlocks(preview) {
  const out = [];
  for (const p of Array.isArray(preview) ? preview : []) {
    if (!p || !KINDS.includes(p.kind)) continue;
    const before = snap(p.before);
    const after = snap(p.after);
    if (p.kind === 'add') {
      if (after?.title) out.push({ kind: 'add', title: after.title, meta: meta(after) });
    } else if (p.kind === 'delete') {
      if (before) out.push({ kind: 'delete', id: str(p.id), title: before.title, meta: meta(before) });
    } else if (before && after) {
      const fields = FIELDS.filter((k) => before[k] !== after[k])
        .map((k) => ({ key: k, label: FIELD_LABELS[k], old: fieldText(k, before[k]), new: fieldText(k, after[k]) }));
      if (fields.length) out.push({ kind: p.kind, id: str(p.id), title: before.title, fields });
    }
  }
  return out;
}

// ---- 상태 ----
// null(닫힘) | { todoId, title, status, question, reply, ops, preview, rev, rule, notice, error, retry, seq, result, restored, at }
// result: 지난 문답의 결과 한 줄(✓ 적용·✗ 버림·지난 제안) · restored: 세션 창 "원래 화면 열기"로 지난 문답째 띄움
// rule: 서버가 낸 지속 규칙 미리보기({ proposal, summary, changes, skipped }) 또는 null
// status: idle → thinking → proposal → applying → applied | error
export function openAsk(todo) {
  if (!todo || typeof todo.id !== 'string' || !todo.id) return null;
  return { todoId: todo.id, title: str(todo.title), status: 'idle', question: '', reply: '', ops: [], preview: [], rev: null, rule: null, notice: null, error: null, retry: null, seq: 0, result: null, restored: false };
}

// 지난 문답째로 열기(GET /todos/:id/thread/last 의 exchange). 아직 ✓ 할 수 있는 제안이면(outcome pending + ops·규칙) 그 diff 그대로,
// 아니면 물음·답 + 결과 한 줄만(ops 없음 → ✓ 없음). 이어서 물으면 보통 팝오버처럼
export function restoreAsk(todo, exchange, threadId) {
  const base = openAsk(todo);
  if (!base) return null;
  const tid = typeof threadId === 'string' && threadId ? { threadId } : {};
  const x = exchange && typeof exchange === 'object' ? exchange : null;
  if (!x || !str(x.question)) return { ...base, ...tid };
  const ops = Array.isArray(x.ops) ? x.ops : [];
  const rule = ruleBlock(x.rule) ? x.rule : null;
  const live = x.outcome === 'pending' && (ops.length > 0 || !!rule) && typeof x.rev === 'string';
  return {
    ...base, ...tid, status: 'proposal', restored: true, question: str(x.question), reply: str(x.reply), at: str(x.at) || null,
    ops: live ? ops : [], preview: live && Array.isArray(x.preview) ? x.preview : [], rev: live ? x.rev : null, rule: live ? rule : null,
    result: live ? null : (str(x.result) || (x.outcome === 'stale' ? '그때 제안은 지났어요 — 다시 물어보세요.' : null)),
  };
}

export function askReducer(s, a) {
  if (a?.type === 'open') return s && s.todoId === a.todo?.id ? s : openAsk(a.todo);
  if (a?.type === 'restore') return isAskBusy(s) && s.todoId === a.todo?.id ? s : restoreAsk(a.todo, a.exchange, a.threadId) ?? s;
  if (a?.type === 'close') return null;
  if (!s) return s;
  switch (a?.type) {
    case 'ask': {
      const q = str(a.text).trim();
      if (!q || s.status === 'thinking' || s.status === 'applying') return s;
      return { ...s, status: 'thinking', question: q, reply: '', ops: [], preview: [], rev: null, rule: null, notice: null, error: null, retry: null, result: null, restored: false, seq: s.seq + 1 };
    }
    case 'answer':
      if (a.seq !== s.seq || s.status !== 'thinking') return s; // 늦게 온 이전 답
      return { ...s, status: 'proposal', ...(typeof a.threadId === 'string' && a.threadId ? { threadId: a.threadId } : {}), reply: str(a.reply), ops: Array.isArray(a.ops) ? a.ops : [], preview: Array.isArray(a.preview) ? a.preview : [], rev: typeof a.rev === 'string' ? a.rev : null, rule: ruleBlock(a.rule) ? a.rule : null };
    case 'askFail':
      if (a.seq !== s.seq || s.status !== 'thinking') return s;
      return { ...s, status: 'error', error: str(a.message) || '못 물어봤어요', retry: 'ask' };
    case 'apply':
      return canApply(s) ? { ...s, status: 'applying', notice: null, error: null } : s;
    case 'applied':
      return s.status === 'applying' ? { ...s, status: 'applied' } : s;
    case 'applyFail':
      return s.status === 'applying' ? { ...s, status: 'error', error: str(a.message) || '적용하지 못했어요', retry: 'apply' } : s;
    case 'stale': // 미리보기 뒤에 할 일이 바뀜 → 새 미리보기로 다시 확인
      return s.status === 'applying'
        ? { ...s, status: 'proposal', ops: Array.isArray(a.ops) ? a.ops : s.ops, preview: Array.isArray(a.preview) ? a.preview : s.preview, rev: typeof a.rev === 'string' ? a.rev : s.rev, rule: a.rule === undefined ? s.rule : ruleBlock(a.rule) ? a.rule : null, notice: '그새 할 일이 바뀌어서 다시 맞췄어. 확인하고 ✓' }
        : s;
    case 'retryApply': // 적용 실패 → 제안 화면으로 돌아가 다시 ✓
      return s.status === 'error' && s.retry === 'apply' ? { ...s, status: 'proposal', error: null, retry: null } : s;
    case 'gone': // 목록에서 그 할 일이 사라짐(적용 중·직후 제외)
      return s.status === 'applying' || s.status === 'applied' ? s : null;
    default:
      return s;
  }
}

// 적용할 것: 할 일 변경(ops)이나 지속 규칙(rule) 중 하나라도
export const hasProposal = (s) => !!s && (s.ops.length > 0 || !!s.rule);
export const canApply = (s) => !!s && s.status === 'proposal' && hasProposal(s);
export const isAskBusy = (s) => !!s && (s.status === 'thinking' || s.status === 'applying');

// 팝오버 키: 'send' | 'apply' | 'discard' | null. 한글 조합 중엔 아무것도 안 함
// ⌘⇧Enter = 채팅 창에서 열기(그 할 일의 대화로)
export function askKey(e) {
  if (!e || e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'discard';
  if (e.key !== 'Enter') return null;
  if (e.shiftKey) return e.metaKey || e.ctrlKey ? 'chat' : null;
  return e.metaKey || e.ctrlKey ? 'apply' : 'send';
}

// 팝오버 → 채팅 창: 그 할 일의 대화를 열고 입력창에 넣어 둘 글.
// 데몬이 문답을 그 할 일의 대화에 이미 남겼으면(답에 threadId) 다시 옮기지 않는다 — 입력 중이던 글만.
// 못 물어봤거나(오류) 옛 데몬이라 안 남았으면 물은 말을 입력창으로(한 번만, 보내는 건 사용자가)
export function chatHandoff(s, inputText) {
  if (!s || typeof s.todoId !== 'string' || !s.todoId) return null;
  const typed = str(inputText).trim();
  if (typed) return { todoId: s.todoId, draft: typed };
  const unlogged = s.question && !s.threadId && (s.status === 'error' || s.status === 'proposal' || s.status === 'idle');
  return { todoId: s.todoId, draft: unlogged ? s.question : '' };
}

// ---- 위치 ----
// anchor: 할 일 줄의 화면 사각형, size: 팝오버 크기, view: 창 크기, pointX: 누른 x(화살표가 가리킬 곳)
// 아래에 들어가면 아래, 아니면 위, 둘 다 안 들어가면 넓은 쪽. 화살표는 줄 쪽을 가리킨다.
export function placePopover({ anchor, size, view, pointX, margin = 8, gap = 10, arrowPad = 18 }) {
  const w = Math.min(size.width, view.width - margin * 2);
  const h = size.height;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - h;
  const roomBelow = view.height - margin - anchor.bottom - gap;
  const roomAbove = anchor.top - gap - margin;
  const placement = h <= roomBelow ? 'below' : h <= roomAbove ? 'above' : roomBelow >= roomAbove ? 'below' : 'above';
  const top = clamp(placement === 'below' ? below : above, margin, Math.max(margin, view.height - margin - h));
  const px = Number.isFinite(pointX) ? clamp(pointX, anchor.left, anchor.right) : anchor.left + 40;
  const left = clamp(px - 48, margin, Math.max(margin, view.width - margin - w));
  const arrowX = clamp(px - left, arrowPad, w - arrowPad);
  return { top: Math.round(top), left: Math.round(left), width: Math.round(w), placement, arrowX: Math.round(arrowX) };
}

// ---- 낙관적 반영 ----
// preview → overlayTodos 겹침 op: 수정 → edit, 삭제·완료 → remove, 추가 → add(tempId)
export function previewOverlay(preview, tempPrefix = 'tmp:ask') {
  const out = [];
  let n = 0;
  for (const p of Array.isArray(preview) ? preview : []) {
    const before = snap(p?.before);
    const after = snap(p?.after);
    if (p?.kind === 'add' && after?.title) {
      out.push({ kind: 'add', tempId: `${tempPrefix}:${++n}`, body: { title: after.title, priority: after.priority ?? 2, ...(after.note ? { note: after.note } : {}), ...(after.link ? { link: after.link } : {}) } });
    } else if ((p?.kind === 'delete' || (p?.kind === 'done' && after?.status === 'done')) && p.id) {
      out.push({ kind: 'remove', id: p.id });
    } else if ((p?.kind === 'edit' || p?.kind === 'reopen') && p.id && before && after) {
      const patch = {};
      for (const k of ['title', 'priority', 'note', 'link']) if (before[k] !== after[k]) patch[k] = after[k];
      if (Object.keys(patch).length) out.push({ kind: 'edit', id: p.id, patch });
    }
  }
  return out;
}

// 성공 뒤 서버 목록(raw)에 확정 반영: 추가는 서버가 준 id 로 바꾸고 pending 표시는 뗀다
export function commitOverlay(todos, overlay, added) {
  const ids = (Array.isArray(added) ? added : []).map((t) => t?.id).filter((id) => typeof id === 'string');
  let i = 0;
  const ops = overlay.map((o) => (o.kind === 'add' ? { ...o, tempId: ids[i++] ?? o.tempId } : o));
  return overlayTodos(todos, ops).map(({ pending: _p, ...t }) => t);
}

// ---- IPC 인자 거르기(메인) ----
// ops: 아는 키·타입만, 최대 20개. 하나라도 이상하면 null
export function sanitizeAskOps(v, { allowEmpty = false } = {}) {
  if (!Array.isArray(v) || v.length > 20 || (!v.length && !allowEmpty)) return null;
  const out = [];
  for (const o of v) {
    if (!o || typeof o !== 'object' || !KINDS.includes(o.op)) return null;
    const x = { op: o.op };
    if (typeof o.id === 'string' && o.id.length <= 500) x.id = o.id;
    if (typeof o.title === 'string') x.title = o.title.slice(0, 350);
    if (Number.isInteger(o.priority)) x.priority = o.priority;
    for (const k of ['link', 'note']) if (o[k] === null || typeof o[k] === 'string') x[k] = o[k] === null ? null : o[k].slice(0, 2050);
    out.push(x);
  }
  return out;
}

export function cleanQuestion(v) {
  const s = str(v).trim();
  return s || null;
}
