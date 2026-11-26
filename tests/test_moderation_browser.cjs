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
  const data = JSON.parse(process.env.FORBIRDS_MODERATION_FIXTURE);
  const errors = [], prompts = [];
  async function page(user) {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('forbirds-language', 'ru'));
    const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? (prompts.shift() || 'Browser moderation test') : undefined));
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
    const mod = await page('moderator');
    await mod.goto(base + `/post.html?id=${data.a.thread_id}`);
    await mod.locator(`#post-${data.a.post_id} .file-tools`).first().waitFor();
    assert.equal(await mod.locator('#show-identity').count(), 0);
    const fileButton = name => mod.locator(`#post-${data.a.post_id} .file-tools`).first().getByRole('button', { name, exact: true });
    await fileButton('Наложить спойлер').click();
    await fileButton('Убрать спойлер').waitFor();
    assert.equal(await mod.locator(`#post-${data.a.post_id} .spoiler-marker`).count(), 1);
    await fileButton('Убрать спойлер').click();
    await fileButton('Наложить спойлер').waitFor();
    await fileButton('Скрыть файл').click();
    await mod.getByText('pattern.png · Файл скрыт', { exact: true }).waitFor();
    assert.equal((await mod.request.get(base + `/api/attachments/${data.file_id}/view`)).status(), 404);
    await fileButton('Показать файл').click();
    await fileButton('Скрыть файл').waitFor();
    assert.equal((await mod.request.get(base + `/api/attachments/${data.file_id}/view`)).status(), 200);
    // Moving a reply leaves attachment IDs unchanged and removes it from the source thread.
    prompts.push(String(data.b.thread_id), 'Move reply');
    await mod.locator(`#post-${data.reply.post_id}`).getByRole('button', { name: 'Переместить', exact: true }).click();
    await mod.locator(`#post-${data.reply.post_id}`).waitFor({ state: 'detached' });
    await mod.goto(base + `/post.html?id=${data.b.thread_id}`);
    await mod.locator(`#post-${data.reply.post_id} .post-body`).filter({ hasText: 'Move this reply' }).waitFor();
    assert.equal(await mod.locator('[name=sage]').count(), 1);
    await mod.goto(base + `/post.html?id=${data.a.thread_id}`);
    await mod.locator(`#post-${data.a.post_id}`).waitFor();
    prompts.push(String(data.section_id), 'Move topic');
    await mod.locator(`#post-${data.a.post_id}`).getByRole('button', { name: 'Переместить', exact: true }).click();
    await mod.locator('#notice').filter({ hasText: 'Сообщение перемещено.' }).waitFor();
    const moved = await (await mod.request.get(base + `/api/threads/${data.a.thread_id}`)).json();
    assert.equal(moved.data.section_id, data.section_id);
    // Pending and deleted are styled, but still not disclosed to the public.
    await mod.goto(base + '/dashboard.html?mode=queue');
    await mod.locator(`#post-${data.pending.post_id}`).waitFor();
    assert.equal(await mod.locator(`#post-${data.pending.post_id}`).evaluate(e => getComputedStyle(e).opacity), '0.65');
    await mod.goto(base + '/dashboard.html?mode=archive');
    await mod.locator(`#post-${data.deleted.post_id}`).waitFor();
    assert.equal(await mod.locator(`#post-${data.deleted.post_id}`).evaluate(e => getComputedStyle(e).opacity), '0.65');
    const admin = await page('admin');
    await admin.goto(base + '/dashboard.html?mode=mine');
    await admin.locator('#show-identity').waitFor();
    assert.equal(await admin.locator('#show-identity').isChecked(), false);
    assert.equal(await admin.locator('.post-identity').first().textContent(), '');
    await admin.locator('#show-identity').check();
    await admin.locator('.post-identity').filter({ hasText: 'IP: 127.0.0.1' }).first().waitFor();
    await admin.goto(base + `/post.html?id=${data.a.thread_id}`);
    await admin.locator('.post-identity').filter({ hasText: 'IP: 127.0.0.1' }).first().waitFor();
    await admin.goto(base + '/dashboard.html?mode=mine');
    await admin.locator('#show-identity').uncheck();
    await admin.waitForFunction(() => [...document.querySelectorAll('.post-identity')].every(e => !e.textContent));
    await admin.waitForFunction(() => !document.querySelector('#show-identity').disabled);
    assert.equal((await admin.request.get(base + `/api/posts/${data.a.post_id}/identity`)).status(), 403);
    const guest = await page();
    await guest.goto(base + `/post.html?id=${data.a.thread_id}`);
    await guest.locator('#thread .post-body').waitFor();
    assert.equal(await guest.locator('.post-identity, .file-tools button').count(), 0);
    // Staff can add a local media ban; no banned image is fetched afterward.
    await mod.goto(base + `/post.html?id=${data.a.thread_id}`);
    await fileButton('Запретить файл и похожие изображения').click();
    await mod.getByText('pattern.png · Файл заблокирован', { exact: true }).waitFor();
    await guest.reload();
    await guest.locator('#thread .post-body').waitFor();
    assert.equal((await guest.request.get(base + `/api/attachments/${data.file_id}/preview`)).status(), 404);
    assert.deepEqual(errors, []);
    console.log('Moderation UI: files, moves, sage, archive styles and gated identity display: OK');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
