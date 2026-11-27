const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
(async () => {
  let options = { headless: true };
  if (process.env.FORBIRDS_SERVERLESS_BROWSER === '1') {
    const packaged = require('@sparticuz/chromium').default;
    options = { ...options, executablePath: await packaged.executablePath(), args: packaged.args.filter(arg => arg !== '--single-process' && !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')) };
  }
  const browser = await chromium.launch(options);
  const base = process.env.FORBIRDS_TEST_URL;
  const fixture = JSON.parse(process.env.FORBIRDS_FALSEFLAG_FIXTURE);
  const errors = [], external = [];
  async function page(user) {
    const context = await browser.newContext();
    await context.addInitScript(() => { if (!localStorage.getItem('forbirds-language')) localStorage.setItem('forbirds-language', 'ru'); });
    const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p.on('request', r => { if (!r.url().startsWith(base)) external.push(r.url()); });
    p.on('dialog', d => { if (p.dismissNextDialog) { p.dismissNextDialog = false; d.dismiss(); } else d.accept(); });
    if (user) {
      await p.goto(base + '/dashboard.html');
      await p.locator('#auth-form [name=username]').fill(user);
      await p.locator('#auth-form [name=password]').fill(process.env.FORBIRDS_TEST_PASSWORD);
      await p.locator('#auth-form button[value=login]').click();
      await p.locator('#account-name').waitFor();
    }
    return p;
  }
  const markdown = '# Heading\n\n**Bold** and *italic* and ~~gone~~ [safe](https://example.org)\n\n- first\n- second\n\n> **green**\n< orange\n^ blue\n\n```js\n> plain code\n<script>window.MARKDOWN_XSS=true</script>\n```\n\n<script>window.MARKDOWN_XSS=true</script>\n\n[bad](javascript:alert(1))\n\n![tracker](https://example.org/tracker.png)';
  try {
    const admin = await page('admin');
    await admin.goto(base + '/dashboard.html');
    await admin.locator('#composer').waitFor();
    assert.equal(await admin.locator('#falseflag-controls').isVisible(), true);
    await admin.locator('#falseflag-enabled').check();
    await admin.locator('#falseflag-user').fill(String(fixture.target));
    await admin.locator('#falseflag-reason').fill('browser-private-attribution');
    await admin.locator('#post-form [name=title]').fill('Masked Markdown topic');
    await admin.locator('#post-form [name=body]').fill(markdown);
    await admin.locator('#pow-start').click();
    await admin.waitForFunction(() => !document.querySelector('#post-submit').disabled);
    admin.dismissNextDialog = true;
    await admin.locator('#post-submit').click();
    await admin.locator('#post-result').filter({ hasText: 'Публикация отменена.' }).waitFor();
    assert.equal(await admin.locator('#falseflag-enabled').isChecked(), true);
    await admin.locator('#post-submit').click();
    await admin.waitForURL(/post\.html\?id=/);
    const topicUrl = admin.url();
    const postId = await admin.locator('#thread .post-table').first().getAttribute('id');
    await admin.locator('#falseflag-controls').waitFor();
    assert.equal(await admin.locator('#falseflag-enabled').isChecked(), false);
    const author = admin.locator(`#${postId} .author-name a`);
    assert.equal(await author.textContent(), 'normal');
    assert.equal(await author.getAttribute('href'), '/profile.html?id=' + fixture.target);
    // Wait for the real actor cooldown; tests must not bypass it through attribution.
    const readonly = await page();
    await readonly.goto(topicUrl);
    const body = readonly.locator(`#${postId} .post-body`);
    await body.locator('h1').waitFor();
    assert.equal(await body.locator('h1').textContent(), 'Heading');
    assert.equal(await body.locator('strong').first().textContent(), 'Bold');
    assert.equal(await body.locator('em').textContent(), 'italic');
    assert.equal(await body.locator('s').textContent(), 'gone');
    assert.equal(await body.locator('ul li').count(), 2);
    assert.equal(await body.locator('.quote-green').textContent(), '> green');
    assert.equal(await body.locator('pre code').textContent(), '> plain code\n<script>window.MARKDOWN_XSS=true</script>\n');
    assert.equal(await body.locator('script,img,iframe,svg').count(), 0);
    assert.equal(await body.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await readonly.evaluate(() => window.MARKDOWN_XSS), undefined);
    assert.equal(await readonly.locator('#falseflag-controls').isVisible(), false);
    await readonly.setViewportSize({ width: 375, height: 812 });
    assert.equal(await readonly.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const moderator = await page('moderator');
    await moderator.goto(base + '/dashboard.html');
    await moderator.locator('#composer').waitFor();
    assert.equal(await moderator.locator('#falseflag-controls').isVisible(), false);
    await moderator.goto(base + '/dashboard.html?mode=falseflags');
    await moderator.locator('#dashboard-content').filter({ hasText: 'Для этого действия нужны права администратора.' }).waitFor();
    const denied = await moderator.request.get(base + '/api/admin/falseflags');
    assert.equal(denied.status(), 403);
    await admin.goto(base + '/dashboard.html?mode=falseflags');
    await admin.locator('#dashboard-content').filter({ hasText: 'browser-private-attribution' }).waitFor();
    assert.ok((await admin.locator('#dashboard-content').textContent()).includes('admin → normal'));
    await admin.evaluate(() => localStorage.setItem('forbirds-language', 'en'));
    await admin.goto(base + '/dashboard.html');
    await admin.getByText('Post as another user', { exact: true }).waitFor();
    // Real form reply, attributed to the same target, also renders Markdown.
    await admin.goto(topicUrl);
    await admin.locator('#composer').waitFor();
    await admin.locator('#falseflag-enabled').check();
    await admin.locator('#falseflag-user').fill(String(fixture.target));
    await admin.locator('#falseflag-reason').fill('browser-private-reply');
    await admin.locator('#post-form [name=body]').fill('Reply **bold**');
    await admin.waitForFunction(() => !document.querySelector('#pow-start').disabled, null, { timeout: 40000 });
    await admin.locator('#pow-start').click();
    await admin.waitForFunction(() => !document.querySelector('#post-submit').disabled);
    await admin.locator('#post-submit').click();
    await admin.locator('#thread .pl .post-body strong').filter({ hasText: 'bold' }).waitFor();
    assert.equal(await admin.locator('#thread .pl .author-name a').last().textContent(), 'normal');
    assert.equal(await admin.locator('#falseflag-enabled').isChecked(), false);
  } finally { await browser.close(); }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Admin-only attribution root/reply, private log, real PoW/cooldown, Markdown safety, colored quotes, mobile and EN: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
