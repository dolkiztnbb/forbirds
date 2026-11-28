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
  window.RufflePlayer = { config };
  let initialized = false;
  const report = type => parent.postMessage({ type: 'forbirds-flash-' + type }, parentOrigin);
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
