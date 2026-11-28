import { t } from '/i18n.js';

/** Native site dialog, never window.prompt/confirm. Backend remains authoritative. */
export function openMoveDialog(item, { node, button, api, post, notify, refresh }) {
  if (document.querySelector('#move-dialog')) return;
  const previousFocus = document.activeElement;
  const dialog = node('dialog', null, 'move-dialog'); dialog.id = 'move-dialog';
  dialog.setAttribute('aria-labelledby', 'move-heading');
  const heading = node('h2', t(item.is_root ? 'Переместить тему' : 'Переместить ответ')); heading.id = 'move-heading';
  const form = node('form'), select = node('select'); select.id = 'move-destination'; select.required = !!item.is_root;
  const label = node('label', t(item.is_root ? 'Раздел назначения' : 'Выбрать тему')); label.htmlFor = select.id;
  const why = node('textarea'); why.id = 'move-reason'; why.required = true; why.maxLength = 1000; why.rows = 3;
  const whyLabel = node('label', t('Причина перемещения')); whyLabel.htmlFor = why.id;
  const feedback = node('p', t('Загрузка…'), 'move-feedback'); feedback.setAttribute('role', 'status');
  const save = node('button', t('Переместить'), 'move-submit'); save.type = 'submit'; save.disabled = true;
  const cancel = button(t('Отмена'), async () => dialog.close());
  const actions = node('div', null, 'move-actions'); actions.append(cancel, save);
  let busy = false, loading = false, page = 1, request = 0;
  const id = node('input'); id.type = 'number'; id.min = '1'; id.max = '999999999'; id.step = '1'; id.required = true; id.id = 'move-thread-id';
  const search = node('input'); search.type = 'search'; search.maxLength = 200; search.id = 'move-search';
  const back = button(t('← Назад'), async () => { --page; await loadThreads(); });
  const next = button(t('Далее →'), async () => { ++page; await loadThreads(); });
  const update = () => { save.disabled = busy || loading || !(item.is_root ? select.value : id.value); };
  select.addEventListener('change', () => { if (!item.is_root) id.value = select.value; update(); });
  id.addEventListener('input', update);
  form.append(label);
  if (!item.is_root) {
    const searchLabel = node('label', t('Поиск темы')); searchLabel.htmlFor = search.id;
    const find = button(t('Найти'), async () => { page = 1; await loadThreads(); });
    const searchRow = node('div', null, 'move-search'); searchRow.append(search, find);
    form.append(searchLabel, searchRow);
    const pager = node('div', null, 'move-pager'); pager.append(back, next);
    form.append(select, pager);
    const idLabel = node('label', t('ID темы назначения')); idLabel.htmlFor = id.id;
    form.append(idLabel, id);
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); find.click(); } });
  } else form.append(select);
  form.append(whyLabel, why, feedback, actions); dialog.append(heading, node('p', t('Сообщение №{id}', { id: item.id }), 'move-source'), form);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++request; dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus(); }, { once: true });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (!busy && event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || loading || !form.reportValidity()) return;
    if (!why.value.trim()) { why.setCustomValidity(t('Укажите причину перемещения.')); why.reportValidity(); return; }
    busy = true; update(); cancel.disabled = true; feedback.textContent = t('Перемещение…');
    try {
      await post(`/posts/${item.id}/move`, { [item.is_root ? 'section_id' : 'thread_id']: Number(item.is_root ? select.value : id.value), reason: why.value.trim() });
    } catch (error) {
      feedback.textContent = error.message; busy = false; cancel.disabled = false; update(); return;
    }
    dialog.close(); notify(t('Сообщение перемещено.'), false);
    try { await refresh(); } catch (error) { notify(error); }
  });
  why.addEventListener('input', () => why.setCustomValidity(''));
  async function loadThreads() {
    const version = ++request; loading = true; update(); back.disabled = next.disabled = true;
    feedback.textContent = t('Загрузка…');
    try {
      const query = new URLSearchParams({ page, limit: '20' });
      const q = search.value.trim(); if (q) { if (new TextEncoder().encode(q).length < 2) throw new Error(t('Введите минимум два символа.')); query.set('q', q); }
      const data = await api('/threads?' + query);
      if (version !== request || !dialog.open) return;
      select.replaceChildren(new Option(t('Выберите назначение'), ''));
      for (const thread of data.items) if (thread.id !== item.thread_id) select.append(new Option(`№${thread.id} · ${thread.title}`, thread.id));
      back.disabled = page <= 1; next.disabled = !data.has_more;
      feedback.textContent = data.items.length ? t('Страница {page}', { page }) : t('Тем не найдено.');
    } catch (error) { if (version === request) feedback.textContent = error.message; }
    finally { if (version === request) { loading = false; update(); } }
  }
  async function loadSections() {
    loading = true; select.disabled = true;
    try {
      const [sections, thread] = await Promise.all([api('/sections'), api('/threads/' + item.thread_id)]);
      if (!dialog.open) return;
      select.append(new Option(t('Выберите назначение'), ''));
      for (const section of sections) if (section.id !== thread.section_id) select.append(new Option(section.title + (section.is_archived ? t(' [архив]') : ''), section.id));
      feedback.textContent = select.options.length > 1 ? '' : t('Нет других разделов.');
    } catch (error) { feedback.textContent = error.message; }
    finally { loading = false; select.disabled = false; update(); }
  }
  document.body.append(dialog); dialog.showModal();
  if (item.is_root) loadSections(); else loadThreads();
}
