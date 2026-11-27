const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
(async () => {
  let options = { headless: true };
  if (process.env.FORBIRDS_SERVERLESS_BROWSER === '1') {
    const packaged = require('@sparticuz/chromium').default;
    options = { ...options, executablePath: await packaged.executablePath(), args: packaged.args.filter(arg => arg !== '--single-process' && !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')) };
  }
  const browser = await chromium.launch(options);
  const base = process.env.FORBIRDS_TEST_URL, data = JSON.parse(process.env.FORBIRDS_PRESENTATION_FIXTURE);
  const errors = [], external = [], privateRequests = [];
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      if (!localStorage.getItem('forbirds-language')) localStorage.setItem('forbirds-language', 'ru');
      window.presentationLeaks = [];
      const inspect = () => {
        if (localStorage.getItem('forbirds-presentation') === '1' && document.body) {
          if (document.body.innerText.includes('PRIVATE-PRESENTATION-') || document.body.innerText.includes('127.0.0.1')) window.presentationLeaks.push('private text painted');
          for (const e of document.querySelectorAll('.post-identity,.mod-tools,#falseflag-controls,#queue-link')) {
            if (e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden') window.presentationLeaks.push('private control painted');
          }
        }
        requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    page.on('request', r => {
      if (!r.url().startsWith(base)) external.push(r.url());
      if (r.headers()['x-forbirds-public-view'] === '1' && /\/api\/(?:moderation|admin)\//.test(r.url())) privateRequests.push(r.url());
    });
    await page.goto(base + '/dashboard.html');
    await page.locator('#auth-form [name=username]').fill('admin');
    await page.locator('#auth-form [name=password]').fill(process.env.FORBIRDS_TEST_PASSWORD);
    await page.locator('#auth-form button[value=login]').click();
    await page.locator('#account-name').waitFor();
    const privacy = page.waitForResponse(r => r.url().endsWith('/api/moderation/privacy') && r.request().method() === 'POST');
    await page.locator('#show-identity').check(); await privacy;
    const rootUrl = base + `/post.html?id=${data.root.thread_id}`;
    await page.goto(rootUrl);
    await page.locator('.post-identity').filter({ hasText: '127.0.0.1' }).first().waitFor();
    await page.getByRole('button', { name: 'Права / бан автора', exact: true }).first().click();
    await page.locator('dialog[open]').waitFor();
    const existing = await context.newPage();
    await existing.goto(base + '/dashboard.html?mode=audit');
    await existing.locator('#dashboard-content').filter({ hasText: 'PRIVATE-PRESENTATION-REASON' }).waitFor();
    await page.bringToFront();
    await page.keyboard.press('Alt+Shift+M');
    await page.waitForFunction(() => document.documentElement.classList.contains('presentation-ready') && document.querySelector('#presentation-toggle')?.getAttribute('aria-pressed') === 'true');
    await existing.locator('#presentation-hint').waitFor();
    assert.equal(await existing.locator('#dashboard-content').isVisible(), false);
    assert.deepEqual(await existing.evaluate(() => window.presentationLeaks), []);
    await existing.close();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('#queue-link').isVisible(), false);
    assert.equal(await page.locator('#account-name').isVisible(), false);
    assert.equal(await page.locator('#composer').isVisible(), false);
    assert.ok(!(await page.locator('body').innerText()).includes('127.0.0.1'));
    assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-PRESENTATION-'));
    assert.deepEqual(await page.evaluate(() => window.presentationLeaks), []);
    // Preference applies before first paint after refresh and on other tabs/pages.
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('presentation-ready'));
    assert.deepEqual(await page.evaluate(() => window.presentationLeaks), []);
    const other = await context.newPage();
    await other.goto(base + '/dashboard.html?mode=audit');
    await other.locator('#presentation-hint').waitFor();
    assert.equal(await other.locator('#dashboard-content').isVisible(), false);
    assert.deepEqual(await other.evaluate(() => window.presentationLeaks), []);
    await other.close();
    await page.goto(base + '/profile.html?id=' + data.user_id);
    await page.locator('#profile-name').waitFor();
    assert.equal(await page.locator('#profile-actions').isVisible(), false);
    assert.equal(await page.locator('#profile-meta').isVisible(), false);
    await page.goto(base + `/post.html?id=${data.pending.thread_id}`);
    await page.locator('#presentation-hint').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-PRESENTATION-'));
    await page.goto(base + `/post.html?id=${data.restricted.thread_id}`);
    await page.locator('#presentation-hint').waitFor();
    assert.deepEqual(await page.evaluate(() => window.presentationLeaks), []);
    assert.deepEqual(privateRequests, []);
    await page.getByRole('button', { name: 'Режим показа', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#presentation-toggle')?.getAttribute('aria-pressed') === 'false');
    await page.locator('.post-body').filter({ hasText: 'PRIVATE-PRESENTATION-' }).waitFor();
    assert.equal(await page.locator('#queue-link').isVisible(), true, 'mode does not revoke the real role');
    await page.goto(base + '/dashboard.html');
    await page.locator('#composer').waitFor();
    const textarea = page.locator('#post-form [name=body]');
    await textarea.fill('Start END');
    await textarea.evaluate(e => e.setSelectionRange(6, 9));
    await page.getByText('Эмодзи из реакций', { exact: true }).click();
    const insert = page.getByRole('button', { name: 'Вставить :like:', exact: true });
    await insert.click();
    assert.equal(await textarea.inputValue(), 'Start :like:');
    assert.equal(await textarea.evaluate(e => e.selectionStart), 'Start :like:'.length);
    assert.equal(await textarea.evaluate(e => e === document.activeElement), true);
    await textarea.fill('x'.repeat(50000));
    await textarea.evaluate(e => e.setSelectionRange(e.value.length, e.value.length));
    await insert.click();
    await page.locator('#notice').filter({ hasText: 'Достигнут лимит длины сообщения.' }).waitFor();
    assert.equal((await textarea.inputValue()).length, 50000);
    const body = 'Hello :like: **:heart:**\n\n`:like:`\n\n```\n:like:\n```\n\n:unknown-emoji:';
    await textarea.fill(body);
    await page.locator('#post-form [name=title]').fill('Emoji shortcodes topic');
    await page.waitForFunction(() => !document.querySelector('#pow-start').disabled, null, { timeout: 40000 });
    await page.locator('#pow-start').click();
    await page.waitForFunction(() => !document.querySelector('#post-submit').disabled);
    await page.locator('#post-submit').click();
    await page.waitForURL(/post\.html\?id=/);
    const content = page.locator('#thread .post-body').first();
    await content.locator('img.post-emoji').first().waitFor();
    assert.equal(await content.locator('img.post-emoji').count(), 2);
    assert.equal(await content.locator('img.post-emoji').first().getAttribute('alt'), ':like:');
    assert.equal(await content.locator('code img').count(), 0);
    assert.equal(await content.locator('pre code').textContent(), ':like:\n');
    assert.ok((await content.textContent()).includes(':unknown-emoji:'));
    const postId = (await page.locator('#thread .post-table').first().getAttribute('id')).replace('post-', '');
    const stored = await (await page.request.get(base + '/api/posts/' + postId)).json();
    assert.equal(stored.data.body.replace(/\r\n/g, '\n'), body);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => localStorage.setItem('forbirds-language', 'en'));
    await page.reload();
    await page.getByRole('button', { name: 'Presentation mode', exact: true }).waitFor();
    await page.getByText('Reaction emoji', { exact: true }).click();
    await page.getByRole('button', { name: 'Insert :like:', exact: true }).waitFor();
  } finally { await browser.close(); }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Presentation early restore/private reads/dialogs and emoji insertion/rendering/code/limits/raw storage/mobile/EN: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
