// One preference per numeric section ID: toggling one section never overwrites another.
const memory = new Map();
const key = id => /^[1-9][0-9]*$/.test(String(id)) ? 'forbirds-section-' + id : null;
export function sectionOpen(id) {
  const name = key(id);
  if (!name) return true;
  if (memory.has(name)) return memory.get(name);
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      const value = window[storage].getItem(name);
      if (value === '0' || value === '1') return value === '1';
    } catch { /* Fall back without breaking navigation when storage is disabled. */ }
  }
  return true;
}
export function rememberSection(id, open) {
  const name = key(id);
  if (!name) return;
  memory.set(name, !!open);
  for (const storage of ['localStorage', 'sessionStorage']) {
    try { window[storage].setItem(name, open ? '1' : '0'); } catch { /* In-page memory still works. */ }
  }
}
