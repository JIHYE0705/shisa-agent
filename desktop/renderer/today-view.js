// 로컬 개인 "오늘 할 일" 표. 서버에 올리지 않고 데몬 SQLite에만 둔다.
export function mountToday({ section, h, cy, refresh }) {
  let items = [];
  let date = '';
  let saving = false;
  let timer = null;

  const fill = (el, ...kids) => {
    el.replaceChildren(...kids.flat().filter((c) => c != null && c !== false));
  };

  function payload() {
    return items
      .map((it) => ({ id: it.id, title: String(it.title || '').replace(/\s+/g, ' ').trim(), done: !!it.done }))
      .filter((it) => it.title);
  }

  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  }

  async function save() {
    if (saving) { scheduleSave(); return; }
    saving = true;
    let r;
    try { r = await cy.todaySave(payload()); } catch { r = { ok: false }; }
    saving = false;
    if (r?.ok && r.data?.plan) {
      date = r.data.plan.date || date;
      items = Array.isArray(r.data.plan.items) ? r.data.plan.items.map(norm) : payload();
      render();
    }
    refresh?.();
  }

  function norm(it) {
    return { id: String(it.id || ''), title: String(it.title || ''), done: it.done === true };
  }

  function addRow() {
    items = [...items, { id: crypto.randomUUID().slice(0, 8), title: '', done: false }];
    render();
    const inputs = section.querySelectorAll('input.title');
    inputs[inputs.length - 1]?.focus();
  }

  function render() {
    const open = items.filter((it) => !it.done).length;
    fill(section,
      h('div.today-head', null,
        h('h2', { text: date ? `${date} 오늘 할 일` : '오늘 할 일' }),
        h('span.muted', { text: items.length ? `남은 ${open} · 전체 ${items.length}` : '아직 없어요. 일정을 보고 적어 보세요.' })),
      h('div.today-list', null,
        ...items.map((it, i) => h(`div.today-row${it.done ? '.done' : ''}`, null,
          h('input', { type: 'checkbox', checked: it.done || undefined, 'aria-label': '끝냄', onchange: (e) => { items[i] = { ...items[i], done: e.target.checked }; render(); scheduleSave(); } }),
          h('input.title', {
            type: 'text', value: it.title, maxlength: '300', placeholder: '할 일',
            oninput: (e) => { items[i] = { ...items[i], title: e.target.value }; scheduleSave(); },
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(); } },
          }),
          h('button.ghost', { type: 'button', text: '지움', onclick: () => { items = items.filter((_, j) => j !== i); render(); scheduleSave(); } })))),
      h('button.ghost', { type: 'button', text: '줄 추가', onclick: addRow }),
    );
  }

  return {
    update(plan) {
      if (section.contains(document.activeElement) && document.activeElement?.matches?.('input.title')) return;
      date = plan && typeof plan.date === 'string' ? plan.date : '';
      items = Array.isArray(plan?.items) ? plan.items.map(norm) : [];
      render();
    },
  };
}
