const axios = require('axios');
const path = require('path');
require('./load-env');
const { BROADCAST_KNOWLEDGE_BASE } = require('./broadcast-knowledge-base');

const AI_API_URL =
  process.env.AI_API_URL || 'https://api.intelligence.io.solutions/api/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-ai/DeepSeek-V3.2';

function getAiApiKey() {
  const v = process.env.AI_API_KEY || process.env.INTELLIGENCE_API_KEY;
  if (v != null) {
    const t = String(v).trim().replace(/^["']|["']$/g, '');
    if (t) return t;
  }
  try {
    const rootAi = require(path.join(__dirname, '..', 'ai-service'));
    if (typeof rootAi.getResolvedIntelligenceApiKey === 'function') {
      const k = String(rootAi.getResolvedIntelligenceApiKey() || '').trim().replace(/^["']|["']$/g, '');
      if (k) return k;
    }
  } catch {
    /* нет корневого ai-service.js */
  }
  return '';
}

/** Не дать случайно подставить токен Green API вместо ключа intelligence.io */
function assertNotGreenApiTokenConfusion(apiKey) {
  const green = process.env.API_TOKEN_INSTANCE;
  if (!green || !apiKey) return;
  if (String(green).trim() === apiKey) {
    throw new Error(
      'AI_API_KEY совпадает с API_TOKEN_INSTANCE: это разные сервисы. ' +
        'API_TOKEN_INSTANCE — для Green API (WhatsApp по HTTP). ' +
        'Для чата нужен отдельный ключ intelligence.io (обычно начинается с io-v2-…), как в корневом reilway/ai-service.js — вынесите его в AI_API_KEY в .env.'
    );
  }
}

/**
 * @param {unknown} error
 * @returns {string|null} null — передать ошибку дальше как есть (например retry по таймауту)
 */
function explainAxiosAiError(error) {
  const res = error?.response;
  if (!res) return null;

  const s = res.status;
  const data = res.data;
  const detail =
    typeof data?.error === 'string'
      ? data.error
      : typeof data?.error?.message === 'string'
        ? data.error.message
        : typeof data?.message === 'string'
          ? data.message
          : '';
  const short = detail.length > 220 ? `${detail.slice(0, 220)}…` : detail;
  const baseUrl = (AI_API_URL || '').split('?')[0];

  if (s === 401 || s === 403) {
    return (
      `Доступ к AI отклонён (HTTP ${s}): для ${baseUrl} нужен ключ intelligence.io (не API_TOKEN_INSTANCE от Green API). ` +
      `Задайте AI_API_KEY отдельно — строка вида io-v2-… из кабинета intelligence.io. ` +
      `В корневом проекте ключ сейчас может быть захардкожен в ai-service.js; скопируйте его в переменную окружения.` +
      (short ? ` Подробности: ${short}` : '')
    );
  }
  if (s === 404) {
    return `Неверный AI_API_URL (HTTP 404): ${baseUrl}${short ? `. ${short}` : ''}`;
  }
  if (s === 429) {
    return `Превышен лимит запросов к AI (HTTP 429).${short ? ` ${short}` : ''}`;
  }
  return `Ошибка AI API (HTTP ${s})${short ? `: ${short}` : ''}`;
}

async function postChatCompletion(url, payload, headers) {
  try {
    return await axios.post(url, payload, { headers, timeout: 90000 });
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        return await axios.post(url, payload, { headers, timeout: 90000 });
      } catch (e2) {
        const msg = explainAxiosAiError(e2);
        throw new Error(msg || e2.message || String(e2));
      }
    }
    const msg = explainAxiosAiError(error);
    throw new Error(msg || error.message || String(error));
  }
}

const LANGUAGE_NAMES = {
  ru: 'русском',
  en: 'английском',
  es: 'испанском',
  de: 'немецком',
  fr: 'французском',
  it: 'итальянском',
  uk: 'украинском'
};

function buildPromptExtrasFromConfig(config) {
  if (!config || typeof config !== 'object') return '';
  const parts = [];
  if (String(config.theme || '').trim()) parts.push(`Тема / фокус контента: ${String(config.theme).trim()}`);
  if (String(config.role || '').trim()) parts.push(`Роль бота: ${String(config.role).trim()}`);
  if (String(config.rules || '').trim()) parts.push(`Правила сообщений и стиля:\n${String(config.rules).trim()}`);
  if (!parts.length) return '';
  return `\n\nНастройки из панели управления:\n${parts.join('\n')}`;
}

function hasPanelIdentity(config) {
  if (!config || typeof config !== 'object') return false;
  return (
    !!String(config.theme || '').trim() ||
    !!String(config.role || '').trim() ||
    !!String(config.rules || '').trim()
  );
}

/**
 * Универсальный чат: ответы на любые темы без привязки к платформе.
 * @param {Array<{ sender: 'user'|'assistant', text: string }>} conversationHistory
 * @param {string} userLanguage код языка (ru, en, …)
 * @param {object} [options]
 * @param {object} [options.panelConfig] — theme, role, rules из bot-config.json (приоритет над «универсальным» режимом)
 * @param {string} [options.configExtras] — устар.; если передан panelConfig, не используется
 */
async function askAI(conversationHistory, userLanguage = 'ru', options = {}) {
  const apiKey = getAiApiKey();
  if (!apiKey) {
    throw new Error(
      'Не задан ключ для intelligence.io: добавьте AI_API_KEY в reilway/.env или оставьте запасной ключ в корневом ai-service.js.'
    );
  }
  assertNotGreenApiTokenConfusion(apiKey);

  const limitedHistory = conversationHistory.slice(-12);
  const langName = LANGUAGE_NAMES[userLanguage] || 'русском';

  const envExtra = process.env.BOT_SYSTEM_PROMPT
    ? `\n\nДополнительно из .env (BOT_SYSTEM_PROMPT):\n${process.env.BOT_SYSTEM_PROMPT}`
    : '';

  const cfg = options.panelConfig || {};
  const theme = String(cfg.theme || '').trim();
  const role = String(cfg.role || '').trim();
  const rules = String(cfg.rules || '').trim();
  const panelMode = hasPanelIdentity(cfg);

  let systemPrompt;
  if (panelMode) {
    systemPrompt = `Ты бот в WhatsApp. Отвечай на ${langName} языке (если пользователь явно пишет на другом — переключись).

НАСТРОЙКИ С САЙТА — ГЛАВНЫЕ. Следуй им в первую очередь; не уходи в «универсальный болтолог».
${theme ? `\n• Тема / фокус: ${theme}` : ''}
${role ? `\n• Роль и тон: ${role}` : ''}
${rules ? `\n• Правила сообщений:\n${rules}` : ''}
${envExtra}

Если вопрос явно не про эту тематику — коротко откажись или мягко верни разговор к теме. Не выдавай себя за врача/юриста при серьёзных вопросах.

Формат: кратко (2–8 предложений), если в правилах не указано иначе; при просьбе пользователя — подробнее.`;
  } else {
    const panelExtra = options.configExtras || '';
    systemPrompt = `Ты дружелюбный умный ассистент в WhatsApp. Отвечай на ${langName} языке (если пользователь явно пишет на другом — переключись на него).

Ты можешь обсуждать любые темы: быт, наука, технологии, работа, учёба, советы, творчество, общие знания. Будь полезным и честным: если чего-то не знаешь — скажи об этом. Не выдавай себя за юриста/врача при серьёзных вопросах — предлагай обратиться к специалисту.

Формат: по умолчанию кратко (2–6 предложений). Если пользователь просит подробнее — разверни ответ.${envExtra}${panelExtra}`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...limitedHistory.map((msg) => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    }))
  ];

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  const payload = {
    model: AI_MODEL,
    messages,
    temperature: panelMode ? 0.55 : 0.7
  };

  const response = await postChatCompletion(AI_API_URL, payload, headers);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`AI API: ${response.status}`);
  }

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Пустой ответ от AI');
  }

  return content.trim();
}

/**
 * Текст одной рассылки для группы (новостной дайджест).
 * @param {{ theme?: string, role?: string, rules?: string }} config
 * @param {string} userLanguage
 * @param {string} broadcastPrompt
 */
async function generateNewsDigest(config = {}, userLanguage = 'ru', broadcastPrompt = '') {
  const apiKey = getAiApiKey();
  if (!apiKey) {
    throw new Error(
      'Не задан ключ для intelligence.io: добавьте AI_API_KEY в reilway/.env или оставьте запасной ключ в корневом ai-service.js.'
    );
  }
  assertNotGreenApiTokenConfusion(apiKey);

  const langName = LANGUAGE_NAMES[userLanguage] || 'русском';
  const theme = String(config.theme || '').trim();
  const role = String(config.role || '').trim();
  const rules = String(config.rules || '').trim();
  const prompt = String(broadcastPrompt || '').trim();

  const systemPrompt = `Ты бот рассылок WhatsApp. Подготовь один готовый пост на ${langName} языке.
${theme ? `ОБЯЗАТЕЛЬНАЯ тематика и угол: ${theme}. Не уходи в сторонние темы.` : 'Тематика общая — актуальный краткий обзор.'}
${role ? `Роль и тон (соблюдай): ${role}.` : ''}
${rules ? `Правила оформления и содержания (соблюдай строго):\n${rules}` : ''}
${prompt ? `Специальный промпт для этой конкретной рассылки (высший приоритет, выполнять строго):\n${prompt}` : ''}

База знаний (используй как единственный источник фактов, если нужен факт):
${BROADCAST_KNOWLEDGE_BASE}

КРИТИЧЕСКИЕ ПРАВИЛА:
1) Если есть специальный промпт рассылки, текст должен соответствовать ему в первую очередь.
2) Используй только факты из базы знаний и из промпта рассылки.
3) Не выдумывай данные, проценты, имена, даты, цены и результаты.
4) Если факта нет в базе, не фантазируй — дай нейтральную формулировку без неподтвержденных деталей.

Требования: один блок текста для отправки в чат; без заголовков с символом #; эмодзи — умеренно; длина примерно 400–2000 символов; не выдумывай конкретные даты событий и цифры, если не уверен — формулируй осторожно.`;

  const userDigestAsk =
    theme || role || rules || prompt
      ? userLanguage === 'en'
        ? `Write one broadcast message. Follow the dedicated broadcast prompt strictly and use only verified facts from the provided knowledge base.`
        : `Напиши одно сообщение-рассылку. Строго выполни специальный промпт рассылки и используй только проверенные факты из базы знаний.`
      : userLanguage === 'en'
        ? `Write today’s short news digest for the group (one message).`
        : 'Напиши краткий новостной дайджест для группы (одно сообщение).';

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: userDigestAsk
    }
  ];

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  const payload = {
    model: AI_MODEL,
    messages,
    temperature: 0.65
  };

  const response = await postChatCompletion(AI_API_URL, payload, headers);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`AI API: ${response.status}`);
  }

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Пустой ответ от AI');
  }

  return content.trim();
}

module.exports = { askAI, generateNewsDigest, buildPromptExtrasFromConfig };
