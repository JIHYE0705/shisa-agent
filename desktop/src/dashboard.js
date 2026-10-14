// 대시보드 패널 뷰모델 — 순수 로직. GET /dashboard 응답을 그리기 좋게 다듬는다.
import { isSafeLink } from './bubbles.js';
import { shapeRules } from './todo-rules.js';

export const SECTIONS = ['setup', 'overview', 'projects', 'todos', 'today', 'chat', 'models'];
export const SECTION_LABELS = { setup: '설치', overview: '개요', projects: '프로젝트', todos: '할 일', today: '오늘 할 일', chat: '채팅', models: '모델' };

// 모르는 섹션은 null. 예전 말풍선 open.section=scrum 은 오늘 표로
export function normalizeSection(s) {
  if (s === 'scrum') return 'today';
  return SECTIONS.includes(s) ? s : null;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function toMs(iso) {
  if (typeof iso !== 'string' || !iso) return NaN;
  return Date.parse(iso);
}

// "방금", "5분 전", "3시간 전", "어제", "4일 전", 그 이상은 "9월 3일"
export function relativeTime(iso, now = Date.now()) {
  const t = toMs(iso);
  if (!Number.isFinite(t)) return '';
  const d = now - t;
  if (d < MIN) return '방금';
  if (d < HOUR) return `${Math.floor(d / MIN)}분 전`;
  if (d < DAY) return `${Math.floor(d / HOUR)}시간 전`;
  if (d < 2 * DAY) return '어제';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}일 전`;
  const x = new Date(t);
  return `${x.getMonth() + 1}월 ${x.getDate()}일`;
}

// "14:05" (로컬 시각)
export function clockTime(iso) {
  const t = toMs(iso);
  if (!Number.isFinite(t)) return '';
  const x = new Date(t);
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}

export function priorityLabel(p) {
  if (p === 1) return 'P1';
  if (p === 2) return 'P2';
  if (p === 3) return 'P3';
  if (p === 4) return '백로그';
  return '기타';
}

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

// 할 일을 우선순위별로 묶는다 (1 → 2 → 3 → 4 백로그 → 기타). 그룹 안 순서는 원래 순서.
export function groupTodos(todos) {
  const groups = new Map();
  for (const t of arr(todos)) {
    if (!t || typeof t !== 'object' || !str(t.id) || !str(t.title)) continue;
    const p = [1, 2, 3, 4].includes(t.priority) ? t.priority : 9;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push({
      id: t.id,
      title: t.title,
      source: str(t.source),
      link: str(t.link) && isSafeLink(t.link) ? t.link : null,
      linkRaw: str(t.link), // 편집칸에 보여줄 원래 값
      note: str(t.note),
      userEdited: t.userEdited === true,
      pending: t.pending === true, // 낙관적 반영 중(서버 응답 대기)
      priority: p,
      ...(t.appliedRule && str(t.appliedRule.text) ? { appliedRule: { id: str(t.appliedRule.id), text: t.appliedRule.text } } : {}), // 적용된 할 일 규칙
      ...(str(t.progress) ? { progress: t.progress, progressAt: str(t.progressAt) } : {}), // 어디까지 됐는지(데몬 진행 확인)
      ...(typeof t.doing === 'boolean' ? { doing: t.doing } : {}), // 사용자가 누른 (진행중) 토글
      ...(str(t.today) ? { today: t.today } : {}), // 오늘 할 일로 고른 날(KST)
    });
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([priority, items]) => ({ priority, label: priorityLabel(priority), items }));
}

// 서버가 준 최근 완료(자동 완료 포함). 자동이면 이유·근거 링크
export function shapeRecentDone(list, now = Date.now()) {
  return arr(list)
    .filter((t) => t && typeof t === 'object' && str(t.id) && str(t.title))
    .map((t) => ({
      id: t.id,
      title: t.title,
      source: str(t.source),
      priority: [1, 2, 3, 4].includes(t.priority) ? t.priority : 2,
      link: str(t.link) && isSafeLink(t.link) ? t.link : null,
      auto: t.doneBy === 'auto',
      reason: t.doneBy === 'auto' ? str(t.autoReason) : '',
      evidence: t.doneBy === 'auto' && str(t.autoEvidence) && isSafeLink(t.autoEvidence) ? t.autoEvidence : null,
      doneRel: relativeTime(t.doneAt, now),
    }));
}

// 숨기기/다시 보이기 낙관적 반영: 응답 오기 전 바꾼 값(path → hidden)을 서버 목록 위에 겹친다
export function overlayHidden(projects, pending) {
  if (!Array.isArray(projects)) return projects;
  if (!pending || !pending.size) return projects;
  return projects.map((p) => (p && pending.has(p.path) ? { ...p, hidden: pending.get(p.path) } : p));
}

// 최근 24시간 안에 손댄 프로젝트를 "진행 중"으로 본다
export function isActiveProject(p, now = Date.now()) {
  const t = toMs(p.lastActive);
  return p.sessions24h > 0 || p.commitsToday > 0 || (Number.isFinite(t) && now - t < DAY);
}

function shapeProject(p, now) {
  return {
    name: str(p.name) || '(이름 없음)',
    path: str(p.path),
    lastActive: str(p.lastActive),
    lastActiveRel: relativeTime(p.lastActive, now),
    sessions24h: num(p.sessions24h),
    branch: str(p.branch),
    commitsToday: num(p.commitsToday),
    hidden: p.hidden === true, // 패널에서 숨김 — 맨 아래 '숨긴 프로젝트'에 모은다
    lastTitle: str(p.lastTitle),
    lastPrompt: str(p.lastPrompt),
    recentCommits: arr(p.recentCommits)
      .filter((c) => c && str(c.subject))
      .slice(0, 5)
      .map((c) => ({ sha: str(c.sha).slice(0, 7), subject: c.subject, time: str(c.time), rel: relativeTime(c.time, now) })),
  };
}

// ---- 연결(커넥터) ----
// GET /dashboard 의 connectors: 기능마다 어디서 읽는지(api·mcp·off)와 준비 상태
export const CONNECTOR_CAPS = ['slack', 'calendar', 'mail', 'issues'];
const CONNECTOR_DEFAULT_LABELS = { slack: 'Slack', calendar: '캘린더', mail: '메일', issues: '이슈' };
export const CONNECTOR_MODE_LABELS = { api: 'API', mcp: 'MCP', off: '꺼짐' };

// 모르는 기능·모드나 모양이 이상한 항목은 건너뛴다. 같은 기능이 두 번 오면 앞의 것
export function shapeConnectors(list) {
  const seen = new Set();
  const out = [];
  for (const c of arr(list)) {
    if (!c || typeof c !== 'object' || !CONNECTOR_CAPS.includes(c.cap) || seen.has(c.cap)) continue;
    if (!Object.hasOwn(CONNECTOR_MODE_LABELS, c.mode)) continue;
    seen.add(c.cap);
    const ready = c.mode !== 'off' && c.ready === true;
    out.push({
      cap: c.cap,
      label: str(c.label).trim() || CONNECTOR_DEFAULT_LABELS[c.cap],
      mode: c.mode,
      modeLabel: CONNECTOR_MODE_LABELS[c.mode],
      ready,
      detail: str(c.detail).trim(),
      doc: str(c.doc).trim(), // 안내용 글자(예: docs/connect/slack.md). 링크로 열지 않는다
    });
  }
  return out;
}

export function visibleSections(_vm) {
  return SECTIONS;
}

export function shapeDashboard(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const all = arr(r.projects).filter((p) => p && typeof p === 'object').map((p) => shapeProject(p, now));
  const projects = all.filter((p) => !p.hidden); // 숨긴 건 집계·목록에서 빼고 따로
  const hiddenProjects = all.filter((p) => p.hidden);
  const todoGroups = groupTodos(r.todos);
  // 백로그(P4 — 기한 없고 안 중요)는 열린 할 일 수·배지에서 뺀다
  const backlogTodos = todoGroups.find((g) => g.priority === 4)?.items.length ?? 0;
  const openTodos = todoGroups.reduce((n, g) => n + g.items.length, 0) - backlogTodos;
  const p1Todos = todoGroups.find((g) => g.priority === 1)?.items.length ?? 0;
  const proposals = arr(r.proposals)
    .filter((p) => p && str(p.id))
    .map((p) => ({ id: p.id, title: str(p.title), repo: str(p.repo), status: str(p.status) || 'pending', result: str(p.result) }));

  const b = r.briefing && typeof r.briefing === 'object' ? r.briefing : null;
  const today = r.today && typeof r.today === 'object' ? r.today : null;
  const connectors = shapeConnectors(r.connectors);
  // 오늘 할 일 = 할 일 중 오늘로 고른 것. 열린 건 할 일 탭과 같은 우선순위 묶음(낙관적 반영 포함), 끝낸 건 '오늘 끝냄'
  const todayDate = str(today?.date);
  const todayGroups = todayDate ? groupTodos(arr(r.todos).filter((t) => t && t.today === todayDate)) : [];
  const todayOpen = todayGroups.flatMap((g) => g.items);
  const openIds = new Set(todayOpen.map((t) => t.id));
  const todayDone = arr(today?.items)
    .filter((it) => it && typeof it === 'object' && str(it.id) && str(it.title) && it.done === true && !openIds.has(it.id))
    .map((it) => ({ id: it.id, title: it.title, source: str(it.source), priority: [1, 2, 3, 4].includes(it.priority) ? it.priority : 2, today: todayDate, auto: false, doneRel: '' }));
  const todayItems = [
    ...todayOpen.map((t) => ({ id: t.id, title: t.title, done: false, priority: t.priority })),
    ...todayDone.map((t) => ({ id: t.id, title: t.title, done: true, priority: t.priority })),
  ];

  return {
    generatedAt: str(r.generatedAt),
    stats: {
      commitsToday: num(r.commitsToday),
      openTodos,
      p1Todos,
      backlogTodos,
      activeProjects: projects.filter((p) => isActiveProject(p, now)).length,
      pendingProposals: proposals.filter((p) => p.status === 'pending').length,
      todayOpen: todayOpen.length,
      todayTotal: todayItems.length,
    },
    briefing: b ? { at: str(b.at), time: clockTime(b.at), rel: relativeTime(b.at, now), bubble: str(b.bubble), md: str(b.replyMd) } : null,
    projects,
    hiddenProjects,
    todoGroups,
    todoRules: shapeRules(r.todoRules),
    recentDone: shapeRecentDone(r.recentDone, now),
    proposals,
    connectors,
    notReady: connectors.filter((c) => !c.ready).map((c) => c.cap),
    today: { date: todayDate, items: todayItems, asked: today?.asked === true },
    todayGroups,
    todayDone,
  };
}
