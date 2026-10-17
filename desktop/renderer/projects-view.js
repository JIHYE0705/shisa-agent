// 프로젝트 탭 위쪽: 직접 만든 프로젝트 카드와 ＋ 만들기 창(새로 만들기 · 일정에서 가져오기).
// 카드: 기한·할 일 수·메모·묶인 열린 할 일(체크로 끝내기, ✕로 빼기)·할 일 추가·기존 할 일 넣기, [고치기][끝내기][지우기(확인 한 번)].
// 데이터는 GET /dashboard 의 manualProjects(src/manual-projects.js 가 다듬은 vm.manualProjects)이고, 바꾼 뒤엔 onChanged 로 다시 읽는다.
import { who } from './who.js';
import { todoCountText, emptyDraft, draftFromPick, draftOf, createBody, editBody, eventWhen, shapePick } from '../src/manual-projects.js';

export function createProjectsView({ h, cy, fill, onChanged, openSettings }) {
  let vm = null;
  let msg = null; // { ok, text } — 카드 위 한 줄
  const busy = new Set(); // 응답 기다리는 프로젝트 id
  let confirmDel = null; // 지우기 확인 중인 프로젝트 id
  const addDrafts = new Map(); // 프로젝트 id → 할 일 추가 칸 글
  let modal = null; // { step: 'choose'|'events'|'form', mode: 'new'|'edit', id?, draft, error, saving, pick? }
  let root = null; // 만들기 창 겉(body 끝에 붙인다)
  let redrawCards = () => {};

  const why = (r) => (typeof r?.data?.error === 'string' ? r.data.error : r?.status ? `HTTP ${r.status}` : `${who()} 연결 확인`);
  let msgTimer = null;
  const say = (ok, text) => {
    msg = { ok, text };
    clearTimeout(msgTimer);
    if (ok) { msgTimer = setTimeout(() => { msg = null; redrawCards(); }, 4000); msgTimer?.unref?.(); } // 잘 된 알림은 잠깐만
    redrawCards();
  };

  async function act(id, call, failText, okText) {
    if (id) busy.add(id);
    msg = null;
    redrawCards();
    let r;
    try { r = await call(); } catch { r = { ok: false }; }
    if (id) busy.delete(id);
    if (r?.ok) { if (okText) say(true, okText); onChanged(); }
    else msg = { ok: false, text: `${failText} — ${why(r)}` };
    redrawCards();
    return r;
  }

  // ---- 카드 ----
  function section(v, rerender) {
    vm = v;
    redrawCards = rerender;
    const list = vm.manualProjects ?? [];
    const kids = [
      h('div.mp-head', null,
        h('h2.mp-title', { text: '내가 만든 프로젝트' }),
        h('span.spacer'),
        h('button.primary.mp-new', { type: 'button', title: '프로젝트 만들기 — 빈 칸에서 시작하거나 일정에서 가져와요', 'aria-label': '프로젝트 만들기', onclick: openCreate }, '＋ 새 프로젝트')),
    ];
    if (msg) kids.push(h(`div.result.${msg.ok ? 'ok' : 'err'}`, { role: 'status', text: msg.text }));
    if (!list.length) {
      kids.push(h('div.card.empty.mp-empty', null,
        h('div', { text: '아직 만든 프로젝트가 없어요.' }),
        h('div.muted.small', { text: '＋를 눌러 직접 적거나, 캘린더 일정에서 가져와 시작해 보세요.' }),
        h('button.mp-empty-btn', { type: 'button', onclick: openCreate }, '＋ 새 프로젝트')));
    } else {
      const open = list.filter((p) => !p.done), done = list.filter((p) => p.done);
      if (open.length) kids.push(h('div.projects.mp-list', null, open.map(card)));
      if (done.length) kids.push(h('h3.mp-sub', { text: `끝난 프로젝트 (${done.length})` }), h('div.projects.mp-list.done', null, done.map(card)));
    }
    return kids;
  }

  function card(p) {
    const wait = busy.has(p.id);
    const confirming = confirmDel === p.id;
    const others = (vm.todoGroups ?? []).flatMap((g) => g.items).filter((t) => t.projectId !== p.id && !t.pending);
    const draft = addDrafts.get(p.id) ?? '';
    const addTodo = (input) => {
      const title = input.value.replace(/\s+/g, ' ').trim();
      if (!title) return;
      addDrafts.delete(p.id);
      act(p.id, () => cy.todoAdd({ title, priority: 2, projectId: p.id }), '할 일 추가 실패');
    };
    const input = h('input.mp-add-input', {
      type: 'text', placeholder: '이 프로젝트에 할 일 추가', 'aria-label': `할 일 추가: ${p.name}`, value: draft, disabled: wait,
      oninput: (e) => addDrafts.set(p.id, e.target.value),
      onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTodo(e.target); } },
    });
    return h(`article.card.proj.mp${p.done ? '.is-done' : ''}${wait ? '.busy' : ''}`, { dataset: { id: p.id } },
      h('div.head', null,
        h('span.name', { text: p.name, title: p.name }),
        p.fromCalendar ? h('span.chip.mp-cal', { text: `📅 일정에서${p.fromCalendar.calendar ? ` · ${p.fromCalendar.calendar}` : ''}`, title: p.fromCalendar.title ? `가져온 일정: ${p.fromCalendar.title}` : '일정에서 가져왔어요' }) : null,
        p.done ? h('span.chip.ok', { text: '끝남' }) : null),
      h('div.meta', null,
        p.dueText ? h(`span.mp-due${p.dueTone ? `.${p.dueTone}` : ''}`, { text: p.dueText }) : null,
        p.startText ? h('span', { text: `시작 ${p.startText}` }) : null,
        h('span', { text: todoCountText(p) })),
      p.note ? h('div.mp-note', { text: p.note }) : null,
      p.linked.length
        ? h('ul.mp-todos', { 'aria-label': `${p.name}의 할 일` }, p.linked.map((t) => h('li', null,
          h('button.ghost.mp-check', { type: 'button', title: '끝냈어요', 'aria-label': `끝내기: ${t.title}`, disabled: wait, onclick: () => act(p.id, () => cy.todoDone(t.id), '끝내기 실패') }, '○'),
          h('span.t', { text: t.title, title: t.title }),
          h('button.ghost.mp-unlink', { type: 'button', title: '이 프로젝트에서 빼기(할 일은 남아요)', 'aria-label': `프로젝트에서 빼기: ${t.title}`, disabled: wait, onclick: () => act(p.id, () => cy.todoEdit(t.id, { projectId: null }), '빼기 실패') }, '✕'))))
        : null,
      p.done ? null : h('div.mp-add', null,
        input,
        h('button', { type: 'button', disabled: wait, onclick: () => addTodo(input) }, '추가'),
        others.length
          ? h('select.mp-pick', {
            'aria-label': `기존 할 일 넣기: ${p.name}`, disabled: wait,
            onchange: (e) => { const id = e.target.value; if (id) act(p.id, () => cy.todoEdit(id, { projectId: p.id }), '넣기 실패'); },
          }, h('option', { value: '', text: '기존 할 일 넣기…' }), others.map((t) => {
            const at = t.projectId ? (vm.manualProjects ?? []).find((x) => x.id === t.projectId) : null; // 다른 프로젝트에 있으면 옮긴다
            return h('option', { value: t.id, text: at ? `${t.title} (${at.name}에서 옮기기)` : t.title });
          }))
          : null),
      confirming
        ? h('div.mp-actions.confirm', { role: 'alert' },
          h('span', { text: p.todos ? `지울까요? 묶인 할 일 ${p.todos}개는 남아요.` : '이 프로젝트를 지울까요?' }),
          h('span.spacer'),
          h('button.danger', { type: 'button', disabled: wait, onclick: () => { confirmDel = null; act(p.id, () => cy.projectDelete(p.id), '지우기 실패', `「${p.name}」 프로젝트를 지웠어요`); } }, '지우기'),
          h('button.ghost', { type: 'button', onclick: () => { confirmDel = null; redrawCards(); } }, '취소'))
        : h('div.mp-actions', null,
          h('button.ghost', { type: 'button', disabled: wait, onclick: () => openEdit(p) }, '고치기'),
          h('button.ghost', { type: 'button', disabled: wait, onclick: () => act(p.id, () => cy.projectEdit(p.id, { status: p.done ? 'open' : 'done' }), p.done ? '다시 열기 실패' : '끝내기 실패') }, p.done ? '다시 진행' : '끝내기'),
          h('span.spacer'),
          h('button.ghost.mp-del', { type: 'button', disabled: wait, onclick: () => { confirmDel = p.id; redrawCards(); } }, '지우기')));
  }

  // ---- 만들기·고치기 창 ----
  function openCreate() { modal = { step: 'choose', mode: 'new', draft: emptyDraft(), error: '' }; drawModal(); }
  function openEdit(p) { modal = { step: 'form', mode: 'edit', id: p.id, cur: p, draft: draftOf(p), error: '' }; drawModal(); }
  function close() { modal = null; drawModal(); }

  async function loadEvents() {
    modal = { ...modal, step: 'events', pick: { state: 'loading' } };
    drawModal();
    let r;
    try { r = await cy.projectCalendarEvents(); } catch { r = { ok: false }; }
    if (!modal || modal.step !== 'events') return;
    modal = { ...modal, pick: shapePick(r) };
    drawModal();
  }

  async function save() {
    if (!modal || modal.saving) return;
    const isNew = modal.mode === 'new';
    const b = isNew ? createBody(modal.draft) : editBody(modal.cur, modal.draft);
    if (b.error) { modal = { ...modal, error: b.error }; drawModal(); return; }
    if (!isNew && !b.patch) { close(); return; }
    modal = { ...modal, saving: true, error: '' };
    drawModal();
    let r;
    try { r = await (isNew ? cy.projectCreate(b) : cy.projectEdit(modal.id, b.patch)); } catch { r = { ok: false }; }
    if (!modal) return;
    if (r?.ok) {
      const name = isNew ? b.name : (b.patch.name ?? modal.cur.name);
      close();
      say(true, isNew ? `「${name}」 프로젝트를 만들었어요` : `「${name}」 프로젝트를 고쳤어요`);
      onChanged();
    } else {
      modal = { ...modal, saving: false, error: `저장하지 못했어요 — ${why(r)}` };
      drawModal();
    }
  }

  const field = (label, el) => h('label.mp-field', null, h('span.l', { text: label }), el);
  function form() {
    const d = modal.draft;
    const set = (k) => (e) => { modal.draft = { ...modal.draft, [k]: e.target.value }; };
    const name = h('input.mp-in', { type: 'text', value: d.name, placeholder: '예: 가을 행사 준비', 'aria-label': '이름', oninput: set('name'), onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } } });
    const note = h('textarea.mp-in', { rows: '5', placeholder: '무엇을 하는 프로젝트인지, 참고할 것', 'aria-label': '메모', oninput: set('note') });
    note.value = d.note;
    queueMicrotask(() => name.focus());
    return [
      h('div.mp-m-head', null,
        modal.mode === 'new' ? h('button.ghost.mp-back', { type: 'button', 'aria-label': '뒤로', onclick: () => { modal = d.source ? { ...modal, step: 'events' } : { ...modal, step: 'choose' }; drawModal(); if (d.source && !modal.pick) loadEvents(); } }, '‹') : null,
        h('h3', { id: 'mp-m-title', text: modal.mode === 'new' ? (d.source ? '일정으로 프로젝트 만들기' : '새 프로젝트') : '프로젝트 고치기' })),
      d.source ? h('div.mp-from', null, h('span.chip.mp-cal', { text: `📅 일정에서${d.source.calendar ? ` · ${d.source.calendar}` : ''}` }), h('span.muted.small', { text: d.source.title || '' })) : null,
      field('이름', name),
      field('메모', note),
      h('div.mp-dates', null,
        field('시작', h('input.mp-in', { type: 'date', value: d.start, 'aria-label': '시작', oninput: set('start') })),
        field('기한', h('input.mp-in', { type: 'date', value: d.due, 'aria-label': '기한', oninput: set('due') }))),
      modal.error ? h('div.result.err', { role: 'alert', text: modal.error }) : null,
      h('div.mp-m-foot', null,
        h('span.spacer'),
        h('button.ghost', { type: 'button', onclick: close }, '취소'),
        h('button.primary', { type: 'button', disabled: modal.saving, onclick: save }, modal.saving ? '저장 중…' : '저장')),
    ];
  }

  function choose() {
    return [
      h('div.mp-m-head', null, h('h3', { id: 'mp-m-title', text: '프로젝트 만들기' })),
      h('div.mp-choose', null,
        h('button.mp-way', { type: 'button', onclick: () => { modal = { ...modal, step: 'form', draft: emptyDraft() }; drawModal(); } },
          h('span.i', { text: '✏️' }), h('span.t', { text: '새로 만들기' }), h('span.d', { text: '빈 칸에서 시작해요' })),
        h('button.mp-way', { type: 'button', onclick: loadEvents },
          h('span.i', { text: '📅' }), h('span.t', { text: '일정에서 가져오기' }), h('span.d', { text: '다가오는 일정을 골라 채워요' }))),
      h('div.mp-m-foot', null, h('span.spacer'), h('button.ghost', { type: 'button', onclick: close }, '취소')),
    ];
  }

  function events() {
    const p = modal.pick ?? { state: 'loading' };
    const pickRow = (ev) => h('button.mp-ev', {
      type: 'button',
      onclick: () => { modal = { ...modal, step: 'form', draft: draftFromPick(ev) }; drawModal(); },
    },
    h('span.when', { text: eventWhen(ev) }),
    h('span.t', { text: ev.title, title: ev.title }),
    h('span.sub', { text: [ev.calendar, ev.location].filter(Boolean).join(' · ') }));
    let body;
    if (p.state === 'loading') body = h('div.mp-ev-note', { role: 'status', text: '일정을 불러오고 있어요…' });
    else if (p.state === 'off') {
      body = h('div.mp-ev-note', null,
        h('div', { text: '설정에서 캘린더를 연결하면 일정에서 가져올 수 있어요.' }),
        h('button', { type: 'button', onclick: () => { close(); openSettings(); } }, '설정 열기'));
    } else if (p.state === 'error') {
      body = h('div.mp-ev-note', null, h('div', { text: '일정을 불러오지 못했어요.' }), h('button', { type: 'button', onclick: loadEvents }, '다시 해 보기'));
    } else if (p.state === 'empty') body = h('div.mp-ev-note', { text: '앞으로 2주 안의 일정이 없어요.' });
    else {
      body = h('div.mp-ev-list', null,
        p.partial ? h('div.muted.small', { text: '캘린더 하나를 못 읽었어요. 읽은 것만 보여 줘요.' }) : null,
        ...(p.upcoming.length ? [h('div.mp-ev-sec', { text: '다가오는 일정' }), ...p.upcoming.map(pickRow)] : []),
        ...(p.past.length ? [h('div.mp-ev-sec', { text: '지난 며칠' }), ...p.past.map(pickRow)] : []));
    }
    return [
      h('div.mp-m-head', null,
        h('button.ghost.mp-back', { type: 'button', 'aria-label': '뒤로', onclick: () => { modal = { ...modal, step: 'choose' }; drawModal(); } }, '‹'),
        h('h3', { id: 'mp-m-title', text: '일정 고르기' })),
      body,
      h('div.mp-m-foot', null, h('span.spacer'), h('button.ghost', { type: 'button', onclick: close }, '취소')),
    ];
  }

  function onKey(e) {
    if (!modal || e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation(); // 패널 닫기(Esc)보다 먼저 창만 닫는다
    close();
  }
  function drawModal() {
    if (!modal) {
      if (root) { root.remove(); root = null; document.removeEventListener('keydown', onKey, true); }
      return;
    }
    if (!root) {
      root = h('div.mp-scrim', { onmousedown: (e) => { if (e.target === root) close(); } });
      document.body.append(root);
      document.addEventListener('keydown', onKey, true);
    }
    const kids = modal.step === 'choose' ? choose() : modal.step === 'events' ? events() : form();
    fill(root, h(`div.mp-modal.step-${modal.step}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mp-m-title' }, kids));
  }

  return { section, openCreate, isOpen: () => !!modal };
}
