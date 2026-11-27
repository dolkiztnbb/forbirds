/* Loaded synchronously in <head>, before any private UI can paint. */
(() => {
  const key = 'forbirds-presentation';
  // If one storage failed to update, an enabled value wins: never restore an
  // older disabled value over a successfully saved screenshot preference.
  const restore = () => ['localStorage', 'sessionStorage'].some(name => {
    try { return window[name].getItem(key) === '1'; } catch { return false; }
  });
  let enabled = restore();
  const apply = value => {
    enabled = value;
    document.documentElement.classList.toggle('presentation-safe', enabled);
    document.documentElement.classList.remove('presentation-ready');
    if (enabled) document.title = 'ForBirds';
  };
  apply(enabled);
  window.ForBirdsPresentation = {
    get enabled() { return enabled; },
    set(value) {
      let saved = false;
      for (const name of ['localStorage', 'sessionStorage']) {
        try { window[name].setItem(key, value ? '1' : '0'); saved = true; } catch { /* No false promise of persistence. */ }
      }
      if (!saved || restore() !== !!value) return false;
      apply(!!value);
      return true;
    },
  };
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    if (event.newValue === null) {
      if (enabled) window.ForBirdsPresentation.set(true);
      return;
    }
    if (['0', '1'].includes(event.newValue) && enabled !== (event.newValue === '1')) {
      window.ForBirdsPresentation.set(event.newValue === '1');
      window.location.reload();
    }
  });
})();
