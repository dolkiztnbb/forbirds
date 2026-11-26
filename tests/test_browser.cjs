/* Optional real-browser integration, launched by test_api.py with an isolated PHP server. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  let options = { headless: true };
  if (process.env.FORBIRDS_SERVERLESS_BROWSER === '1') {
    const packaged = require('@sparticuz/chromium').default;
    options = { ...options, executablePath: await packaged.executablePath(), args: packaged.args.filter(arg => !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')) };
  }
  const browser = await chromium.launch(options);
  const errors = [], externalRequests = [], mediaRequests = [];
  const base = process.env.FORBIRDS_TEST_URL;
  async function page(context) {
    const p = await context.newPage();
    p.on('dialog', dialog => dialog.accept());
    p.on('pageerror', e => errors.push(e.message));
    p.on('request', r => { if (/\/api\/attachments\//.test(r.url())) mediaRequests.push(r.url()); if (!r.url().startsWith(base) && !r.url().startsWith('blob:')) externalRequests.push(r.url()); });
    return p;
  }
  async function login(p, username) {
    await p.goto(base + '/dashboard.html');
    await p.locator('#auth-form [name=username]').fill(username);
    await p.locator('#auth-form [name=password]').fill(process.env.FORBIRDS_TEST_PASSWORD);
    await p.locator('#auth-form button[value=login]').click();
    await p.locator('#account-name').waitFor({ state: 'visible' });
    await p.waitForFunction(() => document.querySelector('#section-select')?.options.length > 0);
    await p.waitForLoadState('networkidle');
  }
  async function solve(p) {
    await p.waitForFunction(() => !document.querySelector('#pow-start').disabled);
    await p.locator('#pow-start').click();
    await p.waitForFunction(() => document.querySelector('#pow-status').textContent.includes('Проверка решена'));
    assert.equal(await p.locator('#post-submit').isEnabled(), true);
  }
  try {
    const guestContext = await browser.newContext(), adminContext = await browser.newContext(), userContext = await browser.newContext();
    const guest = await page(guestContext), administrator = await page(adminContext), user = await page(userContext);
    await guest.goto(base + '/dashboard.html');
    await guest.waitForFunction(() => document.querySelector('#section-select')?.options.length > 0);
    const originalLayout = await guest.evaluate(() => ({
      headerHeight: getComputedStyle(document.querySelector('.sub')).height,
      bannerWidth: document.querySelector('.banner-placeholder').getBoundingClientRect().width,
      bannerHeight: document.querySelector('.banner-placeholder').getBoundingClientRect().height,
      scrollHeight: getComputedStyle(document.querySelector('.main-content > .scroll')).height,
      textareaHeight: document.querySelector('.post-tb').getBoundingClientRect().height,
      viewportHeight: innerHeight,
      composerIsTable: document.querySelector('#post-form > .composer-table')?.tagName === 'TABLE',
      navigationInSidebar: !!document.querySelector('.sidebar .site-nav'),
    }));
    assert.equal(originalLayout.headerHeight, '30px');
    assert.equal(originalLayout.bannerWidth, 600);
    assert.equal(originalLayout.bannerHeight, 200);
    assert.equal(originalLayout.scrollHeight, '640px');
    assert.ok(Math.abs(originalLayout.textareaHeight - originalLayout.viewportHeight / 2) <= 2);
    assert.equal(originalLayout.composerIsTable, true);
    assert.equal(originalLayout.navigationInSidebar, true);
    await guest.locator('#post-form [name=title]').fill('Browser guest topic');
    await guest.locator('#post-form [name=body]').fill('Guest message through a real form');
    const fixture = filename => fs.readFileSync(path.join(process.env.FORBIRDS_TEST_FIXTURES, filename));
    await guest.locator('#file-input').setInputFiles([
      { name: 'browser.txt', mimeType: 'text/plain', buffer: Buffer.from('Browser attachment') },
      { name: 'wide.png', mimeType: 'image/png', buffer: fixture('wide.png') },
      { name: 'wide.gif', mimeType: 'image/gif', buffer: fixture('animated.gif') },
      { name: 'hidden.png', mimeType: 'image/png', buffer: fixture('wide.png') },
      { name: 'wide.jpg', mimeType: 'image/jpeg', buffer: fixture('wide.jpg') },
      { name: 'wide.webp', mimeType: 'image/webp', buffer: fixture('wide.webp') },
    ]);
    await guest.locator('#file-list input[type=checkbox]').nth(0).check();
    await guest.locator('#file-list input[type=checkbox]').nth(3).check();
    assert.equal(await guest.locator('#post-submit').isDisabled(), true);
    await solve(guest);
    await guest.locator('#post-submit').click();
    await guest.waitForFunction(() => document.querySelector('#post-result').textContent.includes('Ожидает проверки'));
    assert.equal(await guest.locator('#pow-start').isDisabled(), true);
    assert.match(await guest.locator('#cooldown').textContent(), /4[0-5] сек/);
    // Both staff roles see an unfeatured pending topic on the home page, guests do not.
    const publicFeed = await page(guestContext);
    await publicFeed.goto(base + '/index.html?view=all');
    await publicFeed.locator('#feed .empty').waitFor();
    assert.equal(await publicFeed.getByRole('link', { name: 'Browser guest topic', exact: true }).count(), 0);
    const moderator = await page(await browser.newContext());
    await login(moderator, 'moderator');
    await moderator.goto(base + '/');
    await moderator.locator('#feed .post-table[data-status=pending]').waitFor();
    assert.equal(await moderator.getByRole('button', { name: 'Подтвердить', exact: true }).isEnabled(), true);
    await moderator.waitForLoadState('networkidle');
    await moderator.close();
    await login(administrator, 'admin');
    await administrator.goto(base + '/');
    await administrator.locator('#feed .post-table[data-status=pending]').waitFor();
    await administrator.waitForLoadState('networkidle');
    await administrator.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await administrator.locator('#feed .post-table[data-status=approved]').waitFor();
    await administrator.waitForLoadState('networkidle');
    await publicFeed.reload();
    await publicFeed.getByRole('link', { name: 'Browser guest topic', exact: true }).waitFor();
    await publicFeed.waitForLoadState('networkidle');
    await publicFeed.close();
    await administrator.goto(base + '/dashboard.html?mode=queue');
    await administrator.getByText('Очередь пуста.', { exact: true }).waitFor();
    await guest.goto(base + '/index.html?view=all');
    await guest.getByRole('link', { name: 'Browser guest topic', exact: true }).click();
    await guest.getByText('Guest message through a real form', { exact: true }).waitFor();
    await guest.waitForFunction(() => {
      const previews = [...document.querySelectorAll('.attachment-preview')];
      return previews.length === 4 && previews.every(img => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 256 && img.naturalHeight <= 256);
    });
    assert.equal(await guest.locator('.spoiler-marker').getAttribute('src'), '/static/preview/spolier.png');
    const threadId = new URL(guest.url()).searchParams.get('id');
    const threadResponse = await guestContext.request.get(base + '/api/threads/' + threadId);
    const attachments = (await threadResponse.json()).data.post.attachments;
    const hiddenImage = attachments.find(file => file.original_name === 'hidden.png');
    assert.equal(mediaRequests.some(url => url.endsWith(hiddenImage.preview_url)), false, 'spoilers must not fetch the real thumbnail');
    const [fullGif] = await Promise.all([
      guest.waitForEvent('popup'),
      guest.getByRole('link', { name: 'Открыть изображение: wide.gif', exact: true }).click(),
    ]);
    await fullGif.waitForLoadState('domcontentloaded');
    assert.equal(await fullGif.locator('img').evaluate(async image => { await image.decode(); return image.naturalWidth; }), 512);
    await fullGif.close();
    const [revealed] = await Promise.all([
      guest.waitForEvent('popup'),
      guest.getByRole('link', { name: 'Открыть изображение под спойлером: hidden.png', exact: true }).click(),
    ]);
    await revealed.waitForLoadState('domcontentloaded');
    assert.equal(await revealed.locator('img').evaluate(async image => { await image.decode(); return image.naturalWidth; }), 512);
    await revealed.close();
    assert.equal(mediaRequests.some(url => url.endsWith(hiddenImage.preview_url)), false);
    await guest.setViewportSize({ width: 375, height: 812 });
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await guest.setViewportSize({ width: 1280, height: 720 });
    await guest.locator('summary').filter({ hasText: 'Файл под спойлером' }).click();
    assert.equal(await guest.getByRole('link', { name: 'browser.txt', exact: true }).isVisible(), true);
    const downloadPath = await guest.getByRole('link', { name: 'browser.txt', exact: true }).getAttribute('href');
    const download = await guestContext.request.get(base + downloadPath);
    assert.equal(await download.text(), 'Browser attachment');

    // Registration form, normal user's pending topic, redirect and 30s countdown.
    await user.goto(base + '/dashboard.html');
    await user.locator('#auth-form [name=username]').fill('browser_user');
    await user.locator('#auth-form [name=password]').fill(process.env.FORBIRDS_TEST_PASSWORD);
    await user.locator('#auth-form button[value=register]').click();
    await user.locator('#account-name').waitFor({ state: 'visible' });
    await user.locator('#post-form [name=title]').fill('Browser registered topic');
    await user.locator('#post-form [name=body]').fill('<script>window.XSS = true</script> User text');
    await solve(user);
    await user.locator('#post-submit').click();
    await user.waitForURL(/post\.html\?id=/);
    await user.locator('.post-status').filter({ hasText: 'Ожидает проверки' }).waitFor();
    await user.waitForFunction(() => /(?:30|29|28) сек/.test(document.querySelector('#cooldown').textContent));
    assert.equal(await user.evaluate(() => window.XSS), undefined);
    assert.equal(await user.locator('.avatar').first().evaluate(img => img.getBoundingClientRect().width), 104);
    const threadUrl = user.url();
    const sectionId = await user.locator('#section-select').inputValue();
    await administrator.goto(base + '/index.html?section_id=' + sectionId);
    const pendingTopic = administrator.locator('#feed .post-table[data-status=pending]');
    await pendingTopic.waitFor();
    await administrator.waitForLoadState('networkidle');
    await pendingTopic.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await pendingTopic.waitFor({ state: 'hidden' });
    await administrator.waitForLoadState('networkidle');
    await administrator.goto(threadUrl);
    await administrator.getByRole('link', { name: 'browser_user', exact: true }).click();
    await administrator.getByRole('button', { name: 'Выдать автоподтверждение' }).click();
    await administrator.getByRole('button', { name: 'Отозвать автоподтверждение' }).waitFor();
    await administrator.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(base + '/index.html?view=all');
    await guest.waitForLoadState('networkidle');
    await guest.locator('#search-form [name=q]').fill('Browser registered');
    await guest.locator('#search-form button').click();
    await guest.getByRole('link', { name: 'Browser registered topic', exact: true }).waitFor();
    await guest.setViewportSize({ width: 375, height: 812 });
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log('Browser forms, worker PoW, uploads, feeds, premode and 45s/30s UI: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
