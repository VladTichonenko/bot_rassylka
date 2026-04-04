/**
 * Язык по номеру из WhatsApp JID (…@c.us), если первое сообщение уже было.
 * Коды совпадают с LANGUAGE_NAMES в ai-service.js.
 */

/** Префиксы E.164 → код из LANGUAGE_NAMES в ai-service.js */
const PREFIX_LANG = [
  ['380', 'uk'],
  ['375', 'ru'],
  ['373', 'ru'],
  ['7', 'ru'],
  ['1', 'en'],
  ['44', 'en'],
  ['49', 'de'],
  ['33', 'fr'],
  ['34', 'es'],
  ['39', 'it']
];

function digitsFromChatId(chatId) {
  const m = String(chatId || '').match(/^(\d+)@/);
  return m ? m[1] : '';
}

function getLanguageFromPhone(chatId) {
  const digits = digitsFromChatId(chatId);
  if (!digits) return 'ru';
  for (const [prefix, lang] of PREFIX_LANG) {
    if (digits.startsWith(prefix)) return lang;
  }
  return 'ru';
}

module.exports = { getLanguageFromPhone, digitsFromChatId };
