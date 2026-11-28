// Only images are displayed; the timeout schedules the next server minute, not a countdown UI.
export function startBanners(anchor) {
  if (!anchor) return;
  const image = document.createElement('img'); image.alt = ''; image.width = 600; image.height = 200;
  image.className = 'site-banner'; image.hidden = true; anchor.append(image);
  let timer = null, stopped = false, revision = 0;
  image.addEventListener('load', () => { image.hidden = false; anchor.classList.add('has-banner'); });
  image.addEventListener('error', () => {
    if (image.getAttribute('src') !== '/static/banner.png') image.src = '/static/banner.png';
    else { image.hidden = true; anchor.classList.remove('has-banner'); }
  });
  const update = async () => {
    clearTimeout(timer);
    const request = ++revision;
    let delay = 60000;
    try {
      const response = await fetch('/api/banner', { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error();
      const { data } = await response.json();
      if (stopped || request !== revision) return;
      if (typeof data.url === 'string' && (data.url === '/static/banner.png' || /^\/static\/banners\/[^/]+$/.test(data.url))) {
        if (image.getAttribute('src') !== data.url) image.src = data.url;
      }
      if (Number.isFinite(data.server_time) && Number.isFinite(data.next_change_at)) delay = Math.max(250, Math.min(60000, (data.next_change_at - data.server_time) * 1000));
    } catch { if (stopped || request !== revision) return; if (!image.getAttribute('src')) image.src = '/static/banner.png'; }
    if (!stopped && request === revision) timer = setTimeout(update, delay);
  };
  const visible = () => { if (!stopped && !document.hidden) { clearTimeout(timer); update(); } };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', () => { stopped = true; ++revision; clearTimeout(timer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; update(); } });
  update();
}
