const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const { renderMarkdown: render } = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync('public/markdown.js')).toString('base64'));
  const result = render('# Heading\n\n**bold** *italic* ~~gone~~ `code`\n\n- one\n- two\n\n1. first\n2. second\n\n[link](https://example.org "title")');
  for (const tag of ['h1', 'strong', 'em', 's', 'code', 'ul', 'ol', 'li']) assert.ok(result.includes('<' + tag + '>'), tag);
  assert.match(result, /rel="nofollow noopener noreferrer"/);
  assert.match(render('> **green**\n< orange\n^ blue'), /class="quote-green">&gt; <strong>green<\/strong>/);
  assert.match(render('> green\n< orange\n^ blue'), /class="quote-orange">&lt; orange/);
  assert.match(render('> green\n< orange\n^ blue'), /class="quote-blue">\^ blue/);
  for (const code of ['```js\n> code\n<script>alert(1)</script>\n```', '    > code']) {
    const html = render(code); assert.match(html, /<pre><code/); assert.ok(!html.includes('quote-green')); assert.ok(!html.includes('<script>'));
  }
  for (const text of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe srcdoc="bad">', '<style>body{display:none}</style>']) {
    const html = render(text); assert.ok(!/<(?:script|img|svg|iframe|style)\b/i.test(html)); assert.match(html, /&lt;/);
  }
  for (const url of ['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,bad', 'file:///etc/passwd', 'ftp://example.org']) {
    assert.ok(!render(`[bad](${url})`).includes('<a '), url);
  }
  for (const url of ['https://example.org', '/post.html?id=1', '#post-1', '../index.html', 'mailto:test@example.org']) {
    assert.ok(render(`[ok](${url})`).includes('<a '), url);
  }
  assert.ok(!render('![tracker](https://example.org/tracker.png)').includes('<img'));
  assert.ok(!render('https://example.org').includes('<a '));
  assert.ok(render('normal > middle').includes('normal &gt; middle'));
  assert.ok(!render('normal > middle').includes('quote-green'));
  console.log('Markdown formatting, safe links, escaped HTML, no remote images, quotes and code fences: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
