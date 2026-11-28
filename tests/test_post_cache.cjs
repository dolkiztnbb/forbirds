const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const source = fs.readFileSync('public/post-cache.js', 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|setInterval|setTimeout/);
  const { createPostCache } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let calls = [], mode = 'ok', etag = '"one"', body = 'first', release;
  const cache = createPostCache({ maxEntries: 2, maxBytes: 1024, fetcher: async (url, options) => {
    const headers = new Headers(options.headers); calls.push({ url, headers });
    if (release) await new Promise(resolve => { release = resolve; });
    if (mode === 'network') throw new Error('offline');
    if (mode === 'error') return Response.json({ error: 'not found' }, { status: 404 });
    if (headers.get('If-None-Match') === etag) return new Response(null, { status: 304 });
    return Response.json({ body }, { headers: { ETag: etag } });
  } });
  const get = (path = '/posts/1', scope = 'guest') => cache.request(path, { method: 'GET', headers: {} }, scope);
  assert.equal((await (await get()).json()).body, 'first');
  assert.equal((await (await get()).json()).body, 'first');
  assert.equal(calls.at(-1).headers.get('If-None-Match'), '"one"');
  etag = '"two"'; body = 'edited';
  assert.equal((await (await get()).json()).body, 'edited');
  mode = 'error'; assert.equal((await get()).status, 404);
  mode = 'ok'; await get(); assert.equal(calls.at(-1).headers.get('If-None-Match'), null);
  await get('/posts/1', 'staff'); assert.equal(calls.at(-1).headers.get('If-None-Match'), null);
  cache.clear(); await get(); assert.equal(calls.at(-1).headers.get('If-None-Match'), null);
  mode = 'network'; await assert.rejects(get(), /offline/); // never serve stale data offline
  mode = 'ok'; await get();
  await get('/posts/2'); await get('/posts/3'); await get();
  assert.equal(calls.at(-1).headers.get('If-None-Match'), null, 'bounded LRU eviction');
  const start = calls.length; release = true;
  const a = get('/threads/1?live=1'), b = get('/threads/1?live=1');
  const finish = release; release = null; finish();
  const results = await Promise.all([a, b]);
  assert.equal(calls.length, start + 1, 'in-flight GETs coalesce');
  assert.deepEqual(await results[0].json(), await results[1].json());
  // Invalidation during a 304 requires an unconditional fetch, not resurrecting the old response.
  release = true; const old = get('/threads/1?live=1');
  const resume = release; release = null; cache.clear(); resume(); await old;
  assert.equal(calls.at(-1).headers.get('If-None-Match'), null);
  await get('/session'); await get('/session');
  assert.equal(calls.at(-1).headers.get('If-None-Match'), null);
  const small = createPostCache({ maxBytes: 1, fetcher: async (_, options) => {
    assert.equal(new Headers(options.headers).get('If-None-Match'), null);
    return Response.json({ large: 'not cached' }, { headers: { ETag: '"big"' } });
  } });
  await small.request('/posts/1', {}, 'guest'); await small.request('/posts/1', {}, 'guest');
  console.log('Post cache: conditional GET, fresh edits, no stale errors/offline, viewer isolation, invalidation races, deduplication and LRU limits: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
