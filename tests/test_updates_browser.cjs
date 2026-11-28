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
  const base = process.env.FORBIRDS_TEST_URL, errors = [], external = [], writes = [];
  const fixture = (status, maintenance) => {
    const result = spawnSync('python3', ['-c', `import pathlib,json,sys,time
p=pathlib.Path(sys.argv[1])/'site-update'; s=json.loads((p/'state.json').read_text()); s.update(status=sys.argv[2],phase='migrate',started_at=int(time.time()),before='a'*40,after='b'*40,output='PRIVATE_RAW_COMMAND_OUTPUT'); s['error']='migration_failed' if sys.argv[2]=='failed' else None; (p/'state.json').write_text(json.dumps(s)); (p/'maintenance').write_text('fixture') if sys.argv[3]=='1' else (p/'maintenance').unlink(missing_ok=True)`, process.env.FORBIRDS_TEST_STORAGE, status, maintenance ? '1' : '0']);
    assert.equal(result.status, 0, String(result.stderr));
  };
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => { if (!localStorage.getItem('forbirds-language')) localStorage.setItem('forbirds-language', 'ru'); });
    await context.route('**/*', route => route.continue());
    const page = await context.newPage(); let dismiss = false;
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { if (dismiss) { dismiss = false; d.dismiss(); } else d.accept(); });
    page.on('request', r => {
      if (!r.url().startsWith(base)) external.push(r.url());
      if (r.url().endsWith('/api/admin/update') && r.method() === 'POST') writes.push(r);
    });
    await page.goto(base + '/dashboard.html');
    await page.locator('#auth-form [name=username]').fill('admin');
    await page.locator('#auth-form [name=password]').fill(process.env.FORBIRDS_TEST_PASSWORD);
    await page.locator('#auth-form button[value=login]').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('presentation-ready') && document.querySelector('#account-name')?.textContent.includes('admin'));
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: 'Обновление сайта', exact: true }).click();
    await page.getByText('Обновление не запущено.', { exact: true }).waitFor();
    const password = page.locator('#site-update-password'), start = page.locator('#site-update-start');
    assert.equal(await password.getAttribute('type'), 'password');
    assert.equal(writes.length, 0, 'loading the page never updates the site');
    await password.fill(process.env.FORBIRDS_TEST_PASSWORD);
    dismiss = true; await start.click();
    assert.equal(writes.length, 0, 'cancel is not a POST');
    assert.equal(await password.inputValue(), process.env.FORBIRDS_TEST_PASSWORD);
    await start.click();
    await page.getByText('Заявка принята. Ожидание серверного обработчика.', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(await start.isDisabled(), true);
    assert.equal(await password.inputValue(), '');
    fixture('running', true);
    await page.getByText('Выполняется обновление…', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('Выполняется обновление…', { exact: true }).waitFor();
    assert.equal(await start.isDisabled(), true, 'maintenance does not break the status page');
    fixture('failed', true);
    await page.getByText('Обновление остановлено из-за ошибки.', { exact: true }).waitFor();
    assert.ok((await page.locator('#site-update-warning').textContent()).includes('восстановление через консоль'));
    assert.equal(await start.isDisabled(), true);
    assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_RAW_COMMAND_OUTPUT'));
    fixture('succeeded', false);
    await page.getByText('Код обновлён, миграции выполнены.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Перезагрузить страницу', exact: true }).waitFor();
    await page.evaluate(() => localStorage.setItem('forbirds-language', 'en'));
    await page.reload();
    await page.getByRole('button', { name: 'Update site', exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => localStorage.setItem('forbirds-presentation', '1'));
    await page.reload();
    await page.locator('#presentation-hint').waitFor();
    assert.equal(await page.locator('#site-update-panel').count(), 0);
    const other = await browser.newContext();
    await other.addInitScript(() => localStorage.setItem('forbirds-language', 'en'));
    const guest = await other.newPage();
    await guest.goto(base + '/dashboard.html?mode=updates');
    await guest.getByText('Administrator privileges are required for this action.', { exact: true }).waitFor();
    assert.equal(await guest.locator('#site-update-panel').count(), 0);
    assert.equal(await guest.getByRole('link', { name: 'Site update', exact: true }).count(), 0);
    await other.close();
  } finally { await browser.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('Admin update confirmation/password/queue/polling, maintenance refresh, failure recovery warning, no raw logs, presentation, guest denial, EN and mobile: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
