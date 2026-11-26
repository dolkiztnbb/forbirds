const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const labels = { approved: 'Опубликовано', pending: 'Ожидает проверки', rejected: 'Отклонено', deleted: 'Удалено' };
const roleLabels = { user: 'Участник', moderator: 'Модератор', admin: 'Администратор' };
let me = null, csrf = '', sections = [], composer = null;
const staff = () => me && !me.is_banned && ['moderator', 'admin'].includes(me.role);
const admin = () => staff() && me.role === 'admin';
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function link(text, href) {
  const a = node('a', text); a.href = href; return a;
}
function button(text, action) {
  const b = node('button', text); b.type = 'button';
  b.addEventListener('click', () => action().catch(notify));
  return b;
}
function notify(value, isError = true) {
  const notice = $('#notice');
  notice.hidden = false;
  notice.classList.toggle('error', isError);
  notice.textContent = value instanceof Error ? value.message : String(value);
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (method === 'POST') headers['X-CSRF-Token'] = csrf;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'; body = JSON.stringify(body);
  }
  const response = await fetch('/api' + path, { method, body, headers, credentials: 'same-origin', cache: 'no-store' });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Сервер вернул некорректный ответ. Повторите запрос позже.'); }
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Ошибка ${response.status}`);
    error.code = payload.error?.code;
    error.retryAfter = Number(payload.error?.retry_after || response.headers.get('Retry-After') || 0);
    throw error;
  }
  if (payload.data?.csrf_token) csrf = payload.data.csrf_token;
  return payload.data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
function date(value) { return new Date(value).toLocaleString('ru-RU'); }
function empty(container, text) { container.replaceChildren(node('p', text, 'empty')); }
function paginate(data) {
  const nav = $('#pagination'); nav.replaceChildren();
  const pageLink = (text, page) => {
    const query = new URLSearchParams(location.search); query.set('page', page);
    return link(text, location.pathname + '?' + query);
  };
  if (data.page > 1) nav.append(pageLink('← Назад', data.page - 1));
  nav.append(node('span', `Страница ${data.page}`));
  if (data.has_more) nav.append(pageLink('Далее →', data.page + 1));
}
function pageQuery() {
  const q = new URLSearchParams();
  q.set('page', params.get('page') || '1');
  q.set('limit', '20');
  return q;
}
function identityUI() {
  $('#auth-form').hidden = !!me; $('#account').hidden = !me;
  if (me) $('#account-name').textContent = `${me.username} · ${roleLabels[me.role]}${me.is_banned ? ' · Заблокирован' : ''}`;
  $('#my-link').hidden = !me;
  $('#queue-link').hidden = !staff();
  if ($('#queue-tab')) $('#queue-tab').hidden = !staff();
}
async function loadSections() {
  sections = await api('/sections');
  const side = $('#sections'); side.replaceChildren();
  if (!sections.length) side.append(node('p', 'Разделов пока нет. Администратор может создать первый в панели публикаций.'));
  for (const section of sections) {
    const details = node('details');
    const summary = node('summary'); summary.append(link(section.title + (section.is_archived ? ' [архив]' : ''), '/index.html?section_id=' + section.id));
    details.append(summary, node('p', section.description)); side.append(details);
  }
  const select = $('#section-select');
  if (select) {
    select.replaceChildren();
    for (const section of sections) {
      const option = node('option', section.title + (section.is_archived ? ' [архив]' : ''));
      option.value = section.id; option.disabled = !!section.is_archived && !staff();
      select.append(option);
    }
    const selected = params.get('section_id');
    if (selected && sections.some(s => String(s.id) === selected)) select.value = selected;
    else if (select.options.length) select.value = [...select.options].find(o => !o.disabled)?.value || '';
  }
}
async function loadNews() {
  const news = await api('/threads?news=1&limit=5');
  const table = $('#news'); table.replaceChildren();
  for (const item of news.items) {
    const row = node('tr'), when = node('td', new Date(item.created_at).toLocaleDateString('ru-RU'), 'news-date');
    const title = node('td'); title.append(link(item.title, '/post.html?id=' + item.id));
    if (item.status === 'pending') title.append(node('span', ' — Ожидает проверки', 'post-status'));
    row.append(when, title); table.append(row);
  }
  if (!news.items.length) {
    const row = node('tr'); row.append(node('td', 'Опубликованных новостей пока нет.')); table.append(row);
  }
}
async function profile(id) {
  const user = await api('/users/' + id);
  const dialog = node('dialog');
  dialog.append(node('h2', user.username), node('p', `${roleLabels[user.role]} · С нами с ${date(user.created_at)}`), node('p', user.is_banned ? 'Аккаунт заблокирован' : 'Аккаунт активен'));
  if ('auto_approve' in user) dialog.append(node('p', 'Автоподтверждение: ' + (user.auto_approve ? 'выдано' : 'не выдано')));
  const canManage = staff() && user.id !== me.id && user.role !== 'admin' && (admin() || user.role === 'user');
  if (canManage) {
    for (const [action, enabled, text] of [
      ['trust', !user.auto_approve, user.auto_approve ? 'Отозвать автоподтверждение' : 'Выдать автоподтверждение'],
      ['ban', !user.is_banned, user.is_banned ? 'Снять бан' : 'Забанить'],
    ]) dialog.append(button(text, async () => {
      if (!confirm(`${text}: ${user.username}?`)) return;
      await post(`/users/${id}/${action}`, { enabled }); dialog.close(); await profile(id);
    }));
    if (admin()) dialog.append(button(user.role === 'moderator' ? 'Снять модератора' : 'Назначить модератором', async () => {
      if (!confirm('Изменить роль ' + user.username + '?')) return;
      await post(`/users/${id}/role`, { role: user.role === 'moderator' ? 'user' : 'moderator' }); dialog.close(); await profile(id);
    }));
  }
  dialog.append(button('Закрыть', async () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}
function renderPost(item, { title = '', threadLink = true, replyCount, pendingReplyCount = 0 } = {}) {
  const table = node('table', null, 'post-table ' + (item.is_root ? 'p' : 'pl'));
  table.dataset.status = item.status;
  const tbody = node('tbody'), row = node('tr'), author = node('td', null, 'post-author'), content = node('td', null, 'post-content');
  const name = node('div', null, 'author-name');
  const username = item.username || 'Аноним';
  if (item.user_id) {
    const a = link(username, '#profile-' + item.user_id);
    a.className = 'role-' + (item.author_role === 'moderator' ? 'mod' : item.author_role || 'user');
    a.addEventListener('click', event => { event.preventDefault(); profile(item.user_id).catch(notify); });
    if (item.author_banned) { const s = node('s'); s.append(a); name.append(s); } else name.append(a);
  } else name.textContent = username;
  const avatar = node('img', null, 'avatar'); avatar.src = '/avatars/noavatar.png'; avatar.alt = ''; avatar.width = 100; avatar.height = 100;
  author.append(name, node('div', roleLabels[item.author_role] || 'Гость', 'author-rank'), avatar);
  const header = node('div', null, 'post-header');
  if (title) {
    const heading = node('b'); heading.append(threadLink ? link(title, '/post.html?id=' + item.thread_id) : node('span', title)); header.append(heading);
  }
  const number = link('№' + item.id, '/post.html?id=' + item.thread_id + '#post-' + item.id);
  number.className = 'post-number'; header.append(number);
  const time = node('time', date(item.created_at)); time.dateTime = item.created_at; header.append(time);
  if (item.status !== 'approved' || staff()) header.append(node('span', labels[item.status], 'post-status'));
  content.append(header, node('hr'), node('div', item.body, 'post-body'));
  if (item.attachments?.length) {
    const files = node('div', null, 'attachments');
    for (const file of item.attachments) {
      const box = node('div', null, (file.is_image ? 'image-box' : 'file-box') + (file.spoiler ? ' spoiler' : ''));
      if (file.is_image) {
        const open = link('', file.view_url);
        open.target = '_blank'; open.rel = 'noopener';
        open.setAttribute('aria-label', (file.spoiler ? 'Открыть изображение под спойлером: ' : 'Открыть изображение: ') + file.original_name);
        const image = node('img', null, file.spoiler ? 'spoiler-marker img2x' : 'attachment-preview');
        image.src = file.spoiler ? '/static/preview/spolier.png' : file.preview_url;
        image.alt = file.spoiler ? 'Изображение под спойлером' : 'Превью: ' + file.original_name;
        image.loading = 'lazy';
        open.append(image); box.append(open, node('div', file.original_name));
        box.append(link('Скачать полноразмерную картинку', file.download_url));
      } else {
        const icon = node('img', null, 'img2x'); icon.src = '/icons/file.png'; icon.alt = '';
        box.append(icon);
        if (file.spoiler) {
          const details = node('details'), summary = node('summary', 'Файл под спойлером');
          details.append(summary, link(file.original_name, file.download_url)); box.append(details);
        } else box.append(link(file.original_name, file.download_url));
      }
      box.append(node('div', `${(file.byte_size / 1024).toFixed(1)} КиБ`)); files.append(box);
    }
    content.append(files);
  }
  if (replyCount !== undefined) {
    const links = node('p', null, 'post-links');
    const count = `Ответов: ${replyCount}` + (staff() && pendingReplyCount ? ` (на проверке: ${pendingReplyCount})` : '');
    links.append(link(count + ' →', '/post.html?id=' + item.thread_id)); content.append(links);
  }
  if (staff() && item.status !== 'deleted') {
    const tools = node('div', null, 'mod-tools');
    for (const [action, text] of [['approve', 'Подтвердить'], ['unapprove', 'Снять подтверждение'], ['reject', 'Отклонить'], ['delete', 'Удалить']]) {
      const b = button(text, async () => {
        if (action === 'delete' && !confirm('Удалить сообщение №' + item.id + '?')) return;
        b.disabled = true;
        try {
          await post(`/posts/${item.id}/moderate`, { action });
          notify(`Сообщение №${item.id}: ${labels[{ approve: 'approved', unapprove: 'pending', reject: 'rejected', delete: 'deleted' }[action]]}`, false);
          await loadView(); await loadNews();
        } finally { if (b.isConnected) b.disabled = false; }
      });
      b.disabled = (action === 'approve' && item.status === 'approved') || (action === 'unapprove' && item.status === 'pending');
      tools.append(b);
    }
    if (item.user_id && item.user_id !== me.id && item.author_role !== 'admin') tools.append(button('Права / бан автора', () => profile(item.user_id)));
    header.append(tools);
  }
  row.append(author, content); tbody.append(row); table.append(tbody); table.id = 'post-' + item.id;
  return table;
}
async function loadFeed() {
  const query = pageQuery(), sectionId = params.get('section_id'), search = params.get('q');
  let title = 'Главная', description = '';
  if (sectionId) {
    query.set('section_id', sectionId);
    const section = sections.find(s => String(s.id) === sectionId);
    title = section?.title || 'Раздел'; description = section?.description || '';
  } else if (search) {
    query.set('q', search); title = 'Поиск: ' + search; description = 'Поиск по опубликованным темам и ответам.';
  } else if (params.get('view') === 'all') { title = 'Все темы'; description = 'Публикации из всех разделов.'; }
  else if (staff()) description = 'Режим персонала: все темы, включая ожидающие проверки. Непроверенные ответы видны внутри тем.';
  else query.set('featured', '1');
  $('#page-title').textContent = title; $('#feed-description').textContent = description;
  const container = $('#feed');
  const data = await api('/threads?' + query);
  const posts = await Promise.all(data.items.map(t => api('/posts/' + t.post_id).then(p => ({ ...t, post: p })).catch(() => null)));
  container.replaceChildren();
  for (const item of posts.filter(Boolean)) container.append(renderPost(item.post, { title: item.title, replyCount: item.reply_count, pendingReplyCount: item.pending_reply_count }));
  if (!posts.filter(Boolean).length) empty(container, 'Тем пока нет. Создайте первую тему или выберите другой раздел.');
  paginate(data);
}
async function loadThread() {
  const id = params.get('id');
  if (!/^[1-9][0-9]*$/.test(id || '')) throw new Error('Не указан номер темы. Выберите тему в ленте.');
  const data = await api('/threads/' + id + '?' + pageQuery());
  $('#page-title').textContent = data.title; document.title = data.title + ' — ForBirds';
  $('#back-to-section').href = '/index.html?section_id=' + data.section_id;
  const container = $('#thread'); container.replaceChildren(renderPost(data.post, { title: data.title, threadLink: false }));
  container.append(node('hr'));
  for (const reply of data.replies.items) container.append(renderPost(reply));
  if (!data.replies.items.length) container.append(node('p', 'Ответов пока нет.'));
  paginate(data.replies);
  const settings = $('#thread-settings'); settings.replaceChildren();
  if (staff()) {
    for (const [key, title] of [['is_locked', 'Тема закрыта'], ['is_news', 'В новостях'], ['is_featured', 'На главной']]) {
      const label = node('label', title + ' '), input = node('input'); input.type = 'checkbox'; input.checked = !!data[key];
      input.addEventListener('change', async () => {
        input.disabled = true;
        try { await post(`/threads/${id}/settings`, { [key]: input.checked }); await loadThread(); await loadNews(); }
        catch (e) { input.checked = !input.checked; notify(e); } finally { input.disabled = false; }
      }); label.prepend(input); settings.append(label);
    }
  }
  const section = sections.find(s => s.id === data.section_id);
  const blocked = !!me?.is_banned || (!staff() && (!!data.is_locked || !!section?.is_archived));
  $('#composer').hidden = blocked;
  if (blocked) container.append(node('p', me?.is_banned ? 'Аккаунт заблокирован.' : 'Тема или раздел закрыты для публикации.'));
  if (!blocked && !composer) composer = new Composer(id);
}
async function loadDashboard() {
  const mode = params.get('mode') || 'new';
  const container = $('#dashboard-content'); container.replaceChildren();
  $('#composer').hidden = mode !== 'new' || !!me?.is_banned;
  $('#section-admin').hidden = !admin() || mode !== 'new';
  if (mode === 'new') {
    if (!composer && !me?.is_banned) composer = new Composer(null);
    if (!sections.length) container.append(node('p', 'Сначала администратор должен добавить раздел ниже.'));
    if (me?.is_banned) container.append(node('p', 'Аккаунт заблокирован. Публикация недоступна.'));
    return;
  }
  if (mode === 'queue' || mode === 'audit') {
    if (!staff()) { empty(container, 'Для этой страницы нужны права модератора.'); return; }
    container.append(link(mode === 'queue' ? 'Журнал модерации →' : '← Очередь', '?mode=' + (mode === 'queue' ? 'audit' : 'queue')));
    const data = await api('/moderation/' + mode + '?' + pageQuery());
    if (!data.items.length) container.append(node('p', mode === 'queue' ? 'Очередь пуста.' : 'Журнал пуст.'));
    if (mode === 'audit') {
      for (const entry of data.items) container.append(node('p', `${date(entry.created_at)} · #${entry.actor_id}: ${entry.action} · ${entry.target_type} №${entry.target_id} · ${entry.details}`));
    } else {
      const posts = await Promise.all(data.items.map(p => api('/posts/' + p.id).then(detail => ({ ...p, ...detail }))));
      for (const p of posts) container.append(renderPost(p, { title: p.title }));
    }
    paginate(data); return;
  }
  if (mode === 'mine') {
    if (!me) { empty(container, 'Войдите, чтобы видеть свои сообщения, в том числе ожидающие проверки.'); return; }
    const data = await api('/me/posts?' + pageQuery());
    const posts = await Promise.all(data.items.map(p => api('/posts/' + p.id).catch(() => ({ ...p, username: me.username, author_role: me.role }))));
    for (const p of posts) container.append(renderPost(p));
    if (!posts.length) empty(container, 'Вы ещё ничего не опубликовали.');
    paginate(data); return;
  }
  empty(container, 'Неизвестная вкладка.');
}
async function loadView() {
  if (document.body.dataset.page === 'index') return loadFeed();
  if (document.body.dataset.page === 'post') return loadThread();
  return loadDashboard();
}

class Composer {
  constructor(threadId) {
    this.threadId = threadId; this.files = []; this.proof = null; this.worker = null;
    this.until = 0; this.busy = false; this.interval = me ? 30 : 45; this.ready = false;
    this.form = $('#post-form');
    $('#composer').hidden = false;
    $('#topic-fields').hidden = !!threadId;
    $('#publish-flags').hidden = !!threadId || !staff();
    $('#section-select').required = !threadId;
    this.form.elements.title.required = !threadId;
    $('#pow-start').addEventListener('click', () => this.solve().catch(notify));
    $('#pow-cancel').addEventListener('click', () => this.cancel('Проверка отменена.'));
    this.form.addEventListener('submit', event => { event.preventDefault(); this.submit().catch(notify); });
    $('#file-input').addEventListener('change', event => { this.addFiles([...event.target.files]); event.target.value = ''; });
    const drop = $('#drop-zone');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag-over'); this.addFiles([...e.dataTransfer.files]); });
    this.form.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); this.addFiles(files); }
    });
    this.form.elements.body.addEventListener('input', () => this.controls());
    this.form.elements.title.addEventListener('input', () => this.controls());
    this.timer = setInterval(() => this.controls(), 500);
    addEventListener('pagehide', () => { this.cancel(); clearInterval(this.timer); }, { once: true });
    this.refreshStatus().catch(e => { $('#pow-status').textContent = e.message; });
  }
  async refreshStatus() {
    this.ready = false; this.controls();
    try {
      const status = await api('/posting-status');
      this.interval = status.interval_seconds; this.until = Date.now() + status.retry_after * 1000;
      if (!this.proof && !this.worker) $('#pow-status').textContent = 'Нажмите кнопку для одноразовой проверки перед отправкой.';
    } finally {
      // Issuing a challenge rechecks the server's timer after a transient read failure.
      this.ready = true; this.controls();
    }
  }
  cancel(message = 'Нужна новая проверка.') {
    if (this.worker) this.worker.terminate(); this.worker = null; this.proof = null;
    $('#pow-status').textContent = message; this.controls();
  }
  controls() {
    const wait = Math.max(0, Math.ceil((this.until - Date.now()) / 1000));
    if (this.proof && Date.now() >= this.proof.expires_at * 1000) this.cancel('Решение истекло. Вычислите новую проверку.');
    $('#cooldown').textContent = wait ? `Следующая публикация через ${wait} сек. Затем решите проверку.` : `Интервал: ${this.interval} сек. Проверка обязательна для каждой публикации.`;
    $('#pow-start').disabled = !this.ready || !!wait || !!this.worker || this.busy;
    $('#pow-start').textContent = this.proof ? 'Вычислить заново' : 'Вычислить проверку';
    $('#pow-cancel').hidden = !this.worker;
    $('#post-submit').disabled = !this.ready || !!wait || !this.proof || this.busy || !!me?.is_banned || (!this.threadId && !$('#section-select').value);
  }
  async solve() {
    if (!this.ready || this.busy || this.worker || Date.now() < this.until) return;
    this.cancel('Получение задачи…'); this.ready = false; this.controls();
    try {
      const challenge = await post('/pow/challenge');
      const worker = new Worker('/pow-worker.js'); this.worker = worker;
      $('#pow-status').textContent = `Вычисление SHA-256 (${challenge.difficulty} бит)…`;
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') $('#pow-status').textContent = `Подбираем хэш: ${data.attempts.toLocaleString('ru-RU')} попыток…`;
        else if (data.type === 'solved') {
          worker.terminate(); this.worker = null;
          this.proof = { pow_id: challenge.id, pow_nonce: data.nonce, expires_at: challenge.expires_at };
          $('#pow-status').textContent = 'Проверка решена. Можно отправлять сообщение.'; this.controls();
        } else { this.cancel(data.message || 'Ошибка вычисления.'); }
      };
      worker.onerror = () => this.cancel('Не удалось запустить вычисление. Проверьте поддержку Web Worker.');
      worker.postMessage(challenge);
    } catch (error) {
      if (error.retryAfter) this.until = Date.now() + error.retryAfter * 1000;
      $('#pow-status').textContent = error.message; throw error;
    } finally { this.ready = true; this.controls(); }
  }
  addFiles(files) {
    if (this.busy) return;
    const next = [...this.files, ...files.map(file => ({ file, spoiler: false }))];
    if (next.length > 10 || next.some(f => f.file.size > 5 * 1024 * 1024 || !f.file.size) || next.reduce((n, f) => n + f.file.size, 0) > 20 * 1024 * 1024) {
      notify('Лимит: до 10 непустых файлов, 5 МиБ на файл, 20 МиБ суммарно.'); return;
    }
    this.files = next; this.renderFiles();
  }
  renderFiles() {
    const list = $('#file-list'); list.replaceChildren();
    this.files.forEach((entry, i) => {
      const item = node('li'), label = node('label', 'Под спойлером'), checkbox = node('input');
      checkbox.type = 'checkbox'; checkbox.checked = entry.spoiler;
      checkbox.addEventListener('change', () => { entry.spoiler = checkbox.checked; });
      label.prepend(checkbox);
      item.append(node('span', `${entry.file.name} · ${(entry.file.size / 1024).toFixed(1)} КиБ`), label,
        button('Убрать', async () => { if (!this.busy) { this.files.splice(i, 1); this.renderFiles(); } }));
      list.append(item);
    });
  }
  async submit() {
    if (this.busy) return;
    if (!this.proof || this.worker || Date.now() < this.until) { notify('Дождитесь окончания интервала и решите хэш-проверку.'); return; }
    if (!this.form.reportValidity()) return;
    this.busy = true; this.controls();
    const data = new FormData();
    data.set('body', this.form.elements.body.value);
    data.set('pow_id', this.proof.pow_id); data.set('pow_nonce', this.proof.pow_nonce);
    if (!this.threadId) {
      data.set('section_id', $('#section-select').value); data.set('title', this.form.elements.title.value);
      if (staff()) { data.set('is_news', this.form.elements.is_news.checked ? '1' : '0'); data.set('is_featured', this.form.elements.is_featured.checked ? '1' : '0'); }
    }
    this.files.forEach((entry, i) => { data.append('files[]', entry.file); if (entry.spoiler) data.append('spoilers[]', String(i)); });
    $('#post-result').textContent = 'Отправка…';
    try {
      const result = await post(this.threadId ? `/threads/${this.threadId}/replies` : '/threads', data);
      const message = `Сообщение №${result.post_id}: ${labels[result.status]}.`;
      this.form.elements.body.value = ''; this.files = []; this.renderFiles();
      this.cancel('Для следующей публикации нужна новая проверка.');
      // Never let a failed status refresh turn a successful POST into an apparent failure.
      this.until = Date.now() + this.interval * 1000;
      $('#post-result').textContent = message;
      if (!this.threadId && (me || result.status === 'approved')) {
        sessionStorage.setItem('forbirds-notice', message); location.assign('/post.html?id=' + result.thread_id); return;
      }
      notify(message, false);
      if (this.threadId) await loadThread().catch(notify);
      await this.refreshStatus().catch(notify);
    } catch (error) {
      $('#post-result').textContent = error.message;
      if (error.retryAfter) this.until = Date.now() + error.retryAfter * 1000;
      if (error.code?.startsWith('pow_') || error.code === 'posting_cooldown') this.cancel('Получите новую проверку.');
      throw error;
    } finally { this.busy = false; this.controls(); }
  }
}

function adminSections() {
  const form = $('#section-form'); if (!form || !admin()) return;
  form.addEventListener('submit', async event => {
    event.preventDefault(); const submit = form.querySelector('button'); submit.disabled = true;
    try {
      await post('/sections', Object.fromEntries(new FormData(form)));
      form.reset(); await loadSections(); options(); notify('Раздел создан.', false); composer?.controls();
    } catch (e) { notify(e); } finally { submit.disabled = false; }
  });
  const formEdit = $('#section-settings-form'), select = formEdit.elements.section_id;
  const titleInput = formEdit.elements.title, description = formEdit.elements.description, archived = formEdit.elements.is_archived;
  const save = formEdit.querySelector('button');
  function options() {
    const selected = select.value;
    select.replaceChildren();
    for (const s of sections) { const option = node('option', s.title); option.value = s.id; select.append(option); }
    if (sections.some(s => String(s.id) === selected)) select.value = selected;
    fill();
  }
  function fill() {
    const section = sections.find(s => String(s.id) === select.value);
    titleInput.value = section?.title || ''; description.value = section?.description || ''; archived.checked = !!section?.is_archived;
    for (const control of [select, titleInput, description, archived, save]) control.disabled = !section;
  }
  select.addEventListener('change', fill);
  formEdit.addEventListener('submit', async event => {
    event.preventDefault(); if (!select.value) return;
    save.disabled = true;
    try {
      await post(`/sections/${select.value}/settings`, { title: titleInput.value, description: description.value, is_archived: archived.checked });
      await loadSections(); options(); notify('Настройки раздела сохранены.', false);
    } catch (error) { notify(error); } finally { save.disabled = false; }
  });
  options();
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
  try {
    await post('/auth/' + (event.submitter?.value || 'login'), Object.fromEntries(new FormData(form)));
    form.elements.password.value = ''; location.reload();
  } catch (error) { notify(error); } finally { buttons.forEach(b => { b.disabled = false; }); }
});
$('#logout').addEventListener('click', async () => {
  try { await post('/auth/logout'); location.reload(); } catch (error) { notify(error); }
});
async function main() {
  const session = await api('/session'); me = session.user; identityUI();
  await Promise.all([loadSections(), loadNews()]);
  await loadView(); adminSections();
  const message = sessionStorage.getItem('forbirds-notice');
  if (message) { notify(message, false); sessionStorage.removeItem('forbirds-notice'); }
  if (/^#post-[0-9]+$/.test(location.hash)) $(location.hash)?.scrollIntoView();
}
main().catch(error => {
  notify(error);
  const target = $('#feed') || $('#thread') || $('#dashboard-content');
  if (target) empty(target, error.message);
});
