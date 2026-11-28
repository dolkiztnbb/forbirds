// Rendering test with controlled SSE events. Real transport/concurrency is covered in test_live_api.py.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium, request } = require('playwright-core');
(async () => {
  let options = { headless: true };
  if (process.env.FORBIRDS_SERVERLESS_BROWSER === '1') {
    const packaged = require('@sparticuz/chromium').default;
    options = { ...options, executablePath: await packaged.executablePath(), args: packaged.args.filter(arg => arg !== '--single-process' && !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')) };
  }
  const browser = await chromium.launch(options);
  const baseURL = process.env.FORBIRDS_TEST_URL;
  const fixture = JSON.parse(process.env.FORBIRDS_LIVE_FIXTURE);
  const errors = [];
  async function user(username) {
    const context = await request.newContext({ baseURL });
    let csrf = (await (await context.get('/api/session')).json()).data.csrf_token;
    const response = await context.post('/api/auth/login', { data: { username, password: process.env.FORBIRDS_TEST_PASSWORD }, headers: { 'X-CSRF-Token': csrf } });
    assert.equal(response.status(), 200); csrf = (await response.json()).data.csrf_token;
    return {
      async post(path, data, posting = false) {
        if (posting) {
          const issued = await context.post('/api/pow/challenge', { data: {}, headers: { 'X-CSRF-Token': csrf } });
          const payload = await issued.json(); assert.ok(issued.ok(), JSON.stringify(payload));
          const challenge = payload.data;
          let nonce = 0;
          while (BigInt('0x' + crypto.createHash('sha256').update(challenge.prefix + ':' + nonce).digest('hex')) >> BigInt(256 - challenge.difficulty)) ++nonce;
          data = { ...data, pow_id: challenge.id, pow_nonce: String(nonce) };
        }
        const response = await context.post(path, { data, headers: { 'X-CSRF-Token': csrf } });
        const payload = await response.json(); assert.ok(response.ok(), JSON.stringify(payload)); return payload.data;
      },
    };
  }
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('forbirds-language', 'en');
      window.__sources = [];
      window.EventSource = class extends EventTarget {
        static CLOSED = 2;
        constructor(url) { super(); this.url = url; this.readyState = 1; window.__sources.push(this); setTimeout(() => this.onopen?.(), 0); }
        close() { this.readyState = 2; }
        event(name, data) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })); }
      };
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    let documents = 0, snapshots = 0, notModified = 0;
    page.on('response', response => { if (response.status() === 304) ++notModified; });
    page.on('request', req => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) ++documents;
      if (new URL(req.url()).pathname === '/api/threads/' + fixture.thread_id) ++snapshots;
    });
    await page.goto(baseURL + '/post.html?id=' + fixture.thread_id);
    await page.locator('#post-' + fixture.post_id).waitFor();
    await page.waitForFunction(() => window.__sources.length > 0);
    const draft = page.locator('#composer textarea[name=body]'); await draft.fill('Keep this unfinished draft'); await draft.focus();
    await page.evaluate(id => { window.__root = document.getElementById('post-' + id); }, fixture.post_id);
    await page.waitForTimeout(1000); const idle = snapshots;
    await page.waitForTimeout(1000); assert.equal(snapshots, idle, 'No periodic snapshot requests');
    const emit = async () => {
      const old = snapshots;
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/threads/' + fixture.thread_id && [200, 304].includes(r.status()));
      await page.evaluate(() => window.__sources.at(-1).event('change', { version: crypto.randomUUID() }));
      await (await response).finished();
      await page.waitForTimeout(75);
      assert.ok(snapshots > old);
    };
    const admin = await user('admin');
    const latest = await admin.post('/api/threads/' + fixture.thread_id + '/replies', { body: 'Live across the page boundary' }, true);
    await emit(); await page.locator('#post-' + latest.post_id).waitFor();
    assert.equal(await page.locator('.thread-tail[hidden]').count(), 0);
    assert.ok(await page.evaluate(id => window.__root === document.getElementById('post-' + id), fixture.post_id));
    assert.equal(await draft.inputValue(), 'Keep this unfinished draft');
    assert.equal(await draft.evaluate(element => element === document.activeElement), true);
    const normal = await user('normal');
    const pending = await normal.post('/api/threads/' + fixture.thread_id + '/replies', { body: 'Pending browser live secret' }, true);
    await emit(); assert.equal(await page.locator('#post-' + pending.post_id).count(), 0);
    await admin.post('/api/posts/' + pending.post_id + '/moderate', { action: 'approve' });
    await emit(); await page.locator('#post-' + pending.post_id).waitFor();
    await admin.post('/api/posts/' + pending.post_id + '/restrict', { action: 'hide', reason: 'Browser live visibility' });
    await emit(); await page.locator('#post-' + pending.post_id).waitFor({ state: 'detached' });
    assert.equal(await draft.inputValue(), 'Keep this unfinished draft');
    assert.equal(documents, 1, 'No page navigation or reload');
    assert.ok(notModified > 0, 'Unchanged snapshots revalidate with 304');
    assert.equal(await page.locator('#thread .mod-tools').count(), 0);
    await page.locator('.banner-placeholder img.site-banner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.banner-placeholder').innerText(), '');
    await page.evaluate(() => window.__sources.at(-1).event('gone', {}));
    await page.getByText('This thread is no longer available.', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#composer').isHidden(), true);
    assert.deepEqual(errors, []);
    console.log('Live DOM: draft/focus/media-node stability, pagination tail, premoderation, hide/gone, English, image-only banner, no reload/polling: OK');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
