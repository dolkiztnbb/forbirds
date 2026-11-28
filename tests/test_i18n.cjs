const assert = require('node:assert/strict');
const fs = require('node:fs');
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
(async () => {
  const source = fs.readFileSync('public/en.js', 'utf8');
  const english = (await import(uri(source))).default;
  for (const filename of ['app.js', 'i18n.js', 'moderation.js', 'ujutnenko.js', 'presentation.js', 'updates.js', 'live-thread.js']) {
    const js = fs.readFileSync('public/' + filename, 'utf8');
    // All source-language system literals must have an English entry, including
    // keys selected indirectly (for example, worker error codes).
    for (const match of js.matchAll(/'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"/g)) {
      const key = match[0].slice(1, -1);
      if (/[А-Яа-яЁё]/.test(key) && !key.includes(' / Choose') && key !== 'Я разговариваю по-русски' && key !== 'Русский') {
        assert.ok(Object.hasOwn(english, key), `Missing English key: ${key}`);
      }
    }
  }
  for (const page of ['index', 'post', 'dashboard', 'profile']) {
    const html = fs.readFileSync(`public/${page}.html`, 'utf8');
    for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]*)"/g)) {
      const key = match[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      assert.ok(Object.hasOwn(english, key), `Missing HTML key: ${key}`);
    }
    assert.match(html, /id="language-switch"/);
  }
  for (const [key, value] of Object.entries(english)) {
    const parameters = text => [...text.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();
    assert.deepEqual(parameters(key), parameters(value), `Mismatched parameters: ${key}`);
    assert.ok(!/[А-Яа-яЁё]/.test(value), `Untranslated English value: ${key}`);
  }
  const callbacks = {};
  const switcher = { addEventListener(event, callback) { callbacks[event] = callback; } };
  global.window = { localStorage: { getItem: () => 'en' }, sessionStorage: { getItem: () => null } };
  global.document = {
    documentElement: {}, querySelectorAll: () => [], querySelector: () => switcher, addEventListener() {},
  };
  const module = await import(uri(fs.readFileSync('public/i18n.js', 'utf8').replace("'/en.js'", JSON.stringify(uri(source)))));
  assert.equal(module.t('Главная'), 'Главная');
  await module.initLanguage();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(module.locale(), 'en-GB');
  assert.equal(module.t('Главная'), 'Home');
  assert.equal(module.t('Ответов: {count}', { count: 12 }), 'Replies: 12');
  assert.equal(module.t('Ошибка {status}', { status: '<b>{count}</b>' }), 'Error <b>{count}</b>');
  assert.equal(module.t('Unknown key'), 'Unknown key');
  assert.equal(switcher.textContent, 'Русский');
  console.log('Translation coverage, placeholders, locale and English initialization: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
