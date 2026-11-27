const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/presentation.js', 'utf8');
const key = 'forbirds-presentation';
function boot(value, localBlocked = false, sessionBlocked = false) {
  const classes = new Set();
  const events = {};
  let reloads = 0;
  const storage = blocked => { let stored = value; return { getItem: () => { if (blocked) throw Error(); return stored; }, setItem: (key, value) => { if (blocked) throw Error(); stored = value; } }; };
  const window = { localStorage: storage(localBlocked), sessionStorage: storage(sessionBlocked), addEventListener: (name, fn) => { events[name] = fn; }, location: { reload: () => { reloads++; } } };
  const document = { title: 'Private title', documentElement: { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, remove(name) { classes.delete(name); } } } };
  vm.runInNewContext(source, { window, document });
  return { window, document, classes, events, reloads: () => reloads };
}
const active = boot('1');
assert.ok(active.classes.has('presentation-safe'), 'restored synchronously before application initialization');
assert.equal(active.document.title, 'ForBirds');
assert.equal(active.window.ForBirdsPresentation.enabled, true);
assert.equal(active.window.ForBirdsPresentation.set(false), true);
assert.ok(!active.classes.has('presentation-safe'));
const crossTab = boot('0');
crossTab.events.storage({ key, newValue: '1' });
assert.ok(crossTab.classes.has('presentation-safe'));
assert.equal(crossTab.reloads(), 1);
crossTab.events.storage({ key, newValue: null });
assert.ok(crossTab.classes.has('presentation-safe'), 'clearing storage must not reveal the current page');
const stale = boot('0');
stale.window.localStorage.setItem = () => { throw Error(); };
assert.equal(stale.window.ForBirdsPresentation.set(true), true, 'session write survives a stale disabled local value');
assert.equal(stale.window.sessionStorage.getItem(key), '1');
const staleEnabled = boot('1');
staleEnabled.window.localStorage.setItem = () => { throw Error(); };
assert.equal(staleEnabled.window.ForBirdsPresentation.set(false), false, 'cannot promise to disable with a stale enabled value');
assert.equal(staleEnabled.window.ForBirdsPresentation.enabled, true);
assert.equal(boot('1', true).window.ForBirdsPresentation.enabled, true, 'session fallback');
const blocked = boot(null, true, true);
assert.equal(blocked.window.ForBirdsPresentation.set(true), false);
assert.equal(blocked.window.ForBirdsPresentation.enabled, false, 'no false claim that the mode was persisted');
for (const page of ['index', 'post', 'dashboard', 'profile']) {
  const html = fs.readFileSync('public/' + page + '.html', 'utf8');
  assert.ok(html.indexOf('src="/presentation.js"') < html.indexOf('rel="stylesheet"'));
}
console.log('Presentation early restore, cross-tab changes, fail-safe clear, storage fallback and head loading: OK');
