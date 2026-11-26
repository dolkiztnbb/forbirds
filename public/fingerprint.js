import '/sha256.js';

// Visible, site-local anti-abuse signal. No persistent hardware ID is available
// to websites; this can be spoofed or shared by different users. No raw canvas
// or GPU strings are transmitted. HMAC scoping is applied again on the server.
export function browserSignal() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 50;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3172aa'; ctx.fillRect(2, 2, 140, 30);
    ctx.font = '17px sans-serif'; ctx.fillStyle = '#f3bd47'; ctx.fillText('ForBirds anti-abuse 123', 3, 24);
    const gpu = document.createElement('canvas').getContext('webgl');
    const info = gpu?.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? gpu.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    const vendor = info ? gpu.getParameter(info.UNMASKED_VENDOR_WEBGL) : '';
    const signal = JSON.stringify([navigator.userAgent, navigator.languages, screen.width, screen.height,
      screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone, renderer, vendor, canvas.toDataURL()]);
    gpu?.getExtension('WEBGL_lose_context')?.loseContext();
    return globalThis.ForBirdsHash.hex(signal);
  } catch { return ''; } // Privacy browsers and clients without WebGL still work.
}
