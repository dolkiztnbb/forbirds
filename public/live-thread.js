import { t } from '/i18n.js';

/** SSE invalidations, never a page-refresh or HTTP polling loop. */
export function startThreadLive({ id, page, publicView, version, scope, refresh, reset, gone, target }) {
  if (!window.EventSource) return;
  const status = document.createElement('span'); status.className = 'live-state'; status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = t('Подключить live'); retry.hidden = true;
  const bar = document.createElement('div'); bar.className = 'thread-live'; bar.append(status, retry); target.before(bar);
  let source = null, stopped = false, refreshing = null, pending = false, resetting = false;
  const stop = () => { source?.close(); source = null; };
  const update = () => {
    if (stopped) return Promise.resolve(false);
    pending = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      do { pending = false; await refresh(); } while (pending && !stopped);
      return true;
    })().catch(error => {
      stop();
      if (['not_found', 'authentication_required', 'forbidden', 'banned'].includes(error.code)) gone();
      else { status.textContent = t('Live-соединение недоступно.'); retry.hidden = false; }
      return false;
    }).finally(() => { refreshing = null; });
    return refreshing;
  };
  const resetScope = async () => {
    stop(); if (stopped || resetting) return;
    resetting = true;
    try { await reset(); if (await update() && !stopped) connect(); }
    catch { gone(); status.textContent = t('Live-соединение недоступно.'); retry.hidden = false; }
    finally { resetting = false; }
  };
  const connect = () => {
    stop(); if (stopped) return;
    const query = new URLSearchParams({ page, limit: '20' });
    if (publicView) query.set('public_view', '1');
    const connection = source = new EventSource('/api/threads/' + id + '/events?' + query);
    retry.hidden = true; status.textContent = t('Подключение live…');
    connection.onopen = () => { if (source === connection) { status.textContent = t('Ответы в реальном времени'); retry.hidden = true; } };
    connection.addEventListener('change', event => {
      if (source !== connection || stopped) return;
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.scope && data.scope !== scope()) { resetScope(); return; }
      if (typeof data.version === 'string' && data.version !== version()) update();
    });
    connection.addEventListener('reset', () => { if (source === connection) resetScope(); });
    for (const event of ['unavailable', 'maintenance']) connection.addEventListener(event, () => {
      if (source !== connection) return;
      stop(); status.textContent = event === 'maintenance' ? t('Сайт обновляется. Повторите запрос позже.') : t('Live-соединение недоступно.'); retry.hidden = false;
    });
    connection.addEventListener('gone', () => {
      if (source !== connection) return;
      stop(); gone(); status.textContent = t('Тема больше недоступна.');
    });
    connection.onerror = () => {
      if (source !== connection) return;
      status.textContent = connection.readyState === EventSource.CLOSED ? t('Live-соединение недоступно.') : t('Восстановление live-соединения…');
      retry.hidden = false; // Native EventSource reconnects; never fall back to polling.
      // A terminal handshake failure may mean a thread became inaccessible while offline.
      if (connection.readyState === EventSource.CLOSED) update();
    };
  };
  const visible = () => { if (document.hidden) stop(); else connect(); };
  const hide = () => stop();
  const show = event => { if (event.persisted && !document.hidden) connect(); };
  retry.addEventListener('click', connect);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  if (!document.hidden) connect();
  return { stop: () => {
    stopped = true; stop(); bar.remove();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
  } };
}
