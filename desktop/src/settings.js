// 설정 창의 순수 로직 — 모델·브리핑 출처·문구·자동 머지 레포 저장 본문 검증, 문구 묶기·검사, 연결 상태 줄 묶기·표시 글.
// 데몬 GET/PUT /settings, GET /connections, POST /connections/check (docs/contract.md "설정 창").

export const CHECK_IDS = ['net', 'claude', 'services', 'gh', 'local'];
export const okCheckId = (id) => typeof id === 'string' && CHECK_IDS.includes(id);
export const MODEL_ROLES = ['quick', 'general', 'code', 'light'];
const okModel = (id) => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id);
const okSource = (s) => typeof s === 'string' && /^[a-z0-9-]{1,32}$/.test(s);
const okPhraseKey = (k) => typeof k === 'string' && /^[a-z0-9_]{1,40}$/.test(k);
// 자동 머지 레포 owner/name(데몬 agent/src/auto-merge.ts normSlug 와 같은 모양 — 링크는 데몬이 다듬지만 창은 owner/name 만 보낸다)
export const okRepoSlug = (s) => typeof s === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(s) && !s.includes('..') && !s.startsWith('.');
export const AUTO_MERGE_MAX = 50;
// 입력창 글 → owner/name(github 링크도 받는다). 모르면 ''
export function repoSlugFrom(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i);
  const s = m ? `${m[1]}/${m[2]}` : t.replace(/\.git$/, '');
  return okRepoSlug(s) ? s : '';
}
// 목록에 넣기·빼기(대소문자 무시) → 새 목록
export function autoMergeNext(list, slug, add) {
  const cur = Array.isArray(list) ? list.filter(okRepoSlug) : [];
  const has = cur.some((x) => x.toLowerCase() === slug.toLowerCase());
  if (add) return has ? cur : [...cur, slug];
  return cur.filter((x) => x.toLowerCase() !== slug.toLowerCase());
}
export const PHRASE_MAX_LINES = 10; // 데몬(agent/src/phrases.ts)과 같은 제한

// 렌더러가 보낸 저장 본문 → 데몬에 넘길 모양(모르는 키·이상한 값이면 null). 진짜 검증(목록 안의 모델인가)은 데몬이
export function sanitizeSettingsPatch(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  for (const k of Object.keys(p)) if (k !== 'models' && k !== 'briefing' && k !== 'phrases' && k !== 'autoMerge') return null;
  if (p.models !== undefined) {
    if (!p.models || typeof p.models !== 'object' || Array.isArray(p.models)) return null;
    const m = {};
    for (const [k, v] of Object.entries(p.models)) {
      if (!MODEL_ROLES.includes(k) || !okModel(v)) return null;
      m[k] = v;
    }
    if (!Object.keys(m).length) return null;
    out.models = m;
  }
  if (p.briefing !== undefined) {
    const ex = p.briefing?.exclude;
    if (!p.briefing || typeof p.briefing !== 'object' || Object.keys(p.briefing).some((k) => k !== 'exclude') || !Array.isArray(ex) || ex.length > 20 || !ex.every(okSource)) return null;
    out.briefing = { exclude: [...new Set(ex)] };
  }
  // 문구: 키 → 글(여러 줄) | null(기본값으로). 자리표시 검사는 데몬이
  if (p.phrases !== undefined) {
    if (!p.phrases || typeof p.phrases !== 'object' || Array.isArray(p.phrases)) return null;
    const ph = {};
    for (const [k, v] of Object.entries(p.phrases)) {
      if (!okPhraseKey(k) || !(v === null || typeof v === 'string')) return null;
      ph[k] = v;
    }
    if (!Object.keys(ph).length || Object.keys(ph).length > 100) return null;
    out.phrases = ph;
  }
  // 자동 머지 레포: 목록 통째로(빈 목록 = 전부 뺌)
  if (p.autoMerge !== undefined) {
    if (!Array.isArray(p.autoMerge) || p.autoMerge.length > AUTO_MERGE_MAX || !p.autoMerge.every(okRepoSlug)) return null;
    out.autoMerge = [...new Set(p.autoMerge)];
  }
  return Object.keys(out).length ? out : null;
}

// ---- 문구(GET /settings phrases: [{ key, group, label, vars, default: [줄], value: [줄] | null }]) ----
// 묶음 순서는 데몬이 준 순서대로
export function phraseGroups(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !okPhraseKey(p.key)) continue;
    let g = out.find((x) => x.group === p.group);
    if (!g) out.push((g = { group: p.group ?? '', items: [] }));
    g.items.push(p);
  }
  return out;
}
const lines = (t) => String(t ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
export const phraseDefaultText = (p) => (Array.isArray(p?.default) ? p.default.join('\n') : '');
// 입력창에 보일 글: 고친 게 있으면 그것, 없으면 기본값
export const phraseText = (p) => (Array.isArray(p?.value) && p.value.length ? p.value.join('\n') : phraseDefaultText(p));
export const phraseCustom = (p) => Array.isArray(p?.value) && p.value.length > 0;
// 저장할 값: 비었거나 기본값과 같으면 null(기본값으로), 아니면 다듬은 글
export function phraseSaveValue(p, text) {
  const l = lines(text);
  return !l.length || l.join('\n') === phraseDefaultText(p) ? null : l.join('\n');
}
// 저장 전 검사(데몬도 다시 본다): 줄 수·모르는 자리표시 → 이유, 괜찮으면 ''
export function phraseProblem(p, text) {
  const l = lines(text);
  if (l.length > PHRASE_MAX_LINES) return `${PHRASE_MAX_LINES}줄까지예요`;
  const vars = Array.isArray(p?.vars) ? p.vars : [];
  const bad = [...new Set(l.flatMap((x) => [...x.matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1])))].filter((v) => !vars.includes(v));
  if (bad.length) return `모르는 자리표시 ${bad.map((v) => `{${v}}`).join(' ')}${vars.length ? ` — 쓸 수 있는 것: ${vars.map((v) => `{${v}}`).join(' ')}` : ' — 이 문구는 자리표시를 못 써요'}`;
  return '';
}

// 연결 줄에서 패널로 보낼 수 있는 탭(설치 안내 · AI 고르기)
export const PANEL_TARGETS = ['setup', 'models'];
export const okPanelTarget = (s) => typeof s === 'string' && PANEL_TARGETS.includes(s);
// 줄에 [설치 안내]를 붙일까: 써야 하는데 안 되는 것만(안 씀·정상·모름은 아님)
export const needsSetupHint = (row) => row?.state === 'error' || row?.state === 'warn';

export const DOT = { ok: 'ok', warn: 'warn', error: 'err', off: 'off', unknown: 'unknown' };
export const dotClass = (state) => DOT[state] ?? 'unknown';
export const STATE_LABEL = { ok: '정상', warn: '확인 필요', error: '문제 있음', off: '안 씀', unknown: '모름' };

export function agoText(iso, now = new Date()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 10) return '방금';
  if (s < 60) return `${s}초 전`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

export function latencyText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
}

// 줄 묶기: 핵심(AI·네트워크) · 연결한 서비스(쓰는 것 / 그 밖) · 로컬
export function groupRows(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
  const services = list.filter((r) => r.group === 'service');
  return {
    core: list.filter((r) => r.group === 'core'),
    used: services.filter((r) => r.used !== false),
    other: services.filter((r) => r.used === false),
    local: list.filter((r) => r.group === 'local'),
  };
}

// 아직 확인 안 한(pending) 비싼 확인 — 창이 열리면 이것만 부른다
export function pendingChecks(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) if (r?.pending && okCheckId(r.check) && !out.includes(r.check)) out.push(r.check);
  return out;
}

// 확인 하나가 돌아온 뒤: 데몬이 준 새 목록(모든 확인의 최신 상태)을 쓰되, 아직 도는 확인의 줄이
// 새 목록에서 pending(한 번도 안 끝남)이면 화면에 있던 줄을 그대로 둔다
export function mergeRows(prev, next, busy = new Set()) {
  const old = new Map((Array.isArray(prev) ? prev : []).map((r) => [r.id, r]));
  return (Array.isArray(next) ? next : []).map((r) => (r.pending && busy.has(r.check) && old.has(r.id) && !old.get(r.id).pending ? old.get(r.id) : r));
}

// 브리핑 토글 → 새 exclude 목록
export function toggleExclude(exclude, source, included) {
  const set = new Set(Array.isArray(exclude) ? exclude : []);
  if (included) set.delete(source);
  else set.add(source);
  return [...set];
}

// 줄에 붙일 꼬리 글: "응답 120ms · 3분 전 확인"
export function metaText(row, now = new Date()) {
  return [latencyText(row?.latencyMs), row?.checkedAt ? `${agoText(row.checkedAt, now)} 확인` : ''].filter(Boolean).join(' · ');
}
