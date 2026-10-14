// 패널 렌더러 — 대시보드(개요·프로젝트·할 일·오늘 할 일)와 채팅. 네트워크는 전부 메인을 거친다.
import DOMPurify from './vendor/purify.js';
import { Marked } from './vendor/marked.js';
import { createMarkdown } from '../src/markdown.js';
import { shapeDashboard, overlayHidden, priorityLabel, SECTIONS, SECTION_LABELS, normalizeSection, relativeTime, clockTime, visibleSections } from '../src/dashboard.js';
import { needsSetup, stepForCap } from '../src/setup.js';
import { isFeature, isAgent, buildWalk, agentSteps } from '../src/setup-flow.js';
import { renderSetup, clearApiDraft, readSlot } from './setup-view.js';
import { mountModels } from './models-view.js';
import { CANNED, cannedReply, connectSteps, hubItem, slotOk, EXTRAS } from '../src/ai-onboard.js';
import { SETUP_FLOW_VERSION, isSetupPhase, phaseAfterBrain, backPhase, restorePhase, agentFrom, NO_AI } from '../src/setup-plan.js';
import { brainView, connectCard } from '../src/brain-state.js';
import { initialChat, chatReducer, isBusy, isRunning, busyLabel, busyThreads, sendButton, stopTargets, localState, queuedChats, queuedLabel, sentLabel } from '../src/chat.js';
import { stamp, withDayDividers } from '../src/chat-time.js';
import { KIND_ICONS, KIND_LABELS, normThread, normThreads, upsertThread, groupThreads, filterThreads, initSeen, isUnread, markSeen, pruneSeen, unreadCount, pickInitial, neighborThread, afterRemoval, mergeMessages, appendLocal, tagLocal, dropLocal, markSent, isDoubleSend, todoChip, okThreadId, editTarget, dropFrom } from '../src/threads.js';
import { PRIORITIES, mergeRecentDone, newTodoBody, overlayTodos, descriptionPatch, isDoing, patchToday, isToday } from '../src/todos.js';
import { createClickSorter, toggleOpen, dropTarget, autoScrollDelta, reorderLocal, isNoopMove, keyMove, detailView, LONG_PRESS, MOVE_SLOP } from '../src/todo-rows.js';
import { askReducer, askKey, chatHandoff, canApply, hasProposal, isAskBusy, diffBlocks, placePopover, previewOverlay, commitOverlay } from '../src/todo-ask.js';
import { originPlan, todoPlan } from '../src/origin.js';
import { trashModel, commitTrash, trashItemOf, todoBodyOf, confirmReducer, isConfirming, confirmKey, isTrashKey, createUndo, readTrashOpen, writeTrashOpen, overTrash, CONFIRM_TEXT, UNDO_MS } from '../src/todo-trash.js';
import { BACKLOG, rulesChip, overlayRules, hitsLabel, readBacklogOpen, writeBacklogOpen, isCollapsed, ruleBlock, ruleOverlay } from '../src/todo-rules.js';
import { attachSlashMenu } from './slash-menu.js';
import { createAttachTray } from './attach-tray.js';
import { attachUrl, chipView, attachSummary } from '../src/attachments.js';
import { cleanModels } from '../src/session.js';
import { normalizeActions, upsertAction, placeActions, cardView, decideResult, belongsToTodo, aroundAnswer, foldedPermission, foldApprovals } from '../src/actions.js';
import { normalizePermissionRules, ruleUsage, withoutPending } from '../src/permissions.js';
import { normAgents, agentStrip, agentCard, canStopAgent, placeAgents, agentsSig, normSessions, sessionCard, placeSessions, sessionsSig, sessionsPlaceSig } from '../src/agents.js';
import { normWorktrees, worktreeCard, openTarget, placeWorktrees, worktreesSig, worktreesPlaceSig } from '../src/worktrees.js';

const cy = window.cy;
const $ = (id) => document.getElementById(id);

if (new URLSearchParams(location.search).get('vibrancy') === '1') document.body.classList.add('vibrant');

const brand = $('brand-img');
// 사이드바 아이콘: 내 캐릭터(눈 뜬 기본 표정) → 번들 png → svg
const BRAND_SRCS = ['cy-asset://app/character/eyes_open@2x.png', 'cy-asset://app/character.png', '../assets/character.png', '../assets/character.svg'];
let brandAt = 0;
brand.addEventListener('error', () => { if (brandAt < BRAND_SRCS.length - 1) brand.src = BRAND_SRCS[++brandAt]; });
brand.src = BRAND_SRCS[0];

// ---- 마크다운: marked(원시 HTML 막음) → DOMPurify ----
const toHtml = createMarkdown(Marked);
const PURIFY = {
  ALLOWED_URI_REGEXP: /^(?:https?|slack):/i,
  FORBID_TAGS: ['style', 'img', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
  FORBID_ATTR: ['style'],
};
function md(el, src) {
  el.classList.add('md');
  el.innerHTML = DOMPurify.sanitize(toHtml(src), PURIFY);
  return el;
}
// 링크는 전부 메인에서 외부로 연다(메인이 스킴 한 번 더 확인)
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  cy.openLink(a.getAttribute('href'));
});

// 작은 DOM 헬퍼: h('div.card', {onclick}, '글자', child)
function h(sel, props, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
// replaceChildren 에 null 을 넣으면 화면에 "null" 글자가 찍힌다
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((c) => c != null && c !== false));
}

// ---- 상태 ----
let raw = null; // 마지막 /dashboard 응답
let flash = null; // { id, until } — 잠깐 강조할 할 일 줄(할 일 id) 또는 제안('proposal:<id>')
let vm = shapeDashboard(null);
let error = null;
let connected = false;
// 이 컴퓨터의 Claude Code·Codex(모르면 있다고 본다)
let caps = { claude: null, codex: null };
const hasCoder = () => caps.claude !== false;
let section = 'overview';
try { section = normalizeSection(localStorage.getItem('section')) ?? 'overview'; } catch { /* 저장소 없음 */ }
let setupPhase = 'name'; // name·brain·ai-key·extras·connect·done (setup-plan.js — 키·토큰은 저장하지 않는다)
let setupName = ''; // 데몬 설정 user.name
let setupRepos = []; // 데몬 설정 repoRoots
let detected = { claude: null, codex: null }; // 이 맥에서 찾은 Claude Code·Codex(로그인까지)
// 뇌(말 거는 AI) 연결 상태 — main 이 GET /status 로 알려 준다(brain-state.js brainView). 모르면 막지 않는다
let brain = { ready: true, known: false, connected: [] };
let setupAgent = '';
let setupPicked = [];
let setupCursor = 0;
let setupChoices = {};
let setupLink = '';
let keyStatus = '';
let afterConnect = ''; // 'claudecode'·'codexcli': 그 도구 연결을 마치면 시사의 AI로 쓴다
let sisa = { provider: '', hasKey: false, persona: '', canned: {}, done: {}, connected: [], chatModels: {}, codeModel: 'default' };
// 예전 화면 위치(ai-offer·agent·pick·walk)는 불러오지 않는다
try {
  setupPhase = restorePhase(localStorage.getItem('setupPhase'));
  const agent = localStorage.getItem('setupAgent');
  if (isAgent(agent)) setupAgent = agent;
  const picked = JSON.parse(localStorage.getItem('setupPicked') || '[]');
  if (Array.isArray(picked)) setupPicked = picked.filter(isFeature);
  const cursor = Number(localStorage.getItem('setupCursor'));
  if (Number.isInteger(cursor) && cursor >= 0) setupCursor = cursor;
  const choices = JSON.parse(localStorage.getItem('setupChoices') || '{}');
  if (choices && typeof choices === 'object' && !Array.isArray(choices)) setupChoices = choices;
  const link = localStorage.getItem('setupLink');
  if (typeof link === 'string') setupLink = link;
  if (localStorage.getItem('setupFlowVersion') !== SETUP_FLOW_VERSION) {
    setupPhase = 'name';
    setupCursor = 0;
    localStorage.setItem('setupFlowVersion', SETUP_FLOW_VERSION);
    localStorage.removeItem('setupDone');
  }
} catch { /* 저장소 없음 */ }
let setupKey = '';

function saveSetup() {
  try {
    localStorage.setItem('setupPhase', setupPhase);
    localStorage.setItem('setupAgent', setupAgent);
    localStorage.setItem('setupPicked', JSON.stringify(setupPicked));
    localStorage.setItem('setupCursor', String(setupCursor));
    localStorage.setItem('setupChoices', JSON.stringify(setupChoices));
    localStorage.setItem('setupLink', setupLink);
  } catch { /* 무시 */ }
}

// 지라처럼 코딩 도구 안에 등록하는 연결이 쓸 도구: 연결 끝낸 쪽
function connectAgentNow() {
  return agentFrom({ done: sisa.done, connected: sisa.connected });
}

// 뇌 고르기 화면에 들어갈 때: 이 맥의 Claude Code·Codex 로그인 확인 + 데몬 설정(이름·레포 폴더)
async function detectAgents() {
  const one = async (who) => { try { return !!(await cy.agentLogin(who))?.loggedIn; } catch { return null; } };
  const [c, x] = await Promise.all([one('claude'), one('codex')]);
  if (c === detected.claude && x === detected.codex) return;
  detected = { claude: c, codex: x };
  setupKey = '';
  if (section === 'setup') renderSetupView(false);
}
async function loadSetupSettings() {
  let r = null;
  try { r = await cy.setupLoad?.(); } catch { /* 데몬이 꺼져 있으면 빈 칸 */ }
  if (!r?.ok) return;
  setupName = r.name || '';
  setupRepos = Array.isArray(r.repoRoots) ? r.repoRoots : [];
  setupKey = '';
  if (section === 'setup') renderSetupView(false);
}
async function saveSetupSettings(patch) {
  let r = null;
  try { r = await cy.setupSave?.(patch); } catch { /* 아래 */ }
  if (r?.ok) {
    if (typeof r.name === 'string') setupName = r.name;
    if (Array.isArray(r.repoRoots)) setupRepos = r.repoRoots;
  }
  return !!r?.ok;
}

function stepsNow() {
  if (setupPhase === 'agentWalk') return agentSteps(setupAgent);
  if (setupPhase === 'connect') {
    return (setupLink === 'claude' || setupLink === 'codex') ? agentSteps(setupLink) : connectSteps(setupLink, connectAgentNow());
  }
  if (setupPhase === 'walk') return buildWalk(setupPicked, setupChoices, setupAgent || 'none');
  return [];
}

function clampSetupCursor() {
  const n = stepsNow().length;
  if (n === 0) return;
  if (setupCursor < 0) setupCursor = 0;
  else if (setupCursor >= n) setupCursor = n - 1;
}
let setupAsked = false;
let chat = initialChat();

// ---- 탭 ----
const nav = $('nav');
const badges = {};
for (const s of SECTIONS) {
  badges[s] = h('span.badge');
  nav.append(h('button', { type: 'button', role: 'tab', dataset: { section: s }, onclick: () => goto(s) }, h('span', { text: SECTION_LABELS[s] }), badges[s]));
}

function goto(s) {
  const prevSection = section;
  section = normalizeSection(s) ?? section;
  if (!visibleSections(vm).includes(section)) section = 'overview';
  if (section !== prevSection || !isListSection()) closeAsk(); // 팝오버는 그 탭의 줄에 붙는다
  try { localStorage.setItem('section', section); } catch { /* 무시 */ }
  for (const b of nav.children) b.setAttribute('aria-selected', String(b.dataset.section === section));
  for (const x of SECTIONS) $(`sec-${x}`).hidden = x !== section;
  $('content').classList.toggle('fill', section === 'chat');
  $('content').classList.toggle('chat-on', section === 'chat');
  $('content').classList.toggle('setup-on', section === 'setup'); // 설치: 버튼 줄은 맨 아래 고정, 내용만 스크롤
  $('title').textContent = SECTION_LABELS[section];
  if (section === 'setup') {
    renderSetupView(true);
    loadSetupSettings();
    if (setupPhase === 'brain') detectAgents();
  }
  if (section === 'models') loadSisa();
  if (section === 'chat') {
    scrollChat(true);
    renderChatLock();
    afterThreadsChanged(); // 보고 있는 대화는 읽음
    if (brain.ready !== false) $('chat-input').focus();
    requestAnimationFrame(() => autosize()); // 숨어 있는 동안 못 잰 입력창 높이(모듈 초기화 뒤에 돈다)
  } else if (isListSection() && todosStale && !todoInputFocused()) {
    renderTodos(); // 입력 중이라 미뤄둔 다시 그리기가 남아 있으면 지금
  }
}

// 연결 안 된 기능의 탭은 숨긴다. 보고 있던 탭이 사라지면 개요로
function renderNav() {
  const shown = visibleSections(vm);
  for (const b of nav.children) b.hidden = !shown.includes(b.dataset.section);
  if (!shown.includes(section)) goto('overview');
}

function renderBadges() {
  const { stats } = vm;
  badges.projects.textContent = vm.projects.length || '';
  badges.todos.textContent = stats.openTodos || '';
  badges.todos.classList.toggle('hot', stats.p1Todos > 0);
  badges.overview.textContent = stats.pendingProposals || '';
  const broken = vm.connectors.filter((c) => c.mode !== 'off' && !c.ready).length;
  badges.setup.className = !broken && needsSetup(vm.connectors) ? 'badge dot' : 'badge';
  badges.setup.classList.toggle('hot', broken > 0);
  badges.setup.textContent = broken || '';
  badges.today.textContent = vm.stats.todayOpen || '';
  // 채팅: 답하는 중이면 점, 아니면 안 읽은 대화 수
  const unread = seenLoaded ? unreadCount(seen, threads, section === 'chat' ? selectedId : null) : 0;
  badges.chat.className = isBusy(chat) ? 'badge dot' : 'badge';
  badges.chat.textContent = isBusy(chat) ? '' : unread || '';
}

// ---- 데이터 ----
let loading = false;
let again = false;
async function load() {
  if (loading) { again = true; return; }
  loading = true;
  let r;
  try { r = await cy.getDashboard(); } catch { r = { ok: false }; }
  loading = false;
  if (r?.ok && r.data && typeof r.data === 'object') {
    raw = r.data;
    error = null;
  } else {
    error = r?.error ? '시사에 연결되지 않았어요.' : `대시보드를 못 가져왔어요 (HTTP ${r?.status ?? '?'})`;
  }
  renderAll();
  if (again) { again = false; load(); }
}

let loadTimer = null;
const loadSoon = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 250); };


function renderAll() {
  const todos = raw ? overlayTodos(raw.todos, pendingOps) : null;
  vm = shapeDashboard(raw ? { ...raw, todos, projects: overlayHidden(raw.projects, hidePending) } : null, Date.now());
  if (openId && todos && !todos.some((t) => t.id === openId)) openId = null; // 끝났거나 지워진 할 일은 접는다
  $('banner').hidden = !error || section === 'setup';
  $('banner').textContent = error ?? '';
  $('updated').textContent = vm.generatedAt ? `${relativeTime(vm.generatedAt)} 갱신` : '';
  renderNav();
  maybeOpenSetup();
  renderSetupView(false);
  renderOverview();
  renderProjects();
  renderTodos(); // 할 일 탭과 오늘 할 일 탭(같은 줄·같은 묶음)
  renderBadges();
  renderThreadHead(); // 할 일 대화의 할 일 칩
}

// 잠깐 띄우는 오류(연결 오류가 있으면 그게 먼저)
let bannerTimer = null;
function setBanner(text) {
  if (error) return;
  clearTimeout(bannerTimer);
  $('banner').hidden = false;
  $('banner').textContent = text;
  bannerTimer = setTimeout(() => { if (!error) $('banner').hidden = true; }, 5000);
}

// ---- 개요 ----
function stat(num, label, sub, hot) {
  return h(`div.card.stat${hot ? '.hot' : ''}`, null, h('div.num', { text: String(num) }), h('div.label', { text: label }), sub ? h(`div.sub${hot ? '.hot' : ''}`, { text: sub }) : null);
}

const PROPOSAL_LABEL = { pending: '대기', approved: '승인', held: '보류', running: '진행 중', done: '완료', failed: '실패' };
const PROPOSAL_CHIP = { pending: 'accent', running: 'warn', done: 'ok', failed: 'err' };

function renderOverview() {
  const { stats, briefing, today, proposals } = vm;
  const el = $('sec-overview');
  const active = vm.projects.filter((p) => p.sessions24h > 0 || p.commitsToday > 0).map((p) => p.name);
  el.replaceChildren(...[ // null(제안 없음 등)은 빼야 'null' 글자로 안 찍힘
    h('div.stats', null,
      stat(stats.commitsToday, '오늘 커밋', vm.projects.filter((p) => p.commitsToday > 0).map((p) => `${p.name} ${p.commitsToday}`).join(' · ') || null),
      stat(stats.openTodos, '열린 할 일', stats.p1Todos ? `P1 ${stats.p1Todos}개` : 'P1 없음', stats.p1Todos > 0),
      stat(stats.activeProjects, '진행 중 프로젝트', active.slice(0, 3).join(', ') || null),
      stat(stats.pendingProposals, '대기 중 제안', null)),
    connected ? null : h('div.card.empty', { text: '시사가 꺼져 있어요. 켜지면 여기 채워져요.' }),
    h('h2', null, h('span', { text: '오늘 할 일 ' }),
      h('span.chip.click', { text: today?.items?.length ? `남은 ${(today.items.filter((it) => !it.done).length)}개` : '아직 없음', role: 'button', onclick: () => goto('today') })),
    h('h2', null, h('span', { text: '최근 브리핑 ' }),
      h('button.ghost.small', { type: 'button', text: '지금 브리핑', onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; b.textContent = '브리핑 중…';
        const r = await cy.briefingNow().catch(() => ({ ok: false }));
        b.textContent = r?.ok ? '시작했어요' : '연결 안 됨';
        setTimeout(() => { b.disabled = false; b.textContent = '지금 브리핑'; }, 4000);
      } })),
    briefing
      ? h('div.card', null,
        h('div.row.briefing-head', null, h('span.chip.accent', { text: `${briefing.time} · ${briefing.rel}` }), briefing.bubble ? h('span.muted', { text: briefing.bubble }) : null),
        md(h('div'), briefing.md || briefing.bubble))
      : h('div.card.empty', { text: '아직 브리핑이 없어요.' }),
    permissionsSection(),
    proposals.length ? h('h2', { text: '제안' }) : null,
    proposals.length
      ? h('div.card', null, proposals.map((p) => h(`div.proposal${flash?.id === `proposal:${p.id}` && Date.now() < flash.until ? '.flash' : ''}`, { dataset: { id: p.id } },
        h(`span.chip.${PROPOSAL_CHIP[p.status] ?? 'x'}`, { text: PROPOSAL_LABEL[p.status] ?? p.status }),
        h('span.t', { text: p.title, title: p.result || p.title }),
        p.repo ? h('span.muted.small', { text: p.repo }) : null,
        /^https:\/\//.test(p.result) ? h('a', { href: p.result, text: 'PR' }) : null)))
      : null,
    ...(renderConnectors(vm.connectors) ?? []),
  ].filter((c) => c != null && c !== false));
}

// ---- 권한([항상 허용]으로 저장한 도구 규칙) — 개요 아래. 지우면 다음부터 다시 묻는다 ----
let permRules = [];
let permLoaded = false;
const permRemoving = new Set();
let permMsg = null;
async function loadPermissions() {
  let r;
  try { r = await cy.permissions(); } catch { r = { ok: false }; }
  if (r?.ok && Array.isArray(r.data?.rules)) { permRules = normalizePermissionRules(r.data.rules); permLoaded = true; renderOverview(); }
}
async function removePermission(rule) {
  if (permRemoving.has(rule.id)) return;
  permRemoving.add(rule.id);
  permMsg = null;
  renderOverview();
  let r;
  try { r = await cy.permissionDelete(rule.id); } catch { r = { ok: false }; }
  permRemoving.delete(rule.id);
  if (r?.ok || r?.status === 404) permRules = permRules.filter((x) => x.id !== rule.id);
  else permMsg = `지우지 못했어요 — ${why(r)}`;
  renderOverview();
}
function permissionsSection() {
  const rules = withoutPending(permRules, permRemoving);
  return h('section.perm-sec', null,
    h('h2', null, h('span', { text: '권한 ' }), h('span.muted.small', { text: '항상 허용한 도구 — 나머지 쓰기는 매번 승인 카드로 물어봐요' })),
    permMsg ? h('div.result.err', { role: 'status', text: permMsg }) : null,
    rules.length
      ? h('div.card.perm-list', null, rules.map((r) => h('div.perm-row', { dataset: { id: r.id } },
        h('span.perm-icon', { text: r.kind.icon, title: r.kind.name }),
        h('span.perm-label', { text: r.label, title: r.scope || r.tool }),
        h('span.muted.small', { text: ruleUsage(r) }),
        h('span.spacer'),
        h('button.ghost.small.perm-del', { type: 'button', text: '지우기', 'aria-label': `권한 지우기: ${r.label}`, onclick: () => removePermission(r) }))))
      : h('div.card.empty.small', { text: permLoaded ? '항상 허용한 도구가 없어요. 승인 카드에서 [항상 허용]을 누르면 여기 생겨요.' : '불러오는 중…' }));
}

// 연결 카드: 기능마다 이름·모드 칩. 준비 안 된 건 이유, 늘 "설정 안내"로 마법사 단계를 연다.
function connectorChip(c) {
  if (c.mode === 'off') return h('span.chip', { text: c.modeLabel });
  return h(`span.chip.${c.ready ? 'ok' : 'warn'}`, { text: c.modeLabel, title: c.ready ? '연결됨' : '준비 안 됨' });
}
function renderConnectors(list) {
  if (!list?.length) return null; // 예전 데몬: 필드가 없으면 카드도 없다
  return [
    h('h2', { text: '연결' }),
    h('div.card.connectors', null, list.map((c) => h(`div.conn-row${c.ready ? '' : '.not-ready'}`, { dataset: { cap: c.cap } },
      h('div.conn-head', null, h('span.conn-label', { text: c.label }), connectorChip(c),
        c.ready && c.detail ? h('span.muted.small.conn-detail', { text: c.detail }) : null,
        h('button.ghost.setup-jump', { type: 'button', text: '설정 안내', onclick: () => openSetup(stepForCap(c.cap)) })),
      c.ready ? null : h('div.conn-hint.muted.small', null,
        h('span', { text: !c.detail || c.detail === '연결 안 됨' ? '연결 안 됨' : `연결 안 됨 — ${c.detail}` }))))),
  ];
}

// ---- 설치 마법사 ----
function openSetup(phase) {
  if (isSetupPhase(phase)) setupPhase = phase;
  else if (!isSetupPhase(setupPhase) || setupPhase === 'done') setupPhase = 'extras';
  saveSetup();
  setupKey = '';
  goto('setup');
}

let copyTimer = null;
let copyBtn = null;
async function copySetup(text, btn) {
  let r;
  try { r = await cy.copyText(text); } catch { r = { ok: false }; }
  if (copyBtn && copyBtn !== btn) copyBtn.textContent = copyBtn.dataset.label || '복사';
  copyBtn = btn;
  btn.textContent = r?.ok ? '복사됨' : '복사 실패';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { if (copyBtn === btn) btn.textContent = btn.dataset.label || '복사'; }, 1200);
}

let agentLoginState = { loggedIn: false, installed: null };
let loginTimer = null;

function codingAgent() {
  if (setupPhase === 'agentWalk' && (setupAgent === 'claude' || setupAgent === 'codex')) return setupAgent;
  if (setupPhase === 'connect' && (setupLink === 'claude' || setupLink === 'codex')) return setupLink;
  return '';
}

function watchAgentLogin() {
  clearInterval(loginTimer);
  loginTimer = null;
  const who = codingAgent();
  if (section !== 'setup' || !who) return;
  const step = agentSteps(who)[setupCursor];
  if (step?.gate !== 'login') return;
  const tick = async () => {
    let r = { loggedIn: false, installed: false };
    try { r = (await cy.agentLogin(who)) || r; } catch { /* 확인 실패는 로그인 전으로 둔다 */ }
    const next = {
      loggedIn: !!r.loggedIn,
      installed: typeof r.installed === 'boolean' ? r.installed : agentLoginState.installed,
    };
    if (next.loggedIn === agentLoginState.loggedIn && next.installed === agentLoginState.installed) return;
    agentLoginState = next;
    setupKey = '';
    renderSetupView(false);
  };
  tick();
  loginTimer = setInterval(tick, 2000);
}

function keyFail(error) {
  const e = String(error || '');
  if (/credit|balance|billing|quota|크레딧/i.test(e) && !/RESOURCE_EXHAUSTED/.test(e)) {
    return '키는 맞을 수 있지만 **크레딧이 없습니다.** 결제 크레딧을 산 뒤 다시 **확인**을 누르세요.';
  }
  if (/RESOURCE_EXHAUSTED|429|rate.?limit/i.test(e)) {
    return '키는 맞지만 **지금은 한도가 찼습니다.** 조금 뒤에 **확인**을 다시 누르세요.';
  }
  if (/API_KEY_INVALID|API key not valid|invalid|incorrect|authentication|unauthorized|401|400/i.test(e)) {
    return '**키가 맞지 않습니다.** 앞에서 복사한 키를 다시 붙이세요. 앞뒤에 빈칸이 들어가지 않았는지도 보세요.';
  }
  if (/fetch failed|network|ENOTFOUND|ECONN/i.test(e)) return '**인터넷에 연결되지 않았습니다.** 연결을 확인하고 다시 누르세요.';
  return '**확인하지 못했습니다.** 키를 다시 복사해서 붙이고 **확인**을 누르세요.';
}

function renderSetupView(resetScroll) {
  if (section !== 'setup') {
    clearInterval(loginTimer);
    loginTimer = null;
    return;
  }
  clampSetupCursor();
  const key = `${setupPhase}|${setupName}|${setupRepos.join(',')}|${JSON.stringify(detected)}|${JSON.stringify(brain)}|${(sisa.connected || []).join(',')}|${setupAgent}|${setupLink}|${setupCursor}|${keyStatus}|${JSON.stringify(sisa.done)}|${setupPicked.join(',')}|${JSON.stringify(setupChoices)}|${agentLoginState.loggedIn}|${agentLoginState.installed}`;
  if (!resetScroll && key === setupKey && $('sec-setup').childElementCount) {
    watchAgentLogin();
    return;
  }
  setupKey = key;
  const top = resetScroll ? 0 : ($('sec-setup').querySelector('.setup-scroll')?.scrollTop ?? 0);
  const redraw = (scroll) => { setupKey = ''; renderSetupView(scroll); };
  renderSetup($('sec-setup'), {
    phase: setupPhase,
    agent: setupAgent,
    picked: setupPicked,
    cursor: setupCursor,
    choices: setupChoices,
    login: agentLoginState,
    link: setupLink,
    connectAgent: connectAgentNow(),
    keyStatus,
    done: sisa.done,
    connected: sisa.connected,
    name: setupName,
    detected,
    current: sisa.provider,
    repos: setupRepos,
    brain,
    coder: hasCoder(),
    onName: async (name) => {
      if (name !== setupName) await saveSetupSettings({ user: { name: name || null } });
      setupPhase = 'brain';
      saveSetup();
      redraw(true);
      detectAgents();
    },
    onPickBrain: async (id) => {
      if (id === NO_AI) {
        // AI 없이 쓰기: 로컬 뇌로 정하고(정해진 말·할 일·오늘 표·회의 알림) 마법사는 그대로 이어 간다
        try { await cy.sisaSkip(); } catch { /* 설정에서 다시 고를 수 있다 */ }
        await loadSisa();
        setupPhase = phaseAfterBrain(NO_AI);
        saveSetup();
        redraw(true);
        return;
      }
      if (id === 'claudecode' || id === 'codexcli') {
        const who = id === 'codexcli' ? 'codex' : 'claude';
        let r = { loggedIn: false };
        try { r = (await cy.agentLogin(who)) || r; } catch { /* 로그인 전으로 본다 */ }
        if (r.loggedIn) {
          let ok = false;
          try { ok = !!(await cy.sisaUseCli(who))?.ok; } catch { /* 아래에서 연결 안내로 */ }
          if (ok) {
            await loadSisa();
            setupPhase = phaseAfterBrain(id, { loggedIn: true });
            saveSetup();
            redraw(true);
            return;
          }
        }
        afterConnect = id;
        setupLink = who;
        setupAgent = who;
        setupPhase = 'connect';
        setupCursor = 0;
        agentLoginState = { loggedIn: false, installed: null };
        saveSetup();
        redraw(true);
        return;
      }
      clearApiDraft();
      keyStatus = '';
      setupLink = id;
      setupPhase = phaseAfterBrain(id);
      saveSetup();
      redraw(true);
    },
    onSkipBrain: () => {
      setupPhase = phaseAfterBrain('skip');
      saveSetup();
      redraw(true);
    },
    onCheckKey: async (apiKey) => {
      let r = { ok: false, error: '확인에 실패했습니다.' };
      try { r = (await cy.sisaCheck(setupLink, apiKey)) || r; } catch { /* 아래 문구 */ }
      if (r.ok) {
        keyStatus = 'ok';
        try { sisa = { ...sisa, ...(await cy.sisaGet()) }; } catch { sisa = { ...sisa, provider: setupLink, hasKey: true }; }
      } else keyStatus = keyFail(r.error);
      redraw(false);
    },
    onKeyNext: () => {
      if (keyStatus !== 'ok') return;
      setupPhase = 'extras';
      keyStatus = '';
      saveSetup();
      redraw(true);
    },
    onOpenExtra: (id) => {
      if (!EXTRAS.includes(id) || !hubItem(id)) return;
      setupLink = id;
      afterConnect = '';
      setupPhase = 'connect';
      setupCursor = 0;
      agentLoginState = { loggedIn: false, installed: null };
      saveSetup();
      redraw(true);
    },
    onAddRepo: async (dir) => {
      if (setupRepos.includes(dir)) return;
      await saveSetupSettings({ repoRoots: [...setupRepos, dir] });
      redraw(false);
    },
    onPickFolder: cy.pickFolder ? async () => {
      let dir = null;
      try { dir = await cy.pickFolder(); } catch { /* 취소 */ }
      if (typeof dir === 'string' && dir && !setupRepos.includes(dir)) {
        await saveSetupSettings({ repoRoots: [...setupRepos, dir] });
        redraw(false);
      }
    } : null,
    onRemoveRepo: async (dir) => {
      await saveSetupSettings({ repoRoots: setupRepos.filter((x) => x !== dir) });
      redraw(false);
    },
    onFinishExtras: () => {
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      setupPhase = 'done';
      saveSetup();
      redraw(true);
    },
    onTour: () => {
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      cy.startTour?.();
    },
    onClose: () => {
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      goto('overview');
    },
    onOpen: (url) => { try { cy.openLink(url); } catch { /* 무시 */ } },
    onAgent: (id) => {
      if (!isAgent(id)) return;
      setupAgent = id;
      saveSetup();
      redraw(false);
    },
    onContinue: () => {
      if (!setupAgent) return;
      if (setupPhase === 'agentWalk' || setupAgent === 'none') setupPhase = 'pick';
      else { setupPhase = 'agentWalk'; setupCursor = 0; }
      saveSetup();
      redraw(true);
    },
    onToggle: (id) => {
      if (!isFeature(id)) return;
      setupPicked = setupPicked.includes(id) ? setupPicked.filter((x) => x !== id) : [...setupPicked, id];
      saveSetup();
      redraw(false);
    },
    onStart: () => {
      setupPhase = 'walk';
      setupCursor = 0;
      saveSetup();
      redraw(true);
    },
    onPrev: () => {
      if (setupCursor > 0) setupCursor -= 1;
      saveSetup();
      redraw(true);
    },
    onList: () => {
      setupPhase = afterConnect ? 'brain' : 'extras';
      afterConnect = '';
      setupCursor = 0;
      keyStatus = '';
      saveSetup();
      redraw(true);
    },
    onNext: async () => {
      if (setupPhase === 'connect') {
        const steps = stepsNow();
        const step = steps[setupCursor];
        if (step?.gate === 'blocked') return;
        if (step?.gate === 'login' && !agentLoginState.loggedIn) return;
        if (step?.slots?.some((s) => !slotOk(s.id, readSlot(s.id)))) return;
        if (setupCursor < steps.length - 1) {
          setupCursor += 1;
          saveSetup();
          redraw(true);
          return;
        }
        const url = (setupLink === 'gcal' || setupLink === 'outlook') ? readSlot(setupLink) : '';
        try { await cy.sisaMark(setupLink, url); } catch { /* 표시만 남긴다 */ }
        if ((afterConnect === 'claudecode' && setupLink === 'claude') || (afterConnect === 'codexcli' && setupLink === 'codex')) {
          afterConnect = '';
          try { await cy.sisaUseCli(setupLink); } catch { /* 목록에서 다시 고르면 된다 */ }
          await loadSisa();
        }
        try {
          const got = await cy.sisaGet();
          if (got && typeof got === 'object') sisa = { ...sisa, ...got, hasKey: !!got.hasKey, done: got.done || {} };
        } catch { /* 목록은 돌아간다 */ }
        sisa.done = { ...(sisa.done || {}), [setupLink]: true };
        // 뇌 고르기에서 설치 안내로 들어왔으면 다음(더 연결하기)으로, 더 연결하기에서 왔으면 그 목록으로
        setupPhase = 'extras';
        setupCursor = 0;
        keyStatus = '';
        saveSetup();
        redraw(true);
        return;
      }
      if (setupPhase === 'agentWalk') {
        const steps = agentSteps(setupAgent);
        const step = steps[setupCursor];
        if (step?.gate === 'login' && !agentLoginState.loggedIn) return;
        if (setupCursor >= steps.length - 1) {
          setupPhase = 'pick';
          setupCursor = 0;
          agentLoginState = { loggedIn: false, installed: null };
        } else setupCursor += 1;
      } else if (setupPhase === 'walk') {
        const steps = buildWalk(setupPicked, setupChoices, setupAgent || 'none');
        if (setupCursor >= steps.length - 1) {
          try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
          setupPhase = 'pick';
          saveSetup();
          goto('overview');
          return;
        }
        setupCursor += 1;
      } else setupCursor += 1;
      saveSetup();
      redraw(true);
    },
    onChoose: (keyName, choiceId) => {
      setupChoices = { ...setupChoices, [keyName]: choiceId };
      const steps = buildWalk(setupPicked, setupChoices, setupAgent || 'none');
      if (setupCursor < steps.length - 1) setupCursor += 1;
      saveSetup();
      redraw(true);
    },
    onSkip: () => {
      const steps = buildWalk(setupPicked, setupChoices, setupAgent || 'none');
      const feature = steps[setupCursor]?.feature;
      let i = setupCursor + 1;
      while (i < steps.length && steps[i].feature === feature) i += 1;
      setupCursor = Math.min(i, Math.max(steps.length - 1, 0));
      saveSetup();
      redraw(true);
    },
    onBack: () => {
      setupPhase = backPhase({ phase: setupPhase, afterConnect: !!afterConnect });
      if (setupPhase === 'brain') detectAgents();
      if (setupPhase !== 'connect') afterConnect = '';
      setupCursor = 0;
      keyStatus = '';
      saveSetup();
      redraw(true);
    },
    onCopy: copySetup,
    onDone: () => {
      try { localStorage.setItem('setupDone', '1'); } catch { /* 무시 */ }
      setupPhase = 'pick';
      saveSetup();
      goto('overview');
    },
  });
  const sc = $('sec-setup').querySelector('.setup-scroll');
  if (sc) sc.scrollTop = top;
  watchAgentLogin();
}

function maybeOpenSetup() {
  if (setupAsked || !needsSetup(vm.connectors)) return;
  setupAsked = true;
  try { if (localStorage.getItem('setupDone') === '1') return; } catch { /* 저장소 없으면 연다 */ }
  if (section === 'overview') openSetup('name');
}

// ---- 프로젝트 ----
// 숨기기: 카드의 '숨기기' 버튼 → 낙관적으로 아래 '숨긴 프로젝트'로, 실패하면 되돌림. 숨긴 건 집계·에이전트 맥락에서도 빠진다
const hidePending = new Map(); // path → hidden (응답 대기 중)
let projMsg = null;
let hiddenOpen = false;
try { hiddenOpen = localStorage.getItem('hiddenProjectsOpen') === '1'; } catch { /* 저장소 없음 */ }

async function setHidden(p, hide) {
  if (!p.path || hidePending.has(p.path)) return;
  hidePending.set(p.path, hide);
  projMsg = null;
  renderAll();
  let r;
  try { r = await cy.projectHide(p.path, hide); } catch { r = { ok: false }; }
  hidePending.delete(p.path);
  if (r?.ok) {
    if (raw && Array.isArray(raw.projects)) raw = { ...raw, projects: raw.projects.map((x) => (x?.path === p.path ? { ...x, hidden: hide } : x)) };
    loadSoon();
  } else {
    projMsg = { ok: false, text: `${hide ? '숨기기' : '다시 보이기'} 실패 — ${why(r)}` };
  }
  renderAll();
}

function toggleHiddenGroup() {
  hiddenOpen = !hiddenOpen;
  try { localStorage.setItem('hiddenProjectsOpen', hiddenOpen ? '1' : '0'); } catch { /* 무시 */ }
  renderProjects();
}

function renderProjects() {
  const el = $('sec-projects');
  const hidden = vm.hiddenProjects;
  const kids = [];
  if (projMsg) kids.push(h(`div.result.${projMsg.ok ? 'ok' : 'err'}`, { role: 'status', text: projMsg.text }));
  if (!vm.projects.length) kids.push(h('div.empty', { text: error && !raw ? '불러오지 못함' : hidden.length ? '숨긴 프로젝트만 있음' : '최근 프로젝트 없음' }));
  else kids.push(projectCards());
  if (hidden.length) {
    kids.push(h('div.hidden-projects', null,
      h('button.ghost.hidden-toggle', { type: 'button', 'aria-expanded': String(hiddenOpen), onclick: toggleHiddenGroup },
        h('span.caret', { text: hiddenOpen ? '▾' : '▸' }), h('span', { text: `숨긴 프로젝트 (${hidden.length})` })),
      hiddenOpen
        ? h('div.card.hidden-list', null, hidden.map((p) => h('div.hidden-row', null,
          h('span.name', { text: p.name }),
          p.path ? h('span.path.mono', { text: p.path, title: p.path }) : null,
          h('span.spacer'),
          h('button.ghost', { type: 'button', text: '다시 보이기', 'aria-label': `다시 보이기: ${p.name}`, onclick: () => setHidden(p, false) }))))
        : null));
  }
  fill(el, ...kids);
}

function projectCards() {
  return h('div.projects', null, vm.projects.map((p) => h('article.card.proj', null,
    h('div.head', null, h('span.name', { text: p.name }), p.branch ? h('span.chip.mono', { text: p.branch }) : null,
      h('span.spacer'),
      h('button.ghost.hide-btn', { type: 'button', text: '숨기기', title: '이 프로젝트 숨기기 — 집계와 에이전트 맥락에서도 빠져요', 'aria-label': `숨기기: ${p.name}`, onclick: () => setHidden(p, true) })),
    p.path ? h('div.path.mono', { text: p.path, title: p.path }) : null,
    h('div.meta', null,
      h('span', null, '마지막 활동 ', h('b', { text: p.lastActiveRel || '—', title: p.lastActive })),
      h('span', null, '24h 세션 ', h('b', { text: String(p.sessions24h) })),
      h('span', null, '오늘 커밋 ', h(`b${p.commitsToday ? '.today' : ''}`, { text: String(p.commitsToday) }))),
    p.lastTitle || p.lastPrompt
      ? h('div.session', null,
        p.lastTitle ? h('div.title', { text: p.lastTitle, title: p.lastTitle }) : null,
        p.lastPrompt ? h('div.prompt', { text: p.lastPrompt, title: p.lastPrompt }) : null)
      : null,
    p.recentCommits.length
      ? h('ul.commits', null, p.recentCommits.map((c) => h('li', null,
        h('span.sha.mono', { text: c.sha }), h('span.subj', { text: c.subject, title: c.subject }), h('span.when', { text: c.rel }))))
      : null,
  )));
}

// ---- 할 일 ----
// 줄: 한 번 누르면 아래에 설명·원본(펼침), 두 번 누르면 그 자리 팝오버(한 턴 편집), 꾹 눌러 끌면 순서·우선순위.
// 변경은 낙관적으로: pendingOps 를 서버 목록 위에 겹쳐 그리고, 실패하면 빼서 되돌린다.
let pendingOps = [];
let opSeq = 0;
let openId = null; // 펼친 할 일(한 번에 하나)
const details = new Map(); // id → { status: 'loading'|'ok'|'error', data?, error? } — GET /todos/:id/detail
let refocusId = null; // 다시 그린 뒤 키보드 포커스를 돌려줄 줄
let recentDone = []; // 이 창에서 방금 완료한 것 — 되돌리기용
let todoMsg = null; // { ok, text }
let todosStale = false;
let addPriority = 2;
let addDraft = '';
let todayPriority = 2; // 오늘 할 일 탭의 추가 칸
let todayDraft = '';

const why = (r) => (typeof r?.data?.error === 'string' ? r.data.error : r?.status ? `HTTP ${r.status}` : '시사 연결 확인');

// 서버 호출 + 낙관적 반영. 성공하면 commit 으로 raw 에 반영, 실패하면 겹침만 빼서 원래대로
// op 하나 또는 여러 개(팝오버 적용). failText 가 null 이면 목록에 오류를 띄우지 않는다(팝오버가 보여줌)
async function mutate(op, call, failText, commit) {
  const ops = Array.isArray(op) ? op : [op];
  for (const o of ops) o.seq = ++opSeq;
  pendingOps.push(...ops);
  todoMsg = null;
  renderAll();
  let r;
  try { r = await call(); } catch { r = { ok: false }; }
  pendingOps = pendingOps.filter((x) => !ops.includes(x));
  if (r?.ok) {
    if (raw) commit?.(r);
    loadSoon();
  } else if (failText) {
    todoMsg = { ok: false, text: `${failText} — ${why(r)}` };
  }
  renderAll();
  return r;
}

const rawTodos = () => (raw && Array.isArray(raw.todos) ? raw.todos : []);
const setRawTodos = (xs) => { raw = { ...raw, todos: xs }; };
const visibleTodos = () => overlayTodos(rawTodos(), pendingOps);

// 끌기·Alt 키로 순서·우선순위 바꾸기
function moveTodo(id, priority, beforeId) {
  if (isNoopMove(visibleTodos(), id, priority, beforeId)) return;
  mutate({ kind: 'reorder', id, priority, beforeId }, () => cy.todoReorder(id, priority, beforeId ?? null), '순서 바꾸기 실패',
    () => setRawTodos(reorderLocal(rawTodos(), id, priority, beforeId)));
}

// scope 'today': 오늘 할 일 탭에서 추가. 같은 할 일로 만들고 오늘로 고른다
function addTodo(scope = 'todos') {
  const today = scope === 'today';
  const date = vm.today?.date || '';
  const body = newTodoBody(today ? todayDraft : addDraft, today ? todayPriority : addPriority);
  if (!body) return;
  if (today) todayDraft = ''; else addDraft = '';
  const input = $(today ? 'today-add-input' : 'todo-add-input');
  if (input) input.value = '';
  const shown = today && date ? { ...body, today: date } : body; // 응답 전에도 오늘 묶음에 보이게
  mutate({ kind: 'add', tempId: `tmp:${opSeq + 1}`, body: shown }, () => cy.todoAdd(today ? { ...body, today: true } : body), '추가 실패', (r) => {
    if (typeof r.data?.id !== 'string') return;
    setRawTodos([{ id: r.data.id, source: 'user', userEdited: false, ...shown }, ...rawTodos()]);
    if (today) raw = { ...raw, today: patchToday(raw.today, r.data.id, { title: body.title, priority: body.priority, source: 'user', done: false }) };
  }).then((r) => {
    if (r?.ok) return;
    if (today) todayDraft = body.title; else addDraft = body.title;
    renderTodos();
  });
}

// 줄의 '오늘' 토글: 할 일을 오늘 할 일로 고르거나 뺀다(할 일은 그대로)
function toggleToday(t) {
  const date = vm.today?.date;
  if (!date) return;
  const on = isToday(t, date);
  mutate({ kind: 'edit', id: t.id, patch: { today: on ? null : date }, rule: true }, () => cy.todoEdit(t.id, { today: !on }), '오늘 할 일 바꾸기 실패', () => {
    setRawTodos(rawTodos().map((x) => {
      if (x.id !== t.id) return x;
      const { today: _drop, ...rest } = x;
      return on ? rest : { ...x, today: date };
    }));
    raw = { ...raw, today: patchToday(raw.today, t.id, on ? null : { title: t.title, priority: t.priority, source: t.source, done: false }) };
  });
}

function completeTodo(t) {
  const item = { id: t.id, title: t.title, source: t.source, priority: t.priority, link: t.linkRaw || undefined, note: t.note || undefined, userEdited: t.userEdited };
  mutate({ kind: 'remove', id: t.id }, () => cy.todoDone(t.id), '완료 처리 실패', () => {
    setRawTodos(rawTodos().filter((x) => x.id !== t.id));
    raw = { ...raw, today: patchToday(raw.today, t.id, { done: true }) }; // 오늘 할 일이면 '오늘 끝냄'으로
    recentDone = [item, ...recentDone.filter((x) => x.id !== t.id)].slice(0, 5);
  });
}

function reopenTodo(item) {
  recentDone = recentDone.filter((x) => x.id !== item.id);
  mutate({ kind: 'add', tempId: item.id, body: item }, () => cy.todoEdit(item.id, { status: 'open' }), '되돌리기 실패', () => {
    setRawTodos([item, ...rawTodos().filter((x) => x.id !== item.id)]);
    raw = { ...raw, today: patchToday(raw.today, item.id, { done: false }) };
  }).then((r) => { if (!r?.ok) { recentDone = [item, ...recentDone]; renderTodos(); } });
}

// 자동 완료 되돌리기: 다시 열고, 이 할 일은 앞으로 자동으로 끝내지 않는다(서버가 기억)
const reverting = new Set();
function revertAuto(item) {
  reverting.add(item.id);
  const body = { id: item.id, title: item.title, source: item.source, priority: item.priority, link: item.link || undefined, userEdited: false };
  mutate({ kind: 'add', tempId: item.id, body }, () => cy.todoRevert(item.id), '되돌리기 실패', () => {
    setRawTodos([body, ...rawTodos().filter((x) => x.id !== item.id)]);
    raw = { ...raw, recentDone: (raw.recentDone ?? []).filter((x) => x.id !== item.id) };
    todoMsg = { ok: true, text: `"${item.title}" 다시 열었어요. 이건 앞으로 자동으로 끝내지 않아요.` };
  }).finally(() => { reverting.delete(item.id); renderTodos(); });
}

function doneRow(t) {
  return h('div.todo.is-done', { dataset: { id: t.id } },
    h('span.t', { text: t.title, title: t.auto && t.reason ? t.reason : null }),
    t.auto ? h('span.chip.ok.auto', { text: '자동', title: t.reason ? `Slack 대화를 보고 자동 완료: ${t.reason}` : 'Slack 대화를 보고 자동 완료' }) : null,
    t.doneRel ? h('span.muted', { text: t.doneRel }) : null,
    t.auto && t.evidence ? h('button.ghost', { type: 'button', text: '근거', title: '근거 메시지 열기', onclick: () => cy.openLink(t.evidence) }) : null,
    h('button.ghost', { type: 'button', text: '되돌리기', onclick: () => (t.auto ? revertAuto(t) : reopenTodo(t)) }));
}

// ---- 휴지통: 줄의 휴지통 버튼·Delete 키·끌어 놓기 → 그 자리 확인 → 휴지통으로(5초 되돌리기). 맨 아래 '휴지통 (N)' ----
let trashPending = []; // todo-trash.js trashModel 의 pending(응답 대기 중)
let confirmState = null; // 그 자리 확인(todo-trash.js confirmReducer)
let focusConfirm = false; // 다음 그리기에서 확인 버튼에 포커스
let trashOpen = readTrashOpen(globalThis.localStorage);
const trashing = new Map(); // id → 휴지통으로 옮기는 요청(되돌리기는 이게 끝난 뒤 restore)

function setConfirm(action) {
  const prev = confirmState;
  confirmState = confirmReducer(confirmState, action);
  if (action.type === 'ask') focusConfirm = true;
  else if (prev?.kind === 'trash') refocusId = prev.id; // 취소하면 그 줄로 포커스
  renderTodos();
}
const askTrash = (t) => { if (t && !t.pending) setConfirm({ type: 'ask', kind: 'trash', id: t.id }); };

function trashTodo(t) {
  const item = trashItemOf(t), body = todoBodyOf(t);
  const op = { kind: 'trash', item };
  confirmState = null;
  if (openId === t.id) openId = null;
  if (ask?.todoId === t.id) closeAsk();
  // 키보드로 지웠으면 다음 줄로 포커스(mutate 가 바로 다시 그린다)
  const ids = listGroups().flatMap((g) => g.items.map((x) => x.id));
  const i = ids.indexOf(t.id);
  if (listSec().contains(document.activeElement)) refocusId = ids[i + 1] ?? ids[i - 1] ?? null;
  trashPending.push(op);
  undo.show(body);
  const job = mutate({ kind: 'remove', id: t.id }, () => cy.todoDelete(t.id), '휴지통으로 옮기기 실패', () => {
    setRawTodos(rawTodos().filter((x) => x.id !== t.id));
    raw = commitTrash(raw, op);
    raw = { ...raw, today: patchToday(raw.today, t.id, null) };
  }).then((r) => { if (!r?.ok && undo.current?.id === t.id) undo.close(); return r; })
    .finally(() => { trashPending = trashPending.filter((x) => x !== op); trashing.delete(t.id); renderTodos(); });
  trashing.set(t.id, job);
}

// 되살리기: body 가 있으면(방금 지운 것 되돌리기) 열린 목록에 바로 다시 보인다. 없으면(휴지통 줄) 응답을 보고 넣는다
async function restoreTodo(id, title, body = null) {
  const op = { kind: 'restore', id };
  trashPending.push(op);
  if (confirmState?.id === id) confirmState = null;
  renderTodos();
  await trashing.get(id);
  const r = await mutate(body ? { kind: 'add', tempId: id, body } : [], () => cy.todoRestore(id), '되살리기 실패', (res) => {
    raw = commitTrash(raw, op);
    const td = res.data?.todo;
    if (td?.status === 'done') return;
    const back = body ?? { id, title: td?.title ?? title, source: td?.source ?? '', priority: td?.priority ?? 2, ...(td?.link ? { link: td.link } : {}), ...(td?.note ? { note: td.note } : {}), userEdited: false };
    setRawTodos([back, ...rawTodos().filter((x) => x.id !== id)].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)));
    if (!body) todoMsg = { ok: true, text: `"${title}" 되살렸어요` };
  });
  trashPending = trashPending.filter((x) => x !== op);
  if (r?.ok && body) refocusId = id;
  renderTodos();
}

function purgeTodo(id) {
  const op = { kind: 'purge', id };
  trashPending.push(op);
  confirmState = null;
  mutate([], () => cy.todoPurge(id), '영구 삭제 실패', () => { raw = commitTrash(raw, op); })
    .finally(() => { trashPending = trashPending.filter((x) => x !== op); renderTodos(); });
}

function emptyTrash() {
  const op = { kind: 'empty' };
  trashPending.push(op);
  confirmState = null;
  mutate([], () => cy.todoTrashEmpty(), '휴지통 비우기 실패', () => { raw = commitTrash(raw, op); })
    .finally(() => { trashPending = trashPending.filter((x) => x !== op); renderTodos(); });
}

function toggleTrash() {
  trashOpen = !trashOpen;
  writeTrashOpen(globalThis.localStorage, trashOpen);
  renderTodos();
}

// 그 자리 확인: "휴지통으로 옮길까요? [옮기기] [취소]" — Enter 확인, Esc 취소(창 닫기로 안 번짐)
function confirmBox(kind, onYes, extra) {
  const c = CONFIRM_TEXT[kind];
  const cancel = () => setConfirm({ type: 'cancel' });
  return h('span.inline-confirm', {
    role: 'group', 'aria-label': c.q,
    onkeydown: (e) => {
      const k = confirmKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 'confirm') onYes(); else cancel();
    },
    onclick: (e) => e.stopPropagation(),
  },
  h('span.q', { text: extra ? `${c.q} ${extra}` : c.q }),
  h('button.danger.yes', { type: 'button', text: c.yes, onclick: onYes }),
  h('button.ghost.no', { type: 'button', text: '취소', onclick: cancel }));
}

const TRASH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.8 7v4.5M9.2 7v4.5"/></svg>';
// ▶ (진행중) 토글: 누르면 켜고, 켜져 있으면 끈다(비서가 진척을 봤어도 끔으로 고정)
function doingButton(t) {
  const on = isDoing(t);
  return h(`button.ghost.row-doing${on ? '.on' : ''}`, {
    type: 'button', text: on ? '⏸' : '▶', disabled: t.pending, 'aria-pressed': String(on),
    title: on ? '진행중 표시 끄기' : '진행중으로 표시', 'aria-label': `${on ? '진행중 끄기' : '진행중으로'}: ${t.title}`,
    onclick: () => mutate({ kind: 'edit', id: t.id, patch: { doing: !on }, rule: true }, () => cy.todoEdit(t.id, { doing: !on }), '진행중 표시 실패'),
  });
}

// '오늘' 토글: 켜져 있으면 오늘 할 일(오늘 할 일 탭에도 같은 줄), 누르면 고르기·빼기
function todayButton(t) {
  const date = vm.today?.date;
  if (!date) return null;
  const on = isToday(t, date);
  return h(`button.ghost.row-today${on ? '.on' : ''}`, {
    type: 'button', text: '오늘', disabled: t.pending, 'aria-pressed': String(on),
    title: on ? '오늘 할 일에서 빼기(할 일은 남아요)' : '오늘 할 일로 고르기', 'aria-label': `${on ? '오늘 할 일에서 빼기' : '오늘 할 일로'}: ${t.title}`,
    onclick: () => toggleToday(t),
  });
}

function trashButton(t) {
  const b = h('button.ghost.row-trash', { type: 'button', title: '휴지통으로 (Delete)', 'aria-label': `휴지통으로: ${t.title}`, disabled: t.pending, onclick: () => askTrash(t) });
  b.innerHTML = TRASH_ICON;
  return b;
}

// 맨 아래 '휴지통 (N)' — 접힘 기억. 끄는 중엔 비어 있어도 놓을 칸으로 보인다
function trashGroup() {
  const m = trashModel(raw?.trash, raw?.trashCount, trashPending);
  if (confirmState?.kind === 'purge' && !m.items.some((x) => x.id === confirmState.id)) confirmState = null;
  if (confirmState?.kind === 'empty' && !m.count) confirmState = null;
  if (!m.count && !dragGroups) return null;
  const head = h('h2.trash-head', {
    role: 'button', tabindex: '0', 'aria-expanded': String(trashOpen), title: trashOpen ? '접기' : '펼치기',
    onclick: toggleTrash, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTrash(); } },
  }, h('span.caret', { text: trashOpen ? '▾' : '▸' }), h('span', { text: '휴지통' }), h('span.chip', { text: String(m.count) }));
  let body = null;
  if (trashOpen && m.items.length) {
    body = h('div.card.todos.trash-list', null,
      m.items.map(trashRow),
      h('div.trash-foot', null,
        m.count > m.items.length ? h('span.muted.small', { text: `최근 ${m.items.length}개만 보여요` }) : h('span.muted.small', { text: '30일 지나면 저절로 지워져요' }),
        isConfirming(confirmState, 'empty')
          ? confirmBox('empty', emptyTrash, `${m.count}개를 영구 삭제해요.`)
          : h('button.ghost.danger-text', { type: 'button', text: '휴지통 비우기', onclick: () => setConfirm({ type: 'ask', kind: 'empty' }) })));
  } else if (dragGroups) {
    body = h('div.card.todos.drop-empty.trash-drop', null, h('div.muted.small', { text: '여기로 끌어 놓으면 휴지통으로' }));
  }
  return h('div.group.trash', null, head, body);
}

function trashRow(t) {
  return h('div.todo.trashed', { dataset: { id: t.id } },
    h('span.t', { text: t.title }),
    h(`span.chip.prio.p${t.priority}`, { text: t.priorityLabel, title: '원래 우선순위' }),
    t.ago ? h('span.muted.small.ago', { text: t.ago, title: t.trashedAt }) : null,
    isConfirming(confirmState, 'purge', t.id)
      ? confirmBox('purge', () => purgeTodo(t.id))
      : [h('button.ghost', { type: 'button', text: '되살리기', onclick: () => restoreTodo(t.id, t.title) }),
        h('button.ghost.danger-text', { type: 'button', text: '영구 삭제', onclick: () => setConfirm({ type: 'ask', kind: 'purge', id: t.id }) })]);
}

// 되돌리기 토스트(5초). ⌘Z 로도
const undoToast = h('div.undo-toast', { role: 'status', 'aria-live': 'polite', hidden: true });
document.body.append(undoToast);
const undo = createUndo({ ms: UNDO_MS, onChange: renderUndo });
function renderUndo(item) {
  undoToast.hidden = !item;
  document.body.classList.toggle('has-undo', !!item); // 맨 아래 줄(휴지통 비우기 등)을 가리지 않게 여백
  if (!item) { undoToast.replaceChildren(); return; }
  const title = item.title.length > 22 ? `${item.title.slice(0, 21)}…` : item.title;
  undoToast.replaceChildren(
    h('span.msg', { text: `'${title}' 휴지통으로 옮겼어요` }),
    h('button.undo', { type: 'button', text: '되돌리기', onclick: undoTrash }),
    h('span.bar')); // 5초(UNDO_MS) 줄어드는 막대 — panel.css
}
function undoTrash() {
  const item = undo.take();
  if (item) restoreTodo(item.id, item.title, item);
}
document.addEventListener('keydown', (e) => {
  if (!undo.current || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  undoTrash();
});
// 확인 밖을 누르면 취소
document.addEventListener('mousedown', (e) => {
  if (!confirmState || e.target.closest?.('.inline-confirm')) return;
  confirmState = null;
  renderTodos();
}, true);

// 추가 입력칸에서 한글 조합 중이거나 끄는 중이면 다시 그리지 않는다(조합·끌기 보호). 끝나면 그때 그림.
// 추가 입력칸은 값을 addDraft 에 들고 있으니 다시 그린 뒤 포커스만 되돌린다.
const todosSec = $('sec-todos');
const todaySec = $('sec-today');
// 할 일 탭과 오늘 할 일 탭은 같은 줄·같은 묶음·같은 조작. 지금 보이는 쪽이 끌기·포커스·팝오버의 기준
const isListSection = () => section === 'todos' || section === 'today';
const listSec = () => (section === 'today' ? todaySec : todosSec);
const listGroups = () => (section === 'today' ? vm.todayGroups : vm.todoGroups);
const listTodos = () => (section === 'today' ? visibleTodos().filter((t) => isToday(t, vm.today?.date)) : visibleTodos());
const ADD_INPUTS = ['todo-add-input', 'today-add-input'];
let composing = false;
for (const sec of [todosSec, todaySec]) {
  sec.addEventListener('compositionstart', () => { composing = true; });
  sec.addEventListener('compositionend', () => { composing = false; if (todosStale) setTimeout(renderTodos, 0); });
  sec.addEventListener('focusout', () => setTimeout(() => { if (todosStale && !todoInputFocused()) renderTodos(); }, 0));
}
function todoInputFocused() {
  const a = document.activeElement;
  if (!a || !(todosSec.contains(a) || todaySec.contains(a)) || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')) return false;
  return composing || !ADD_INPUTS.includes(a.id);
}

function renderTodos() {
  if (todoInputFocused() || drag) { todosStale = true; return; }
  todosStale = false;
  const sec = listSec();
  const addFocused = ADD_INPUTS.includes(document.activeElement?.id) ? document.activeElement.id : null;
  const rowFocus = refocusId ?? (sec.contains(document.activeElement) ? document.activeElement?.closest?.('.todo.row')?.dataset.id : null);
  refocusId = null;
  if (confirmState?.kind === 'trash' && !findTodo(confirmState.id)) confirmState = null; // 지워졌거나 끝난 줄
  todosSec.replaceChildren(...todoListKids());
  todaySec.replaceChildren(...todayListKids());
  syncAsk();
  const yes = (focusConfirm || sec.contains(document.activeElement) || document.activeElement === document.body) && confirmState ? sec.querySelector('.inline-confirm .yes') : null;
  focusConfirm = false;
  if (yes) yes.focus();
  else if (addFocused) $(addFocused)?.focus();
  else if (rowFocus) sec.querySelector(`.todo.row[data-id="${CSS.escape(rowFocus)}"]`)?.focus();
}

function todoListKids() {
  // 끄는 동안엔 빈 우선순위 칸도 보여서 거기로 옮길 수 있게
  const groups = dragGroups ? withEmptyGroups(vm.todoGroups) : vm.todoGroups;
  const kids = [addForm(), rulesBar()];
  if (todoMsg) kids.push(h(`div.result.${todoMsg.ok ? 'ok' : 'err'}`, { role: 'status', text: todoMsg.text }));
  if (!groups.length) kids.push(h('div.empty', { text: error && !raw ? '불러오지 못함' : '할 일 없음' }));
  kids.push(...groups.map(todoGroup));
  const done = mergeRecentDone(recentDone, vm.recentDone, [...reverting]);
  if (done.length) {
    kids.push(h('div.group.done', null,
      h('h2', null, h('span', { text: '최근 완료' })),
      h('div.card.todos', null, done.map(doneRow))));
  }
  const trash = trashGroup(); // 휴지통이 비면 null — replaceChildren 에 넘기면 "null" 글자가 찍힌다
  if (trash) kids.push(trash);
  return kids;
}

// 오늘 할 일: 날짜·남은 수 머리 + 할 일 탭과 같은 추가 칸·우선순위 묶음 + 오늘 끝낸 것
function todayListKids() {
  const t = vm.today ?? { date: '', items: [] };
  const groups = dragGroups && section === 'today' ? withEmptyGroups(vm.todayGroups) : vm.todayGroups;
  const open = vm.stats.todayOpen, total = vm.stats.todayTotal;
  const kids = [
    h('div.today-head', null,
      h('h2', { text: t.date ? `${t.date} 오늘 할 일` : '오늘 할 일' }),
      h('span.muted', { text: total ? `남은 ${open} · 전체 ${total}` : '아직 없어요. 일정을 보고 적어 보세요.' })),
    addForm('today'),
  ];
  if (todoMsg) kids.push(h(`div.result.${todoMsg.ok ? 'ok' : 'err'}`, { role: 'status', text: todoMsg.text }));
  if (total && !groups.length) kids.push(h('div.empty', { text: '오늘 할 일을 다 끝냈어요' }));
  kids.push(...groups.map(todoGroup));
  if (vm.todayDone.length) {
    kids.push(h('div.group.done', null,
      h('h2', null, h('span', { text: '오늘 끝냄' }), h('span.chip', { text: String(vm.todayDone.length) })),
      h('div.card.todos', null, vm.todayDone.map(doneRow))));
  }
  if (!total) kids.push(h('div.muted.small', { text: '할 일 탭에서 줄의 「오늘」을 눌러 골라도 돼요.' }));
  return kids;
}

function withEmptyGroups(groups) {
  const out = [...groups];
  for (const p of [1, 2, 3, BACKLOG]) if (!out.some((g) => g.priority === p)) out.push({ priority: p, label: priorityLabel(p), items: [] });
  return out.sort((a, b) => a.priority - b.priority);
}

// 우선순위 묶음. 백로그(P4)는 기본 접힘(기억) — 접혀 있어도 끌어 놓을 칸은 남는다
function todoGroup(g) {
  const collapsed = isCollapsed(g.priority, backlogOpen);
  const head = g.priority === BACKLOG
    ? h('h2.backlog-head', {
      role: 'button', tabindex: '0', 'aria-expanded': String(!collapsed), title: collapsed ? '펼치기' : '접기',
      onclick: toggleBacklog, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBacklog(); } },
    }, h('span.caret', { text: collapsed ? '▸' : '▾' }), h('span', { text: g.label }), h('span.chip', { text: String(g.items.length) }))
    : h('h2', null, h('span', { text: g.label }), h('span.chip', { text: String(g.items.length) }));
  const body = collapsed
    ? h('div.card.todos.drop-empty.collapsed', null, g.items.length ? null : h('div.muted.small', { text: '끌어 놓기' }))
    : h(`div.card.todos${g.items.length ? '' : '.drop-empty'}`, null, g.items.length ? g.items.map(todoRow) : h('div.muted.small', { text: '끌어 놓기' }));
  return h(`div.group.p${g.priority}`, { dataset: [1, 2, 3, BACKLOG].includes(g.priority) ? { priority: String(g.priority) } : null }, head, body);
}

let backlogOpen = readBacklogOpen(globalThis.localStorage);
function toggleBacklog() {
  backlogOpen = !backlogOpen;
  writeBacklogOpen(globalThis.localStorage, backlogOpen);
  renderTodos();
}

// ---- 할 일 규칙: '규칙 N' 칩 → 짧은 목록(글·적용 횟수·켜기/끄기·지우기) ----
let rulesOpen = false;
const rulePending = new Map(); // id → { enabled } | 'delete' (응답 대기)
const visibleRules = () => overlayRules(vm.todoRules, rulePending);

function rulesBar() {
  const rules = visibleRules();
  const chip = h(`button.chip.rules-chip${rulesOpen ? '.on' : ''}`, {
    type: 'button', text: rulesChip(rules), 'aria-expanded': String(rulesOpen),
    title: '할 일 규칙',
    onclick: () => { rulesOpen = !rulesOpen; renderTodos(); },
  });
  const bar = h('div.todo-tools', null, chip, vm.stats.backlogTodos ? h('span.muted.small', { text: `백로그 ${vm.stats.backlogTodos}개` }) : null);
  if (!rulesOpen) return bar;
  const list = rules.length
    ? rules.map((r) => h(`div.rule-row${r.enabled ? '' : '.off'}`, { dataset: { id: r.id } },
      h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `규칙 켜기: ${r.text}`, title: r.enabled ? '끄기' : '켜기', onchange: () => toggleRule(r) }),
      h('div.rule-main', null, h('span.rule-text', { text: r.text }), h('span.muted.small', { text: [r.summary, hitsLabel(r.hits)].filter(Boolean).join(' · ') })),
      h('button.ghost.rule-del', { type: 'button', text: '✕', title: '규칙 지우기', 'aria-label': `규칙 지우기: ${r.text}`, onclick: () => deleteRule(r) })))
    : [h('div.muted.small', { text: '규칙 없음' })];
  return h('div.todo-tools-wrap', null, bar, h('div.card.rules-list', null, list));
}

async function ruleCall(r, pending, call, failText) {
  rulePending.set(r.id, pending);
  renderTodos();
  let res;
  try { res = await call(); } catch { res = { ok: false }; }
  rulePending.delete(r.id);
  if (!res?.ok) todoMsg = { ok: false, text: `${failText} — ${why(res)}` };
  else loadSoon();
  renderTodos();
}
const toggleRule = (r) => ruleCall(r, { enabled: !r.enabled }, () => cy.todoRuleEdit(r.id, { enabled: !r.enabled }), '규칙 바꾸기 실패');
const deleteRule = (r) => ruleCall(r, 'delete', () => cy.todoRuleDelete(r.id), '규칙 지우기 실패');

function addForm(scope = 'todos') {
  const today = scope === 'today';
  const input = h('input', { id: today ? 'today-add-input' : 'todo-add-input', type: 'text', placeholder: today ? '오늘 할 일 추가 (Enter)' : '할 일 추가 — Enter', 'aria-label': today ? '새 오늘 할 일' : '새 할 일' });
  input.value = today ? todayDraft : addDraft;
  input.addEventListener('input', () => { if (today) todayDraft = input.value; else addDraft = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    addTodo(scope);
  });
  return h('div.todo-add', null,
    input,
    prioritySelect(today ? todayPriority : addPriority, (p) => { if (today) todayPriority = p; else addPriority = p; }),
    h('button.primary', { type: 'button', text: '추가', onclick: () => addTodo(scope) }));
}

function prioritySelect(value, onChange) {
  const sel = h('select.prio', { 'aria-label': '우선순위' }, PRIORITIES.map((p) => h('option', { value: String(p.value), text: p.label })));
  sel.value = String(value);
  sel.addEventListener('change', () => onChange(Number(sel.value)));
  return sel;
}

// ---- 할 일 줄: 한 번 = 펼침, 두 번 = 팝오버, 꾹 눌러 끌기 = 순서·우선순위, Alt+↑↓/1·2·3 = 키보드로 같은 일 ----
const ROW_CONTROLS = 'button, select, input, textarea, a, label, .todo-detail, .inline-confirm';
const findTodo = (id) => vm.todoGroups.flatMap((g) => g.items).find((t) => t.id === id);
const sorter = createClickSorter({
  onSingle: (id) => toggleDetail(id),
  onDouble: (id, x) => { const t = findTodo(id); if (t && !t.pending) showAsk(t, x); },
});
let suppressClick = false; // 끌기를 끝낸 직후의 click 은 무시

function toggleDetail(id) {
  openId = toggleOpen(openId, id);
  refocusId = id;
  if (openId) loadDetail(openId);
  renderTodos();
}

async function loadDetail(id, force = false) {
  const cur = details.get(id);
  if (cur && (cur.status === 'loading' || (cur.status === 'ok' && !force))) return;
  details.set(id, { status: 'loading' });
  let r;
  try { r = await cy.todoDetail(id); } catch { r = { ok: false }; }
  details.set(id, r?.ok && r.data ? { status: 'ok', data: r.data } : { status: 'error', error: r?.status === 404 ? '이 할 일을 못 찾았어요.' : `설명을 못 불러왔어요 — ${why(r)}` });
  if (openId === id) renderTodos();
}

function todoRow(t) {
  const open = openId === t.id;
  const confirming = isConfirming(confirmState, 'trash', t.id);
  const flashing = flash?.id === t.id && Date.now() < flash.until;
  const row = h(`div.todo.row${t.pending ? '.pending' : ''}${open ? '.open' : ''}${ask?.todoId === t.id ? '.asking' : ''}${confirming ? '.confirming' : ''}${flashing ? '.flash' : ''}`, {
    dataset: { id: t.id }, tabindex: '0', role: 'button', 'aria-expanded': String(open),
    'aria-label': `${t.title} — Enter 설명, Shift+Enter 편집, Alt+↑↓ 순서, Alt+1·2·3 우선순위, Alt+4 백로그, Delete 휴지통`,
    title: '눌러서 설명 · 두 번 눌러 편집 · 꾹 눌러 끌어서 순서·우선순위',
    onclick: (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (t.pending || e.target.closest(ROW_CONTROLS)) return;
      sorter.click(t.id, e.clientX);
    },
    onkeydown: (e) => onRowKey(t, e),
    onpointerdown: (e) => onRowPointerDown(t, e),
  },
  h('input.check', { type: 'checkbox', 'aria-label': `완료: ${t.title}`, title: '완료', disabled: t.pending, onchange: () => completeTodo(t) }),
  // (진행중): 사용자가 ▶ 로 켠 것, 아니면 작업 세션을 보니 하는 중(todo-progress.ts 가 진척을 남김) → 제목 앞
  h('span.t', null, isDoing(t) ? h('span.doing', { text: '(진행중) ', title: t.progress ? `진행: ${t.progress}` : '직접 진행중으로 표시' }) : null, t.title),
  t.source ? h('span.chip', { text: t.source === 'user' ? '직접 추가' : t.source }) : null,
  confirming ? null : todayButton(t),
  confirming ? null : doingButton(t),
  confirming ? confirmBox('trash', () => trashTodo(t)) : trashButton(t));
  return open ? h('div.todo-wrap', null, row, todoDetailView(t)) : row;
}

function onRowKey(t, e) {
  if (e.target !== e.currentTarget || e.isComposing || e.keyCode === 229) return;
  const digit = /^Digit([1234])$/.exec(e.code)?.[1]; // 맥에서 Alt+1 은 key 가 '¡'. 4 = 백로그
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || digit)) {
    e.preventDefault();
    if (t.pending) return;
    const m = keyMove(listTodos(), t.id, digit ?? e.key);
    if (m) { refocusId = t.id; moveTodo(t.id, m.priority, m.beforeId); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) { if (!t.pending) showAsk(t); } else toggleDetail(t.id);
  } else if (isTrashKey(e)) {
    e.preventDefault();
    askTrash(t);
  }
}

// 이 할 일에 적용된 할 일 규칙(있으면)
const ruleLine = (t) => (t.appliedRule ? h('div.applied-rule.muted.small', { title: '할 일 규칙이 우선순위·메모를 정했어요' }, h('span', { text: `📏 규칙: ${t.appliedRule.text}` })) : null);
// 어디까지 됐는지(데몬이 작업 세션을 읽고 남긴 한 줄 — 사용자 메모와 따로)
const progressLine = (t) => (t.progress ? h('div.applied-rule.muted.small', { title: '작업 세션을 보고 비서가 남긴 진척' }, h('span', { text: `⏳ 진행: ${t.progress}` })) : null);

// 펼친 설명: 링크가 있으면 설명을 눌러 원본으로. 원본(Slack 메시지·커밋·메일·세션) 블록
function todoDetailView(t) {
  const d = details.get(t.id);
  if (!d || d.status === 'loading') {
    return h('div.todo-detail', null,
      ruleLine(t),
      progressLine(t),
      t.description ? h('p.desc', { text: t.description }) : null,
      h('div.detail-loading.muted.small', null, h('span.spin'), h('span', { text: t.description ? '원본 찾는 중…' : '설명 만드는 중…' })));
  }
  if (d.status === 'error') {
    return h('div.todo-detail', null, h('span.muted', { text: d.error }), h('button.ghost', { type: 'button', text: '다시', onclick: () => loadDetail(t.id, true).then(renderTodos) }));
  }
  const v = detailView(d.data);
  const s = v.source;
  return h('div.todo-detail', null,
    ruleLine(t),
    progressLine(t),
    descNode(t, v.description || t.description || '', v.link),
    s ? h('div.origin', null,
      h('div.origin-head', null,
        h(`span.chip.src-${s.kind}`, { text: s.kindLabel }),
        s.meta.length ? h('span.muted.small', { text: s.meta.join(' · ') }) : null,
        s.permalink ? h('a.small', { href: s.permalink, text: '원본 보기' }) : null),
      s.excerpt ? h(s.quote ? 'blockquote.excerpt' : 'p.excerpt', { text: s.excerpt }) : null)
      : null);
}

// ---- 설명 직접 고치기: 펼친 설명을 두 번 누르면 그 자리 편집(AI 없음). 한 번 누르면(링크 있으면) 원본 열기 ----
let editingDesc = null; // 고치는 중인 할 일 id
let descDraft = '';
const descSorter = createClickSorter({
  onSingle: (_id, link) => { if (link) cy.openLink(link); },
  onDouble: (id) => startDescEdit(id),
});

function descNode(t, text, link) {
  if (editingDesc === t.id) return descEditor(t, text);
  return h(`p.desc${link ? '.link' : ''}${text ? '' : '.empty'}`, {
    text: text || '설명 없음',
    title: link ? '원본 열기' : '설명 고치기',
    role: link ? 'link' : 'button', tabindex: '0',
    onclick: (e) => { e.stopPropagation(); descSorter.click(t.id, link); },
    onkeydown: (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      if (link && !e.shiftKey) cy.openLink(link); else startDescEdit(t.id);
    },
  });
}

function startDescEdit(id) {
  const t = findTodo(id);
  if (!t || t.pending) return;
  const d = details.get(id);
  descDraft = (d?.status === 'ok' ? d.data?.description : null) || t.description || '';
  editingDesc = id;
  renderTodos();
  const ta = listSec().querySelector('textarea.desc-edit');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); growDesc(ta); }
}

const growDesc = (ta) => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`; };

function descEditor(t, current) {
  const ta = h('textarea.desc-edit', { rows: '2', 'aria-label': '설명 고치기', placeholder: '무슨 일인지 — Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소' });
  ta.value = descDraft;
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    editingDesc = null;
    if (save) saveDesc(t, current);
    ta.blur();
    renderTodos();
  };
  ta.addEventListener('input', () => { descDraft = ta.value; growDesc(ta); });
  ta.addEventListener('keydown', (e) => {
    const k = askKey(e); // Enter 저장(⌘Enter 도), Esc 취소, 한글 조합 중엔 무시, Shift+Enter 줄바꿈
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    finish(k !== 'discard');
  });
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('click', (e) => e.stopPropagation());
  return ta;
}

// 낙관적: 펼친 설명·목록을 바로 바꾸고, 실패하면 되돌린다
function saveDesc(t, current) {
  const r = descriptionPatch(current, descDraft);
  if (r.error) { todoMsg = { ok: false, text: r.error }; return; }
  if (!r.patch) return;
  const prev = details.get(t.id);
  if (prev?.status === 'ok') details.set(t.id, { status: 'ok', data: { ...prev.data, description: r.patch.description } });
  mutate({ kind: 'edit', id: t.id, patch: r.patch }, () => cy.todoEdit(t.id, r.patch), '설명 저장 실패', () => {
    setRawTodos(rawTodos().map((x) => (x.id === t.id ? { ...x, ...(r.patch.description ? { description: r.patch.description } : {}), userEdited: true } : x)));
  }).then((res) => { if (!res?.ok && prev) { details.set(t.id, prev); renderTodos(); } });
}

// ---- 꾹 눌러 끌기 ----
let press = null; // { id, x, y, timer }
let drag = null; // { id, ghost, line, target, raf, y }
let dragGroups = false;

function onRowPointerDown(t, e) {
  if (e.button !== 0 || t.pending || e.target.closest(ROW_CONTROLS)) return;
  cancelPress();
  press = { id: t.id, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, timer: setTimeout(() => startDrag(press?.x, press?.y), LONG_PRESS) };
}
function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function startDrag(x, y) {
  const id = press?.id;
  cancelPress();
  const t = id && findTodo(id);
  if (!t) return;
  sorter.cancel();
  window.getSelection()?.removeAllRanges();
  dragGroups = true;
  renderTodos(); // 빈 우선순위 칸까지 그린 뒤 고정
  const row = listSec().querySelector(`.todo.row[data-id="${CSS.escape(id)}"]`);
  if (!row) { dragGroups = false; return; }
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  const line = h('div.drop-line');
  document.body.append(ghost, line);
  document.body.classList.add('dragging-todo');
  row.classList.add('drag-src');
  drag = { id, ghost, line, target: null, raf: 0, y, x, offY: y - rect.top };
  moveDrag(y, x);
}

function dropGroups() {
  return [...listSec().querySelectorAll('.group[data-priority]')].map((g) => {
    const card = g.querySelector('.card.todos').getBoundingClientRect();
    const head = g.getBoundingClientRect();
    return {
      priority: Number(g.dataset.priority), top: head.top, bottom: head.bottom, left: card.left, width: card.width,
      rows: [...g.querySelectorAll('.todo.row')].map((r) => { const b = r.getBoundingClientRect(); return { id: r.dataset.id, top: b.top, bottom: b.bottom }; }),
    };
  });
}

function moveDrag(y, x) {
  if (!drag) return;
  drag.y = y;
  if (x != null) drag.x = x;
  drag.ghost.style.top = `${y - drag.offY}px`;
  // 휴지통 묶음 위면 휴지통으로(놓으면 확인)
  const tg = listSec().querySelector('.group.trash');
  const hot = !!tg && overTrash(drag.x, y, tg.getBoundingClientRect());
  tg?.classList.toggle('drop-hot', hot);
  if (hot) {
    drag.target = { trash: true };
    drag.line.hidden = true;
    const box = $('content').getBoundingClientRect();
    if (autoScrollDelta(y, box) && !drag.raf) drag.raf = requestAnimationFrame(scrollTick);
    return;
  }
  const groups = dropGroups();
  const tgt = dropTarget(y, groups, drag.id);
  drag.target = tgt;
  const g = tgt && groups.find((x) => x.priority === tgt.priority);
  drag.line.hidden = !g;
  if (g) Object.assign(drag.line.style, { top: `${tgt.y - 1}px`, left: `${g.left + 6}px`, width: `${g.width - 12}px` });
  // 가장자리 근처면 자동 스크롤
  const box = $('content').getBoundingClientRect();
  if (autoScrollDelta(y, box) && !drag.raf) drag.raf = requestAnimationFrame(scrollTick);
}
function scrollTick() {
  if (!drag) return;
  drag.raf = 0;
  const content = $('content');
  const d = autoScrollDelta(drag.y, content.getBoundingClientRect());
  if (!d) return;
  content.scrollTop += d;
  moveDrag(drag.y);
}

function finishDrag(commit) {
  if (!drag) return;
  const { id, target, ghost, line, raf } = drag;
  cancelAnimationFrame(raf);
  ghost.remove();
  line.remove();
  document.body.classList.remove('dragging-todo');
  drag = null;
  dragGroups = false;
  refocusId = id;
  renderTodos();
  if (commit && target?.trash) askTrash(findTodo(id));
  else if (commit && target) moveTodo(id, target.priority, target.beforeId);
}

document.addEventListener('pointermove', (e) => {
  if (drag) { e.preventDefault(); moveDrag(e.clientY, e.clientX); return; }
  if (press) {
    press.x = e.clientX; press.y = e.clientY;
    if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > MOVE_SLOP) cancelPress();
  }
});
document.addEventListener('pointerup', () => {
  if (drag) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); finishDrag(true); } else cancelPress();
});
document.addEventListener('pointercancel', () => { if (drag) finishDrag(false); else cancelPress(); });

// ---- 할 일 팝오버: 그 자리에서 한 번 묻고 → 제안 diff(빨강 전 / 초록 후) → ✓ 적용 · ✗ 버림 ----
let ask = null; // todo-ask.js 상태(null = 닫힘)
let askActions = []; // 팝오버 답에 붙은 확인 카드(회의 응답)
let askPointX = null; // 누른 x — 화살표가 가리킬 곳
let askTimer = null;
const askInput = h('input.ask-input', { type: 'text', placeholder: '이 할 일에 대해 — 예: 내일로 미뤄 / 끝났어 / 둘로 나눠', 'aria-label': '이 할 일에 대해 묻기' });
const askSend = h('button.primary.ask-send', { type: 'button', text: '묻기', onclick: () => sendAsk() });
const askBody = h('div.ask-body', { 'aria-live': 'polite' });
const askTitle = h('span.ask-title');
const askArrow = h('div.ask-arrow');
const askPop = h('div.ask-pop', { role: 'dialog', 'aria-label': '할 일에 대해 묻기', hidden: true },
  askArrow,
  h('div.ask-head', null, askTitle,
    // 이 할 일의 대화(팝오버 문답이 쌓인 곳)를 채팅 탭에서 이어 간다 — 입력 중이던 글은 옮겨 간다
    h('button.ghost.ask-chat', { type: 'button', text: '💬 채팅 창에서 열기', title: '이 할 일 대화를 채팅 탭에서 이어 가기 — 긴 질문·코드 질문도 (⌘⇧Enter)', onclick: () => continueAskInChat() }),
    h('button.ghost.ask-x', { type: 'button', text: '✕', title: '닫기 (Esc)', 'aria-label': '닫기', onclick: () => discardAsk() })),
  askBody,
  h('div.ask-row', null, askInput, askSend));
document.body.append(askPop);

askInput.addEventListener('keydown', (e) => {
  const k = askKey(e);
  if (!k) return;
  e.preventDefault();
  e.stopPropagation();
  if (k === 'send') sendAsk();
  else if (k === 'chat') continueAskInChat();
  else if (k === 'apply') applyAsk();
  else discardAsk();
});
// 팝오버 밖을 누르면 닫는다(그 줄 자체를 누른 건 줄 클릭이 처리)
document.addEventListener('mousedown', (e) => {
  if (!ask || askPop.contains(e.target)) return;
  if (e.target.closest?.(`.todo[data-id="${CSS.escape(ask.todoId)}"]`)) return;
  closeAsk();
}, true);
window.addEventListener('resize', () => syncAsk());
$('content').addEventListener('scroll', () => syncAsk(), { passive: true });

function dispatchAsk(action) {
  const prev = ask;
  ask = askReducer(ask, action);
  if (ask === prev) return;
  if (prev?.todoId !== ask?.todoId) {
    for (const el of listSec().querySelectorAll('.todo.row')) el.classList.toggle('asking', el.dataset.id === ask?.todoId);
  }
  renderAsk();
}

function showAsk(t, x) {
  if (ask?.todoId !== t.id) closeAsk();
  askPointX = Number.isFinite(x) ? x : null;
  dispatchAsk({ type: 'open', todo: t });
  askInput.focus();
}

function continueAskInChat() {
  const hand = chatHandoff(ask, askInput.value);
  if (!hand) return;
  closeAsk();
  openTodoThread(hand.todoId, hand.draft);
}

function closeAsk() {
  clearTimeout(askTimer);
  askActions = [];
  if (!ask) return;
  dispatchAsk({ type: 'close' });
  askInput.value = '';
}

// ✗·Esc: 제안이 있었으면 거절했다고 데몬에 알린다(학습 신호)
function discardAsk() {
  const s = ask;
  if (s && s.status === 'proposal' && hasProposal(s)) cy.todoReject(s.todoId, s.question, s.ops, s.rule?.proposal ?? null).catch(() => {});
  closeAsk();
}

async function sendAsk(text = askInput.value) {
  if (!ask || isAskBusy(ask)) return;
  const q = String(text ?? '').trim();
  if (!q) return;
  askActions = [];
  dispatchAsk({ type: 'ask', text: q });
  askInput.value = '';
  const { todoId, seq } = ask;
  let r;
  try { r = await cy.todoAsk(todoId, q); } catch { r = { ok: false }; }
  if (ask?.todoId !== todoId) return;
  if (r?.ok && r.data && typeof r.data.reply === 'string') {
    for (const a of normalizeActions(r.data.actions)) askActions = upsertAction(askActions, a);
    dispatchAsk({ type: 'answer', seq, threadId: r.data.threadId, reply: r.data.reply, ops: r.data.ops, preview: r.data.preview, rev: r.data.rev, rule: r.data.rule });
  } else {
    const msg = r?.status === 404 ? '그 할 일을 못 찾았어요. 이미 지워졌거나 끝났을 수 있어요.' : `못 물어봤어요 — ${why(r)}`;
    dispatchAsk({ type: 'askFail', seq, message: msg });
  }
  if (ask?.todoId === todoId && ask.status !== 'thinking') askInput.focus();
}

// ✓: 목록에 바로 반영(낙관적), 실패하면 되돌리고 팝오버에 오류. 미리보기 뒤에 바뀌었으면(409) 새 diff 로 다시 확인
async function applyAsk() {
  const s = ask;
  if (!canApply(s)) return;
  dispatchAsk({ type: 'apply' });
  const overlay = [...previewOverlay(s.preview, `tmp:ask${opSeq + 1}`), ...ruleOverlay(s.rule)]; // 규칙이 맞는 다른 할 일도 바로
  const doneItem = s.preview.find((p) => p.kind === 'done')
    ? rawTodos().find((x) => x.id === s.todoId) : null;
  const r = await mutate(overlay, () => cy.todoApply(s.todoId, s.ops, s.rev, s.rule?.proposal ?? null), null, (res) => {
    setRawTodos(commitOverlay(rawTodos(), overlay, res.data?.added));
    if (doneItem) recentDone = [{ ...doneItem, userEdited: true }, ...recentDone.filter((x) => x.id !== doneItem.id)].slice(0, 5);
  });
  if (ask?.todoId !== s.todoId) return;
  if (r?.ok) {
    dispatchAsk({ type: 'applied' });
    clearTimeout(askTimer);
    askTimer = setTimeout(closeAsk, 900);
  } else if (r?.status === 409 && r.data) {
    dispatchAsk({ type: 'stale', ops: r.data.ops, preview: r.data.preview, rev: r.data.rev, rule: r.data.rule });
  } else {
    dispatchAsk({ type: 'applyFail', message: r?.status === 404 ? '그 할 일이 그새 없어졌어요.' : `적용 못 했어요 — ${why(r)}` });
  }
}

function askAnchor() {
  return ask && listSec().querySelector(`.todo[data-id="${CSS.escape(ask.todoId)}"]`);
}

// 목록이 다시 그려지면 그 줄을 다시 찾아 붙는다. 줄이 사라졌거나 화면 밖이면 닫는다(적용 직후는 자리 유지)
function syncAsk() {
  if (!ask) return;
  const row = askAnchor();
  if (row) row.classList.add('asking');
  else if (raw && !rawTodos().some((x) => x.id === ask.todoId)) dispatchAsk({ type: 'gone' });
  placeAsk(row);
}

let askLastRect = null;
function placeAsk(row) {
  if (!ask) return;
  const rect = row?.getBoundingClientRect() ?? askLastRect;
  if (!rect) return;
  const box = $('content').getBoundingClientRect();
  if (row && (rect.bottom < box.top || rect.top > box.bottom)) { closeAsk(); return; }
  askLastRect = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  const view = { width: window.innerWidth, height: window.innerHeight };
  const width = Math.min(420, Math.max(300, rect.right - rect.left - 24), view.width - 16);
  askPop.style.width = `${width}px`; // 폭을 먼저 정해야 높이를 잴 수 있다
  const p = placePopover({ anchor: askLastRect, size: { width, height: askPop.offsetHeight || 160 }, view, pointX: askPointX ?? undefined });
  Object.assign(askPop.style, { top: `${p.top}px`, left: `${p.left}px`, width: `${p.width}px` });
  askPop.dataset.placement = p.placement;
  askArrow.style.left = `${p.arrowX}px`;
}

function renderAsk() {
  askPop.hidden = !ask;
  if (!ask) return;
  const s = ask;
  askTitle.textContent = s.title;
  askTitle.title = s.title;
  askInput.disabled = isAskBusy(s) || s.status === 'applied';
  askSend.disabled = askInput.disabled;
  askInput.placeholder = s.status === 'idle' ? '이 할 일에 대해 — 예: 내일로 미뤄 / 끝났어 / 둘로 나눠' : '다시 물어보기 (Enter)';
  const kids = [];
  if (s.restored) kids.push(h('div.ask-past.muted.small', { text: `지난 문답${s.at ? ` · ${relativeTime(s.at)}` : ''} — 이어서 물어보세요` }));
  if (s.question && s.status !== 'idle') kids.push(h('div.ask-q', { text: s.question }));
  if (s.status === 'idle') kids.push(h('div.ask-hint.muted.small', { text: 'Enter 묻기 · ⌘Enter 적용 · Esc 닫기' }));
  if (s.status === 'thinking') {
    kids.push(h('div.ask-thinking', null, h('span.spin'), h('span', { text: '생각 중…' })));
    for (const a of askActions) kids.push(actionCard(a)); // 묻는 동안 뜬 도구 승인 카드
  }
  if (['proposal', 'applying', 'applied'].includes(s.status) || (s.status === 'error' && s.retry === 'apply')) {
    if (s.reply) kids.push(h('div.ask-reply', { text: s.reply }));
    const blocks = diffBlocks(s.preview);
    const rb = ruleBlock(s.rule);
    if (blocks.length || rb) kids.push(h('div.ask-diff', null, rb ? ruleDiff(rb) : null, blocks.map(diffBlock)));
    if (s.notice) kids.push(h('div.ask-notice', { role: 'status', text: s.notice }));
    if (s.result) kids.push(h('div.ask-result', { role: 'status', text: s.result }));
    for (const a of askActions) kids.push(actionCard(a));
  }
  if (s.status === 'applied') kids.push(h('div.ask-done', { role: 'status', text: '적용했어요 ✓' }));
  if (s.status === 'error') kids.push(h('div.ask-err', { role: 'alert', text: s.error }));
  const acts = [];
  if (s.status === 'proposal' || s.status === 'applying') {
    if (hasProposal(s)) {
      acts.push(h('button.ask-no', { type: 'button', text: '✗ 버리기', title: '버리기 (Esc)', disabled: s.status === 'applying', onclick: discardAsk }));
      acts.push(h('button.ask-yes', { type: 'button', text: s.status === 'applying' ? '적용 중…' : '✓ 적용', title: '적용 (⌘Enter)', disabled: s.status === 'applying', onclick: applyAsk }));
    } else {
      acts.push(h('button.ghost', { type: 'button', text: '닫기', onclick: closeAsk }));
    }
  } else if (s.status === 'error') {
    acts.push(h('button.ghost', { type: 'button', text: '닫기', onclick: closeAsk }));
    acts.push(h('button.primary', {
      type: 'button', text: '다시 시도',
      onclick: () => { if (s.retry === 'apply') { dispatchAsk({ type: 'retryApply' }); applyAsk(); } else sendAsk(s.question); },
    }));
  }
  if (acts.length) kids.push(h('div.ask-acts', null, h('span.spacer'), acts));
  fill(askBody, ...kids);
  syncAsk();
}

// 지속 규칙 제안: "📏 새 규칙: …" + 맞는 열린 할 일 전부의 전/후(빨강 → 초록)
function ruleDiff(rb) {
  return h('div.diff.rule', null,
    h('div.rule-new', null, h('span.tag.rule-tag', { text: '📏 새 규칙' }), h('span.rule-text', { text: rb.text })),
    rb.summary ? h('div.meta.rule-sum', { text: rb.summary }) : null,
    rb.changes.length ? h('div.rule-hits.muted.small', { text: `${rb.changes.length}개 적용` }) : h('div.rule-hits.muted.small', { text: '이후 할 일에 적용' }),
    rb.changes.map((c) => h('div.diff.edit.rule-change', null,
      h('div.ctx', { text: c.title }),
      c.fields.map((f) => h(`div.field.f-${f.key}`, null,
        h('span.label', { text: f.label }),
        f.old !== null ? h('del.old', { text: f.old }) : h('span.none', { text: '(없음)' }),
        h('span.arrow', { text: '→' }),
        f.new !== null ? h('ins.new', { text: f.new }) : h('span.none', { text: '(지움)' }))))),
    rb.skipped.length ? h('div.muted.small.rule-skip', { text: `직접 정한 우선순위라 그대로: ${rb.skipped.map((x) => x.title).join(', ')}` }) : null);
}

// diff 블록 하나: 수정은 필드별 '이름 · 빨강(전) → 초록(후)', 삭제는 통째로 빨간 취소선, 추가는 초록 새 줄
function diffBlock(b) {
  if (b.kind === 'delete') {
    return h('div.diff.del', null, h('span.sign', { text: '−' }), h('del.old', null, h('span', { text: b.title }), b.meta ? h('span.meta', { text: ` · ${b.meta}` }) : null), h('span.tag', { text: '삭제' }));
  }
  if (b.kind === 'add') {
    return h('div.diff.add', null, h('span.sign', { text: '+' }), h('ins.new', null, h('span', { text: b.title }), b.meta ? h('span.meta', { text: ` · ${b.meta}` }) : null), h('span.tag', { text: '새 할 일' }));
  }
  return h(`div.diff.edit.${b.kind}`, null,
    b.fields.some((f) => f.key === 'title') ? null : h('div.ctx', { text: b.title }),
    b.fields.map((f) => h(`div.field.f-${f.key}`, null,
      h('span.label', { text: f.label }),
      f.old !== null ? h('del.old', { text: f.old }) : h('span.none', { text: '(없음)' }),
      h('span.arrow', { text: '→' }),
      f.new !== null ? h('ins.new', { text: f.new }) : h('span.none', { text: '(지움)' }))));
}

// ---- 채팅: 대화 목록(스레드) + 선택한 대화 ----
const chatLog = $('chat-log');
const chatInput = $('chat-input');
// 첨부: 📎 · 대화 쪽에 끌어다 놓기 · ⌘V(스크린샷·파일). 붙이자마자 데몬에 올린다(보낼 때는 id 만)
let attErrTimer = null;
function showAttError(msg) {
  const el = $('chat-att-err');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(attErrTimer);
  attErrTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
const tray = createAttachTray({
  tray: $('chat-tray'), input: chatInput, drop: $('th-main'), pick: $('chat-attach'),
  upload: (name, mime, bytes) => (cy.chatAttach ? cy.chatAttach(name, mime, bytes) : Promise.resolve({ ok: false })),
  onChange: () => renderSendButton(),
  onError: showAttError,
});
if (!cy.chatAttach) $('chat-attach').hidden = true;
const chatSec = $('sec-chat');
const thList = $('th-list');
const thSearch = $('th-search');
const thTitle = $('th-title');
const thTitleInput = $('th-title-input');
const thTodo = $('th-todo');
const thArchiveToggle = $('th-archive-toggle');

let threads = []; // 보관 안 한 스레드(최근 순)
let archived = null; // 보관함 보기일 때만 목록
let showArchived = false;
let selectedId = null; // null = 새 대화(첫 말을 보내면 스레드가 생김)
let messages = []; // 선택한 스레드의 말
// 고치는 중인 내 말(✏️ — 아래 "말 고치기")
let editingMsg = null; // { key: 'n:<순번>' | 'q:<chatId>', kind: 'sent'|'queued', n?, chatId?, text, el?, saving?, error? }
let moreAbove = false;
let thQuery = '';
let rowMode = null; // { id, mode: 'rename' | 'delete' | 'archive' | 'unarchive' }
let listOpen = false; // 좁은 창에서 목록 펼침
let threadsLoaded = false;
const drafts = new Map(); // 스레드별 입력 중인 글(null 키 = 새 대화)
let seen = {};
let seenLoaded = false;
let msgSeq = 0;
let loadedUpdated = null; // 선택한 스레드를 마지막으로 불러올 때의 updated
// 대화 속 서브에이전트(아래 "대화 속 서브에이전트")
const chatAgentsEl = $('chat-agents');
let agents = []; // 선택한 대화의 서브에이전트(시작 순)
let agentsFor = null; // agents 를 받은 대화 id
let agentsSeq = 0;
let agentsDoneOpen = false; // "에이전트 N개 끝남 ▸" 펼침
let agentsTimer = null;
const agentCardEls = new Map(); // runId/toolUseId → 대화 속 카드(진행만 바뀌면 그 카드만 고친다)
// 대화 속 작업 세션 카드(같은 응답의 sessions — 채팅이 넘긴 수정 run). 진행 줄·경과만 바뀌면 그 카드만 고친다
let sessions = [];
const sessionCardEls = new Map(); // runId → 카드
// 대화 속 워크트리 카드(같은 응답의 worktrees — 한 답이 판 워크트리들). 토큰·상태만 바뀌면 그 카드만 고친다
let worktrees = [];
const wtCardEls = new Map(); // 첫 줄 key → { el, keys }

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};
function saveSeen() { store.set('threadSeen', JSON.stringify(seen)); }
const allThreads = () => (showArchived ? archived ?? [] : threads);
const currentThread = () => threads.find((t) => t.id === selectedId) ?? archived?.find((t) => t.id === selectedId) ?? null;

// ---- 확인 카드(회의 응답 등): 답 아래에 [실행]/[취소]. 누르기 전엔 아무것도 보내지 않는다 ----
let threadActions = []; // 선택한 대화의 카드
const actionLocal = new Map(); // id → 'confirming' | 'cancelling' | { error }

// 머지 승인 카드(채팅에서 시킨 PR 머지): PR 머리·링크, 대상(base ← head)·검사·충돌·리뷰, ✓ 머지 / ✗ 안 함.
// 캐릭터 말풍선과 같은 결정 — 어디서 누르든 결과(머지됨 + 머지 커밋 / 안 함 / 실패 이유)로 접힌다
function mergeCardEl(a, v, opts) {
  const rows = v.rows.length ? h('dl.ac-fields.merge-rows', null, v.rows.flatMap((r) => [h('dt', { text: r.label }), h(`dd.t-${r.tone}${r.code ? '.code' : ''}`, { text: r.value, title: r.value })])) : null;
  const prLink = v.url ? h('button.link.ac-pr', { type: 'button', text: 'PR 보기 ↗', title: v.url, onclick: () => cy.openLink(v.url) }) : null;
  const commit = v.link ? h('button.link.ac-commit', { type: 'button', text: '머지 커밋 ↗', title: v.link, onclick: () => cy.openLink(v.link) }) : null;
  if (opts.fold && foldedPermission(a) && !actionLocal.get(a.id)) {
    return h(`details.action-card.merge.folded.s-${v.state}`, { dataset: { id: a.id } },
      // 접힌 줄에서도 PR 로 바로(머지한 뒤에도) — 누르면 펼치지 않고 PR 을 연다
      h('summary', null, h('span.ac-fold-head', { text: v.head }), v.status ? h(`span.ac-status.${v.tone}`, { text: v.status }) : null,
        v.url ? h('button.link.ac-pr', { type: 'button', text: 'PR ↗', title: v.url, onclick: (e) => { e.preventDefault(); e.stopPropagation(); cy.openLink(v.url); } }) : null,
        timeEl(a.created)),
      rows, h('div.ac-links', null, prLink, commit));
  }
  return h(`div.action-card.merge.s-${v.state}`, { dataset: { id: a.id } },
    h('div.ac-kind', { text: '머지 승인' }),
    h('div.ac-head', null, h('span', { text: v.head }), timeEl(a.created)),
    v.sub ? h('div.ac-sub', null, h('span', { text: v.sub }), prLink) : prLink,
    rows,
    v.blocked ? h('div.ac-blocked', { role: 'note', text: `✋ ${v.blocked}` }) : null,
    v.question ? h('div.ac-q', { text: v.question }) : null,
    v.buttons.length ? h('div.ac-acts', null, v.buttons.map((b) => h(`button.${b.primary ? 'primary' : 'ghost'}.ac-${b.decision}`,
      { type: 'button', text: b.label, title: b.title ?? '', disabled: v.disabled || !!b.disabled, onclick: () => decideAction(a, b.decision) }))) : null,
    v.status ? h(`div.ac-status.${v.tone}`, { role: 'status' }, h('span', { text: v.status }), commit) : null);
}

function actionCard(a, opts = {}) {
  const local = actionLocal.get(a.id) ?? null;
  const v = cardView(a, local);
  if (v.merge) return mergeCardEl(a, v, opts);
  // 결정이 끝난 도구 승인은 한 줄로 접기(채팅) — 줄줄이 쌓여 답을 가리지 않게
  if (opts.fold && foldedPermission(a) && !local) {
    return h(`details.action-card.perm.folded.s-${v.state}`, { dataset: { id: a.id } },
      h('summary', null, h('span.ac-fold-head', { text: `🔐 ${v.head}` }), v.status ? h(`span.ac-status.${v.tone}`, { text: v.status }) : null, timeEl(a.created)),
      v.fields.length ? h('dl.ac-fields', null, v.fields.flatMap((f) => [h('dt', { text: f.label }), h('dd', { text: f.value, title: f.value })])) : null,
      v.body ? h(`pre.ac-body.${v.bodyKind}`, { text: v.body }) : null);
  }
  return h(`div.action-card.s-${v.state}${v.permission ? '.perm' : ''}`, { dataset: { id: a.id } },
    v.permission ? h('div.ac-kind', { text: '🔐 승인 요청' }) : null,
    h('div.ac-head', null, h('span', { text: v.head }), timeEl(a.created)),
    v.question ? md(h('div.ac-q'), v.question) : null,
    v.fields.length ? h('dl.ac-fields', null, v.fields.flatMap((f) => [h('dt', { text: f.label }), h('dd', { text: f.value, title: f.value })])) : null,
    v.body ? h(`pre.ac-body.${v.bodyKind}`, { text: v.body }) : null,
    v.comment ? h('div.ac-comment', { text: `메모: ${v.comment}` }) : null,
    v.buttons.length ? h('div.ac-acts', null, v.buttons.map((b) => h(`button.${b.primary ? 'primary' : b.danger ? 'ghost.danger' : 'ghost'}.ac-${b.decision}`,
      { type: 'button', text: b.label, title: b.title ?? '', disabled: v.disabled, onclick: () => decideAction(a, b.decision) }))) : null,
    v.status ? h(`div.ac-status.${v.tone}`, { role: 'status', text: v.status }) : null);
}

// 승인 카드 여럿: 결정이 끝난 도구 승인이 2개 이상이면 한 줄 묶음(「🔐 셸 명령 14번 허용 · 1번 취소 ▸」, 펼치면 하나씩) + 나머지는 그대로
const groupOpen = new Set(); // 펼친 묶음(첫 카드 id) — 다시 그려도 펼친 채
function pushApprovals(items, cards) {
  if (!cards?.length) return;
  const f = foldApprovals(cards.filter((a) => !actionLocal.get(a.id)));
  const busy = cards.filter((a) => actionLocal.get(a.id));
  if (f.group) {
    const key = f.group[0].id;
    const el = h('details.action-group', { dataset: { id: key }, ...(groupOpen.has(key) ? { open: true } : {}) },
      h('summary', null, h('span.ac-fold-head', { text: f.summary }), timeEl(f.group[0].created)),
      f.group.map((a) => actionCard(a, { fold: true })));
    el.addEventListener('toggle', () => { if (el.open) groupOpen.add(key); else groupOpen.delete(key); });
    items.push(el);
  }
  for (const a of [...f.rest, ...busy]) items.push(actionCard(a, { fold: true }));
}

function updateAction(a) {
  if (!a) return;
  if (a.threadId && a.threadId === selectedId) threadActions = upsertAction(threadActions, a);
  // 팝오버: 응답에 온 카드 + 묻는 동안 이 할 일에서 난 도구 승인 카드(SSE)
  if (askActions.some((x) => x.id === a.id) || belongsToTodo(a, ask?.todoId)) askActions = upsertAction(askActions, a);
  if (a.type === 'tool_permission' && a.status === 'done' && /항상 허용/.test(a.result?.message ?? '')) loadPermissions();
}

async function decideAction(a, decision) {
  if (['confirming', 'cancelling', 'always'].includes(actionLocal.get(a.id))) return;
  actionLocal.set(a.id, decision === 'confirm' ? 'confirming' : decision === 'always' ? 'always' : 'cancelling');
  renderChat(); if (ask) renderAsk();
  let r;
  try { r = await cy.actionDecide(a.id, decision); } catch { r = { ok: false }; }
  const out = decideResult(a, decision, r);
  if (out.error) actionLocal.set(a.id, { error: out.error }); else actionLocal.delete(a.id);
  updateAction(out.action);
  renderChat(); if (ask) renderAsk();
}

function onActionEvent(p) {
  const a = normalizeActions([p?.action])[0];
  if (!a) return;
  if (actionLocal.get(a.id) && a.status !== 'pending') actionLocal.delete(a.id);
  const before = threadActions, beforeAsk = askActions;
  updateAction(a);
  if (before !== threadActions) renderChat();
  if (beforeAsk !== askActions && ask) renderAsk();
}

function dispatchChat(action) {
  chat = chatReducer(chat, action);
  if (chat.replies.length) chat = chatReducer(chat, { type: 'consumed' }); // 패널은 대화 목록으로 다 보여줌
  renderChat();
  renderThreadList();
  renderBadges();
}

async function loadThreads() {
  let r;
  try { r = await cy.chatThreads(false); } catch { return; }
  if (!r?.ok || !Array.isArray(r.data?.threads)) return;
  threads = normThreads(r.data.threads);
  if (!seenLoaded) {
    let stored = null;
    try { stored = JSON.parse(store.get('threadSeen') ?? 'null'); } catch { stored = null; }
    seen = initSeen(stored, threads);
    seenLoaded = true;
    saveSeen();
  } else {
    seen = pruneSeen(seen, [...threads, ...(archived ?? [])]);
  }
  if (!threadsLoaded) {
    threadsLoaded = true;
    if (selectedId === null && !pendingOpen) selectThread(pickInitial(threads, store.get('thread')), { keepList: true });
  }
  if (showArchived) await loadArchived();
  afterThreadsChanged();
}
let threadsTimer = null;
const loadThreadsSoon = () => { clearTimeout(threadsTimer); threadsTimer = setTimeout(loadThreads, 200); };

async function loadArchived() {
  let r;
  try { r = await cy.chatThreads(true); } catch { return; }
  if (r?.ok && Array.isArray(r.data?.threads)) archived = normThreads(r.data.threads);
}

// 목록이 바뀐 뒤: 선택한 스레드가 바뀌었으면(새 답·시스템 줄) 말을 다시, 읽음 처리, 그리기
function afterThreadsChanged() {
  const cur = currentThread();
  if (selectedId && cur && cur.updated !== loadedUpdated) loadMessages();
  if (cur && section === 'chat' && document.visibilityState !== 'hidden') {
    const next = markSeen(seen, cur);
    if (next !== seen) { seen = next; saveSeen(); }
  }
  renderThreadList();
  renderThreadHead();
  renderBadges();
}

async function loadMessages(opts = {}) {
  const id = selectedId;
  if (!id) return;
  const seq = ++msgSeq;
  const before = opts.older ? messages.find((m) => m.n != null)?.n : undefined;
  let r;
  try { r = await cy.chatThreadMessages(id, before); } catch { r = { ok: false }; }
  if (seq !== msgSeq || id !== selectedId) return;
  if (r?.ok && Array.isArray(r.data?.messages)) {
    messages = mergeMessages(messages, r.data.messages, { older: !!opts.older });
    if (Array.isArray(r.data.actions)) for (const a of r.data.actions) threadActions = upsertAction(threadActions, a);
    moreAbove = !!r.data.more;
    if (r.data.thread) {
      const t = normThread(r.data.thread);
      if (t && !t.archived) threads = upsertThread(threads, t);
      loadedUpdated = t?.updated ?? loadedUpdated;
    }
    renderChat({ keepScroll: !!opts.older });
    renderThreadHead();
  } else if (r?.status === 404) {
    // 다른 데서 지웠다
    threads = threads.filter((t) => t.id !== id);
    selectThread(null);
  }
}

function selectThread(id, opts = {}) {
  const prevId = selectedId;
  drafts.set(prevId, chatInput.value);
  selectedId = id ?? null;
  store.set('thread', selectedId ?? '');
  if (prevId !== selectedId || opts.reload) {
    messages = [];
    threadActions = [];
    moreAbove = false;
    loadedUpdated = null;
    msgSeq++;
    agents = [];
    sessions = [];
    worktrees = [];
    agentsFor = null;
    agentsDoneOpen = false;
    renderAgents();
    if (selectedId) { loadMessages(); loadAgents(); }
  }
  rowMode = rowMode?.id === selectedId ? rowMode : null;
  endTitleEdit(false);
  chatInput.value = drafts.get(selectedId) ?? '';
  autosize();
  if (!opts.keepList) setListOpen(false);
  const t = currentThread();
  if (t) { seen = markSeen(seen, t); saveSeen(); }
  renderChat();
  renderThreadList();
  renderThreadHead();
  renderBadges();
  if (section === 'chat' && !opts.noFocus) chatInput.focus();
}

function newChat() {
  if (section !== 'chat') goto('chat');
  if (showArchived) toggleArchived(false);
  selectThread(null);
  drafts.set(null, '');
  chatInput.value = '';
  autosize();
  chatInput.focus();
}

// 다른 곳(말풍선·할 일 팝오버)에서 그 대화를 열어 달라고 할 때 — 목록에 아직 없으면 불러온 뒤
let pendingOpen = null;
async function openThread(id) {
  if (!okThreadId(id)) return;
  pendingOpen = id;
  if (section !== 'chat') goto('chat');
  if (!threads.some((t) => t.id === id)) await loadThreads();
  if (pendingOpen !== id) return;
  pendingOpen = null;
  if (showArchived && !archived?.some((t) => t.id === id)) toggleArchived(false);
  selectThread(id, { reload: true });
}

// 할 일 하나의 대화(할 일당 하나)를 연다 — 없으면 만든다. text 가 있으면 입력창에 옮겨 둔다
async function openTodoThread(todoId, text) {
  let r;
  try { r = await cy.chatThreadCreate({ kind: 'todo', todoId }); } catch { r = { ok: false }; }
  if (!r?.ok || !r.data?.thread) { todoMsg = { ok: false, text: `대화를 못 열었어요 — ${why(r)}` }; renderTodos(); return; }
  threads = upsertThread(threads, r.data.thread);
  await openThread(r.data.thread.id);
  if (text) { chatInput.value = text; drafts.set(selectedId, text); autosize(); }
  chatInput.focus();
}

function toggleArchived(on = !showArchived) {
  showArchived = on;
  thArchiveToggle.setAttribute('aria-pressed', String(on));
  thArchiveToggle.textContent = on ? '← 대화 목록' : '보관함';
  rowMode = null;
  if (on) loadArchived().then(() => renderThreadList());
  renderThreadList();
}

function setListOpen(on) {
  listOpen = !!on;
  chatSec.classList.toggle('list-open', listOpen);
  $('th-toggle').setAttribute('aria-expanded', String(listOpen));
  $('th-scrim').hidden = !listOpen;
}

// 보이는 순서(⌘↑/⌘↓)
function visibleOrder() {
  return groupThreads(filterThreads(allThreads(), thQuery)).flatMap((g) => g.items.map((t) => t.id));
}

function renderThreadList() {
  const busy = busyThreads(chat);
  const list = filterThreads(allThreads(), thQuery);
  const kids = [];
  if (showArchived) {
    kids.push(h('div.th-group', { text: `보관함 (${list.length})` }));
    kids.push(...list.map((t) => threadRow(t, busy)));
  } else {
    for (const g of groupThreads(list)) kids.push(h('div.th-group', { text: g.label }), ...g.items.map((t) => threadRow(t, busy)));
  }
  if (!list.length) {
    kids.push(h('div.th-empty', { text: thQuery ? '찾는 대화가 없어요' : showArchived ? '보관한 대화가 없어요' : threadsLoaded ? '아직 대화가 없어요' : '불러오는 중…' }));
  }
  const focused = document.activeElement?.closest?.('.th-row')?.dataset.id;
  const renameFocused = document.activeElement?.classList.contains('th-rename');
  thList.replaceChildren(...kids);
  if (renameFocused) thList.querySelector('.th-rename')?.focus();
  else if (focused) thList.querySelector(`.th-row[data-id="${CSS.escape(focused)}"]`)?.focus();
}

function threadRow(t, busy) {
  const sel = t.id === selectedId;
  const unread = isUnread(seen, t, selectedId);
  const mode = rowMode?.id === t.id ? rowMode.mode : null;
  const icon = h('span.th-icon', { text: KIND_ICONS[t.kind] ?? '💬', title: KIND_LABELS[t.kind] ?? '' });
  if (mode === 'delete' || mode === 'archive') {
    const del = mode === 'delete';
    return h('div.th-row.confirm', { dataset: { id: t.id }, role: 'option', 'aria-selected': String(sel) },
      icon,
      h('span.th-ask', { text: del ? `"${t.title}" 지울까요? 되돌릴 수 없어요` : `"${t.title}" 보관할까요?` }),
      h('button.ghost', { type: 'button', text: '취소', onclick: (e) => { e.stopPropagation(); rowMode = null; renderThreadList(); } }),
      h(`button${del ? '.danger' : '.primary'}`, { type: 'button', text: del ? '삭제' : '보관', onclick: (e) => { e.stopPropagation(); del ? deleteThread(t.id) : archiveThread(t.id, true); } }));
  }
  if (mode === 'rename') {
    const input = h('input.th-rename', { type: 'text', value: t.title, 'aria-label': '대화 이름' });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      rowMode = null;
      if (save) renameThread(t.id, input.value);
      else renderThreadList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => { if (input.isConnected && document.activeElement !== input) { input.focus(); input.select(); } });
    return h('div.th-row', { dataset: { id: t.id }, role: 'option', 'aria-selected': String(sel) }, icon, input);
  }
  const act = (label, text, fn) => h('button', { type: 'button', text, title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); fn(); } });
  return h(`div.th-row${unread ? '.unread' : ''}`, {
    dataset: { id: t.id }, role: 'option', tabindex: '0', 'aria-selected': String(sel), title: t.title,
    onclick: () => selectThread(t.id),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); selectThread(t.id); } },
  },
  icon,
  h('span.th-text', null, h('span.th-name', { text: t.title }), t.preview ? h('span.th-prev', { text: t.preview.replace(/[*_`#>~]/g, '') }) : null),
  busy.has(t.id) ? h('span.spin.th-busy', { title: '답하는 중' }) : unread ? h('span.th-dot', { title: '새 답', 'aria-label': '새 답' }) : null,
  h('span.th-acts', null,
    act('이름 바꾸기', '✎', () => { rowMode = { id: t.id, mode: 'rename' }; renderThreadList(); }),
    showArchived ? act('꺼내기', '↩︎', () => archiveThread(t.id, false)) : act('보관', '🗄', () => { rowMode = { id: t.id, mode: 'archive' }; renderThreadList(); }),
    act('삭제', '🗑', () => { rowMode = { id: t.id, mode: 'delete' }; renderThreadList(); })));
}

async function renameThread(id, title) {
  const v = String(title ?? '').trim();
  const t = allThreads().find((x) => x.id === id);
  if (!v || !t || v === t.title) { renderThreadList(); renderThreadHead(); return; }
  const patch = (list) => list?.map((x) => (x.id === id ? { ...x, title: v } : x));
  threads = patch(threads); archived = patch(archived); // 바로 보이게
  renderThreadList(); renderThreadHead();
  let r;
  try { r = await cy.chatThreadEdit(id, { title: v }); } catch { r = { ok: false }; }
  if (!r?.ok) { setBanner(`이름을 못 바꿨어요 — ${why(r)}`); loadThreads(); }
}

async function archiveThread(id, on) {
  const order = visibleOrder();
  rowMode = null;
  let r;
  try { r = await cy.chatThreadEdit(id, { archived: on }); } catch { r = { ok: false }; }
  if (!r?.ok) { setBanner(`${on ? '보관' : '꺼내기'} 못 했어요 — ${why(r)}`); renderThreadList(); return; }
  if (on) {
    threads = threads.filter((t) => t.id !== id);
    if (selectedId === id) selectThread(afterRemoval(order, id), { noFocus: true });
  } else {
    archived = archived?.filter((t) => t.id !== id) ?? null;
    if (r.data?.thread) threads = upsertThread(threads, r.data.thread);
  }
  if (showArchived) await loadArchived();
  renderThreadList();
}

async function deleteThread(id) {
  const order = visibleOrder();
  rowMode = null;
  let r;
  try { r = await cy.chatThreadDelete(id); } catch { r = { ok: false }; }
  if (!r?.ok && r?.status !== 404) { setBanner(`못 지웠어요 — ${why(r)}`); renderThreadList(); return; }
  threads = threads.filter((t) => t.id !== id);
  archived = archived?.filter((t) => t.id !== id) ?? null;
  drafts.delete(id);
  if (selectedId === id) selectThread(afterRemoval(order, id), { noFocus: true });
  renderThreadList();
}

// 머리말: 종류 아이콘 · 제목(눌러서 이름 바꾸기) · 할 일 대화면 그 할 일 칩
function renderThreadHead() {
  const t = currentThread();
  $('th-kind').textContent = t ? KIND_ICONS[t.kind] ?? '' : '💬';
  if (thTitleInput.hidden) {
    thTitle.textContent = t ? t.title : '새 대화';
    thTitle.disabled = !t;
    thTitle.title = t ? '눌러서 이름 바꾸기' : '첫 말을 보내면 대화가 생겨요';
  }
  const chip = todoChip(t, rawTodos(), [...recentDone, ...(raw?.recentDone ?? [])]);
  thTodo.hidden = !chip;
  if (chip) {
    thTodo.textContent = chip.gone ? `✅ ${chip.title} (목록에 없음)` : chip.done ? `✔︎ ${chip.title} (끝남)` : `✅ ${chip.title}`;
    thTodo.title = chip.gone ? '이 할 일은 이제 목록에 없어요(지웠거나 오래전에 끝남)' : chip.done ? '끝난 할 일' : '할 일 목록에서 보기';
    thTodo.classList.toggle('gone', !!chip.gone);
    thTodo.classList.toggle('done', !!chip.done);
    thTodo.disabled = !chip.open;
    thTodo.dataset.id = chip.id;
  }
  $('th-sync').hidden = !(t?.cliSync && cy.chatThreadSync);
  chatInput.placeholder = t?.kind === 'todo'
    ? '이 할 일에 대해 — 예: 내일로 미뤄 / 끝났어 (바로 적용돼요 · Shift+Enter 줄바꿈)'
    : '물어보세요 — 예: 오늘 커밋 보여줘 (Shift+Enter 줄바꿈)';
}

function startTitleEdit() {
  const t = currentThread();
  if (!t) return;
  thTitleInput.value = t.title;
  thTitle.hidden = true;
  thTitleInput.hidden = false;
  thTitleInput.focus();
  thTitleInput.select();
}
function endTitleEdit(save) {
  if (thTitleInput.hidden) return;
  const id = selectedId;
  const v = thTitleInput.value;
  thTitleInput.hidden = true;
  thTitle.hidden = false;
  if (save && id) renameThread(id, v);
  renderThreadHead();
}
thTitle.addEventListener('click', startTitleEdit);
thTitleInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') { e.preventDefault(); endTitleEdit(true); chatInput.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTitleEdit(false); chatInput.focus(); }
});
thTitleInput.addEventListener('blur', () => endTitleEdit(true));
thTodo.addEventListener('click', () => {
  const id = thTodo.dataset.id;
  if (!id || thTodo.disabled) return;
  goto('todos');
  if (openId !== id) toggleDetail(id);
});
$('th-new').addEventListener('click', newChat);
$('th-toggle').addEventListener('click', () => setListOpen(!listOpen));
$('th-scrim').addEventListener('click', () => setListOpen(false));
thArchiveToggle.addEventListener('click', () => toggleArchived());
thSearch.addEventListener('input', () => { thQuery = thSearch.value; renderThreadList(); });
thSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && thSearch.value) { e.preventDefault(); e.stopPropagation(); thSearch.value = ''; thQuery = ''; renderThreadList(); }
  else if (e.key === 'Enter' && !e.isComposing) { const first = visibleOrder()[0]; if (first) selectThread(first); }
});

function nearBottom() {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
}
function scrollChat(force) {
  if (force || nearBottom()) requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; });
}

// 작은 시각(18:22). 글자는 ::before(data-t)로만 그려서 선택·복사에 섞이지 않는다("…내용18:22" 안 되게). 올리면 전체 날짜·시각
function timeEl(iso) {
  const t = stamp(iso);
  return t ? h('span.when', { 'data-t': t.text, title: t.title }) : null;
}

// 말풍선 아래 한 줄(시각·상태) — 말풍선 쪽(내 말은 오른쪽, 답은 왼쪽)에 맞춘다
// status: 글 또는 { status, title, tone } — tone: sending|sent(내 말 보낸 상태)
function metaEl(m, status) {
  const st = typeof status === 'string' ? { status } : status;
  return h('div.msg-meta', null,
    m.via === 'cli' ? h('span.via-cli', { text: 'Claude Code', title: '터미널의 Claude Code(claude --resume)에서 이어 간 말을 불러온 거예요' }) : null,
    m.edited ? h('span.edited', { text: '수정됨', title: `${stamp(m.edited)?.title ?? ''} 고쳐서 다시 보낸 말이에요`.trim() }) : null,
    st?.status ? h(`span.st${st.tone ? `.s-${st.tone}` : ''}`, { 'data-s': st.status, ...(st.title ? { title: st.title } : {}) }) : null, timeEl(m.at));
}

// 내 말의 상태 줄: 못 보냄 · 보내는 중(받아들여졌는지·줄 섰는지 아직 모름) · 보냄(모델에 감 — 줄 섰다 갔으면 얼마나 기다렸는지)
// 서버 기록(로컬 사본 아님)은 줄 섰다 간 말만 「대기 N분 뒤 보냄」
function userStatus(m) {
  if (m.local && m.error) return { status: '못 보냄' };
  if (!m.local) return m.queuedAt ? sentStatus(m.queuedAt, m.at) : null;
  const st = localState(chat, m.chatId);
  if (st === 'sending') return { status: '보내는 중', tone: 'sending', title: m.chatId ? '데몬이 받았어요 — 바로 보낼지 줄 설지 확인하는 중' : '데몬에 보내는 중' };
  const p = chat.pending[m.chatId];
  return { ...sentLabel(m.queuedAt ?? p?.queuedAt, m.sentAt ?? p?.sentAt), tone: 'sent' }; // 로컬 사본은 늘 「보냄」까지 — 서버 기록이 오면 조용해진다
}
function sentStatus(queuedAt, sentAt) {
  const s = sentLabel(queuedAt, sentAt);
  return s.status === '보냄' && !queuedAt ? null : { ...s, tone: 'sent' };
}

// 기다리는 말(대기 중): 답하던 게 끝나면 차례대로 간다 — [지금 보내기]는 답하던 걸 멈추고 바로, [취소]는 빼서 입력창으로.
// 데몬 큐(chat.pending 의 queued)로 그린다 — 패널을 닫았다 열어도 같은 자리에. 흐린 점선 풍선 + 아래 상태 줄(차례·무엇을 기다리는지·줄 선 시각)
const queueBusy = new Set(); // 지금 보내기·취소를 누르고 응답을 기다리는 chatId
function queuedRow(p, canEdit = false) {
  const busy = queueBusy.has(p.chatId);
  const l = queuedLabel(p);
  const key = `q:${p.chatId}`;
  return h(`div.msg-row.user.queued${canEdit ? '.editable' : ''}`, { dataset: { chat: p.chatId } },
    queuedAtts(p),
    canEdit && editingMsg?.key === key ? msgEditor() : (p.text || !p.attachments?.length) ? h('div.msg.user.queued', { title: '아직 보내지 않았어요 — 줄 서 있어요' }, h('span', { text: p.text ?? '' })) : null,
    canEdit && editingMsg?.key !== key ? editButton(() => startEdit({ key, kind: 'queued', chatId: p.chatId, text: p.text ?? '' })) : null,
    h('div.msg-meta.q-meta', null,
      h('span.st.s-queued', { 'data-s': l.status, title: l.wait }),
      h('span.q-wait', { text: l.wait, title: l.wait }),
      timeEl(p.queuedAt)),
    h('div.msg-meta.q-actions', null,
      h('button.ghost.small.q-now', { type: 'button', text: '지금 보내기', title: '지금 답하던 걸 멈추고 이 말을 바로 보내요', disabled: busy || !cy.chatNow, onclick: () => sendNowQueued(p.chatId) }),
      h('button.ghost.small.q-cancel', { type: 'button', text: '취소', title: '이 말은 보내지 않아요 (입력창으로 돌려놔요)', disabled: busy, onclick: () => cancelQueued(p.chatId) })));
}

// ---- 첨부(보낸 말의 그림·파일) — 그림은 미리보기(cy-attach://, 보내기 전 사본은 blob:), 누르면 기본 앱으로 연다 ----
function attsEl(list, threadId, { queued = false } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  return h(`div.msg-atts${queued ? '.queued' : ''}`, null, list.map((a) => {
    const v = chipView(a);
    const url = a.file ? attachUrl(threadId, a.file) : null;
    const open = url && cy.openAttachment ? () => cy.openAttachment(threadId, a.file) : null;
    const src = a.kind === 'image' ? (url ?? a.localUrl ?? null) : null;
    if (src) return h('button.msg-att-img', { type: 'button', title: open ? `${v.title}\n눌러서 열기` : v.title, disabled: !open, onclick: open }, h('img', { src, alt: a.name, loading: 'lazy' }));
    return h('button.msg-att-file', { type: 'button', title: open ? `${v.title}\n눌러서 열기` : v.title, disabled: !open, onclick: open },
      h('span.att-icon', { text: v.icon, 'aria-hidden': 'true' }), h('span.att-name', { text: v.name }), h('span.att-size', { text: v.size }));
  }));
}
// 줄 선 말의 첨부: 로컬 사본(미리보기 있음)이 있으면 그것, 없으면 데몬 큐의 이름·크기
function queuedAtts(p) {
  const local = messages.find((m) => m.local && ((p.chatId && m.chatId === p.chatId) || (p.clientId && m.clientId === p.clientId)));
  return attsEl(local?.attachments ?? p.attachments, selectedId, { queued: true });
}

// ---- 말 고치기(✏️) — 이 대화의 마지막 내 말만. 저장하면: 답하는 중이면 멈추고, 그 뒤 답은 걷히고, 고친 글로 다시 답한다(데몬 Chat.edit).
// 줄 선 말이면 글만 바뀐다(차례 그대로). Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소
function editButton(onclick) {
  return h('button.msg-edit', { type: 'button', text: '✏️', title: '이 말 고치기 — 고친 글로 다시 답해요', 'aria-label': '이 말 고치기', onclick });
}
function startEdit(e) {
  if (!cy.chatEdit && e.kind === 'sent') return;
  if (!cy.chatEditQueued && e.kind === 'queued') return;
  editingMsg = { ...e };
  renderChat();
  requestAnimationFrame(() => { const ta = editingMsg?.el?.querySelector('textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
}
function endEdit() {
  editingMsg = null;
  renderChat();
  chatInput.focus();
}
// 편집기는 한 번 만들어 다시 그려도 그대로 쓴다(SSE 로 대화가 다시 그려져도 글·커서가 안 날아가게)
function msgEditor() {
  const e = editingMsg;
  if (e.el) { e.el.querySelector('.me-err').textContent = e.error ?? ''; e.el.querySelectorAll('button').forEach((b) => { b.disabled = !!e.saving; }); return e.el; }
  const ta = h('textarea.msg-editor', { rows: 1, 'aria-label': '고칠 말' });
  ta.value = e.text;
  const size = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 220)}px`; };
  ta.addEventListener('input', () => { e.text = ta.value; size(); });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.isComposing) { ev.preventDefault(); ev.stopPropagation(); endEdit(); return; }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    saveEdit();
  });
  e.el = h('div.msg-edit-box', null, ta,
    h('div.me-row', null,
      h('span.me-err'),
      h('span.me-hint', { text: e.kind === 'queued' ? '아직 안 보낸 말이라 글만 바뀌어요' : '저장하면 고친 말로 다시 답해요 — 그 뒤 답은 걷혀요' }),
      h('button.ghost.small', { type: 'button', text: '취소', onclick: endEdit }),
      h('button.primary.small', { type: 'button', text: '저장', onclick: () => saveEdit() })));
  requestAnimationFrame(size);
  return e.el;
}
async function saveEdit() {
  const e = editingMsg;
  if (!e || e.saving) return;
  const text = e.text.trim();
  if (!text) { e.error = '비어 있으면 저장할 수 없어요'; renderChat(); return; }
  const tid = selectedId;
  e.saving = true; e.error = null;
  renderChat();
  let r;
  if (e.kind === 'queued') {
    try { r = await cy.chatEditQueued(e.chatId, text); } catch { r = { ok: false }; }
    if (r?.ok) {
      messages = messages.map((m) => (m.local && m.chatId === e.chatId ? { ...m, text } : m));
      if (editingMsg === e) editingMsg = null;
      renderChat();
      return;
    }
  } else {
    const clientId = newClientId();
    const model = $('chat-model').hidden ? null : $('chat-model').value || null;
    const opts = { clientId, ...(model ? { model } : {}) };
    try { r = await cy.chatEdit(tid, e.n, text, opts); } catch { r = { ok: false }; }
    // 그 턴이 띄운 백그라운드 에이전트가 아직 돈다 — 멈춰도 되는지 묻는다(안 멈추면 옛 물음의 결과가 새 답 뒤에 끼어든다)
    if (r?.status === 409 && r.data?.error === 'agents_running') {
      const n = Array.isArray(r.data.agents) ? r.data.agents.length : 1;
      const names = Array.isArray(r.data.agents) ? r.data.agents.map((a) => `「${a.description}」`).join(', ') : '';
      if (!confirm(`이 답이 띄운 에이전트 ${n}개${names ? `(${names})` : ''}가 아직 돌고 있어요.\n고치면 그 에이전트를 멈춰요. 고칠까요?`)) { e.saving = false; renderChat(); return; }
      try { r = await cy.chatEdit(tid, e.n, text, { ...opts, stopAgents: true }); } catch { r = { ok: false }; }
    }
    if (r?.ok && r.data?.chatId) {
      if (editingMsg === e) editingMsg = null;
      if (selectedId === tid) {
        const at = new Date().toISOString();
        messages = appendLocal(dropFrom(messages, e.n), { role: 'user', text, at, clientId });
        messages = tagLocal(messages, { text, at, clientId }, r.data.chatId);
        dispatchChat({ type: 'accepted', chatId: r.data.chatId, threadId: r.data.threadId, clientId, text, ...(r.data.queued != null ? { queued: r.data.queued } : {}) });
        renderChat();
        scrollChat(true);
        loadMessages();
      }
      return;
    }
  }
  if (editingMsg !== e) return;
  e.saving = false;
  const why = r?.data?.error;
  e.error = why === 'not_latest' || why === 'not_queued' ? '이제 마지막 말이 아니라 고칠 수 없어요' : why === 'agents_running' ? '에이전트가 돌고 있어 고치지 않았어요' : '고치지 못했어요 — 다시 해 보세요';
  renderChat();
  if (why === 'not_latest' || why === 'not_queued') loadMessages();
}

async function sendNowQueued(chatId) {
  if (!chatId || queueBusy.has(chatId) || !cy.chatNow) return;
  queueBusy.add(chatId);
  renderChat();
  try { await cy.chatNow(chatId); } catch { /* 결과는 SSE chat 으로 — 404 면 이미 차례가 왔다 */ }
  queueBusy.delete(chatId);
  renderChat();
}

async function cancelQueued(chatId) {
  if (!chatId || queueBusy.has(chatId) || !cy.chatStop) return;
  queueBusy.add(chatId);
  renderChat();
  try { await cy.chatStop(chatId); } catch { /* 결과는 SSE chat stopped */ }
  queueBusy.delete(chatId);
  renderChat();
}

// ---- 대화 속 서브에이전트(GET /chat/threads/:id/agents) — 입력창 위 "에이전트" 줄 + 대화 속 카드. 누르면 작업 세션 창의 그 Agent 줄 ----
const agentKey = (a) => `${a.runId}/${a.toolUseId}`;
const placeSig = (list) => list.map((a) => `${agentKey(a)}:${a.status}`).join('|'); // 자리·상태가 바뀌면 대화를 다시 그림

async function loadAgents() {
  const id = selectedId;
  if (!id || !cy.chatThreadAgents) return;
  const seq = ++agentsSeq;
  let r;
  try { r = await cy.chatThreadAgents(id); } catch { r = null; }
  if (seq !== agentsSeq || id !== selectedId || !r?.ok) return;
  const next = normAgents(r.data);
  const nextSessions = normSessions(r.data);
  const nextWt = normWorktrees(r.data);
  const prev = agentsFor === id ? agents : [];
  const prevSessions = agentsFor === id ? sessions : [];
  const prevWt = agentsFor === id ? worktrees : [];
  agents = next;
  sessions = nextSessions;
  worktrees = nextWt;
  agentsFor = id;
  const agentsSame = agentsSig(next) === agentsSig(prev);
  if (agentsSame && sessionsSig(nextSessions) === sessionsSig(prevSessions) && worktreesSig(nextWt) === worktreesSig(prevWt)) return;
  if (!agentsSame) renderAgents();
  if (placeSig(next) !== placeSig(prev) || sessionsPlaceSig(nextSessions) !== sessionsPlaceSig(prevSessions) || worktreesPlaceSig(nextWt) !== worktreesPlaceSig(prevWt)) renderChat();
  else {
    for (const a of next) agentCardEls.get(agentKey(a))?.replaceWith(agentCardEl(a));
    refreshSessionCards();
    refreshWorktreeCards(); // 토큰이 늘거나 끝난 줄만 — 대화 전체를 다시 그리지 않는다
  }
}
const loadAgentsSoon = () => { clearTimeout(agentsTimer); agentsTimer = setTimeout(loadAgents, 150); };
const openAgent = (a) => cy.openSession?.(a.runId, a.toolUseId);

// 백그라운드 에이전트(채팅이 넘긴 것)는 카드 옆 [멈추기] — 채팅 답의 [멈추기]와 따로(답은 이미 끝났다)
const agentStopping = new Set();
function agentCardEl(a) {
  const v = agentCard(a);
  const card = h(`button.agent-card.t-${v.tone}${a.background ? '.bg' : ''}`, { type: 'button', title: '작업 세션 창에서 이 에이전트가 한 일 보기', onclick: () => openAgent(a) },
    h('span.ag-title', { text: v.title }),
    h('span.ag-status', null, a.status === 'running' ? h('i.ag-dot') : null, h('span', { text: v.status })),
    v.last ? h('span.ag-last', { text: v.last }) : null,
    v.note ? h('span.ag-note', { text: v.note }) : null,
    v.worktree ? h('span.ag-note.ag-wt', { text: v.worktree, title: '이 에이전트가 일한 워크트리(브랜치 · 경로)' }) : null,
    a.via === 'cli' ? h('span.via-cli', { text: 'Claude Code', title: '터미널의 Claude Code 에서 띄운 에이전트예요' }) : null,
    timeEl(a.startedAt));
  const el = canStopAgent(a) && cy.agentStop
    ? h('div.agent-wrap', null, card, h('button.ghost.small.ag-stop', { type: 'button', text: '멈추기',
      title: '이 에이전트만 멈춰요(채팅은 그대로)', disabled: agentStopping.has(a.toolUseId), onclick: () => stopAgent(a) }))
    : card;
  agentCardEls.set(agentKey(a), el);
  return el;
}
async function stopAgent(a) {
  if (agentStopping.has(a.toolUseId) || !cy.agentStop) return;
  agentStopping.add(a.toolUseId);
  agentCardEls.get(agentKey(a))?.replaceWith(agentCardEl(a));
  try { await cy.agentStop(a.toolUseId); } catch { /* 결과는 SSE agents·threads 로 */ }
  agentStopping.delete(a.toolUseId);
  loadAgentsSoon();
}

// 대화 속 작업 세션 카드(Orca 작업 공간 카드처럼): 머리 = 상태 점 + 레포(아래 흐리게 브랜치), 안쪽 줄 = 스피너(끝나면 ✓/✗/–) ✳ 작업 제목 - 마지막 줄 · 경과.
// 누르면 작업 세션 창이 그 run 을 연다
function sessionCardEl(s) {
  const v = sessionCard(s, { connected });
  const el = h(`button.session-card.t-${v.tone}`, { type: 'button', title: `작업 세션 창에서 보기 — ${s.title} (${v.status})`, onclick: () => cy.openSession?.(s.runId) },
    h('span.ws-head', null,
      h(`i.ws-dot.d-${v.dot}`, { 'aria-hidden': 'true' }),
      h('span.ws-name', { text: v.header }),
      v.sub ? h('span.ws-sub', { text: v.sub }) : null),
    h('span.ws-row', null,
      v.spinning ? h('i.ws-spin', { 'aria-label': '진행 중' }) : h('span.ws-icon', { text: v.icon, 'aria-label': v.status }),
      h('span.ws-mark', { text: '✳', 'aria-hidden': 'true' }),
      h('span.ws-text', null, h('b', { text: v.label }), v.last ? h('span.ws-last', { text: ` - ${v.last}` }) : null),
      h('span.ws-age', { text: v.age, title: v.ageTitle })));
  sessionCardEls.set(s.runId, el);
  return el;
}
// 대화 속 워크트리 카드: 머리 「🌿 워크트리 N개 · N개 진행 중」, 줄마다 (스피너) 제목 · 브랜치 · 「12.3k 토큰…」 / 초록 「완료」·빨강 「실패」·「멈춤」.
// 하나라도 돌면 초록 테두리. 줄을 누르면 작업 세션 창(에이전트면 그 Agent 줄)
function wtCardEl(group) {
  const v = worktreeCard(group);
  const rows = v.rows.map((r, i) => {
    const t = openTarget(group[i]);
    return h(`button.wt-row${r.running ? '.run' : ''}`, { type: 'button', title: r.tip, disabled: !t, onclick: () => { if (t) cy.openSession?.(t.runId, t.toolUseId); } },
      r.running ? h('i.ws-spin', { 'aria-label': '진행 중' }) : null,
      h('span.wt-title', { text: r.title }),
      r.branch ? h('span.wt-branch', { text: r.branch }) : null,
      r.tokens ? h('span.wt-tokens', { text: r.tokens }) : null,
      r.state ? h(`span.wt-state.t-${r.state.tone}`, { text: r.state.text }) : null);
  });
  const el = h(`div.wt-card${v.active ? '.active' : ''}`, null,
    h('div.wt-head', null, h('b', { text: v.head }), h('span.wt-sub', { text: v.sub })), ...rows);
  wtCardEls.set(group[0].key, { el, keys: group.map((w) => w.key) });
  return el;
}
function refreshWorktreeCards() {
  const byKey = new Map((agentsFor === selectedId ? worktrees : []).map((w) => [w.key, w]));
  for (const [, c] of [...wtCardEls]) {
    const group = c.keys.map((k) => byKey.get(k)).filter(Boolean);
    if (group.length) c.el.replaceWith(wtCardEl(group));
  }
}
function refreshSessionCards() {
  for (const s of agentsFor === selectedId ? sessions : []) sessionCardEls.get(s.runId)?.replaceWith(sessionCardEl(s));
}
// 돌고 있는 작업 세션의 경과(5분·1시간)는 30초마다 그 카드만 고친다
setInterval(() => { if (agentsFor === selectedId && sessions.some((s) => s.status === 'running')) refreshSessionCards(); }, 30e3);

// 입력창 위: 돌고 있는 에이전트 한 줄씩(점이 깜빡임) + 끝난 것 "에이전트 N개 끝남 ▸". 돌고 있는 게 없으면 숨김
function renderAgents() {
  const strip = agentsFor === selectedId ? agentStrip(agents, { open: agentsDoneOpen }) : null;
  chatAgentsEl.hidden = !strip;
  if (!strip) { chatAgentsEl.replaceChildren(); return; }
  const rows = strip.running.map((r) => h('button.ag-row.run', { type: 'button', title: `${r.agent.description} — 작업 세션 창에서 보기`, onclick: () => openAgent(r.agent) },
    h('i.ag-dot'), h('span.ag-text', { text: r.text })));
  if (strip.finished) {
    const f = strip.finished;
    rows.push(h('button.ag-toggle', { type: 'button', 'aria-expanded': f.open ? 'true' : 'false', text: `${f.label} ${f.open ? '▾' : '▸'}`,
      onclick: () => { agentsDoneOpen = !agentsDoneOpen; renderAgents(); } }));
    for (const r of f.rows) rows.push(h(`button.ag-row.done.t-${r.tone}`, { type: 'button', title: '작업 세션 창에서 보기', onclick: () => openAgent(r.agent) },
      h('span.ag-icon', { text: r.icon }), h('span.ag-text', { text: r.text })));
  }
  chatAgentsEl.replaceChildren(...rows);
}

function renderChat(opts = {}) {
  const stick = nearBottom();
  const prevHeight = chatLog.scrollHeight, prevTop = chatLog.scrollTop;
  const items = [];
  if (moreAbove) items.push(h('button.ghost.chat-more', { type: 'button', text: '이전 말 더 보기', onclick: () => loadMessages({ older: true }) }));
  // 대기 중인 내 말은 맨 아래(답하는 중 표시 밑)로 따로 — 데몬 큐 기준. 그 말의 로컬 사본은 대화 속에 또 그리지 않는다
  const queued = selectedId ? queuedChats(chat, selectedId) : [];
  const qIds = new Set(queued.map((p) => p.chatId)), qClients = new Set(queued.map((p) => p.clientId).filter(Boolean));
  const isQueued = (m) => m.local && !m.error && ((m.chatId && qIds.has(m.chatId)) || (m.clientId && qClients.has(m.clientId)) || localState(chat, m.chatId) === 'queued');
  const shown = messages.filter((m) => !isQueued(m));
  // 카드 자리: 붙은 말 위(승인)·아래(확인 카드), 안 붙었으면 자기 시각 자리 — 새 말보다 아래에 박히지 않게
  const placed = placeActions(threadActions, shown, { moreAbove });
  // 서브에이전트 카드: 띄운 시각 자리(그 뒤 첫 말 앞)에
  const agentAt = placeAgents(agentsFor === selectedId ? agents : [], shown, { moreAbove });
  // 워크트리 카드: 한 답이 판 워크트리들(둘 이상이면 그 수정 run 들의 세션 카드 대신 이 카드 하나)
  const wtAt = placeWorktrees(agentsFor === selectedId ? worktrees : [], shown, { moreAbove });
  // 작업 세션 카드: 채팅에서 시킨 것은 넘긴 답 바로 아래, 그 밖은 시작 시각 자리
  const sessAt = placeSessions((agentsFor === selectedId ? sessions : []).filter((s) => !wtAt.hideRuns.has(s.runId)), shown, { moreAbove });
  const indexOf = new Map(shown.map((m, i) => [m, i]));
  // ✏️ 가 붙는 말: 이 대화의 마지막 내 말 하나(줄 선 말이 있으면 맨 뒤에 줄 선 말)
  const target = selectedId ? editTarget(shown, queued) : null;
  if (editingMsg && !(target && editingMsg.key === (target.kind === 'sent' ? `n:${target.n}` : `q:${target.chatId}`))) editingMsg = null; // 더는 마지막 말이 아니다
  agentCardEls.clear();
  sessionCardEls.clear();
  wtCardEls.clear();
  const sessionsAfter = (i) => {
    for (const s of sessAt.after.get(i) ?? []) items.push(sessionCardEl(s));
    const g = wtAt.after.get(i);
    if (g) items.push(wtCardEl(g));
  };
  for (const it of withDayDividers(shown)) {
    if (it.type === 'day') { items.push(h('div.day-sep', { role: 'separator', 'aria-label': it.label, title: it.title }, h('span', { 'data-t': it.label }))); continue; }
    const m = it.msg;
    const mi = indexOf.get(m);
    if (mi === 0) sessionsAfter(-1);
    pushApprovals(items, placed.before.get(mi) ?? []); // 답이 안 붙은 카드: 자기 시각 자리(이 말 앞)
    for (const a of agentAt.before.get(mi) ?? []) items.push(agentCardEl(a));
    if (m.role === 'system') {
      const sc = aroundAnswer(placed.byMsg.get(m.n)); // 답 없이 끝난 턴의 줄("답을 끝내지 못했어요 …")에 붙은 승인 카드 → 줄 위
      pushApprovals(items, sc.before);
      items.push(h('div.msg.system', null, h('span', { text: m.text }), timeEl(m.at)));
      for (const a of sc.after) items.push(actionCard(a));
      sessionsAfter(mi); continue;
    }
    if (m.role === 'user') {
      const about = m.todoId ? (m.todoTitle || todoTitleOf(m.todoId)) : null;
      const chipOn = m.todoId && m.todoId !== currentThread()?.todoId; // 할 일 대화 안에서 그 할 일 칩은 군더더기
      const status = userStatus(m);
      const key = Number.isInteger(m.n) ? `n:${m.n}` : null;
      const canEdit = !!key && target?.kind === 'sent' && target.n === m.n;
      const bubble = m.text || chipOn || !m.attachments?.length; // 글 없이 첨부만 보낸 말은 첨부만
      items.push(h(`div.msg-row.user${m.local && m.error ? '.error' : ''}${canEdit ? '.editable' : ''}`, null,
        attsEl(m.attachments, selectedId),
        canEdit && editingMsg?.key === key ? msgEditor() : bubble ? h(`div.msg.user${m.local ? '.local' : ''}${m.local && m.error ? '.error' : ''}`, null,
          chipOn ? h('span.about', { text: about ? `할 일: ${about}` : '할 일', title: about ?? m.todoId }) : null, m.text ? h('span', { text: m.text }) : null) : null,
        canEdit && editingMsg?.key !== key ? editButton(() => startEdit({ key, kind: 'sent', n: m.n, text: m.text })) : null,
        metaEl(m, status)));
      sessionsAfter(mi);
      continue;
    }
    const cards = aroundAnswer(placed.byMsg.get(m.n));
    pushApprovals(items, cards.before); // 답을 만드는 동안 난 승인 → 답 위
    items.push(h('div.msg-row.assistant', null,
      h(`div.msg.assistant${m.error ? '.error' : ''}`, null,
        md(h('div'), m.text),
        m.show ? h('button.go', { type: 'button', text: `${SECTION_LABELS[m.show]} 보기`, onclick: () => goto(m.show) }) : null),
      metaEl(m)));
    for (const a of cards.after) items.push(actionCard(a));
    sessionsAfter(mi);
  }
  pushApprovals(items, placed.orphans); // 그 뒤 말이 없는 카드(지금 도는 턴)만 맨 아래
  for (const a of agentAt.tail) items.push(agentCardEl(a));
  for (const s of sessAt.tail) items.push(sessionCardEl(s));
  for (const g of wtAt.tail) items.push(wtCardEl(g));
  if (!items.length && !queued.length) {
    const t = currentThread();
    items.push(selectedId && t?.count
      ? h('div.chat-hello.muted', { text: '불러오는 중…' })
      : h('div.chat-hello', null, h('b', { text: t?.kind === 'todo' ? '이 할 일에 대해 말해 보세요' : '새 대화' }),
        h('span', { text: t?.kind === 'todo' ? '"내일로 미뤄", "끝났어", "둘로 나눠"처럼 말하면 바로 바꿔요.' : `무엇이든 물어보세요. 예: ${hasCoder() ? '"오늘 커밋 보여줘", "P1 할 일 뭐 있어?"' : '"오늘 일정 알려줘", "급한 할 일 뭐 있어?"'} 다른 대화의 내용은 이어지지 않아요.` })));
  }
  if (selectedId && isRunning(chat, selectedId)) items.push(h('div.typing', null, h('i'), h('i'), h('i'), h('span', { text: busyLabel(chat, selectedId) })));
  for (const p of queued) items.push(queuedRow(p, target?.kind === 'queued' && target.chatId === p.chatId));
  chatLog.replaceChildren(...items);
  renderChatLock();
  renderSendButton();
  if (opts.keepScroll) chatLog.scrollTop = prevTop + (chatLog.scrollHeight - prevHeight);
  else if (stick) scrollChat(true);
}

// 뇌(AI)가 없으면 입력창 대신 연결 안내 카드 + 정해진 말 버튼(로컬로 되는 것은 그대로)
function renderChatLock() {
  const compose = $('chat-compose');
  let box = $('chat-canned');
  if (!box) {
    box = document.createElement('div');
    box.id = 'chat-canned';
    compose.before(box);
  }
  const locked = brain.ready === false;
  compose.hidden = locked;
  box.hidden = !locked;
  if (!locked) return;
  const card = connectCard(brain);
  box.replaceChildren(
    h('div.card.connect-card', null,
      h('h3', { text: card.title }),
      h('ul', null, card.lines.map((l) => md(h('li'), l))),
      h('button.primary', { type: 'button', text: card.button, onclick: () => { openSetup('brain'); detectAgents(); } })),
    h('div.canned-row', null, CANNED.map((c) => h('button.ghost', { type: 'button', text: c.label, onclick: () => sayCanned(c) }))),
  );
}

// main 이 알려 주는 뇌 연결 상태(GET /status · SSE status)
function applyBrain(v) {
  if (!v || typeof v !== 'object') return;
  const was = brain.ready;
  brain = v;
  if (was !== brain.ready) {
    renderChatLock();
    if (section === 'chat') renderChat();
  }
  if (section === 'setup') renderSetupView(false);
}
cy.brain?.().then(applyBrain).catch(() => {});
cy.onBrain?.(applyBrain);

function sayCanned(c) {
  const openItems = rawTodos();
  const text = cannedReply(c.id, { open: openItems.length, done: vm.recentDone.length, next: openItems[0]?.title || '', hour: new Date().getHours() }, { override: sisa.canned });
  const at = new Date().toISOString();
  messages = appendLocal(appendLocal(messages, { role: 'user', text: c.label, at }), { role: 'assistant', text, at });
  renderChat();
  scrollChat(true);
}

async function loadSisa() {
  try {
    const got = await cy.sisaGet();
    if (got && typeof got === 'object') {
      sisa = {
        provider: got.provider || '',
        hasKey: !!got.hasKey,
        persona: got.persona || '',
        canned: got.canned && typeof got.canned === 'object' ? got.canned : {},
        done: got.done || {},
        connected: Array.isArray(got.connected) ? got.connected : [],
        chatModels: got.chatModels && typeof got.chatModels === 'object' ? got.chatModels : {},
        codeModel: typeof got.codeModel === 'string' ? got.codeModel : 'default',
      };
    }
  } catch { /* 키 없으면 채팅을 막는다 */ }
  renderChatLock();
  if (section === 'chat') renderChat();
  if (section === 'models') modelsView.show();
}

// 대화 목록의 할 일 칩 제목(기록에 제목이 없을 때)
function todoTitleOf(id) {
  return rawTodos().find((t) => t.id === id)?.title ?? null;
}

// 보내기 ↔ 멈추기: 이 대화가 답하는 중이고 입력창이 비었으면 멈추기
function renderSendButton() {
  const b = sendButton(chat, selectedId, chatInput.value || (tray.has() ? attachSummary(tray.items()) : ''));
  const btn = $('chat-send');
  btn.textContent = b.text;
  btn.title = b.title;
  btn.dataset.mode = b.mode;
  btn.classList.toggle('primary', b.mode === 'send');
  btn.classList.toggle('stop', b.mode === 'stop');
}

// 답하던 것 멈추기(이 대화에서 돌고·기다리는 것 전부). 결과는 SSE chat stopped 로 온다 — 404 면 이미 끝난 것
async function stopChat() {
  const ids = stopTargets(chat, selectedId);
  if (!ids.length || !cy.chatStop) return;
  const btn = $('chat-send');
  btn.disabled = true;
  try { await Promise.all(ids.map((id) => cy.chatStop(id).catch(() => null))); } finally { btn.disabled = false; }
}

// 말 id(clientId): 낙관적 사본 ↔ 데몬 큐·서버 기록을 정확히 짝 맞춘다
const newClientId = () => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

// 데몬 큐(GET /chat/queue)로 대기 중·보냄을 되살린다 — 패널을 다시 열거나 다시 연결됐을 때(데몬이 기준)
async function loadQueue() {
  if (!cy.chatQueue) return;
  let r;
  try { r = await cy.chatQueue(); } catch { return; }
  if (r?.ok && r.data) dispatchChat({ type: 'queue', queue: r.data.queue, running: r.data.running });
}

function onSendClick() {
  if ($('chat-send').dataset.mode === 'stop') stopChat();
  else sendChat();
}

let sendingAtts = false; // 첨부가 다 올라가길 기다리는 중(그동안 또 보내지 않게)
async function sendChat() {
  if (brain.ready === false) return;
  const text = chatInput.value.trim();
  if ((!text && !tray.has()) || sendingAtts) return;
  const tid = selectedId;
  // 첨부: 올리는 중인 건 끝날 때까지 기다리고, 못 올린 게 있으면 보내지 않는다(✕ 로 빼고 다시)
  let atts = [];
  if (tray.has()) {
    sendingAtts = true;
    try {
      const st = await tray.ready();
      if (st.failed) { showAttError('못 올린 첨부가 있어요 — ✕ 로 빼고 다시 보내 주세요'); return; }
      atts = tray.take();
    } finally { sendingAtts = false; }
    if (selectedId !== tid) { tray.restore(atts); return; } // 기다리는 사이 다른 대화로 옮겼다
  }
  chatInput.value = '';
  drafts.set(tid, '');
  autosize();
  if (!atts.length && isDoubleSend(messages, text)) return; // 같은 말이 방금 나갔다(Enter 두 번) — 두 번 보내 두 번 답하지 않게
  const at = new Date().toISOString();
  const clientId = newClientId();
  messages = appendLocal(messages, { role: 'user', text, at, clientId, ...(atts.length ? { attachments: atts } : {}) });
  renderChat();
  scrollChat(true);
  let r;
  const model = $('chat-model').hidden ? null : $('chat-model').value || null;
  try { r = await cy.chatSend(text, { threadId: tid, clientId, ...(model ? { model } : {}), ...(atts.length ? { attachments: atts.map((a) => a.id) } : {}) }); } catch { r = { ok: false }; }
  if (r?.ok && r.chatId) {
    messages = tagLocal(messages, { text, at, clientId }, r.chatId); // 대기 중·지금 보내기·취소가 이 말을 찾게
    // queued: POST 응답이 SSE queued 보다 먼저 와도 대기 중으로(예전엔 이때 「보냄」처럼 보였다)
    dispatchChat({ type: 'accepted', chatId: r.chatId, threadId: r.threadId, clientId, text, ...(r.queued != null ? { queued: r.queued } : {}), ...(r.position ? { position: r.position } : {}) });
    if (tid === null && r.threadId && selectedId === null) {
      // 새 대화 → 방금 생긴 스레드로(이미 붙인 내 말은 그대로 두고 서버 기록으로 맞춘다)
      selectedId = r.threadId;
      store.set('thread', selectedId);
      drafts.delete(null);
      loadThreadsSoon();
      renderThreadList();
      renderThreadHead();
    }
  } else {
    if (selectedId !== tid) return;
    messages = messages.map((m) => (m.local && !m.error && m.clientId === clientId ? { ...m, error: true } : m));
    const gone = r?.status === 404;
    if (atts.length) tray.restore(atts); // 첨부는 칩으로 돌려놓는다(다시 보내기)
    const why = r?.status === 400 && typeof r.data?.error === 'string' ? `못 보냈어요: ${r.data.error}` : null; // 첨부 한도·못 찾음 등
    messages = appendLocal(messages, { role: 'assistant', text: gone ? '이 대화를 못 찾았어요. 다른 곳에서 지웠을 수 있어요.' : why ?? '시사에 연결되지 않아서 못 보냈어요.', at: new Date().toISOString(), error: true });
    if (gone) loadThreadsSoon();
    renderChat();
  }
  scrollChat(true);
}

function autosize() {
  // 채팅 탭이 숨어 있으면(display:none) scrollHeight 가 0 이라 재지 않는다 — 보일 때 다시 잰다
  if (!chatInput.offsetParent) { chatInput.style.height = ''; return; }
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight + 2, 260)}px`;
  chatInput.style.overflowY = chatInput.scrollHeight + 2 > 260 ? 'auto' : 'hidden';
}
chatInput.addEventListener('input', () => { autosize(); drafts.set(selectedId, chatInput.value); renderSendButton(); });
// 모델 고르기(작업 세션 창과 같은 목록). 고른 건 이 컴퓨터에 기억, 목록에 없어졌으면 대화 기본값
async function loadChatModels() {
  const sel = $('chat-model');
  const res = await cy.listModels?.().catch(() => null);
  const models = res?.ok ? cleanModels(res.data) : null;
  sel.hidden = !models;
  if (!models) return;
  let saved = null;
  try { saved = localStorage.getItem('chatModel'); } catch { /* 무시 */ }
  sel.replaceChildren(...models.choices.map((c) => h('option', { value: c.id, text: c.label })));
  sel.value = models.choices.some((c) => c.id === saved) ? saved : models.defaults.chat;
}
$('chat-model').addEventListener('change', () => { try { localStorage.setItem('chatModel', $('chat-model').value); } catch { /* 무시 */ } });
loadChatModels();
// `/` 로 시작하면 슬래시 명령 자동완성(열려 있는 동안 Enter 는 넣기 — 아래 보내기보다 먼저 가로챈다)
if (cy.listCommands) attachSlashMenu(chatInput, { listCommands: () => cy.listCommands() });
chatInput.addEventListener('keydown', (e) => {
  // 답하는 중 Esc = 멈추기(패널 닫기보다 먼저)
  if (e.key === 'Escape' && !e.isComposing && selectedId && stopTargets(chat, selectedId).length) {
    e.preventDefault();
    e.stopPropagation();
    stopChat();
    return;
  }
  // 한글 조합 중 Enter 는 보내지 않는다
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  sendChat();
});
$('chat-send').addEventListener('click', onSendClick);


// SSE chat: 진행 표시 + 선택한 대화에 답이 오면 그 대화를 다시(시스템 줄까지). 오류는 서버에 안 남으니 여기만
function onChatEvent(ev) {
  if (ev?.status === 'done' && Array.isArray(ev.actions)) for (const a of ev.actions) updateAction(normalizeActions([a])[0]);
  // 대기 중이던 말이 멈춤(취소) → 데몬은 기록하지 않으니 로컬 사본을 빼고, 입력창이 비었으면 그 말을 돌려놓는다
  if (ev?.status === 'stopped' && localState(chat, ev.chatId) === 'queued') {
    const r = dropLocal(messages, ev.chatId);
    messages = r.messages;
    if (r.dropped && ev.threadId === selectedId && !chatInput.value.trim()) {
      chatInput.value = r.dropped.text;
      drafts.set(selectedId, chatInput.value);
      autosize();
    }
    // 그 말의 첨부(데몬에 올려 둔 그대로)도 칩으로 돌려놓는다
    const back = r.dropped?.attachments ?? chat.pending[ev.chatId]?.attachments;
    if (back?.length && ev.threadId === selectedId) tray.restore(back);
  }
  // 줄 섰던 말이 모델에 감: 같은 풍선을 지금 답하는 자리(맨 아래)로 옮기고 보낸 때를 붙인다(새 풍선 없음)
  if (ev?.status === 'thinking' && ev.threadId === selectedId && ev.queuedAt) {
    const p = chat.pending[ev.chatId];
    messages = markSent(messages, { chatId: ev.chatId, clientId: ev.clientId ?? p?.clientId, text: p?.text, queuedAt: ev.queuedAt, sentAt: ev.sentAt });
  }
  // 말을 고쳤다(다른 창에서 고쳤어도): 그 말부터 뒤는 걷고 다시 불러온다. 줄 선 말이면 그 글만
  if (ev?.status === 'edited' && ev.threadId === selectedId) {
    if (Number.isInteger(ev.n)) { messages = dropFrom(messages, ev.n); loadMessages(); }
    else if (typeof ev.text === 'string') messages = messages.map((m) => (m.local && m.chatId === ev.chatId ? { ...m, text: ev.text } : m));
  }
  dispatchChat({ type: 'event', ev });
  const tid = typeof ev?.threadId === 'string' ? ev.threadId : null;
  if (!tid || !['done', 'error', 'stopped'].includes(ev.status)) return; // stopped: "답을 멈췄어요" 시스템 줄을 다시 불러온다
  if (tid === selectedId) {
    if (ev.status === 'error') { messages = appendLocal(messages, { role: 'assistant', text: ev.text || '답을 못 만들었어요.', at: new Date().toISOString(), error: true }); renderChat(); }
    // 새 답은 맨 아래 — 승인 카드를 보느라 위에 있어도 답으로 내려간다
    Promise.resolve(loadMessages()).finally(() => scrollChat(true));
    loadAgentsSoon();
  }
  loadThreadsSoon();
}

// ↻ 새로고침: 이 대화의 run 들이 터미널 Claude Code 에서 이어 간 말을 불러온다(새 말은 SSE threads 로도 온다)
async function syncThread() {
  const id = selectedId, btn = $('th-sync');
  if (!id || btn.disabled || !cy.chatThreadSync) return;
  btn.disabled = true;
  btn.classList.add('spin');
  try {
    const r = await cy.chatThreadSync(id);
    btn.title = r?.ok
      ? (r.data?.imported ? `터미널에서 이어 간 기록 ${r.data.imported}줄을 불러왔어요` : '새로 불러올 터미널 기록이 없어요')
      : (r?.data?.error || '터미널 기록을 못 불러왔어요');
    if (r?.ok && id === selectedId) { await loadMessages(); loadAgents(); }
  } finally { btn.disabled = false; btn.classList.remove('spin'); }
}
$('th-sync').addEventListener('click', syncThread);

// SSE threads: 하나 바뀜(thread) · 지워짐(deleted)
function onThreadsEvent(p) {
  if (p?.deleted && typeof p.deleted === 'string') {
    const order = visibleOrder();
    threads = threads.filter((t) => t.id !== p.deleted);
    archived = archived?.filter((t) => t.id !== p.deleted) ?? null;
    if (selectedId === p.deleted) selectThread(afterRemoval(order, p.deleted), { noFocus: true });
  } else if (p?.thread) {
    const t = normThread(p.thread);
    if (!t) return;
    if (t.archived) { threads = threads.filter((x) => x.id !== t.id); if (archived) archived = upsertThread(archived, t); }
    else { threads = upsertThread(threads, t); if (archived) archived = archived.filter((x) => x.id !== t.id); }
  }
  afterThreadsChanged();
}

// ---- 이벤트 ----
cy.onChat(onChatEvent);
cy.onThreads?.(onThreadsEvent);
cy.onAgents?.((p) => { if (p?.threadId && p.threadId === selectedId) loadAgentsSoon(); });
cy.onAction?.(onActionEvent);
cy.onDashboard(loadSoon);
// id(선택): 오버레이 말풍선(새 할 일)에서 연 그 할 일을 펼친다
cy.onSection(({ section: s, id } = {}) => {
  if (s === 'chat' && typeof id === 'string' && id) { openThread(id); return; } // 말풍선(호버 답) → 그 대화
  if (s === 'setup' && isSetupPhase(id)) { openSetup(id); if (id === 'brain') detectAgents(); return; } // 연결 안내 말풍선 → 마법사의 그 단계
  if (normalizeSection(s)) goto(s);
  if (s === 'todos' && typeof id === 'string' && id && openId !== id) toggleDetail(id);
});
// ---- 세션 창 "원래 화면 열기" — 그 대화(채팅 탭) · 할 일 팝오버(지난 문답째) · 제안(개요) ----
let originSeq = 0;
function flashFor(id, ms = 2400) {
  flash = { id, until: Date.now() + ms };
  setTimeout(() => { if (flash?.id === id && Date.now() >= flash.until) { flash = null; renderTodos(); renderOverview(); } }, ms + 50);
}
async function openOriginThread(threadId, note) {
  await openThread(threadId);
  if (note) setBanner(note);
  chatInput.focus();
}
async function openOrigin(origin) {
  const plan = originPlan(origin);
  if (!plan) return;
  const seq = ++originSeq;
  if (plan.action === 'thread') return openOriginThread(plan.threadId);
  if (plan.action === 'proposal') {
    goto('overview');
    flashFor(`proposal:${plan.proposalId}`);
    renderOverview();
    const el = $('sec-overview').querySelector(`.proposal[data-id="${CSS.escape(plan.proposalId)}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
    else setBanner('그 제안은 지금 개요 목록에 없어요(오래됐거나 처리됐을 수 있어요).');
    return;
  }
  // 할 일: 지난 문답을 받아 팝오버째로. 없어졌거나 끝났으면 그 할 일의 대화로
  let r;
  try { r = await cy.todoLastAsk(plan.todoId); } catch { r = { ok: false }; }
  if (seq !== originSeq) return;
  const p = todoPlan(origin, r);
  if (!p) return;
  if (p.action === 'thread') return openOriginThread(p.threadId, p.note);
  goto('todos');
  if (p.action === 'todos') { setBanner(p.note); return; }
  if (!findTodo(p.todo.id)) { await load(); if (seq !== originSeq) return; } // 목록이 아직 옛것이면 한 번 새로
  const t = findTodo(p.todo.id);
  if (t?.priority === BACKLOG && !backlogOpen) { backlogOpen = true; writeBacklogOpen(globalThis.localStorage, true); }
  flashFor(p.todo.id);
  renderTodos();
  const row = todosSec.querySelector(`.todo.row[data-id="${CSS.escape(p.todo.id)}"]`);
  if (!t || !row) {
    if (p.threadId) return openOriginThread(p.threadId, '목록에서 그 할 일을 못 찾아서 대화를 열었어요.');
    setBanner('목록에서 그 할 일을 못 찾았어요.');
    return;
  }
  row.scrollIntoView({ block: 'center' });
  closeAsk();
  askPointX = null;
  askActions = normalizeActions(p.actions);
  dispatchAsk({ type: 'restore', todo: t, exchange: p.exchange, threadId: p.threadId });
  askInput.focus();
}
cy.onOpenOrigin?.(openOrigin);

cy.onConnection(({ connected: c }) => {
  const was = connected;
  connected = !!c;
  const el = $('conn');
  el.textContent = connected ? '시사 켜짐' : '시사 꺼짐';
  el.title = connected ? '시사 켜짐' : '시사 꺼짐';
  el.classList.toggle('off', !connected);
  if (connected && !was) { load(); loadThreads(); loadPermissions(); loadChatModels(); loadAgents(); loadQueue(); }
  if (!connected) { chat = { ...chat, pending: {} }; renderChat(); renderThreadList(); renderBadges(); }
});

// ↻ 새로고침: 화면 다시 그리기 + 데몬이 슬랙·메일을 지금 다시 읽어 새 할 일을 넣는다(결과는 캐릭터 말풍선)
$('refresh').addEventListener('click', () => { cy.refreshSources?.(); load(); loadThreads(); if (selectedId) { loadMessages(); loadAgents(); } });
$('open-session')?.addEventListener('click', () => cy.openSession?.());
// 이 컴퓨터에 Claude Code 가 없으면(Gemini·GPT 키·로컬) 코드 관련 버튼(작업 세션)은 숨긴다
function applyCaps(c) {
  if (c && typeof c === 'object' && 'claude' in c) caps = { claude: c.claude, codex: c.codex };
  for (const id of ['open-session']) { const b = $(id); if (b) b.hidden = !hasCoder(); }
  if (section === 'chat') renderChat();
}
cy.caps?.().then(applyCaps).catch(() => {});
cy.onCaps?.(applyCaps);
$('close').addEventListener('click', () => cy.close());
document.addEventListener('keydown', (e) => {
  if (drag && e.key === 'Escape') { e.preventDefault(); finishDrag(false); return; } // 끌기 취소
  if (ask && (e.key === 'Escape' || e.key === 'Enter')) {
    const k = askKey(e);
    if (k === 'discard') { e.preventDefault(); discardAsk(); return; }
    if (k === 'apply') { e.preventDefault(); applyAsk(); return; }
    if (k === 'chat') { e.preventDefault(); continueAskInChat(); return; }
    if (e.key === 'Escape') return; // 한글 조합 중 Esc
  }
  if (e.key === 'Escape' && !e.isComposing) {
    if (section === 'chat' && rowMode) { rowMode = null; renderThreadList(); return; }
    if (section === 'chat' && listOpen) { setListOpen(false); return; }
    cy.close();
  } else if (e.metaKey && e.key === 'w') {
    e.preventDefault();
    cy.close();
  } else if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    newChat();
  } else if (e.metaKey && section === 'chat' && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing) {
    e.preventDefault();
    const next = neighborThread(visibleOrder(), selectedId, e.key === 'ArrowDown' ? 1 : -1);
    if (next !== selectedId) selectThread(next);
  } else if (e.metaKey && /^[1-5]$/.test(e.key)) {
    e.preventDefault();
    const shown = visibleSections(vm); // 숨긴 탭은 건너뛰고 보이는 순서대로
    if (shown[Number(e.key) - 1]) goto(shown[Number(e.key) - 1]);
  }
});

// 상대 시각은 1분마다 다시 그림 (오늘 할 일 입력·채팅 입력은 건드리지 않음)
setInterval(() => { if (raw) renderAll(); }, 60_000);

function applySisa(v) {
  sisa = {
    ...sisa,
    provider: v.provider ?? sisa.provider,
    hasKey: !!v.hasKey,
    persona: typeof v.persona === 'string' ? v.persona : sisa.persona,
    canned: v.canned && typeof v.canned === 'object' ? v.canned : sisa.canned,
    connected: Array.isArray(v.connected) ? v.connected : sisa.connected,
    chatModels: v.chatModels && typeof v.chatModels === 'object' ? v.chatModels : sisa.chatModels,
    codeModel: typeof v.codeModel === 'string' ? v.codeModel : sisa.codeModel,
  };
  renderChatLock();
}
const modelsView = mountModels({ section: $('sec-models'), h, cy, getSisa: () => sisa, onSisa: applySisa, gotoSetup: () => openSetup() });

goto(section);
renderAll();
renderChat();
loadSisa();
renderThreadList();
renderThreadHead();
load();
loadPermissions();
loadThreads();
loadQueue();
