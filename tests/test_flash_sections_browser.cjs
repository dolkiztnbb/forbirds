const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
(async () => {
  let options = { headless: true };
  if (process.env.FORBIRDS_SERVERLESS_BROWSER === '1') {
    const packaged = require('@sparticuz/chromium').default;
    options = { ...options, executablePath: await packaged.executablePath(), args: packaged.args.filter(arg => arg !== '--single-process' && !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')) };
  }
  const browser = await chromium.launch(options);
  const base = process.env.FORBIRDS_TEST_URL, data = JSON.parse(process.env.FORBIRDS_FLASH_FIXTURE);
  const errors = [], consoleErrors = [], requests = [], external = [], popups = [], sandboxRequests = [];
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => { try { if (!localStorage.getItem('forbirds-language')) localStorage.setItem('forbirds-language', 'ru'); } catch { /* Opaque Flash sandbox. */ } });
    await context.route('**/*', route => {
      const url = route.request().url();
      requests.push(url);
      // Regression: the opaque sandbox must work even when its subrequests fail.
      if (route.request().frame().url().endsWith('/flash-player.html') && !route.request().isNavigationRequest()) {
        sandboxRequests.push(url); return route.abort();
      }
      if (url.endsWith('.wasm')) {
        assert.equal(route.request().headers().cookie, undefined, 'public WASM fetch omits session cookies');
        assert.ok(!route.request().frame().url().endsWith('/flash-player.html'), 'WASM fetched by parent');
      }
      if (!url.startsWith(base)) { external.push(url); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('popup', popup => { popups.push(popup.url()); popup.close(); });
    const url = base + `/post.html?id=${data.root.thread_id}`;
    await page.goto(url);
    const section = page.locator(`.section-item[data-section-id="${data.section}"]`);
    const second = page.locator(`.section-item[data-section-id="${data.second}"]`);
    await section.waitFor();
    assert.equal(await section.getAttribute('open'), '');
    await section.locator('summary').press('Space');
    await page.waitForFunction(id => localStorage.getItem('forbirds-section-' + id) === '0', data.section);
    await page.reload();
    await second.waitFor();
    assert.equal(await section.getAttribute('open'), null);
    assert.equal(await second.getAttribute('open'), '');
    await second.locator('summary').press('Space');
    await page.waitForFunction(id => localStorage.getItem('forbirds-section-' + id) === '0', data.second);
    await page.goto(base + '/');
    await second.waitFor();
    assert.equal(await section.getAttribute('open'), null);
    assert.equal(await second.getAttribute('open'), null);
    await section.locator('summary').press('Space');
    await page.waitForFunction(id => localStorage.getItem('forbirds-section-' + id) === '1', data.section);
    await page.goto(url);
    await second.waitFor();
    assert.equal(await section.getAttribute('open'), '');
    assert.equal(await second.getAttribute('open'), null);
    const firstPlayer = page.locator('.flash-player').first();
    await firstPlayer.getByRole('button', { name: 'Запустить Flash', exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'no player before explicit start');
    assert.ok(!requests.some(u => u.includes('/vendor/ruffle/') || u === base + data.file.view_url));
    await firstPlayer.getByRole('button', { name: 'Запустить Flash', exact: true }).click();
    await firstPlayer.getByText('Flash запущен через Ruffle.', { exact: true }).waitFor({ timeout: 65000 });
    const iframe = firstPlayer.locator('iframe');
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    const frame = page.frames().find(f => f.url().endsWith('/flash-player.html'));
    await frame.waitForFunction(() => document.querySelector('ruffle-player')?.ruffle().metadata?.width === 320);
    const isolation = await frame.evaluate(() => {
      let parentBlocked = false, storageBlocked = false;
      try { void parent.document.body; } catch { parentBlocked = true; }
      try { void localStorage.length; } catch { storageBlocked = true; }
      const player = document.querySelector('ruffle-player');
      return { parentBlocked, storageBlocked, canvas: !!player.shadowRoot.querySelector('canvas'), height: player.ruffle().metadata.height };
    });
    assert.deepEqual(isolation, { parentBlocked: true, storageBlocked: true, canvas: true, height: 240 });
    assert.equal(await page.evaluate(() => window.FLASH_ESCAPED), undefined);
    assert.equal(page.url(), url);
    assert.deepEqual(external, []);
    assert.deepEqual(popups, []);
    assert.deepEqual(sandboxRequests, [], 'sandbox has no network subrequests');
    assert.ok(requests.some(u => u.endsWith('.wasm')), 'real local Ruffle WASM ran');
    // This is not an arbitrary fetch proxy, even for messages from the sandbox.
    const beforeInvalid = requests.length;
    await frame.evaluate(() => parent.postMessage({ type: 'forbirds-flash-runtime-request', name: '../../api/session' }, '*'));
    await page.waitForTimeout(100);
    assert.ok(!requests.slice(beforeInvalid).some(u => u.includes('/vendor/ruffle/')), 'invalid runtime names are ignored');
    await firstPlayer.getByRole('button', { name: 'Остановить Flash', exact: true }).click();
    assert.equal(await page.locator('iframe').count(), 0);
    const spoiler = page.locator('.flash-box > details');
    await spoiler.locator('summary').click();
    await spoiler.getByRole('button', { name: 'Запустить Flash', exact: true }).click();
    await spoiler.getByText('Flash запущен через Ruffle.', { exact: true }).waitFor({ timeout: 65000 });
    await spoiler.locator('summary').click();
    await page.waitForFunction(() => !document.querySelector('iframe'));
    // A failed WASM download exits promptly and removes the waiting sandbox.
    await page.route('**/vendor/ruffle/*.wasm', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await firstPlayer.getByRole('button', { name: 'Запустить Flash', exact: true }).click();
    await firstPlayer.getByText('Не удалось запустить Flash. Возможно, файл несовместим или доступ к нему изменился.', { exact: true }).waitFor();
    assert.equal(await firstPlayer.locator('iframe').count(), 0);
    assert.equal(await firstPlayer.getByRole('button', { name: 'Запустить Flash', exact: true }).isEnabled(), true);
    await page.unroute('**/vendor/ruffle/*.wasm');
    // Revoked access produces a generic error and never instantiates a sandbox.
    await page.route('**' + data.file.view_url, route => route.fulfill({ status: 404, body: '{}' }));
    await firstPlayer.getByRole('button', { name: 'Запустить Flash', exact: true }).click();
    await firstPlayer.getByText('Не удалось запустить Flash. Возможно, файл несовместим или доступ к нему изменился.', { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await page.unroute('**' + data.file.view_url);
    await page.evaluate(() => localStorage.setItem('forbirds-language', 'en'));
    await page.reload();
    await page.getByRole('button', { name: 'Start Flash', exact: true }).first().waitFor();
    assert.equal(await second.getAttribute('open'), null);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Storage-disabled browsers must still render sections and work normally.
    const blocked = await browser.newContext();
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('disabled'); } });
      Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('disabled'); } });
    });
    const blockedPage = await blocked.newPage();
    await blockedPage.goto(base + '/');
    await blockedPage.getByRole('button', { name: 'I speak English', exact: true }).click();
    await blockedPage.locator('.section-item').first().waitFor();
    assert.equal(await blockedPage.locator('.section-item').first().getAttribute('open'), '');
    await blocked.close();
  } catch (error) {
    console.error('Browser console:', consoleErrors);
    throw error;
  } finally { await browser.close(); }
  assert.deepEqual(errors, []);
  console.log('Real Ruffle WASM FWS/CWS playback, opaque sandbox, no network/popups/page access, spoilers, stop/errors, sidebar persistence, mobile, EN and disabled storage: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
