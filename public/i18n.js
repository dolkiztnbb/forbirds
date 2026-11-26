import english from '/en.js';

const storageKey = 'forbirds-language';
let language = 'ru';
export const locale = () => language === 'en' ? 'en-GB' : 'ru-RU';
export function t(key, values = {}) {
  const message = language === 'en' ? (english[key] ?? key) : key;
  return message.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
function savedLanguage() {
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      const value = window[storage].getItem(storageKey);
      if (value === 'ru' || value === 'en') return value;
    } catch { /* Storage may be disabled; selection still works for this page. */ }
  }
  return null;
}
function save(value) {
  for (const storage of ['localStorage', 'sessionStorage']) {
    try { window[storage].setItem(storageKey, value); } catch { /* Private browser settings. */ }
  }
}
function apply(value) {
  language = value;
  document.documentElement.lang = language;
  // Only explicitly marked system UI is translated, never user-generated content.
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  for (const attribute of ['aria-label', 'placeholder', 'title', 'alt']) {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    });
  }
}
export async function initLanguage() {
  let selected = savedLanguage();
  if (!selected) {
    const dialog = document.createElement('dialog');
    dialog.id = 'language-dialog';
    dialog.setAttribute('aria-labelledby', 'language-heading');
    const heading = document.createElement('h2');
    heading.id = 'language-heading';
    heading.textContent = 'Выберите язык / Choose your language';
    dialog.append(heading);
    dialog.addEventListener('cancel', event => event.preventDefault());
    document.body.append(dialog);
    selected = await new Promise(resolve => {
      for (const [value, text] of [['ru', 'Я разговариваю по-русски'], ['en', 'I speak English']]) {
        const button = document.createElement('button');
        button.type = 'button'; button.lang = value; button.textContent = text;
        button.addEventListener('click', () => { save(value); dialog.close(); dialog.remove(); resolve(value); });
        dialog.append(button);
      }
      dialog.showModal();
    });
  }
  apply(selected);
  // Native browser validation text otherwise follows the browser/OS language,
  // which can differ from the explicit forum selection.
  document.addEventListener('invalid', event => {
    const input = event.target;
    if (!input.setCustomValidity) return;
    input.setCustomValidity('');
    const v = input.validity;
    if (v.valueMissing) input.setCustomValidity(t('Заполните это поле.'));
    else if (v.tooShort) input.setCustomValidity(t('Минимум символов: {count}.', { count: input.minLength }));
    else if (v.tooLong) input.setCustomValidity(t('Максимум символов: {count}.', { count: input.maxLength }));
    else if (v.patternMismatch) input.setCustomValidity(t('Используйте указанный формат.'));
    else if (!v.valid) input.setCustomValidity(t('Проверьте значение этого поля.'));
  }, true);
  for (const event of ['input', 'change']) {
    document.addEventListener(event, e => e.target.setCustomValidity?.(''));
  }
  let dirty = false;
  for (const event of ['input', 'change', 'drop', 'paste']) {
    document.addEventListener(event, e => {
      if (e.target.closest('form:not(#auth-form):not(#search-form)')) dirty = true;
    });
  }
  const switcher = document.querySelector('#language-switch');
  switcher.hidden = false;
  switcher.textContent = language === 'ru' ? 'English' : 'Русский';
  switcher.lang = language === 'ru' ? 'en' : 'ru';
  switcher.addEventListener('click', () => {
    if (dirty && !window.confirm(t('Есть несохранённые изменения. Сменить язык и перезагрузить страницу?'))) return;
    save(language === 'ru' ? 'en' : 'ru');
    location.reload();
  });
}
