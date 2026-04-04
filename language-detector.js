/**
 * Грубое определение языка текста (ru / en) для приветствия и ответов.
 */

function detectLanguageFromText(text) {
  const s = String(text || '');
  if (!s.trim()) return 'ru';
  const cyrillic = (s.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  if (cyrillic > latin) return 'ru';
  if (latin > cyrillic) return 'en';
  return 'ru';
}

module.exports = { detectLanguageFromText };
