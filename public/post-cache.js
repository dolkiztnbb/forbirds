/** Bounded, per-tab memory cache. Every reuse is authorized/revalidated by the server; no offline fallback. */
export function createPostCache({ fetcher = (...args) => fetch(...args), maxEntries = 80, maxBytes = 4 * 1024 * 1024 } = {}) {
  const entries = new Map(), pending = new Map();
  let bytes = 0, generation = 0;
  const eligible = path => /^\/(?:posts\/[1-9][0-9]*|threads(?:\/[1-9][0-9]*)?)(?:\?|$)/.test(path);
  const remove = key => { const old = entries.get(key); if (old) bytes -= old.size; entries.delete(key); };
  const clear = () => { ++generation; entries.clear(); pending.clear(); bytes = 0; };
  const request = async (path, options, scope) => {
    if ((options.method || 'GET') !== 'GET' || !eligible(path)) return fetcher('/api' + path, options);
    const key = JSON.stringify([scope, path]);
    if (pending.has(key)) return (await pending.get(key)).clone();
    const epoch = generation;
    const load = async () => {
      const previous = entries.get(key);
      const headers = new Headers(options.headers);
      if (previous) headers.set('If-None-Match', previous.etag);
      let response = await fetcher('/api' + path, { ...options, headers, cache: 'no-store' });
      if (response.status === 304) {
        if (previous && epoch === generation) {
          entries.delete(key); entries.set(key, previous);
          return new Response(previous.body, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // A write/session reset overtook validation. Never resurrect an invalidated entry.
        response = await fetcher('/api' + path, { ...options, cache: 'no-store' });
      }
      if (epoch !== generation) return response;
      remove(key);
      const etag = response.headers.get('ETag');
      if (response.status === 200 && etag && response.headers.get('Content-Type')?.includes('application/json')) {
        const body = await response.clone().text();
        const size = body.length * 2; // conservative UTF-16 storage budget
        if (epoch === generation && size <= maxBytes) {
          entries.set(key, { body, etag, size }); bytes += size;
          while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
        }
      }
      return response;
    };
    const task = load(); pending.set(key, task);
    try { return (await task).clone(); }
    finally { if (pending.get(key) === task) pending.delete(key); }
  };
  return { request, clear };
}
