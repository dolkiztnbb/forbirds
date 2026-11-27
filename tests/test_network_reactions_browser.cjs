const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { spawnSync } = require('node:child_process');
(async () => {
  let options = { headless: true };
  if (process.env.FORBIRDS_SERVERLESS_BROWSER === '1') {
    const packaged = require('@sparticuz/chromium').default;
    options = { ...options, executablePath: await packaged.executablePath(), args: packaged.args.filter(arg => arg !== '--single-process' && !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')) };
  }
  const browser = await chromium.launch(options);
  const base = process.env.FORBIRDS_TEST_URL;
  const data = JSON.parse(process.env.FORBIRDS_REACTION_FIXTURE);
  const errors = [];
  const network = enabled => {
    const result = spawnSync('python3', ['-c', "import sqlite3,sys,time; db=sqlite3.connect(sys.argv[1]); db.execute('DELETE FROM network_ranges'); db.execute('INSERT INTO network_ranges VALUES (?,?,?)',('tor','127.0.0.1/32',int(time.time()))) if sys.argv[2]=='1' else None; db.commit(); db.close()", process.env.FORBIRDS_TEST_DB, enabled ? '1' : '0']);
    assert.equal(result.status, 0, String(result.stderr));
  };
  async function page(user) {
    const context = await browser.newContext();
    await context.addInitScript(() => { if (!localStorage.getItem('forbirds-language')) localStorage.setItem('forbirds-language', 'ru'); });
    const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Browser appeal accepted' : undefined));
    if (user) {
      await p.goto(base + '/dashboard.html');
      await p.locator('#auth-form [name=username]').fill(user);
      await p.locator('#auth-form [name=password]').fill(process.env.FORBIRDS_TEST_PASSWORD);
      await p.locator('#auth-form button[value=login]').click();
      await p.locator('#account-name').waitFor();
    }
    return p;
  }
  try {
    const guest = await page();
    const user = await page('normal');
    const url = base + `/post.html?id=${data.root.thread_id}`;
    await guest.goto(url);
    const first = p => p.locator(`#post-${data.root.post_id} .reaction-button`).filter({ has: p.locator(`img[src$="/${data.images[0]}"]`) });
    const second = p => p.locator(`#post-${data.root.post_id} .reaction-button`).filter({ has: p.locator(`img[src$="/${data.images[1]}"]`) });
    await first(guest).waitFor();
    assert.equal(await first(guest).isDisabled(), true);
    await user.goto(url);
    await first(user).click();
    await first(user).filter({ hasText: '1' }).waitFor();
    assert.equal(await first(user).getAttribute('aria-pressed'), 'true');
    await second(user).click();
    await second(user).filter({ hasText: '1' }).waitFor();
    assert.equal(await first(user).textContent(), '0');
    await second(user).click();
    await second(user).filter({ hasText: '0' }).waitFor();
    await user.setViewportSize({ width: 375, height: 812 });
    assert.equal(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    network(true);
    await user.reload();
    await user.locator('#network-read-only').waitFor();
    assert.equal(await first(user).isDisabled(), true);
    assert.equal(await user.locator('#search-form [name=q]').isDisabled(), false);
    assert.equal(await user.locator('#language-switch').isDisabled(), false);
    assert.equal(await user.locator('#composer').isVisible(), false);
    const session = (await (await user.request.get(base + '/api/session')).json()).data;
    const denied = await user.request.post(base + '/api/pow/challenge', { headers: { 'X-CSRF-Token': session.csrf_token }, data: {} });
    assert.equal(denied.status(), 403);
    assert.equal((await denied.json()).error.code, 'network_read_only');
    network(false);
    await user.reload();
    await user.locator('#network-read-only').waitFor();
    const admin = await page('admin');
    await admin.goto(base + '/dashboard.html?mode=network-bans');
    const privacy = admin.waitForResponse(r => r.url().endsWith('/api/moderation/privacy') && r.request().method() === 'POST');
    await admin.locator('#show-identity').check();
    await privacy;
    await admin.reload();
    await admin.getByRole('button', { name: 'Снять блокировку', exact: true }).first().waitFor();
    assert.equal(await admin.getByRole('button', { name: 'Снять блокировку', exact: true }).count(), 2);
    await admin.getByRole('button', { name: 'Снять блокировку', exact: true }).first().click();
    await admin.waitForFunction(() => document.querySelectorAll('#dashboard-content button').length === 1);
    await admin.getByRole('button', { name: 'Снять блокировку', exact: true }).click();
    await admin.getByText('Список блокировок пуст.', { exact: true }).waitFor();
    await user.reload();
    await user.locator('#composer').waitFor();
    assert.equal(await user.locator('#network-read-only').count(), 0);
    assert.equal(await first(user).isDisabled(), false);
    await user.evaluate(() => localStorage.setItem('forbirds-language', 'en'));
    await user.reload();
    await user.getByRole('button', { name: 'Reaction: ' + data.images[0].replace('.png', ''), exact: true }).waitFor();
  } finally {
    network(false);
    await browser.close();
  }
  assert.deepEqual(errors, []);
  console.log('Reactions, votes, toggle, guest read-only, Tor persistent restrictions, admin appeal, responsive UI and English: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
