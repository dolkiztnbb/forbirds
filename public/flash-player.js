// Runs only in an opaque-origin sandbox. It never receives cookies, URLs or CSRF tokens.
(() => {
  const parentOrigin = new URL(location.href).origin;
  const config = {
    publicPath: new URL('/vendor/ruffle/', location.href).href,
    polyfills: false, autoplay: 'on', splashScreen: false,
    allowScriptAccess: false, allowNetworking: 'none', openUrlMode: 'deny',
    socketProxy: [], credentialAllowList: [], fontSources: [],
    showSwfDownload: false, contextMenu: 'off', allowFullscreen: false,
    maxExecutionDuration: 5, logLevel: 'error',
  };
  // Ruffle's pinned loader uses fetch for one of these two WASM builds. The
  // opaque iframe never performs network I/O: the parent supplies public bytes.
  const builds = new Set(['ruffle_web_bg.QDRSAAAZ.wasm', 'ruffle_web-wasm_mvp_bg.UMWKJ7EM.wasm']);
  const pending = new Map();
  window.fetch = async input => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const name = url.pathname.split('/').pop();
    if (url.origin !== parentOrigin || url.pathname !== '/vendor/ruffle/' + name || url.search || url.hash || !builds.has(name)) throw new Error('Sandbox network disabled');
    if (pending.has(name)) throw new Error('Duplicate runtime request');
    return new Promise((resolve, reject) => {
      pending.set(name, { resolve, reject });
      parent.postMessage({ type: 'forbirds-flash-runtime-request', name }, parentOrigin);
    });
  };
  window.RufflePlayer = { config };
  let initialized = false;
  const report = type => parent.postMessage({ type: 'forbirds-flash-' + type }, parentOrigin);
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'forbirds-flash-runtime') return;
    const entry = pending.get(event.data.name);
    if (!entry) return;
    pending.delete(event.data.name);
    const bytes = event.data.bytes;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 8 || bytes.byteLength > 20 * 1024 * 1024) {
      entry.reject(new Error('Runtime unavailable')); return;
    }
    entry.resolve(new Response(bytes, { headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(bytes.byteLength) } }));
  });
  window.addEventListener('message', async event => {
    if (initialized || event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'forbirds-flash-load') return;
    const bytes = event.data.bytes;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 15 || bytes.byteLength > 5 * 1024 * 1024) return;
    initialized = true;
    try {
      const player = window.RufflePlayer.newest().createPlayer();
      document.querySelector('#player').append(player);
      await player.ruffle().load({ ...config, data: new Uint8Array(bytes) });
      report('loaded');
    } catch { report('error'); }
  });
  window.addEventListener('DOMContentLoaded', () => report('ready'), { once: true });
})();
