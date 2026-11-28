import { t, locale } from '/i18n.js';

export function moderationUI({ node, button, link, api, post, notify, refresh, staff, admin }) {
  let showIdentity = false;
  const panel = (title, classes) => {
    const tools = node('fieldset', null, 'mod-tools ' + classes);
    tools.append(node('legend', t(title))); return tools;
  };
  const actionButton = (action, label, callback) => {
    const control = button(label, callback);
    if (['delete', 'hashban', 'block', 'avatar_delete', 'avatar_hashban', 'description_delete', 'description_hashban'].includes(action)) control.classList.add('mod-danger');
    return control;
  };
  const reason = () => prompt(t('Причина действия (обязательно):'))?.trim();
  async function fillIdentity(element) {
    element.replaceChildren();
    if (!showIdentity || !admin()) return;
    try {
      const identity = await api(`/posts/${element.dataset.identityPost}/identity`);
      if (!showIdentity || !element.isConnected) return;
      element.textContent = `IP: ${identity.ip || '—'} · CID: ${identity.cid?.slice(0, 12) || '—'} · HID: ${identity.hid?.slice(0, 12) || '—'}`;
      const text = t('Блокировать подключение / браузер');
      element.append(button(text, async () => {
        const kind = prompt(t('Тип блокировки: cidr, browser или fingerprint'), 'cidr');
        if (!['cidr', 'browser', 'fingerprint'].includes(kind)) return;
        const value = kind === 'cidr' ? prompt(t('IP или CIDR-сеть:'), identity.ip || '') : '';
        if (kind === 'cidr' && !value) return;
        const hours = prompt(t('Срок в часах (1–8760):'), '24');
        if (!hours) return;
        const why = reason(); if (!why) return;
        if (!confirm(t('Блокировка может затронуть других людей. Продолжить?'))) return;
        await post('/moderation/identity-bans', { kind, value, post_id: Number(element.dataset.identityPost), hours, reason: why });
        notify(t('Блокировка добавлена.'), false);
      }));
    } catch (error) { if (showIdentity) element.textContent = error.message; }
  }
  function identityBadge(id) {
    const element = node('small', '', 'post-identity'); element.dataset.identityPost = id;
    // Inserted by the caller synchronously before the API response resolves.
    if (showIdentity && admin()) fillIdentity(element);
    return element;
  }
  function setIdentity(enabled) {
    showIdentity = !!enabled;
    document.querySelectorAll('[data-identity-post]').forEach(fillIdentity);
  }
  function fileTools(file) {
    const tools = panel('Модерация файла', 'file-tools');
    if (!staff() || file.moderation_state === 'deleted') return tools;
    const actions = [
      [file.spoiler ? 'unspoiler' : 'spoiler', file.spoiler ? t('Убрать спойлер') : t('Наложить спойлер')],
      [file.moderation_state === 'hidden' ? 'show' : 'hide', file.moderation_state === 'hidden' ? t('Показать файл') : t('Скрыть файл')],
      ['delete', t('Удалить файл навсегда')], ['hashban', t('Запретить файл и похожие изображения')],
    ];
    for (const [action, label] of actions) tools.append(actionButton(action, label, async () => {
      const why = reason(); if (!why) return;
      if (!confirm(label + ': ' + file.original_name + '?')) return;
      await post(`/attachments/${file.id}/moderate`, { action, reason: why });
      await refresh();
    }));
    return tools;
  }
  function moveButton(item) {
    return button(t('Переместить'), async () => {
      const target = prompt(item.is_root ? t('ID раздела назначения:') : t('ID темы назначения:'));
      if (!target) return;
      const why = reason(); if (!why) return;
      await post(`/posts/${item.id}/move`, { [item.is_root ? 'section_id' : 'thread_id']: target, reason: why });
      notify(t('Сообщение перемещено.'), false); await refresh();
    });
  }
  function profileTools(user, canManage, after = refresh) {
    const tools = panel('Модерация профиля', 'profile-moderation');
    if (!canManage) return tools;
    const actions = [
      ['avatar_delete', t('Удалить аватарку пользователя')],
      ['avatar_hashban', t('Запретить аватарку и похожие изображения')],
      [user.avatar_locked ? 'avatar_unlock' : 'avatar_lock', user.avatar_locked ? t('Разрешить смену аватарки') : t('Запретить смену аватарки')],
      ['description_delete', t('Очистить описание пользователя')],
      ['description_hashban', t('Запретить текст описания')],
      [user.description_locked ? 'description_unlock' : 'description_lock', user.description_locked ? t('Разрешить редактирование описания') : t('Запретить редактирование описания')],
    ];
    for (const [action, label] of actions) {
      const control = actionButton(action, label, async () => {
        const why = reason(); if (!why) return;
        if (!confirm(label + ': ' + user.username + '?')) return;
        await post(`/users/${user.id}/profile/moderate`, { action, reason: why });
        await after();
      });
      if ((action === 'avatar_delete' || action === 'avatar_hashban') && user.avatar_url === '/avatars/noavatar.png') control.disabled = true;
      if ((action === 'description_delete' || action === 'description_hashban') && !user.description) control.disabled = true;
      tools.append(control);
    }
    return tools;
  }
  function postControls(item) {
    const tools = panel('Ограничения доступа', 'post-restrictions');
    if (!staff()) return tools;
    for (const [action, label] of [
      [item.is_hidden ? 'unhide' : 'hide', item.is_hidden ? t('Вернуть видимость поста') : t('Скрыть пост от посетителей')],
      [item.is_blocked ? 'unblock' : 'block', item.is_blocked ? t('Разблокировать пост') : t('Заблокировать пост')],
    ]) tools.append(actionButton(action, label, async () => {
      const why = reason(); if (!why) return;
      if (!confirm(label + ' #' + item.id + '?')) return;
      await post(`/posts/${item.id}/restrict`, { action, reason: why });
      await refresh();
    }));
    return tools;
  }
  function navigation(container) {
    if (!staff()) return;
    for (const [mode, text] of [['archive', t('Удалённые и отклонённые')], ['restricted', t('Скрытые и заблокированные посты')], ['media-bans', t('Запреты файлов')], ['description-bans', t('Запреты описаний')]]) {
      container.append(link(text, '/dashboard.html?mode=' + mode), ' · ');
    }
    if (admin()) {
      container.append(link(t('Обновление сайта'), '/dashboard.html?mode=updates'), ' · ');
      container.append(link(t('Закрытый журнал фалзфлага'), '/dashboard.html?mode=falseflags'), ' · ');
      container.append(link(t('Автоблокировки Tor/I2P'), '/dashboard.html?mode=network-bans'), ' · ');
      container.append(link(t('Блокировки подключений'), '/dashboard.html?mode=identity-bans'), ' · ');
      const label = node('label', t('Показывать IP и идентификаторы (только администратор)'));
      const input = node('input'); input.type = 'checkbox'; input.id = 'show-identity'; input.checked = showIdentity;
      input.addEventListener('change', async () => {
        input.disabled = true;
        try {
          await post('/moderation/privacy', { enabled: input.checked });
          setIdentity(input.checked);
        } catch (error) { input.checked = showIdentity; notify(error); }
        finally { input.disabled = false; }
      });
      label.prepend(input); container.append(label);
    }
  }
  async function bans(container, mode) {
    if (!staff()) throw new Error(t('Для этой страницы нужны права модератора.'));
    const data = await api('/moderation/' + mode + '?' + new URLSearchParams({ page: new URLSearchParams(location.search).get('page') || '1', limit: '20' }));
    if (!data.items.length) container.append(node('p', t('Список блокировок пуст.')));
    for (const ban of data.items) {
      const row = node('p', `#${ban.id} · ${ban.kind || ''} ${ban.value || ''} · ${ban.reason} · ${ban.expires_at ? new Date(ban.expires_at * 1000).toLocaleString(locale()) : typeof ban.created_at === 'number' ? new Date(ban.created_at * 1000).toLocaleString(locale()) : ban.created_at}`);
      row.append(button(t('Снять блокировку'), async () => {
        const why = reason(); if (!why) return;
        await post(`/moderation/${mode}/${ban.id}/remove`, { reason: why });
        await refresh();
      }));
      container.append(row);
    }
    return data;
  }
  return { fileTools, moveButton, identityBadge, setIdentity, navigation, bans, profileTools, postControls };
}
