import { t, locale } from '/i18n.js';

export async function siteUpdateUI(container, { node, button, api, post, readOnly }) {
  const panel = node('section', null, 'site-update-panel'); panel.id = 'site-update-panel';
  panel.append(node('h2', t('Обновление сайта')),
    node('p', t('Сначала резервная копия SQLite, затем обновление из origin/main и миграции. Нужны чистая ветка main и настроенный серверный обработчик.')),
    node('p', t('На время обновления API перейдёт в режим обслуживания. Сначала сохраните черновики и сделайте внешнюю резервную копию данных.')));
  const status = node('p'); status.id = 'site-update-status'; status.setAttribute('role', 'status');
  const details = node('p'); details.id = 'site-update-details';
  const warning = node('p'); warning.id = 'site-update-warning';
  const feedback = node('p'); feedback.id = 'site-update-feedback'; feedback.setAttribute('role', 'alert');
  const form = node('form'); form.method = 'post'; form.id = 'site-update-form';
  const label = node('label', t('Текущий пароль администратора'));
  const password = node('input'); password.name = 'password'; password.type = 'password'; password.autocomplete = 'current-password'; password.required = true; password.minLength = 12; password.maxLength = 72; password.id = 'site-update-password';
  label.htmlFor = password.id;
  const submit = node('button', t('Обновить сайт')); submit.type = 'submit'; submit.id = 'site-update-start'; submit.disabled = true;
  form.append(label, password, submit);
  const reload = button(t('Перезагрузить страницу'), async () => location.reload());
  reload.hidden = true;
  panel.append(status, details, warning, form, feedback, reload); container.append(panel);
  const statuses = { idle: t('Обновление не запущено.'), queued: t('Заявка принята. Ожидание серверного обработчика.'), running: t('Выполняется обновление…'), succeeded: t('Код обновлён, миграции выполнены.'), failed: t('Обновление остановлено из-за ошибки.') };
  const phases = { queued: t('Ожидание'), preflight: t('Проверка рабочей копии'), maintenance: t('Ожидание завершения запросов'), backup: t('Резервная копия SQLite'), pull: t('Получение кода'), migrate: t('Миграции БД'), complete: t('Готово') };
  let state = null, sending = false, timer = null, stopped = false;
  const controls = () => {
    const disabled = sending || readOnly || !state?.enabled || state?.maintenance || ['queued', 'running'].includes(state?.status);
    password.disabled = !!disabled; submit.disabled = !!disabled;
  };
  const show = value => {
    state = value;
    status.textContent = statuses[value.status] || t('Неизвестное состояние обновления.');
    details.textContent = [value.id, phases[value.phase], value.started_at ? new Date(value.started_at * 1000).toLocaleString(locale()) : '', value.before?.slice(0, 12), value.after?.slice(0, 12)].filter(Boolean).join(' · ');
    // Error codes are fixed server enums, never raw Git output or HTML.
    if (value.error) details.textContent += ' · ' + value.error;
    warning.textContent = value.maintenance ? t('Включён режим обслуживания. При ошибке требуется восстановление через консоль сервера; повторное обновление заблокировано.')
      : !value.enabled ? t('Обновления выключены. Оператор должен настроить обработчик bin/update.php и FORBIRDS_UPDATES_ENABLED=1 на сервере.')
      : value.status === 'queued' ? t('Если ожидание затянулось, проверьте запуск обработчика на сервере. Закрытие вкладки не отменяет заявку.') : '';
    reload.hidden = value.status !== 'succeeded'; controls();
  };
  const poll = async () => {
    try { show(await api('/admin/update')); }
    catch (error) { state = null; controls(); feedback.textContent = error.message; }
    finally { if (!stopped && panel.isConnected) timer = setTimeout(poll, 3000); }
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    if (!confirm(t('Обновить сайт из origin/main и выполнить миграции? На время работ сайт будет недоступен.'))) return;
    const secret = password.value; password.value = ''; sending = true; feedback.textContent = ''; controls();
    try { show(await post('/admin/update', { password: secret, confirm: 'UPDATE' })); }
    catch (error) { feedback.textContent = error.message; }
    finally { sending = false; controls(); }
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); password.value = ''; }, { once: true });
  await poll();
}
