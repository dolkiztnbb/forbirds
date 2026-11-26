/* Optional real-browser integration, launched by test_api.py with an isolated PHP server. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  let options = { headless: true };
  if (process.env.FORBIRDS_SERVERLESS_BROWSER === '1') {
    const packaged = require('@sparticuz/chromium').default;
    options = { ...options, executablePath: await packaged.executablePath(), args: packaged.args.filter(arg => arg !== '--single-process' && !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')) };
  }
  const browser = await chromium.launch(options);
  const errors = [], externalRequests = [], mediaRequests = [];
  const base = process.env.FORBIRDS_TEST_URL;
  async function page(context) {
    const p = await context.newPage();
    await p.addInitScript(() => localStorage.setItem('forbirds-language', 'ru'));
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
  async function languages() {
    const context = await browser.newContext({ locale: 'en-GB' });
    const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(base + '/dashboard.html');
    await p.locator('#language-dialog').waitFor();
    assert.equal(await p.locator('#language-dialog button').count(), 2);
    // Browser locale does not silently choose a language; Escape cannot dismiss the choice.
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('#language-dialog').isVisible(), true);
    await p.getByRole('button', { name: 'I speak English', exact: true }).click();
    await p.waitForFunction(() => document.querySelector('#section-select')?.options.length > 0);
    assert.equal(await p.locator('html').getAttribute('lang'), 'en');
    await p.getByRole('button', { name: 'Compute proof', exact: true }).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Compute proof', exact: true }).count(), 1);
    assert.match(await p.locator('#cooldown').textContent(), /45 seconds/);
    assert.equal(await p.locator('#section-select option').first().textContent(), 'Общий раздел');
    await p.locator('#auth-form button[value=login]').click();
    assert.equal(await p.locator('#auth-form [name=username]').evaluate(input => input.validationMessage), 'Please fill out this field.');
    await p.locator('#auth-form [name=username]').fill('wrongname');
    await p.locator('#auth-form [name=password]').fill('Incorrect-password-123');
    await p.locator('#auth-form button[value=login]').click();
    await p.locator('#notice').filter({ hasText: 'Incorrect username or password.' }).waitFor();
    // Unsaved text and file selections survive a cancelled language switch.
    await p.locator('#post-form [name=title]').fill('Ожидает проверки');
    await p.locator('#post-form [name=body]').fill('Сообщение пользователя без перевода');
    await p.locator('#file-input').setInputFiles({ name: 'текст.txt', mimeType: 'text/plain', buffer: Buffer.from('sample') });
    p.once('dialog', dialog => dialog.dismiss());
    await p.locator('#language-switch').click();
    assert.equal(await p.locator('#post-form [name=title]').inputValue(), 'Ожидает проверки');
    assert.match(await p.locator('#file-list').textContent(), /текст.txt/);
    await p.locator('#pow-start').click();
    await p.locator('#pow-status').filter({ hasText: 'Proof computed.' }).waitFor();
    assert.equal(await p.locator('#post-submit').isEnabled(), true);
    assert.equal(await p.locator('#post-form [name=body]').inputValue(), 'Сообщение пользователя без перевода');
    // Same page URLs and a saved choice on subsequent navigation.
    for (const url of ['/', '/post.html?id=99999999', '/profile.html?id=99999999', '/dashboard.html?mode=mine']) {
      await p.goto(base + url);
      await p.waitForFunction(() => document.documentElement.lang === 'en');
      assert.equal(await p.locator('#language-dialog').count(), 0);
      assert.equal(await p.getByRole('link', { name: 'Home', exact: true }).count(), 1);
    }
    await p.locator('#language-switch').click();
    await p.waitForFunction(() => document.documentElement.lang === 'ru');
    assert.equal(await p.getByRole('link', { name: 'Главная', exact: true }).count(), 1);
    await p.locator('#auth-form button[value=login]').click();
    assert.equal(await p.locator('#auth-form [name=username]').evaluate(input => input.validationMessage), 'Заполните это поле.');
    await p.reload();
    await p.locator('#language-switch').waitFor();
    assert.equal(await p.locator('#language-dialog').count(), 0);
    // Storage denial does not break startup or the explicit language choice.
    const blocked = await browser.newContext();
    const b = await blocked.newPage();
    b.on('pageerror', e => errors.push(e.message));
    await b.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('disabled'); };
      Storage.prototype.setItem = () => { throw new Error('disabled'); };
    });
    await b.goto(base + '/');
    await b.getByRole('button', { name: 'Я разговариваю по-русски', exact: true }).click();
    await b.locator('#feed .empty, #feed .post-table').first().waitFor();
    assert.equal(await b.locator('html').getAttribute('lang'), 'ru');
  }
  try {
    await languages();
    const guestContext = await browser.newContext(), adminContext = await browser.newContext(), userContext = await browser.newContext();
    const guest = await page(guestContext), administrator = await page(adminContext), user = await page(userContext);
    await guest.goto(base + '/dashboard.html');
    await guest.waitForFunction(() => document.querySelector('#section-select')?.options.length > 0);
    await guest.locator('#composer').waitFor();
    const originalLayout = await guest.evaluate(() => ({
      headerHeight: getComputedStyle(document.querySelector('.sub')).height,
      bannerWidth: document.querySelector('.banner-placeholder').getBoundingClientRect().width,
      bannerHeight: document.querySelector('.banner-placeholder').getBoundingClientRect().height,
      scrollOverflow: getComputedStyle(document.querySelector('.main-content > .scroll')).overflowY,
      textareaHeight: document.querySelector('.post-tb').getBoundingClientRect().height,
      viewportHeight: innerHeight,
      composerIsTable: document.querySelector('#post-form > .composer-table')?.tagName === 'TABLE',
      navigationInHeader: !!document.querySelector('.sub .site-nav'),
    }));
    assert.ok(parseFloat(originalLayout.headerHeight) >= 30);
    assert.equal(originalLayout.bannerWidth, 600);
    assert.equal(originalLayout.bannerHeight, 200);
    assert.equal(originalLayout.scrollOverflow, 'auto');
    assert.ok(Math.abs(originalLayout.textareaHeight - originalLayout.viewportHeight / 2) <= 2);
    assert.equal(originalLayout.composerIsTable, true);
    assert.equal(originalLayout.navigationInHeader, true);
    await guest.locator('#post-form [name=title]').fill('Browser guest topic');
    await guest.locator('#post-form [name=body]').fill('Guest message through a real form\n> green quote\n< orange quote\n^ blue quote\nplain > uncolored\n\n<script>window.QUOTE_XSS=true</script>');
    const fixture = filename => fs.readFileSync(path.join(process.env.FORBIRDS_TEST_FIXTURES, filename));
    await guest.locator('#file-input').setInputFiles([
      { name: 'browser.txt', mimeType: 'text/plain', buffer: Buffer.from('Browser attachment') },
      { name: 'wide.png', mimeType: 'image/png', buffer: fixture('wide.png') },
      { name: 'wide.gif', mimeType: 'image/gif', buffer: fixture('animated.gif') },
      { name: 'hidden.png', mimeType: 'image/png', buffer: fixture('wide.png') },
      { name: 'wide.jpg', mimeType: 'image/jpeg', buffer: fixture('wide.jpg') },
      { name: 'wide.webp', mimeType: 'image/webp', buffer: fixture('wide.webp') },
      { name: 'sample.webm', mimeType: 'video/webm', buffer: fixture('sample.webm') },
      { name: 'hidden.webm', mimeType: 'video/webm', buffer: fixture('sample.webm') },
      { name: 'sample.wav', mimeType: 'audio/wav', buffer: fixture('sample.wav') },
      { name: 'hidden.wav', mimeType: 'audio/wav', buffer: fixture('sample.wav') },
    ]);
    await guest.locator('#file-list input[type=checkbox]').nth(0).check();
    await guest.locator('#file-list input[type=checkbox]').nth(3).check();
    await guest.locator('#file-list input[type=checkbox]').nth(7).check();
    await guest.locator('#file-list input[type=checkbox]').nth(9).check();
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
    await guest.locator('#thread .post-body').filter({ hasText: 'Guest message through a real form' }).waitFor();
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
    const oldUrl = guest.url(), pageCount = guestContext.pages().length;
    await guest.getByRole('link', { name: 'Открыть изображение: wide.gif', exact: true }).click();
    const viewer = guest.getByRole('dialog', { name: 'Просмотр изображения: wide.gif', exact: true });
    await viewer.waitFor();
    assert.equal(await viewer.locator('img').evaluate(async image => { await image.decode(); return image.naturalWidth; }), 512);
    assert.equal(guest.url(), oldUrl);
    assert.equal(guestContext.pages().length, pageCount);
    await guest.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
    assert.equal(await guest.getByRole('link', { name: 'Открыть изображение: wide.gif', exact: true }).evaluate(a => a === document.activeElement), true);
    await guest.setViewportSize({ width: 375, height: 812 });
    await guest.getByRole('link', { name: 'Открыть изображение под спойлером: hidden.png', exact: true }).click();
    const revealed = guest.getByRole('dialog', { name: 'Просмотр изображения: hidden.png', exact: true });
    assert.equal(await revealed.locator('img').evaluate(async image => { await image.decode(); return image.naturalWidth; }), 512);
    const fits = await revealed.locator('img').evaluate(image => {
      const r = image.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    });
    assert.equal(fits, true);
    await revealed.getByRole('button', { name: 'Закрыть', exact: true }).click();
    assert.equal(mediaRequests.some(url => url.endsWith(hiddenImage.preview_url)), false);
    const hiddenVideo = attachments.find(file => file.original_name === 'hidden.webm');
    assert.equal(mediaRequests.some(url => url.endsWith(hiddenVideo.view_url)), false);
    const visibleVideo = guest.locator('video.attachment-video');
    assert.equal(await visibleVideo.count(), 1);
    assert.equal(await visibleVideo.getAttribute('preload'), 'none');
    assert.equal(await visibleVideo.evaluate(v => v.paused && !v.autoplay), true);
    assert.equal(await visibleVideo.evaluate(async v => { await v.play(); return v.videoWidth; }), 160);
    await visibleVideo.evaluate(v => { v.pause(); });
    await guest.getByText('Видео под спойлером: hidden.webm', { exact: true }).click();
    await guest.waitForFunction(() => document.querySelectorAll('video.attachment-video').length === 2);
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const hiddenAudio = attachments.find(file => file.original_name === 'hidden.wav');
    assert.equal(mediaRequests.some(url => url.endsWith(hiddenAudio.view_url)), false);
    const audio = guest.locator('audio.attachment-audio');
    assert.equal(await audio.count(), 1);
    assert.equal(await audio.getAttribute('preload'), 'none');
    assert.equal(await audio.evaluate(a => a.controls && a.paused && !a.autoplay), true);
    await audio.evaluate(async a => { await a.play(); });
    await audio.evaluate(a => a.pause());
    await guest.getByText('Аудио под спойлером: hidden.wav', { exact: true }).click();
    await guest.waitForFunction(() => document.querySelectorAll('audio.attachment-audio').length === 2);
    const spoilerAudio = guest.locator('.audio-box details audio');
    await spoilerAudio.evaluate(a => a.play());
    await guest.getByText('Аудио под спойлером: hidden.wav', { exact: true }).click();
    await guest.waitForFunction(() => document.querySelector('.audio-box details audio').paused);
    await audio.first().dispatchEvent('error');
    assert.equal(await guest.getByText('Если браузер не поддерживает формат аудио, скачайте оригинал.', { exact: true }).first().isVisible(), true);
    const body = guest.locator('#thread .post-body').first();
    assert.equal(await body.locator('.quote-green').textContent(), '> green quote');
    assert.equal(await body.locator('.quote-orange').first().textContent(), '< orange quote');
    assert.equal(await body.locator('.quote-blue').textContent(), '^ blue quote');
    assert.equal(await body.locator('script').count(), 0);
    assert.equal(await guest.evaluate(() => window.QUOTE_XSS), undefined);
    assert.ok((await body.textContent()).includes('plain > uncolored\n\n<script>'));
    const colors = await body.locator('[class^="quote-"]').evaluateAll(lines => lines.map(l => getComputedStyle(l).color));
    assert.equal(new Set(colors).size, 3);
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const recent = guest.locator('#sections .section-recent li');
    assert.equal(await recent.count(), 1);
    assert.equal(await recent.locator('a').getAttribute('href'), '/post.html?id=' + threadId + '&page=1#post-' + (await threadResponse.json()).data.post.id);
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
    const pendingProfileUrl = await user.locator('#account-name a').getAttribute('href');
    await guest.goto(base + pendingProfileUrl);
    await guest.locator('#profile').waitFor();
    assert.equal(await guest.locator('#profile-posts a').count(), 0, 'pending posts must not leak in public profiles');

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
    await administrator.getByRole('button', { name: 'Права / бан пользователя' }).click();
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

    // Section forms share the composer layout and retain real create/edit behavior.
    await administrator.goto(base + '/dashboard.html');
    const createSection = administrator.locator('#section-form');
    const editSection = administrator.locator('#section-settings-form');
    await createSection.waitFor();
    await administrator.waitForLoadState('networkidle');
    assert.equal(await createSection.locator('> .composer-table').count(), 1);
    assert.equal(await editSection.locator('> .composer-table').count(), 1);
    await createSection.getByLabel('Название', { exact: true }).fill('Наблюдение за птицами');
    await createSection.getByLabel('Адрес раздела', { exact: true }).fill('Invalid Address');
    assert.equal(await createSection.evaluate(f => f.checkValidity()), false);
    await createSection.getByLabel('Адрес раздела', { exact: true }).fill('bird-talk');
    await createSection.getByLabel('Описание', { exact: false }).fill('Где и как наблюдать за птицами.');
    await createSection.getByRole('button', { name: 'Добавить раздел' }).click();
    await administrator.locator('#notice').filter({ hasText: 'Раздел создан.' }).waitFor();
    assert.equal(await createSection.getByLabel('Название', { exact: true }).inputValue(), '');
    await administrator.locator('#section-select option').filter({ hasText: 'Наблюдение за птицами' }).waitFor({ state: 'attached' });
    await editSection.getByLabel('Раздел', { exact: true }).selectOption({ label: 'Наблюдение за птицами' });
    assert.equal(await editSection.getByLabel('Описание', { exact: false }).inputValue(), 'Где и как наблюдать за птицами.');
    const editedId = await editSection.getByLabel('Раздел', { exact: true }).inputValue();
    await editSection.getByLabel('Название', { exact: true }).fill('Полевые наблюдения');
    await editSection.getByLabel('Описание', { exact: false }).fill('Заметки и фотографии из поездок.');
    await editSection.getByLabel('Архивный раздел', { exact: true }).check();
    await editSection.getByRole('button', { name: 'Сохранить изменения' }).click();
    await administrator.locator('#notice').filter({ hasText: 'Настройки раздела сохранены.' }).waitFor();
    assert.equal(await editSection.getByLabel('Раздел', { exact: true }).inputValue(), editedId);
    await administrator.reload();
    await administrator.waitForLoadState('networkidle');
    await editSection.getByLabel('Раздел', { exact: true }).selectOption(editedId);
    assert.equal(await editSection.getByLabel('Название', { exact: true }).inputValue(), 'Полевые наблюдения');
    assert.equal(await editSection.getByLabel('Архивный раздел', { exact: true }).isChecked(), true);
    await createSection.getByLabel('Название', { exact: true }).fill('Повтор');
    await createSection.getByLabel('Адрес раздела', { exact: true }).fill('bird-talk');
    await createSection.getByRole('button', { name: 'Добавить раздел' }).click();
    await administrator.locator('#notice.error').waitFor();
    assert.equal(await createSection.getByLabel('Название', { exact: true }).inputValue(), 'Повтор');
    assert.equal(await createSection.getByRole('button').isEnabled(), true);
    for (const width of [1280, 375]) {
      await administrator.setViewportSize({ width, height: 900 });
      assert.equal(await administrator.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const form of [createSection, editSection]) {
        const layout = await form.evaluate(f => {
          const field = f.querySelector('.composer-body').getBoundingClientRect();
          const actions = f.querySelector('.composer-options').getBoundingClientRect();
          return { fieldRight: field.right, fieldBottom: field.bottom, actionsLeft: actions.left, actionsTop: actions.top };
        });
        if (width > 700) assert.ok(layout.actionsLeft >= layout.fieldRight - 1);
        else assert.ok(layout.actionsTop >= layout.fieldBottom - 1);
      }
    }
    await guest.goto(base + '/dashboard.html');
    await guest.waitForLoadState('networkidle');
    assert.equal(await guest.locator('#section-admin').isVisible(), false);
    const modSettings = await page(await browser.newContext());
    await login(modSettings, 'moderator');
    assert.equal(await modSettings.locator('#section-admin').isVisible(), false);
    await modSettings.close();

    // Own profile editing, public profile rendering, and avatars in existing posts.
    await user.goto(base + '/dashboard.html');
    await user.waitForLoadState('networkidle');
    await user.locator('#account-name a').click();
    await user.locator('#profile-editor').waitFor();
    await user.waitForLoadState('networkidle');
    const profileUrl = user.url();
    const profileForm = user.locator('#profile-form');
    const bio = '<script>window.profileXss = true</script> Люблю наблюдать за птицами.';
    await profileForm.getByLabel('О себе', { exact: true }).fill(bio);
    await profileForm.getByLabel('Флаг', { exact: true }).selectOption('ru.gif');
    assert.equal(await user.locator('#profile-flag-preview .user-flag').textContent(), 'Россия');
    await profileForm.getByLabel('Новая аватарка', { exact: true }).setInputFiles(path.join(process.env.FORBIRDS_TEST_FIXTURES, 'wide.png'));
    await profileForm.getByRole('button', { name: 'Сохранить профиль' }).click();
    await user.locator('#profile-result').filter({ hasText: 'Профиль сохранён.' }).waitFor();
    await user.waitForFunction(() => document.querySelector('#profile-avatar').complete && document.querySelector('#profile-avatar').naturalWidth === 256);
    assert.equal(await user.locator('#profile-description').textContent(), bio);
    assert.equal(await user.locator('#profile-flag .user-flag').textContent(), 'Россия');
    assert.equal(await user.evaluate(() => window.profileXss), undefined);
    await user.reload();
    await user.locator('#profile-editor').waitFor();
    await user.waitForLoadState('networkidle');
    assert.equal(await user.locator('#profile-bio').inputValue(), bio);
    assert.equal(await profileForm.getByLabel('Флаг', { exact: true }).inputValue(), 'ru.gif');
    await guest.goto(profileUrl);
    await guest.locator('#profile').waitFor();
    assert.equal(await guest.locator('#profile-editor').isVisible(), false);
    assert.equal(await guest.locator('#profile-description').textContent(), bio);
    assert.equal(await guest.locator('#profile-flag .user-flag').textContent(), 'Россия');
    assert.equal(await guest.evaluate(() => window.profileXss), undefined);
    assert.equal(await guest.locator('#profile-posts .post-table').count(), 0, 'profile posts must be compact rows, not full post cards');
    await guest.locator('#profile-posts a').filter({ hasText: 'Browser registered topic' }).click();
    await guest.waitForFunction(() => document.querySelector('.avatar')?.complete && document.querySelector('.avatar').naturalWidth === 256);
    assert.equal(await guest.locator('.post-author .user-flag').first().textContent(), 'Россия');
    await guest.locator('.author-name a').click();
    await guest.locator('#profile').waitFor();
    for (const width of [1280, 375]) {
      await user.setViewportSize({ width, height: 900 });
      assert.equal(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await guest.setViewportSize({ width, height: 900 });
      assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await profileForm.getByLabel('Флаг', { exact: true }).selectOption('');
    await profileForm.getByLabel('Удалить аватарку', { exact: true }).check();
    await profileForm.getByRole('button', { name: 'Сохранить профиль' }).click();
    await user.locator('#profile-result').filter({ hasText: 'Профиль сохранён.' }).waitFor();
    assert.equal(await user.locator('#profile-avatar').getAttribute('src'), '/avatars/noavatar.png');
    assert.equal(await user.locator('#profile-flag .user-flag').count(), 0);
    await guest.goto(base + '/profile.html?id=99999999');
    await guest.locator('#notice.error').waitFor();
    assert.equal(await guest.locator('#profile').isVisible(), false);

  } finally {
    await browser.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log('RU/EN selection, persistence, validation, unsaved changes, browser forms, section management, responsive layout, worker PoW, uploads, feeds, premode and 45s/30s UI: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
