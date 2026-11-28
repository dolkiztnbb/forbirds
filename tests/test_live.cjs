const assert = require('node:assert/strict');
const fs = require('node:fs');
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event); }
}
class Element extends Events {
  constructor() { super(); this.children = []; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  before(element) { this.bar = element; }
  remove() { this.removed = true; }
}
class Source extends Events {
  static CLOSED = 2;
  static instances = [];
  constructor(url) { super(); this.url = url; this.readyState = 1; Source.instances.push(this); }
  close() { this.closed = true; this.readyState = Source.CLOSED; }
  change(data) { this.emit('change', { data: JSON.stringify(data) }); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  global.document = Object.assign(new Events(), { hidden: false, createElement: () => new Element() });
  global.window = Object.assign(new Events(), { EventSource: Source });
  global.EventSource = Source;
  const js = fs.readFileSync('public/live-thread.js', 'utf8').replace("import { t } from '/i18n.js';", 'const t = key => key;');
  // No polling or page-refresh fallback is allowed in the live client.
  assert.doesNotMatch(js, /setInterval|setTimeout|location\.(?:reload|replace|assign)|fetch\(/);
  const { startThreadLive } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  let version = 'v1', scope = 'public', updates = 0, resets = 0, gone = 0;
  let release;
  const target = new Element();
  const options = { id: 42, page: 2, publicView: true, target, version: () => version, scope: () => scope,
    refresh: async () => { ++updates; if (release) await new Promise(resolve => { release = resolve; }); version = 'v2'; },
    reset: async () => { ++resets; scope = 'guest'; }, gone: () => ++gone };
  const live = startThreadLive(options);
  let source = Source.instances.at(-1);
  assert.match(source.url, /^\/api\/threads\/42\/events\?/);
  assert.equal(new URL('https://test' + source.url).searchParams.get('public_view'), '1');
  source.onopen();
  source.change({ version: 'v1', scope }); await tick(); assert.equal(updates, 0);
  source.emit('change', { data: '{broken' }); await tick(); assert.equal(updates, 0);
  source.change({ version: 'v2', scope }); await tick(); assert.equal(updates, 1);
  source.change({ version: 'v2', scope }); await tick(); assert.equal(updates, 1);
  source.change({ version: 'v3', scope: 'guest' }); await tick();
  assert.equal(resets, 1); assert.equal(updates, 2); assert.ok(source.closed);
  source = Source.instances.at(-1);
  // Coalesce a burst while a fetch is in flight, with one trailing reconciliation.
  release = true;
  source.change({ version: 'v4', scope }); await tick();
  for (let i = 0; i < 10; i++) source.change({ version: 'v5', scope });
  const finish = release; release = null; finish(); await tick();
  assert.equal(updates, 4);
  source.emit('maintenance'); assert.ok(source.closed);
  const retry = target.bar.children[1]; assert.equal(retry.hidden, false);
  retry.emit('click'); source = Source.instances.at(-1);
  source.emit('gone'); assert.equal(gone, 1);
  document.hidden = true; document.emit('visibilitychange');
  document.hidden = false; document.emit('visibilitychange');
  source = Source.instances.at(-1); assert.ok(!source.closed);
  const count = Source.instances.length;
  live.stop(); assert.ok(source.closed); assert.ok(target.bar.removed);
  document.emit('visibilitychange'); source.change({ version: 'v100', scope }); await tick();
  assert.equal(Source.instances.length, count); assert.equal(updates, 4);
  assert.equal(document.listeners.get('visibilitychange').size, 0);
  console.log('SSE client: versions, public view, scope reset, burst coalescing, retry, no polling, disposal: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
