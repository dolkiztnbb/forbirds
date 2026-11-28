import { t, locale, initLanguage } from '/i18n.js';
import { browserSignal } from '/ujutnenko.js';
import { moderationUI } from '/moderation.js';
import { renderMarkdown } from '/markdown.js';
import { siteUpdateUI } from '/updates.js';
import { sectionOpen, rememberSection } from '/section-state.js';
await initLanguage();

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const labels = { approved: t("Опубликовано"), pending: t("Ожидает проверки"), rejected: t("Отклонено"), deleted: t("Удалено") };
const roleLabels = { user: t("Участник"), moderator: t("Модератор"), admin: t("Администратор") };
let me = null, csrf = '', sections = [], composer = null, readOnly = false, reactionEmojis = [];
const presentation = () => !!window.ForBirdsPresentation?.enabled;
const staff = () => !presentation() && me && !me.is_banned && ['moderator', 'admin'].includes(me.role);
const admin = () => staff() && me.role === 'admin';
const privacyNotice = document.createElement('details'); privacyNotice.className = 'privacy-notice';
const privacySummary = document.createElement('summary'); privacySummary.textContent = t('Приватность и защита от спама');
const privacyText = document.createElement('p');
privacyText.textContent = t('Для борьбы со спамом сохраняются IP публикаций, случайный cookie ID и хэш отпечатка браузера (Canvas/WebGL). Это не аппаратный ID. IP доступны только администратору с включённым показом; доступ журналируется. Срок хранения IP — 30 дней при ежедневной очистке.');
privacyText.textContent += ' ' + t('Распознанным подключениям Tor/I2P доступно только чтение. Попытка записи сохраняет запрет для браузера и уже вошедшего аккаунта; ограничения и история их снятия хранятся для проверки администратором.');
privacyNotice.append(privacySummary, privacyText); document.querySelector('header').after(privacyNotice);
const signal = browserSignal();
const moderation = moderationUI({ node, button, link, api, post: (...args) => post(...args), notify,
  refresh: async () => { await loadView(); await loadNews(); await loadSections(); }, staff, admin });
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
  if (method !== 'GET' && presentation()) throw new Error(t('В режиме показа действия отключены.'));
  const headers = { 'Accept-Language': document.documentElement.lang };
  if (presentation()) headers['X-ForBirds-Public-View'] = '1';
  if (signal) headers['X-ForBirds-Fingerprint'] = signal;
  if (method === 'POST') headers['X-CSRF-Token'] = csrf;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'; body = JSON.stringify(body);
  }
  let response;
  try { response = await fetch('/api' + path, { method, body, headers, credentials: 'same-origin', cache: 'no-store' }); }
  catch { throw new Error(t('Не удалось связаться с сервером. Проверьте соединение и повторите запрос.')); }
  let payload;
  try { payload = await response.json(); } catch { throw new Error(t("Сервер вернул некорректный ответ. Повторите запрос позже.")); }
  if (!response.ok) {
    const error = new Error(payload.error?.message || t('Ошибка {status}', { status: response.status }));
    error.code = payload.error?.code;
    if (error.code === 'network_read_only') { readOnly = true; applyReadOnly(); }
    error.retryAfter = Number(payload.error?.retry_after || response.headers.get('Retry-After') || 0);
    throw error;
  }
  if (payload.data?.csrf_token) csrf = payload.data.csrf_token;
  return payload.data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
function applyReadOnly() {
  if (!readOnly && !presentation()) return;
  if (composer) { composer.cancel(); clearInterval(composer.timer); }
  for (const form of document.querySelectorAll('form[method="post"]')) {
    for (const input of form.querySelectorAll('input,textarea,select,button')) input.disabled = true;
  }
  for (const button of document.querySelectorAll('.mod-tools button, .reaction-button, .reaction-add, .reaction-option, #logout, #show-identity, #thread-settings input')) button.disabled = true;
  if ($('#composer')) $('#composer').hidden = true;
  if (readOnly && !$('#network-read-only')) {
    const notice = node('p', t('Для этого подключения, браузера или аккаунта доступно только чтение.'), 'read-only-notice');
    notice.id = 'network-read-only'; notice.setAttribute('role', 'status');
    document.querySelector('header').after(notice);
  }
}
function reactionBar(item) {
  const bar = node('div', null, 'post-reactions');
  bar.setAttribute('aria-label', t('Реакции'));
  let reactions = item.reactions || [], busy = false, picker = null;
  const unavailable = () => busy || presentation() || readOnly || !me || !!me.is_banned || item.status !== 'approved';
  const updateControls = () => {
    for (const control of bar.querySelectorAll('button')) control.disabled = unavailable();
    for (const control of picker?.querySelectorAll('.reaction-option') || []) control.disabled = unavailable();
  };
  const image = reaction => {
    const img = node('img'); img.src = reaction.url; img.alt = ''; img.loading = 'lazy'; return img;
  };
  const choose = async reaction => {
    if (unavailable()) return;
    busy = true; updateControls();
    try {
      reactions = await post(`/posts/${item.id}/reactions`, { reaction: reaction.selected ? '' : reaction.file });
      fill();
      if (picker?.open) picker.close();
      else if (bar.isConnected) (bar.querySelector('.reaction-button[aria-pressed="true"]') || bar.querySelector('.reaction-add'))?.focus({ preventScroll: true });
    } catch (error) {
      if (picker?.open) {
        let feedback = picker.querySelector('.reaction-picker-error');
        if (!feedback) { feedback = node('p', null, 'reaction-picker-error'); feedback.setAttribute('role', 'alert'); picker.append(feedback); }
        feedback.textContent = error.message;
      }
      throw error;
    } finally { busy = false; updateControls(); }
  };
  const openPicker = async () => {
    if (unavailable() || picker?.open) return;
    const dialog = node('dialog', null, 'reaction-picker'); picker = dialog;
    dialog.setAttribute('aria-label', t('Выбрать реакцию'));
    const header = node('div', null, 'reaction-picker-header');
    const close = button(t('Закрыть'), async () => dialog.close());
    header.append(node('strong', t('Выбрать реакцию')), close);
    const options = node('div', null, 'reaction-picker-options');
    for (const reaction of reactions) {
      const control = button('', () => choose(reaction));
      control.className = 'reaction-option';
      control.setAttribute('aria-label', t('Реакция: {label}', { label: reaction.label }));
      control.setAttribute('aria-pressed', reaction.selected ? 'true' : 'false');
      control.append(image(reaction), node('span', reaction.label)); options.append(control);
    }
    dialog.append(header, options);
    dialog.addEventListener('close', () => {
      dialog.remove(); if (picker === dialog) picker = null;
      if (bar.isConnected) bar.querySelector('.reaction-add')?.focus({ preventScroll: true });
    }, { once: true });
    dialog.addEventListener('click', event => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
    });
    document.body.append(dialog); updateControls(); dialog.showModal();
    (options.querySelector('.reaction-option[aria-pressed="true"]') || options.querySelector('.reaction-option'))?.focus();
  };
  const fill = () => {
    bar.replaceChildren();
    for (const reaction of reactions.filter(reaction => reaction.count > 0)) {
      const control = button('', () => choose(reaction));
      control.className = 'reaction-button'; control.title = reaction.label;
      control.setAttribute('aria-label', t('Реакция: {label}', { label: reaction.label }));
      control.setAttribute('aria-pressed', reaction.selected ? 'true' : 'false');
      control.append(image(reaction), node('span', String(reaction.count), 'reaction-count')); bar.append(control);
    }
    const add = button('+', openPicker); add.className = 'reaction-add';
    add.title = t('Добавить реакцию'); add.setAttribute('aria-label', t('Добавить реакцию'));
    add.setAttribute('aria-haspopup', 'dialog'); bar.append(add); updateControls();
  };
  fill(); return bar;
}
function composerEmojis(textarea) {
  const details = node('details', null, 'composer-emojis'); details.id = 'composer-emojis';
  details.append(node('summary', t('Эмодзи из реакций')));
  const choices = node('div', null, 'composer-emoji-options');
  const seen = new Set();
  for (const reaction of reactionEmojis) {
    const code = reaction.file.replace(/\.[^.]+$/, '');
    if (seen.has(code)) continue;
    seen.add(code);
    const token = ':' + code + ':';
    const control = button('', async () => {
      if (readOnly || presentation() || textarea.disabled) return;
      textarea.focus({ preventScroll: true });
      const start = textarea.selectionStart, end = textarea.selectionEnd;
      if (textarea.value.length - (end - start) + token.length > textarea.maxLength) { notify(t('Достигнут лимит длины сообщения.')); return; }
      textarea.setRangeText(token, start, end, 'end'); textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    control.className = 'composer-emoji'; control.title = reaction.label + ' ' + token;
    control.setAttribute('aria-label', t('Вставить {code}', { code: token }));
    const image = node('img'); image.src = reaction.url; image.alt = ''; image.loading = 'lazy';
    control.append(image, node('span', token)); choices.append(control);
  }
  details.append(choices);
  if (!seen.size) details.append(node('p', t('В каталоге пока нет эмодзи.')));
  $('.markdown-help').after(details);
}
function date(value) { return new Date(value).toLocaleString(locale()); }
function empty(container, text) { container.replaceChildren(node('p', text, 'empty')); }
function paginate(data) {
  const nav = $('#pagination'); nav.replaceChildren();
  const pageLink = (text, page) => {
    const query = new URLSearchParams(location.search); query.set('page', page);
    return link(text, location.pathname + '?' + query);
  };
  if (data.page > 1) nav.append(pageLink(t("← Назад"), data.page - 1));
  nav.append(node('span', t('Страница {page}', { page: data.page })));
  if (data.has_more) nav.append(pageLink(t("Далее →"), data.page + 1));
}
function pageQuery() {
  const q = new URLSearchParams();
  q.set('page', params.get('page') || '1');
  q.set('limit', '20');
  return q;
}
function identityUI() {
  $('#auth-form').hidden = !!me; $('#account').hidden = !me;
  if (me) $('#account-name').replaceChildren(link(me.username, '/profile.html?id=' + me.id), ` · ${roleLabels[me.role]}${me.is_banned ? t(' · Заблокирован') : ''}`);
  $('#my-link').hidden = !me;
  $('#profile-link').hidden = !me;
  if (me) $('#profile-link').href = '/profile.html?id=' + me.id;
  $('#queue-link').hidden = !staff();
  if ($('#queue-tab')) $('#queue-tab').hidden = !staff();
}
async function loadSections() {
  sections = await api('/sections');
  const side = $('#sections'); side.replaceChildren();
  if (!sections.length) side.append(node('p', t("Разделов пока нет. Администратор может создать первый в панели публикаций.")));
  for (const section of sections) {
    const details = node('details');
    const summary = node('summary'); summary.append(link(section.title + (section.is_archived ? t(" [архив]") : ''), '/index.html?section_id=' + section.id));
    details.className = 'section-item'; details.dataset.sectionId = section.id;
    details.open = sectionOpen(section.id);
    details.addEventListener('toggle', () => {
      if (details.isConnected && sectionOpen(section.id) !== details.open) rememberSection(section.id, details.open);
    });
    details.append(summary);
    if (section.description) details.append(node('p', section.description, 'section-description'));
    const recent = node('ol', null, 'section-recent'); recent.setAttribute('aria-label', t("Последние сообщения: ") + section.title);
    for (const item of section.recent_posts || []) {
      const row = node('li');
      const a = link(`${item.is_root ? t("Тема") : t("Ответ")}: ${item.title}`, item.url);
      a.title = `${item.username || t("Аноним")} · ${date(item.created_at)}`;
      row.append(a, node('span', item.excerpt, 'section-excerpt'));
      if (item.status === 'pending') row.append(node('span', labels.pending, 'post-status'));
      recent.append(row);
    }
    if (recent.childElementCount) details.append(recent);
    else details.append(node('p', t("Сообщений пока нет."), 'section-description'));
    side.append(details);
  }
  const select = $('#section-select');
  if (select) {
    select.replaceChildren();
    for (const section of sections) {
      const option = node('option', section.title + (section.is_archived ? t(" [архив]") : ''));
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
    const row = node('tr'), when = node('td', new Date(item.created_at).toLocaleDateString(locale()), 'news-date');
    const title = node('td'); title.append(link(item.title, '/post.html?id=' + item.id));
    if (item.status === 'pending') title.append(node('span', t(" — Ожидает проверки"), 'post-status'));
    row.append(when, title); table.append(row);
  }
  if (!news.items.length) {
    const row = node('tr'); row.append(node('td', t("Опубликованных новостей пока нет."))); table.append(row);
  }
}
async function profile(id) {
  const user = await api('/users/' + id);
  const dialog = node('dialog');
  dialog.append(link(t("Открыть страницу пользователя →"), '/profile.html?id=' + id), node('h2', user.username), node('p', t('{role} · С нами с {date}', { role: roleLabels[user.role], date: date(user.created_at) })), node('p', user.is_banned ? t("Аккаунт заблокирован") : t("Аккаунт активен")));
  if ('auto_approve' in user) dialog.append(node('p', t("Автоподтверждение: ") + (user.auto_approve ? t("выдано") : t("не выдано"))));
  const canManage = staff() && user.id !== me.id && user.role !== 'admin' && (admin() || user.role === 'user');
  if (canManage) {
    dialog.append(moderation.profileTools(user, true, async () => { dialog.close(); await loadView(); await profile(id); }));
    for (const [action, enabled, text] of [
      ['trust', !user.auto_approve, user.auto_approve ? t("Отозвать автоподтверждение") : t("Выдать автоподтверждение")],
      ['ban', !user.is_banned, user.is_banned ? t("Снять бан") : t("Забанить")],
    ]) dialog.append(button(text, async () => {
      if (!confirm(`${text}: ${user.username}?`)) return;
      await post(`/users/${id}/${action}`, { enabled }); dialog.close(); await profile(id);
    }));
    if (admin()) dialog.append(button(user.role === 'moderator' ? t("Снять модератора") : t("Назначить модератором"), async () => {
      if (!confirm(t("Изменить роль ") + user.username + '?')) return;
      await post(`/users/${id}/role`, { role: user.role === 'moderator' ? 'user' : 'moderator' }); dialog.close(); await profile(id);
    }));
  }
  dialog.append(button(t("Закрыть"), async () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}
function showImage(file) {
  if ($('.image-viewer')) return;
  const dialog = node('dialog', null, 'image-viewer');
  dialog.setAttribute('aria-label', t("Просмотр изображения: ") + file.original_name);
  const header = node('div', null, 'image-viewer-header');
  const close = button(t("Закрыть"), async () => dialog.close());
  header.append(node('strong', file.original_name), link(t("Скачать оригинал"), file.download_url), close);
  const status = node('p', t("Загрузка изображения…")); status.setAttribute('role', 'status');
  const stage = node('div', null, 'image-viewer-stage');
  const image = node('img'); image.alt = file.original_name;
  image.addEventListener('load', () => { status.hidden = true; });
  image.addEventListener('error', () => { status.hidden = false; status.textContent = t("Не удалось загрузить изображение. Возможно, доступ к сообщению изменился."); });
  stage.append(image); dialog.append(header, status, stage);
  const focused = document.activeElement;
  dialog.addEventListener('close', () => {
    image.removeAttribute('src'); dialog.remove(); document.body.classList.remove('viewer-open');
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }, { once: true });
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  document.body.append(dialog); document.body.classList.add('viewer-open');
  dialog.showModal(); close.focus(); image.src = file.view_url;
}
function flashPlayer(file) {
  const box = node('div', null, 'flash-player');
  const status = node('p', t('Flash запускается через Ruffle. Поддерживаются не все файлы; сеть и доступ к странице отключены.'));
  status.setAttribute('role', 'status');
  let frame = null, request = null, timeout = null, handler = null, observer = null;
  const clear = () => {
    clearTimeout(timeout); request?.abort(); request = null;
    if (handler) window.removeEventListener('message', handler); handler = null;
  };
  const stop = () => {
    clear(); observer?.disconnect(); observer = null; frame?.remove(); frame = null;
    start.disabled = false; end.hidden = true;
  };
  box.stop = stop;
  const start = button(t('Запустить Flash'), async () => {
    stop(); start.disabled = true; end.hidden = false; status.textContent = t('Загрузка Flash…');
    request = new AbortController(); const current = request;
    try {
      // Fetch through the authenticated API in the parent, never expose session/token to the sandbox.
      const response = await fetch(file.view_url, { signal: current.signal, headers: presentation() ? { 'X-ForBirds-Public-View': '1' } : {} });
      if (!response.ok) throw new Error();
      const bytes = await response.arrayBuffer();
      if (current.signal.aborted || !box.isConnected) return;
      if (bytes.byteLength < 15 || bytes.byteLength > 5 * 1024 * 1024) throw new Error();
      frame = node('iframe', null, 'attachment-flash');
      frame.title = t('Flash: ') + file.original_name;
      frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
      const active = frame; let sent = false;
      const fail = () => { stop(); status.textContent = t('Не удалось запустить Flash. Возможно, файл несовместим или доступ к нему изменился.'); };
      handler = event => {
        if (event.source !== active.contentWindow || event.origin !== 'null') return;
        if (event.data?.type === 'forbirds-flash-ready' && !sent) {
          sent = true; active.contentWindow.postMessage({ type: 'forbirds-flash-load', bytes }, '*', [bytes]);
        } else if (event.data?.type === 'forbirds-flash-loaded' && sent) {
          clearTimeout(timeout); status.textContent = t('Flash запущен через Ruffle.');
        } else if (event.data?.type === 'forbirds-flash-error') fail();
      };
      window.addEventListener('message', handler);
      timeout = setTimeout(fail, 60000);
      frame.src = '/flash-player.html'; box.append(frame);
      observer = new MutationObserver(() => { if (!box.isConnected) stop(); });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch {
      if (current.signal.aborted || !box.isConnected) return;
      stop(); status.textContent = t('Не удалось запустить Flash. Возможно, файл несовместим или доступ к нему изменился.');
    }
  });
  const end = button(t('Остановить Flash'), async () => { stop(); status.textContent = t('Flash остановлен.'); }); end.hidden = true;
  window.addEventListener('pagehide', stop, { once: true });
  box.append(start, end, status); return box;
}
function videoPlayer(file) {
  const video = node('video', null, 'attachment-video');
  video.controls = true; video.preload = 'none'; video.playsInline = true;
  video.setAttribute('aria-label', t("Видео: ") + file.original_name);
  video.src = file.view_url;
  const fallback = node('p', t("Если браузер не поддерживает кодек этого видео, скачайте оригинал."), 'video-help');
  fallback.hidden = true;
  video.addEventListener('error', () => { fallback.hidden = false; });
  const player = node('div'); player.append(video, fallback); return player;
}
function audioPlayer(file) {
  const audio = node('audio', null, 'attachment-audio');
  audio.controls = true; audio.preload = 'none';
  audio.setAttribute('aria-label', t('Аудио: ') + file.original_name);
  audio.src = file.view_url;
  const fallback = node('p', t('Если браузер не поддерживает формат аудио, скачайте оригинал.'), 'audio-help');
  fallback.hidden = true;
  audio.addEventListener('error', () => { fallback.hidden = false; });
  const player = node('div'); player.append(audio, fallback); return player;
}
function postBody(text) {
  const body = node('div', null, 'post-body markdown-body');
  // Only fixed, locally bundled markdown-it output. Raw HTML and Markdown images are disabled; shortcode images use the local reaction catalog.
  body.innerHTML = renderMarkdown(text, reactionEmojis);
  return body;
}
function flagBadge(flag) {
  const badge = node('span', null, 'user-flag');
  const image = node('img'); image.src = flag.url; image.alt = ''; image.title = flag.label;
  badge.append(image, node('span', flag.label));
  return badge;
}
function renderPost(item, { title = '', threadLink = true, replyCount, pendingReplyCount = 0 } = {}) {
  const table = node('table', null, 'post-table ' + (item.is_root ? 'p' : 'pl'));
  table.dataset.status = item.status;
  table.dataset.restricted = item.is_hidden || item.is_blocked ? '1' : '0';
  const tbody = node('tbody'), row = node('tr'), author = node('td', null, 'post-author'), content = node('td', null, 'post-content');
  const name = node('div', null, 'author-name');
  const username = item.username || t("Аноним");
  if (item.user_id) {
    const a = link(username, '/profile.html?id=' + item.user_id);
    a.className = 'role-' + (item.author_role === 'moderator' ? 'mod' : item.author_role || 'user');
    if (item.author_banned) { const s = node('s'); s.append(a); name.append(s); } else name.append(a);
  } else name.textContent = username;
  const avatar = node('img', null, 'avatar'); avatar.src = item.avatar_url || '/avatars/noavatar.png'; avatar.alt = ''; avatar.width = 100; avatar.height = 100;
  author.append(name, node('div', roleLabels[item.author_role] || t("Гость"), 'author-rank'), avatar);
  if (admin()) author.append(moderation.identityBadge(item.id));
  if (item.flag) author.append(flagBadge(item.flag));
  const header = node('div', null, 'post-header');
  if (title) {
    const heading = node('b'); heading.append(threadLink ? link(title, '/post.html?id=' + item.thread_id) : node('span', title)); header.append(heading);
  }
  const number = link('№' + item.id, '/post.html?id=' + item.thread_id + '#post-' + item.id);
  number.className = 'post-number'; header.append(number);
  const time = node('time', date(item.created_at)); time.dateTime = item.created_at; header.append(time);
  if (item.status !== 'approved' || staff()) header.append(node('span', labels[item.status], 'post-status'));
  if (item.is_hidden) header.append(node('span', t('Пост скрыт'), 'post-status'));
  if (item.is_blocked) header.append(node('span', t('Пост заблокирован'), 'post-status'));
  if (staff()) header.append(moderation.postControls(item));
  content.append(header, node('hr'), postBody(item.body));
  if (item.attachments?.length) {
    const files = node('div', null, 'attachments');
    for (const file of item.attachments) {
      const box = node('div', null, (file.is_image ? 'image-box' : file.is_video ? 'video-box' : file.is_audio ? 'audio-box' : file.is_flash ? 'flash-box' : 'file-box') + (file.spoiler ? ' spoiler' : ''));
      if (staff()) box.append(moderation.fileTools(file));
      if (!file.download_url) {
        box.append(node('p', file.original_name + ' · ' + (file.blocked ? t('Файл заблокирован') : file.moderation_state === 'deleted' ? t('Файл удалён') : t('Файл скрыт'))));
        files.append(box); continue;
      }
      if (file.is_image) {
        const open = link('', file.view_url);
        open.setAttribute('aria-haspopup', 'dialog');
        open.addEventListener('click', event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); showImage(file);
        });
        open.setAttribute('aria-label', (file.spoiler ? t("Открыть изображение под спойлером: ") : t("Открыть изображение: ")) + file.original_name);
        const image = node('img', null, file.spoiler ? 'spoiler-marker img2x' : 'attachment-preview');
        image.src = file.spoiler ? '/static/preview/spolier.png' : file.preview_url;
        image.alt = file.spoiler ? t("Изображение под спойлером") : t("Превью: ") + file.original_name;
        image.loading = 'lazy';
        open.append(image); box.append(open, node('div', file.original_name));
        box.append(link(t("Скачать полноразмерную картинку"), file.download_url));
      } else if (file.is_flash) {
        const player = flashPlayer(file);
        if (file.spoiler) {
          const details = node('details'); details.append(node('summary', t('Flash под спойлером: ') + file.original_name), player);
          details.addEventListener('toggle', () => { if (!details.open) player.stop(); });
          box.append(details);
        } else box.append(node('div', file.original_name), player);
        box.append(link(t('Скачать Flash: ') + file.original_name, file.download_url));
      } else if (file.is_audio) {
        if (file.spoiler) {
          const details = node('details'), summary = node('summary', t('Аудио под спойлером: ') + file.original_name);
          details.append(summary);
          details.addEventListener('toggle', () => {
            if (details.open && !details.querySelector('audio')) details.append(audioPlayer(file));
            if (!details.open) details.querySelector('audio')?.pause();
          });
          box.append(details);
        } else box.append(node('div', file.original_name), audioPlayer(file));
        box.append(link(t('Скачать аудио: ') + file.original_name, file.download_url));
      } else if (file.is_video) {
        if (file.spoiler) {
          const details = node('details'), summary = node('summary', t("Видео под спойлером: ") + file.original_name);
          details.append(summary);
          details.addEventListener('toggle', () => {
            if (details.open && !details.querySelector('video')) details.append(videoPlayer(file));
            if (!details.open) details.querySelector('video')?.pause();
          });
          box.append(details);
        } else box.append(node('div', file.original_name), videoPlayer(file));
        box.append(link(t("Скачать видео: ") + file.original_name, file.download_url));
      } else {
        const icon = node('img', null, 'img2x'); icon.src = '/icons/file.png'; icon.alt = '';
        box.append(icon);
        if (file.spoiler) {
          const details = node('details'), summary = node('summary', t("Файл под спойлером"));
          details.append(summary, link(file.original_name, file.download_url)); box.append(details);
        } else box.append(link(file.original_name, file.download_url));
      }
      box.append(node('div', t('{size} КиБ', { size: (file.byte_size / 1024).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }))); files.append(box);
    }
    content.append(files);
  }
  if (item.reactions?.length) content.append(reactionBar(item));
  if (replyCount !== undefined) {
    const links = node('p', null, 'post-links');
    const count = t('Ответов: {count}', { count: replyCount }) + (staff() && pendingReplyCount ? t(' (на проверке: {count})', { count: pendingReplyCount }) : '');
    links.append(link(count + ' →', '/post.html?id=' + item.thread_id)); content.append(links);
  }
  if (staff() && item.status !== 'deleted') {
    const tools = node('div', null, 'mod-tools');
    for (const [action, text] of [['approve', t("Подтвердить")], ['unapprove', t("Снять подтверждение")], ['reject', t("Отклонить")], ['delete', t("Удалить")]]) {
      const b = button(text, async () => {
        if (action === 'delete' && !confirm(t("Удалить сообщение №") + item.id + '?')) return;
        b.disabled = true;
        try {
          await post(`/posts/${item.id}/moderate`, { action });
          notify(t('Сообщение №{id}: {status}', { id: item.id, status: labels[{ approve: 'approved', unapprove: 'pending', reject: 'rejected', delete: 'deleted' }[action]] }), false);
          await loadView(); await loadNews(); await loadSections();
        } finally { if (b.isConnected) b.disabled = readOnly; }
      });
      b.disabled = (action === 'approve' && (item.status === 'approved' || item.is_blocked)) || (action === 'unapprove' && item.status === 'pending');
      tools.append(b);
    }
    tools.append(moderation.moveButton(item));
    if (item.user_id && item.user_id !== me.id && item.author_role !== 'admin') tools.append(button(t("Права / бан автора"), () => profile(item.user_id)));
    header.append(tools);
  }
  row.append(author, content); tbody.append(row); table.append(tbody); table.id = 'post-' + item.id;
  return table;
}
async function loadFeed() {
  const query = pageQuery(), sectionId = params.get('section_id'), search = params.get('q');
  let title = t("Главная"), description = '';
  if (sectionId) {
    query.set('section_id', sectionId);
    const section = sections.find(s => String(s.id) === sectionId);
    title = section?.title || t("Раздел"); description = section?.description || '';
  } else if (search) {
    query.set('q', search); title = t("Поиск: ") + search; description = t("Поиск по опубликованным темам и ответам.");
  } else if (params.get('view') === 'all') { title = t("Все темы"); description = t("Публикации из всех разделов."); }
  else if (staff()) description = '';
  else query.set('featured', '1');
  $('#page-title').textContent = title; $('#feed-description').textContent = description;
  const container = $('#feed');
  const data = await api('/threads?' + query);
  const posts = await Promise.all(data.items.map(t => api('/posts/' + t.post_id).then(p => ({ ...t, post: p })).catch(() => null)));
  container.replaceChildren();
  for (const item of posts.filter(Boolean)) container.append(renderPost(item.post, { title: item.title, replyCount: item.reply_count, pendingReplyCount: item.pending_reply_count }));
  if (!posts.filter(Boolean).length) empty(container, t("Тем пока нет. Создайте первую тему или выберите другой раздел."));
  paginate(data);
}
async function loadThread() {
  const id = params.get('id');
  if (!/^[1-9][0-9]*$/.test(id || '')) throw new Error(t("Не указан номер темы. Выберите тему в ленте."));
  const data = await api('/threads/' + id + '?' + pageQuery());
  $('#page-title').textContent = data.title; document.title = data.title + ' — BirdArmageddon';
  $('#back-to-section').href = '/index.html?section_id=' + data.section_id;
  const container = $('#thread'); container.replaceChildren(renderPost(data.post, { title: data.title, threadLink: false }));
  container.append(node('hr'));
  for (const reply of data.replies.items) container.append(renderPost(reply));
  if (!data.replies.items.length) container.append(node('p', t("Ответов пока нет.")));
  paginate(data.replies);
  const settings = $('#thread-settings'); settings.replaceChildren();
  if (staff()) {
    for (const [key, title] of [['is_locked', t("Тема закрыта")], ['is_news', t("В новостях")], ['is_featured', t("На главной")]]) {
      const label = node('label', title + ' '), input = node('input'); input.type = 'checkbox'; input.checked = !!data[key];
      input.addEventListener('change', async () => {
        input.disabled = true;
        try { await post(`/threads/${id}/settings`, { [key]: input.checked }); await loadThread(); await loadNews(); }
        catch (e) { input.checked = !input.checked; notify(e); } finally { input.disabled = readOnly; }
      }); label.prepend(input); settings.append(label);
    }
  }
  const section = sections.find(s => s.id === data.section_id);
  const blocked = presentation() || readOnly || !!me?.is_banned || (!staff() && (!!data.is_locked || !!section?.is_archived));
  $('#composer').hidden = blocked;
  if (blocked && !presentation()) container.append(node('p', readOnly ? t('Для этого подключения, браузера или аккаунта доступно только чтение.') : me?.is_banned ? t("Аккаунт заблокирован.") : t("Тема или раздел закрыты для публикации.")));
  if (!blocked && !composer) composer = new Composer(id);
}
async function loadDashboard() {
  const mode = params.get('mode') || 'new';
  const container = $('#dashboard-content'); container.replaceChildren();
  if (presentation()) return;
  $('#composer').hidden = mode !== 'new' || readOnly || !!me?.is_banned;
  $('#section-admin').hidden = !admin() || mode !== 'new';
  if (mode === 'new') {
    if (!composer && !readOnly && !me?.is_banned) composer = new Composer(null);
    if (!sections.length) container.append(node('p', t("Сначала администратор должен добавить раздел ниже.")));
    if (me?.is_banned) container.append(node('p', t("Аккаунт заблокирован. Публикация недоступна.")));
    return;
  }
  if (mode === 'updates') {
    if (!admin()) { empty(container, t('Для этого действия нужны права администратора.')); return; }
    await siteUpdateUI(container, { node, button, api, post, readOnly }); return;
  }
  if (mode === 'falseflags') {
    if (!admin()) { empty(container, t('Для этого действия нужны права администратора.')); return; }
    const data = await api('/admin/falseflags?' + pageQuery());
    if (!data.items.length) empty(container, t('Закрытый журнал пуст.'));
    for (const entry of data.items) {
      const row = node('p');
      row.append(link('№' + entry.post_id, '/post.html?id=' + entry.thread_id + '#post-' + entry.post_id),
        node('span', ` · ${date(entry.created_at)} · ${entry.actor_name} → ${entry.target_name} · ${entry.reason}`));
      container.append(row);
    }
    paginate(data); return;
  }
  if (mode === 'media-bans' || mode === 'identity-bans' || mode === 'description-bans' || mode === 'network-bans') {
    paginate(await moderation.bans(container, mode)); return;
  }
  if (mode === 'queue' || mode === 'audit' || mode === 'archive' || mode === 'restricted') {
    if (!staff()) { empty(container, t("Для этой страницы нужны права модератора.")); return; }
    container.append(link(mode === 'queue' ? t("Журнал модерации →") : t("← Очередь"), '?mode=' + (mode === 'queue' ? 'audit' : 'queue')));
    const data = await api('/moderation/' + mode + '?' + pageQuery());
    if (!data.items.length) container.append(node('p', mode === 'queue' ? t("Очередь пуста.") : mode !== 'audit' ? t("Сообщений пока нет.") : t("Журнал пуст.")));
    if (mode === 'audit') {
      for (const entry of data.items) container.append(node('p', `${date(entry.created_at)} · #${entry.actor_id}: ${entry.action} · ${entry.target_type} №${entry.target_id} · ${entry.details}`));
    } else {
      const posts = await Promise.all(data.items.map(p => api('/posts/' + p.id).then(detail => ({ ...p, ...detail }))));
      for (const p of posts) container.append(renderPost(p, { title: p.title }));
    }
    paginate(data); return;
  }
  if (mode === 'mine') {
    if (!me) { empty(container, t("Войдите, чтобы видеть свои сообщения, в том числе ожидающие проверки.")); return; }
    const data = await api('/me/posts?' + pageQuery());
    const posts = await Promise.all(data.items.map(p => api('/posts/' + p.id).catch(() => ({ ...p, username: me.username, author_role: me.role }))));
    for (const p of posts) container.append(renderPost(p));
    if (!posts.length) empty(container, t("Вы ещё ничего не опубликовали."));
    paginate(data); return;
  }
  empty(container, t("Неизвестная вкладка."));
}
async function loadProfile() {
  if (presentation() && !params.get('id')) return;
  const id = params.get('id') || (me ? String(me.id) : '');
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error(t("Выберите пользователя или войдите, чтобы открыть свой профиль."));
  const user = await api('/users/' + id);
  const data = await api(`/users/${id}/posts?` + pageQuery());
  $('#page-title').textContent = t("Профиль: ") + user.username;
  document.title = user.username + ' — BirdArmageddon';
  $('#profile').hidden = false;
  $('#profile-name').textContent = user.username;
  $('#profile-avatar').src = user.avatar_url;
  $('#profile-flag').replaceChildren(...(user.flag ? [flagBadge(user.flag)] : []));
  $('#profile-description').textContent = user.description || t("Пользователь пока ничего не рассказал о себе.");
  $('#profile-meta').textContent = t('{role} · С нами с {date}', { role: roleLabels[user.role], date: date(user.created_at) }) + (user.is_banned ? t(' · Заблокирован') : '');
  const actions = $('#profile-actions'); actions.replaceChildren();
  if (staff()) actions.append(button(t("Права / бан пользователя"), () => profile(user.id)));
  actions.append(moderation.profileTools(user, staff() && user.id !== me.id && user.role !== 'admin' && (admin() || user.role === 'user')));
  const own = !presentation() && me?.id === user.id;
  $('#profile-editor').hidden = !own || !!me?.is_banned;
  if (own) {
    $('#profile-bio').value = user.description;
    $('#profile-bio').disabled = !!user.description_locked;
    profileForm.elements.avatar.disabled = !!user.avatar_locked;
    profileForm.elements.remove_avatar.disabled = !!user.avatar_locked;
    let locks = $('#profile-locks');
    if (!locks) { locks = node('p'); locks.id = 'profile-locks'; profileForm.prepend(locks); }
    locks.textContent = user.avatar_locked || user.description_locked ? t('Некоторые поля профиля заблокированы модератором.') : '';
    const flags = await api('/flags');
    const select = $('#profile-flag-select');
    select.replaceChildren();
    const none = node('option', t("Без флага")); none.value = ''; select.append(none);
    for (const flag of flags) {
      const option = node('option', flag.label); option.value = flag.file; select.append(option);
    }
    select.value = user.flag?.file || '';
    const preview = () => {
      const flag = flags.find(item => item.file === select.value);
      $('#profile-flag-preview').replaceChildren(...(flag ? [flagBadge(flag)] : []));
    };
    select.onchange = preview; preview();
    $('#profile-flag-help').textContent = flags.length ? t("Флаг отображается в профиле и возле ваших сообщений. Выбор необязателен.") : t("В папке флагов пока нет доступных изображений.");
  }
  $('#profile-posts-note').textContent = staff() ? t("Вам как сотруднику видны все статусы сообщений.")
    : own ? t("Здесь также видны ваши ожидающие проверки сообщения в доступных вам темах.") : t("Только опубликованные сообщения в открытых для просмотра темах.");
  const container = $('#profile-posts'); container.replaceChildren();
  if (!data.items.length) empty(container, t("Нет доступных сообщений."));
  else {
    const table = node('table', null, 'table news-table profile-posts-table');
    const caption = node('caption', t("Темы и ответы · новые сверху"));
    const head = node('thead'), headers = node('tr');
    for (const text of [t("Дата"), t("Сообщение")]) { const th = node('th', text); th.scope = 'col'; headers.append(th); }
    head.append(headers);
    const rows = node('tbody');
    for (const item of data.items) {
      const row = node('tr'), when = node('td', null, 'news-date');
      const time = node('time'); time.dateTime = item.created_at;
      const timestamp = new Date(item.created_at);
      time.append(node('span', timestamp.toLocaleDateString(locale())), node('span', timestamp.toLocaleTimeString(locale())));
      when.append(time);
      const content = node('td');
      content.append(link(`${item.is_root ? t("Тема") : t("Ответ")}: ${item.title} · №${item.id}`, item.url));
      if (item.status !== 'approved' || staff()) content.append(node('span', ' — ' + labels[item.status], 'post-status'));
      content.append(node('div', item.excerpt, 'profile-excerpt'));
      if (admin()) content.append(moderation.identityBadge(item.id));
      if (item.is_hidden) content.append(node('span', t('Пост скрыт'), 'post-status'));
      if (item.is_blocked) content.append(node('span', t('Пост заблокирован'), 'post-status'));
      row.dataset.restricted = item.is_hidden || item.is_blocked ? '1' : '0';
      row.dataset.status = item.status; row.append(when, content); rows.append(row);
    }
    table.append(caption, head, rows); container.append(table);
  }
  paginate(data);
}

const profileForm = $('#profile-form');
if (profileForm) {
  profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = profileForm.querySelector('[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true;
    const result = $('#profile-result'); result.textContent = t("Сохранение…");
    try {
      const data = new FormData(profileForm), file = profileForm.elements.avatar.files[0];
      if (!file) data.delete('avatar');
      if (!profileForm.elements.remove_avatar.disabled) data.set('remove_avatar', profileForm.elements.remove_avatar.checked ? '1' : '0');
      if (file && file.size > 2 * 1024 * 1024) throw new Error(t("Аватарка должна быть не больше 2 МиБ."));
      me = await post('/me/profile', data);
      profileForm.reset(); identityUI(); await loadProfile();
      result.textContent = t("Профиль сохранён.");
    } catch (error) { result.textContent = error.message; }
    finally { submit.disabled = readOnly; }
  });
  profileForm.elements.avatar.addEventListener('change', () => {
    if (profileForm.elements.avatar.files.length) profileForm.elements.remove_avatar.checked = false;
  });
  profileForm.elements.remove_avatar.addEventListener('change', () => {
    if (profileForm.elements.remove_avatar.checked) profileForm.elements.avatar.value = '';
  });
}

async function loadView() {
  try { return await loadCurrentView(); } finally { applyReadOnly(); }
}
async function loadCurrentView() {
  if (document.body.dataset.page === 'index') return loadFeed();
  if (document.body.dataset.page === 'post') return loadThread();
  if (document.body.dataset.page === 'profile') return loadProfile();
  return loadDashboard();
}

class Composer {
  constructor(threadId) {
    this.threadId = threadId; this.files = []; this.proof = null; this.worker = null;
    this.until = 0; this.busy = false; this.interval = me ? 30 : 45; this.ready = false;
    this.form = $('#post-form');
    composerEmojis(this.form.elements.body);
    $('#composer').hidden = false;
    $('#topic-fields').hidden = !!threadId;
    $('#publish-flags').hidden = !!threadId || !staff();
    $('#section-select').required = !threadId;
    this.form.elements.title.required = !threadId;
    $('#falseflag-controls').hidden = !admin();
    const attributionControls = () => {
      const enabled = admin() && $('#falseflag-enabled').checked;
      for (const input of [$('#falseflag-user'), $('#falseflag-reason')]) { input.disabled = !enabled || readOnly; input.required = enabled; }
    };
    $('#falseflag-enabled').checked = false;
    $('#falseflag-enabled').addEventListener('change', attributionControls);
    this.resetAttribution = () => {
      $('#falseflag-enabled').checked = false; $('#falseflag-user').value = ''; $('#falseflag-reason').value = ''; attributionControls();
    };
    this.resetAttribution();
    $('#pow-start').addEventListener('click', () => this.solve().catch(notify));
    $('#pow-cancel').addEventListener('click', () => this.cancel(t("Проверка отменена.")));
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
      if (!this.proof && !this.worker) $('#pow-status').textContent = t("Нажмите кнопку для одноразовой проверки перед отправкой.");
    } finally {
      // Issuing a challenge rechecks the server's timer after a transient read failure.
      this.ready = true; this.controls();
    }
  }
  cancel(message = t("Нужна новая проверка.")) {
    if (this.worker) this.worker.terminate(); this.worker = null; this.proof = null;
    $('#pow-status').textContent = message; this.controls();
  }
  controls() {
    const wait = Math.max(0, Math.ceil((this.until - Date.now()) / 1000));
    if (this.proof && Date.now() >= this.proof.expires_at * 1000) this.cancel(t("Решение истекло. Вычислите новую проверку."));
    $('#cooldown').textContent = wait ? t('Следующая публикация через {seconds} сек. Затем решите проверку.', { seconds: wait }) : t('Интервал: {seconds} сек. Проверка обязательна для каждой публикации.', { seconds: this.interval });
    $('#pow-start').disabled = readOnly || !this.ready || !!wait || !!this.worker || this.busy;
    $('#pow-start').textContent = this.proof ? t("Вычислить заново") : t("Вычислить проверку");
    $('#pow-cancel').hidden = !this.worker;
    $('#post-submit').disabled = readOnly || !this.ready || !!wait || !this.proof || this.busy || !!me?.is_banned || (!this.threadId && !$('#section-select').value);
  }
  async solve() {
    if (!this.ready || this.busy || this.worker || Date.now() < this.until) return;
    this.cancel(t("Получение задачи…")); this.ready = false; this.controls();
    try {
      const challenge = await post('/pow/challenge');
      const worker = new Worker('/pow-worker.js'); this.worker = worker;
      $('#pow-status').textContent = t('Вычисление SHA-256 ({bits} бит)…', { bits: challenge.difficulty });
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') $('#pow-status').textContent = t('Подбираем хэш: {count} попыток…', { count: data.attempts.toLocaleString(locale()) });
        else if (data.type === 'solved') {
          worker.terminate(); this.worker = null;
          this.proof = { pow_id: challenge.id, pow_nonce: data.nonce, expires_at: challenge.expires_at };
          $('#pow-status').textContent = t("Проверка решена. Можно отправлять сообщение."); this.controls();
        } else { this.cancel(t({ pow_difficulty: 'Неподдерживаемая сложность проверки.', pow_timeout: 'Вычисление заняло слишком много времени. Попробуйте новую проверку.' }[data.code] || 'Ошибка вычисления.')); }
      };
      worker.onerror = () => this.cancel(t("Не удалось запустить вычисление. Проверьте поддержку Web Worker."));
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
      notify(t("Лимит: до 10 непустых файлов, 5 МиБ на файл, 20 МиБ суммарно.")); return;
    }
    this.files = next; this.renderFiles();
  }
  renderFiles() {
    const list = $('#file-list'); list.replaceChildren();
    this.files.forEach((entry, i) => {
      const item = node('li'), label = node('label', t("Под спойлером")), checkbox = node('input');
      checkbox.type = 'checkbox'; checkbox.checked = entry.spoiler;
      checkbox.addEventListener('change', () => { entry.spoiler = checkbox.checked; });
      label.prepend(checkbox);
      item.append(node('span', `${entry.file.name} · ` + t('{size} КиБ', { size: (entry.file.size / 1024).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })), label,
        button(t("Убрать"), async () => { if (!this.busy) { this.files.splice(i, 1); this.renderFiles(); } }));
      list.append(item);
    });
  }
  async submit() {
    if (this.busy) return;
    if (!this.proof || this.worker || Date.now() < this.until) { notify(t("Дождитесь окончания интервала и решите хэш-проверку.")); return; }
    if (!this.form.reportValidity()) return;
    this.busy = true; this.controls();
    const data = new FormData();
    data.set('body', this.form.elements.body.value);
    if (this.threadId) data.set('sage', this.form.elements.sage.checked ? '1' : '0');
    data.set('pow_id', this.proof.pow_id); data.set('pow_nonce', this.proof.pow_nonce);
    if (!this.threadId) {
      data.set('section_id', $('#section-select').value); data.set('title', this.form.elements.title.value);
      if (staff()) { data.set('is_news', this.form.elements.is_news.checked ? '1' : '0'); data.set('is_featured', this.form.elements.is_featured.checked ? '1' : '0'); }
    }
    this.files.forEach((entry, i) => { data.append('files[]', entry.file); if (entry.spoiler) data.append('spoilers[]', String(i)); });
    $('#post-result').textContent = t("Отправка…");
    try {
      if (admin() && $('#falseflag-enabled').checked) {
        const target = await api('/users/' + $('#falseflag-user').value);
        if (!confirm(t('Опубликовать от имени {name}? Действие попадёт в закрытый журнал.', { name: target.username }))) {
          $('#post-result').textContent = t('Публикация отменена.'); return;
        }
        data.set('post_as_user_id', String(target.id)); data.set('falseflag_reason', $('#falseflag-reason').value);
      }
      const result = await post(this.threadId ? `/threads/${this.threadId}/replies` : '/threads', data);
      const message = t('Сообщение №{id}: {status}.', { id: result.post_id, status: labels[result.status] });
      this.resetAttribution();
      this.form.elements.body.value = ''; this.files = []; this.renderFiles();
      this.cancel(t("Для следующей публикации нужна новая проверка."));
      // Never let a failed status refresh turn a successful POST into an apparent failure.
      this.until = Date.now() + this.interval * 1000;
      $('#post-result').textContent = message;
      if (!this.threadId && (me || result.status === 'approved')) {
        try { sessionStorage.setItem('forbirds-notice', JSON.stringify({ id: result.post_id, status: result.status })); } catch { /* Storage disabled. */ }
        location.assign('/post.html?id=' + result.thread_id); return;
      }
      notify(message, false);
      if (this.threadId) await loadThread().catch(notify);
      await loadSections().catch(notify);
      await this.refreshStatus().catch(notify);
    } catch (error) {
      $('#post-result').textContent = error.message;
      if (error.retryAfter) this.until = Date.now() + error.retryAfter * 1000;
      if (error.code?.startsWith('pow_') || error.code === 'posting_cooldown') this.cancel(t("Получите новую проверку."));
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
      form.reset(); await loadSections(); options(); notify(t("Раздел создан."), false); composer?.controls();
    } catch (e) { notify(e); } finally { submit.disabled = readOnly; }
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
      await loadSections(); options(); notify(t("Настройки раздела сохранены."), false);
    } catch (error) { notify(error); } finally { save.disabled = readOnly; }
  });
  options();
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
  try {
    await post('/auth/' + (event.submitter?.value || 'login'), Object.fromEntries(new FormData(form)));
    form.elements.password.value = ''; location.reload();
  } catch (error) { notify(error); } finally { buttons.forEach(b => { b.disabled = readOnly; }); }
});
$('#logout').addEventListener('click', async () => {
  try { await post('/auth/logout'); location.reload(); } catch (error) { notify(error); }
});
function presentationUI() {
  const change = async () => {
    if (!confirm(t('Переключить режим показа? Страницы в других вкладках тоже могут обновиться; сначала сохраните черновики.'))) return;
    for (const dialog of document.querySelectorAll('dialog[open]:not(#language-dialog)')) dialog.close();
    if (!window.ForBirdsPresentation?.set(!presentation())) {
      alert(t('Не удалось сохранить режим показа. Разрешите локальное хранилище браузера.')); return;
    }
    window.location.reload();
  };
  const toggle = button(t('Режим показа'), change);
  toggle.setAttribute('aria-keyshortcuts', 'Alt+Shift+M'); toggle.title = 'Alt+Shift+M';
  document.addEventListener('keydown', event => {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyM' && !event.repeat) { event.preventDefault(); change().catch(notify); }
  });
  toggle.id = 'presentation-toggle'; toggle.setAttribute('aria-pressed', presentation() ? 'true' : 'false');
  $('#language-switch').after(toggle);
  if (presentation() && (document.body.dataset.page === 'dashboard' || (document.body.dataset.page === 'profile' && !params.get('id')))) {
    const hint = node('p', t('Страница скрыта в режиме показа.')); hint.id = 'presentation-hint';
    document.querySelector('header').after(hint);
  }
}
async function main() {
  presentationUI();
  const session = await api('/session'); me = session.user; readOnly = !!session.read_only; identityUI();
  moderation.setIdentity(!presentation() && session.privacy_enabled);
  if ($('.dashboard-nav')) moderation.navigation($('.dashboard-nav'));
  // The control page must still work while normal API endpoints are in maintenance.
  if (document.body.dataset.page === 'dashboard' && params.get('mode') === 'updates' && !presentation()) {
    await loadDashboard(); applyReadOnly(); document.documentElement.classList.add('presentation-ready'); return;
  }
  reactionEmojis = await api('/reactions').catch(() => []);
  await Promise.all([loadSections(), loadNews()]);
  await loadView(); adminSections(); applyReadOnly();
  let message;
  try { message = sessionStorage.getItem('forbirds-notice'); } catch { /* Storage disabled. */ }
  if (message && !presentation()) {
    try { const notice = JSON.parse(message); notify(t('Сообщение №{id}: {status}.', { id: notice.id, status: labels[notice.status] }), false); } catch { /* Ignore obsolete notices. */ }
    sessionStorage.removeItem('forbirds-notice');
  }
  document.documentElement.classList.add('presentation-ready');
  if (/^#post-[0-9]+$/.test(location.hash)) $(location.hash)?.scrollIntoView();
}
main().catch(error => {
  if (presentation()) {
    const hint = $('#presentation-hint') || node('p'); hint.id = 'presentation-hint';
    hint.textContent = t('Страница недоступна в режиме показа.'); document.querySelector('header').after(hint); return;
  }
  notify(error);
  const target = $('#feed') || $('#thread') || $('#profile-posts') || $('#dashboard-content');
  if (target) empty(target, error.message);
});
