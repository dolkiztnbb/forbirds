import { t, locale } from '/i18n.js';

export function moderationUI({ node, button, link, api, post, notify, refresh, staff, admin }) {
  let showIdentity = false;
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
    const tools = node('div', null, 'mod-tools file-tools');
    if (!staff() || file.moderation_state === 'deleted') return tools;
    const actions = [
      [file.spoiler ? 'unspoiler' : 'spoiler', file.spoiler ? t('Убрать спойлер') : t('Наложить спойлер')],
      [file.moderation_state === 'hidden' ? 'show' : 'hide', file.moderation_state === 'hidden' ? t('Показать файл') : t('Скрыть файл')],
      ['delete', t('Удалить файл навсегда')], ['hashban', t('Запретить файл и похожие изображения')],
    ];
    for (const [action, label] of actions) tools.append(button(label, async () => {
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
  function navigation(container) {
    if (!staff()) return;
    for (const [mode, text] of [['archive', t('Удалённые и отклонённые')], ['media-bans', t('Запреты файлов')]]) {
      container.append(link(text, '/dashboard.html?mode=' + mode), ' · ');
    }
    if (admin()) {
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
      const row = node('p', `#${ban.id} · ${ban.kind || ''} ${ban.value || ''} · ${ban.reason} · ${ban.expires_at ? new Date(ban.expires_at * 1000).toLocaleString(locale()) : ban.created_at}`);
      row.append(button(t('Снять блокировку'), async () => {
        const why = reason(); if (!why) return;
        await post(`/moderation/${mode}/${ban.id}/remove`, { reason: why });
        await refresh();
      }));
      container.append(row);
    }
    return data;
  }
  return { fileTools, moveButton, identityBadge, setIdentity, navigation, bans };
}
