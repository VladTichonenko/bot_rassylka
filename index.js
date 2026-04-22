const path = require('path');
require('./load-env');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { DateTime } = require('luxon');

const { detectLanguageFromText } = require('./language-detector');
const { getLanguageFromPhone } = require('./phone-utils');
const { askAI, generateNewsDigest } = require('./ai-service');
const { readConfig, patchConfig } = require('./config-store');

/**
 * Локально / монорепо: BOT_PORT перекрывает PORT, если в корневом .env PORT занят другим сервисом.
 * На Railway прокси шлёт только на process.env.PORT — если задать BOT_PORT в Variables, сайт «не отвечает».
 */
/** Railway задаёт PORT и часто RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT (в Docker тоже). */
const onRailway = Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_PUBLIC_DOMAIN
);
const BOT_PORT = parseInt(
  onRailway ? process.env.PORT || '3000' : process.env.BOT_PORT || process.env.PORT || '3002',
  10
);
const sessionPath = process.env.SESSION_PATH || path.join(__dirname, '.wwebjs_auth_general');
const clientId = process.env.WWEBJS_CLIENT_ID || 'general-ai-wabot';
const USE_POLLING = process.env.USE_POLLING !== '0' && process.env.USE_POLLING !== 'false';

let botReady = false;
let lastQr = null;
let scheduleTimer = null;
const conversationHistory = new Map();
const firstMessageUsers = new Set();
const MAX_HISTORY_LENGTH = 20;

const processedMessageIds = new Map();
const MAX_PROCESSED_IDS = 10000;
const PROCESSED_ID_TTL = 3600000;

function cleanupProcessedIds() {
  const now = Date.now();
  for (const [msgId, ts] of processedMessageIds.entries()) {
    if (now - ts > PROCESSED_ID_TTL) processedMessageIds.delete(msgId);
  }
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const sorted = [...processedMessageIds.entries()].sort((a, b) => a[1] - b[1]);
    sorted.slice(0, processedMessageIds.size - MAX_PROCESSED_IDS).forEach(([id]) => processedMessageIds.delete(id));
  }
}

function addToHistory(chatId, sender, text) {
  if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
  const h = conversationHistory.get(chatId);
  h.push({ sender, text, timestamp: Date.now() });
  if (h.length > MAX_HISTORY_LENGTH) h.shift();
}

function getHistory(chatId) {
  return conversationHistory.get(chatId) || [];
}

function isMarkedUnreadError(error) {
  const s = error.message || error.toString() || '';
  return s.includes('markedUnread') || s.includes('sendSeen') || s.includes('Cannot read properties of undefined');
}

async function sendMessageSafely(msg, text, client) {
  const chatId = msg.from;
  try {
    const chat = await msg.getChat();
    await chat.sendMessage(text);
    return;
  } catch (e) {
    if (!isMarkedUnreadError(e)) console.error('send chat:', e.message);
  }
  try {
    await client.sendMessage(chatId, text, { sendSeen: false });
    return;
  } catch (e) {
    if (!isMarkedUnreadError(e)) console.error('send direct:', e.message);
  }
  try {
    await msg.reply(text);
  } catch (e) {
    if (!isMarkedUnreadError(e)) console.error('reply:', e.message);
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next();
  const h = req.headers.authorization || '';
  if (h !== `Bearer ${token}`) {
    return res.status(401).json({ success: false, error: 'Требуется авторизация (ADMIN_TOKEN).' });
  }
  return next();
}

function extractInviteCode(url) {
  if (!url || typeof url !== 'string') return null;
  const m = String(url).trim().match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{10,})/i);
  return m ? m[1] : null;
}

function clearScheduleTimer() {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
}

function normalizePlannedBroadcasts(raw, fallbackTimezone) {
  if (!Array.isArray(raw)) return [];
  const fallbackTz = String(fallbackTimezone || 'UTC').trim() || 'UTC';
  const prepared = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || `pb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`).trim();
    const scheduleAt = String(item.scheduleAt || '').trim();
    const scheduleTimezone = String(item.scheduleTimezone || fallbackTz).trim() || fallbackTz;
    const prompt = String(item.prompt || '').trim();
    const source = String(item.source || 'manual').trim() === 'weekly' ? 'weekly' : 'manual';
    const weeklyRuleId = source === 'weekly' ? String(item.weeklyRuleId || '').trim() : '';
    if (!scheduleAt) continue;
    const at = new Date(scheduleAt).getTime();
    if (Number.isNaN(at)) continue;
    prepared.push({
      id,
      scheduleAt: new Date(at).toISOString(),
      scheduleTimezone,
      prompt,
      source,
      weeklyRuleId: weeklyRuleId || undefined
    });
  }
  prepared.sort((a, b) => new Date(a.scheduleAt).getTime() - new Date(b.scheduleAt).getTime());
  return prepared;
}

function dayKeyInTimezone(iso, timezone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  }
}

function validatePlannedBroadcasts(planned) {
  const byDay = new Map();
  for (const p of planned) {
    const k = dayKeyInTimezone(p.scheduleAt, p.scheduleTimezone || 'UTC');
    if (!k) continue;
    const c = (byDay.get(k) || 0) + 1;
    byDay.set(k, c);
    if (c > 2) {
      return `На ${k} задано больше 2 рассылок.`;
    }
  }
  return null;
}

function normalizeWeeklyBroadcastRules(raw, fallbackTimezone) {
  if (!Array.isArray(raw)) return [];
  const fallbackTz = String(fallbackTimezone || 'UTC').trim() || 'UTC';
  const prepared = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || `wr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`).trim();
    const weekday = Number(item.weekday);
    const time = String(item.time || '').trim();
    const prompt = String(item.prompt || '').trim();
    const scheduleTimezone = String(item.scheduleTimezone || fallbackTz).trim() || fallbackTz;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!/^\d{2}:\d{2}$/.test(time)) continue;
    prepared.push({
      id,
      weekday,
      time,
      prompt,
      scheduleTimezone
    });
  }
  prepared.sort((a, b) => (a.weekday - b.weekday) || a.time.localeCompare(b.time));
  return prepared;
}

function validateWeeklyBroadcastRules(rules) {
  const byWeekday = new Map();
  for (const rule of rules) {
    const c = (byWeekday.get(rule.weekday) || 0) + 1;
    byWeekday.set(rule.weekday, c);
    if (c > 2) return 'Для одного дня недели можно задать максимум 2 рассылки.';
  }
  return null;
}

/**
 * weekday в правилах: как в JS getDay() — 0=воскресенье … 6=суббота.
 * Время rule.time — стена часов в rule.scheduleTimezone (IANA).
 * Раньше использовался локальный пояс процесса Node — на UTC-серверах слоты уезжали или оказывались в прошлом.
 */
function expandWeeklyRulesToPlannedBroadcasts(rules) {
  const planned = [];
  const now = DateTime.now();
  const end = now.plus({ months: 3 });

  for (const rule of rules) {
    const tz = String(rule.scheduleTimezone || 'UTC').trim() || 'UTC';
    const [hh, mm] = String(rule.time || '')
      .split(':')
      .map((n) => Number(n));
    if (Number.isNaN(hh) || Number.isNaN(mm)) continue;
    const luxonWeekday = rule.weekday === 0 ? 7 : rule.weekday;

    let zoneNow = now.setZone(tz);
    if (!zoneNow.isValid) {
      zoneNow = now.setZone('UTC');
    }
    let day = zoneNow.startOf('day');
    const limit = end.setZone(zoneNow.zone).endOf('day');

    while (day <= limit) {
      const slot = day.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
      if (slot.weekday === luxonWeekday && slot > now && slot <= end) {
        const iso = slot.toUTC().toISO();
        if (!iso) continue;
        const stamp = slot.setZone(tz).toFormat('yyyyMMddHHmm');
        planned.push({
          id: `wk_${rule.id}_${stamp}`,
          scheduleAt: iso,
          scheduleTimezone: tz,
          prompt: rule.prompt,
          source: 'weekly',
          weeklyRuleId: rule.id
        });
      }
      day = day.plus({ days: 1 });
    }
  }
  planned.sort((a, b) => new Date(a.scheduleAt).getTime() - new Date(b.scheduleAt).getTime());
  return planned;
}

function buildPlannedBroadcastsFromConfig(cfg) {
  const planned = normalizePlannedBroadcasts(cfg.plannedBroadcasts, cfg.scheduleTimezone);
  if (planned.length) return planned;
  const weeklyRules = normalizeWeeklyBroadcastRules(cfg.weeklyBroadcastRules, cfg.scheduleTimezone);
  if (weeklyRules.length) return expandWeeklyRulesToPlannedBroadcasts(weeklyRules);
  if (cfg.scheduleAt) {
    const at = new Date(cfg.scheduleAt).getTime();
    if (!Number.isNaN(at) && at > Date.now()) {
      return [
        {
          id: `legacy_${at}`,
          scheduleAt: new Date(at).toISOString(),
          scheduleTimezone: cfg.scheduleTimezone || 'UTC',
          prompt: ''
        }
      ];
    }
  }
  return [];
}

function scheduleNextBroadcast() {
  clearScheduleTimer();
  const cfg = readConfig();
  const planned = buildPlannedBroadcastsFromConfig(cfg).filter((p) => new Date(p.scheduleAt).getTime() > Date.now());
  if (!planned.length) return;
  const next = planned[0];
  const at = new Date(next.scheduleAt).getTime();
  const ms = at - Date.now();
  if (ms <= 0) return;
  scheduleTimer = setTimeout(() => {
    runNewsBroadcast({ plannedId: next.id, prompt: next.prompt, isScheduled: true })
      .catch((e) => console.error('Scheduled broadcast:', e.message))
      .finally(() => scheduleNextBroadcast());
  }, ms);
}

async function resolveNewsChatId(cfg) {
  const url = cfg.groupInviteUrl;
  if (!url || !String(url).trim()) {
    throw new Error('Укажите ссылку-приглашение в группу или ID чата в настройках.');
  }
  const code = extractInviteCode(url);
  if (!code) {
    throw new Error('Не удалось разобрать ссылку chat.whatsapp.com/…');
  }
  const chatId = await client.acceptInvite(code);
  if (typeof chatId === 'string' && chatId.includes('@')) {
    patchConfig({ newsTargetChatId: chatId });
    return chatId;
  }
  throw new Error('Не удалось получить ID группы после приглашения.');
}

/** @param {string} chatId */
function looksLikeWhatsAppId(chatId) {
  return typeof chatId === 'string' && /@(g|c)\.us$/i.test(chatId.trim());
}

async function runNewsBroadcast(options = {}) {
  if (!botReady) {
    throw new Error('WhatsApp ещё не готов.');
  }
  const plannedId = String(options.plannedId || '').trim();
  const runPrompt = String(options.prompt || '').trim();
  const isScheduled = Boolean(options.isScheduled);
  const cfg = readConfig();
  let targetId = cfg.newsTargetChatId;
  const planned = buildPlannedBroadcastsFromConfig(cfg);
  const selectedPlanned = plannedId ? planned.find((p) => p.id === plannedId) : null;
  const effectivePrompt = runPrompt || (selectedPlanned?.prompt ? String(selectedPlanned.prompt).trim() : '');
  try {
    if (!targetId || !String(targetId).trim()) {
      targetId = await resolveNewsChatId(cfg);
    } else {
      targetId = String(targetId).trim();
      if (!looksLikeWhatsAppId(targetId)) {
        throw new Error('Некорректный ID чата WhatsApp (ожидается …@g.us или …@c.us).');
      }
    }
    const text = await generateNewsDigest(cfg, 'ru', effectivePrompt);
    await client.sendMessage(targetId, text);
    const remainingPlanned = selectedPlanned ? planned.filter((p) => p.id !== selectedPlanned.id) : planned;
    patchConfig({
      newsTargetChatId: targetId,
      lastBroadcastAt: new Date().toISOString(),
      lastBroadcastError: null,
      scheduleAt: null,
      plannedBroadcasts: remainingPlanned
    });
  } catch (e) {
    const msg = e.message || String(e);
    patchConfig({
      lastBroadcastError: msg,
      plannedBroadcasts: planned
    });
    throw e;
  }
}

const puppeteerExecutable = process.env.PUPPETEER_EXECUTABLE_PATH
  ? String(process.env.PUPPETEER_EXECUTABLE_PATH).trim()
  : undefined;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionPath, clientId }),
  puppeteer: {
    headless: true,
    ...(puppeteerExecutable ? { executablePath: puppeteerExecutable } : {}),
    protocolTimeout: parseInt(process.env.PROTOCOL_TIMEOUT_MS, 10) || 180000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  },
  restartOnAuthFail: true
});

function helpText(lang) {
  if (lang === 'en') {
    return `Commands:
/start — hello
/help — this text
Any other message — AI reply (general topics).`;
  }
  return `Команды:
/start — приветствие
/help — эта справка
Любое другое сообщение — ответ ИИ (любые темы).`;
}

async function handleIncomingMessage(msg) {
  if (msg.fromMe) return;
  if (!botReady) {
    try {
      const state = await client.getState();
      if (state === 'CONNECTED') botReady = true;
      else return;
    } catch {
      return;
    }
  }

  let chat;
  try {
    chat = await msg.getChat();
  } catch {
    return;
  }
  if (chat.isGroup) {
    const hint =
      detectLanguageFromText(msg.body || '') === 'en'
        ? 'Please write to me in *private chat*, not in a group.'
        : 'Напишите мне в *личные сообщения*, не в группе.';
    try {
      await sendMessageSafely(msg, hint, client);
    } catch {
      /* ignore */
    }
    return;
  }
  if (chat.isChannel) return;

  if (!msg.body || !String(msg.body).trim()) return;

  const messageText = String(msg.body).trim();
  const chatId = msg.from;
  const lower = messageText.toLowerCase();

  const isFirst = !firstMessageUsers.has(chatId);
  let userLanguage = isFirst ? detectLanguageFromText(messageText) : getLanguageFromPhone(chatId);
  if (isFirst) firstMessageUsers.add(chatId);

  if (lower === '/start') {
    const t =
      userLanguage === 'en'
        ? '👋 Hi! I am a general AI assistant. Send any message or /help.'
        : '👋 Привет! Я универсальный ИИ-ассистент. Напишите что угодно или /help.';
    await sendMessageSafely(msg, t, client);
    return;
  }
  if (lower === '/help') {
    await sendMessageSafely(msg, helpText(userLanguage), client);
    return;
  }

  addToHistory(chatId, 'user', messageText);
  try {
    const history = getHistory(chatId);
    const cfg = readConfig();
    const reply = await askAI(history, userLanguage, {
      panelConfig: cfg
    });
    addToHistory(chatId, 'assistant', reply);
    await sendMessageSafely(msg, reply, client);
  } catch (err) {
    console.error('AI error:', err.message);
    const errMsg =
      userLanguage === 'en'
        ? 'Sorry, the AI is temporarily unavailable. Check AI_API_KEY in .env.'
        : 'Не удалось получить ответ ИИ. Проверьте AI_API_KEY в .env.';
    await sendMessageSafely(msg, errMsg, client);
  }
}

function registerMessageHandler(msg) {
  const msgId = msg.id._serialized || msg.id.id || JSON.stringify(msg.id);
  if (processedMessageIds.has(msgId)) return;
  processedMessageIds.set(msgId, Date.now());
  handleIncomingMessage(msg).catch((e) => console.error(e));
}

client.on('qr', (qr) => {
  lastQr = qr;
  console.log('Scan QR to link WhatsApp:');
  qrcode.generate(qr, { small: true });
});

let pollingInterval = null;

client.on('ready', () => {
  console.log('WhatsApp client ready (general AI bot).');
  botReady = true;
  lastQr = null;
  scheduleNextBroadcast();

  if (!USE_POLLING) return;

  let n = 0;
  pollingInterval = setInterval(async () => {
    if (!botReady) return;
    n++;
    try {
      const chats = await client.getChats();
      const personal = chats.filter((c) => !c.isGroup && !c.isChannel);
      for (const chat of personal) {
        const messages = await chat.fetchMessages({ limit: 15 });
        const sorted = [...messages].sort((a, b) => {
          let tA = a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp || 0;
          let tB = b.timestamp < 1e12 ? b.timestamp * 1000 : b.timestamp || 0;
          return tB - tA;
        });
        for (const m of sorted) {
          if (m.fromMe) continue;
          const msgId = m.id._serialized || m.id.id || JSON.stringify(m.id);
          if (processedMessageIds.has(msgId)) continue;
          let msgTime = m.timestamp < 1e12 ? m.timestamp * 1000 : m.timestamp;
          if (Date.now() - msgTime < 600000) {
            processedMessageIds.set(msgId, Date.now());
            handleIncomingMessage(m).catch((e) => console.error(e));
          } else {
            processedMessageIds.set(msgId, Date.now());
          }
        }
      }
      if (n % 100 === 0) cleanupProcessedIds();
    } catch (e) {
      console.error('polling:', e.message);
    }
  }, 3000);
});

client.on('authenticated', () => {
  lastQr = null;
  console.log('WhatsApp authenticated.');
});
client.on('auth_failure', (m) => console.error('auth_failure:', m));
client.on('disconnected', (r) => {
  console.warn('disconnected:', r);
  botReady = false;
  lastQr = null;
  clearScheduleTimer();
  if (r === 'LOGOUT') {
    console.warn('Сессия WhatsApp завершена (LOGOUT). Запустите бота снова и при необходимости отсканируйте QR.');
    return;
  }
  setTimeout(() => {
    console.log('Повторная инициализация WhatsApp после обрыва…');
    client.initialize().catch((e) => console.error('re-init:', e.message));
  }, 4000);
});

client.on('message', registerMessageHandler);
client.on('message_create', registerMessageHandler);

app.get('/api/meta', (req, res) => {
  res.json({
    success: true,
    service: 'general-ai-whatsapp-bot',
    ready: botReady,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, ready: botReady });
});

app.get('/api/whatsapp/groups/search', async (req, res) => {
  if (!botReady) {
    return res.status(503).json({ success: false, error: 'WhatsApp ещё не готов. Дождитесь подключения.' });
  }
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) {
    return res.status(400).json({ success: false, error: 'Укажите запрос: ?q=часть названия' });
  }
  try {
    const chats = await client.getChats();
    const matches = [];
    for (const c of chats) {
      if (!c.isGroup) continue;
      const name = (c.name && String(c.name).trim()) || 'Без названия';
      if (!name.toLowerCase().includes(q)) continue;
      matches.push({
        id: c.id._serialized,
        name
      });
      if (matches.length >= 40) break;
    }
    res.json({ success: true, query: q, matches });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

app.get('/api/whatsapp/status', async (req, res) => {
  try {
    const state = await client.getState();
    const info = client.info;
    res.json({
      success: true,
      ready: botReady,
      state: state || 'UNKNOWN',
      qr: lastQr,
      phone: info?.wid?.user || null,
      pushname: info?.pushname || null
    });
  } catch (e) {
    res.json({
      success: true,
      ready: false,
      state: 'INIT',
      qr: lastQr,
      error: e.message
    });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ success: true, config: readConfig() });
});

app.put('/api/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const allowed = [
    'theme',
    'role',
    'rules',
    'groupInviteUrl',
    'scheduleAt',
    'plannedBroadcasts',
    'weeklyBroadcastRules',
    'scheduleTimezone',
    'newsTargetChatId',
    'newsTargetTitle'
  ];
  const patch = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'scheduleAt')) {
    if (patch.scheduleAt === '' || patch.scheduleAt === undefined) {
      patch.scheduleAt = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'newsTargetChatId')) {
    if (patch.newsTargetChatId === '' || patch.newsTargetChatId === undefined) {
      patch.newsTargetChatId = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'newsTargetTitle')) {
    if (patch.newsTargetTitle === '' || patch.newsTargetTitle === undefined) {
      patch.newsTargetTitle = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'newsTargetChatId') && patch.newsTargetChatId === null) {
    patch.newsTargetTitle = null;
  }
  if (patch.scheduleAt) {
    const t = new Date(patch.scheduleAt).getTime();
    if (!Number.isNaN(t) && t <= Date.now()) {
      return res.status(400).json({
        success: false,
        error: 'Дата рассылки должна быть в будущем.'
      });
    }
  }
  const currentCfg = readConfig();
  const fallbackTimezone = patch.scheduleTimezone || currentCfg.scheduleTimezone;
  const hasPlannedPatch = Object.prototype.hasOwnProperty.call(patch, 'plannedBroadcasts');
  const hasWeeklyPatch = Object.prototype.hasOwnProperty.call(patch, 'weeklyBroadcastRules');

  const existingPlanned = normalizePlannedBroadcasts(currentCfg.plannedBroadcasts, fallbackTimezone);
  const existingManual = existingPlanned.filter((p) => p.source !== 'weekly');
  const existingWeekly = existingPlanned.filter((p) => p.source === 'weekly');

  let manualPlanned = existingManual;
  if (hasPlannedPatch) {
    manualPlanned = normalizePlannedBroadcasts(patch.plannedBroadcasts, fallbackTimezone).map((p) => ({
      ...p,
      source: 'manual',
      weeklyRuleId: undefined
    }));
    patch.scheduleAt = null;
  }

  let weeklyRules = normalizeWeeklyBroadcastRules(currentCfg.weeklyBroadcastRules, fallbackTimezone);
  if (hasWeeklyPatch) {
    weeklyRules = normalizeWeeklyBroadcastRules(patch.weeklyBroadcastRules, fallbackTimezone);
    const weeklyErr = validateWeeklyBroadcastRules(weeklyRules);
    if (weeklyErr) {
      return res.status(400).json({
        success: false,
        error: weeklyErr
      });
    }
    patch.weeklyBroadcastRules = weeklyRules;
    patch.scheduleAt = null;
  }

  if (hasPlannedPatch || hasWeeklyPatch) {
    const weeklyPlanned = hasWeeklyPatch ? expandWeeklyRulesToPlannedBroadcasts(weeklyRules) : existingWeekly;
    const combinedPlanned = normalizePlannedBroadcasts(
      [...manualPlanned, ...weeklyPlanned],
      fallbackTimezone
    );
    const now = Date.now();
    for (const p of combinedPlanned) {
      const t = new Date(p.scheduleAt).getTime();
      if (t <= now) {
        return res.status(400).json({
          success: false,
          error: 'Все плановые рассылки должны быть в будущем.'
        });
      }
    }
    const plannedErr = validatePlannedBroadcasts(combinedPlanned);
    if (plannedErr) {
      return res.status(400).json({
        success: false,
        error: plannedErr
      });
    }
    patch.plannedBroadcasts = combinedPlanned;
  }
  const next = patchConfig(patch);
  scheduleNextBroadcast();
  res.json({ success: true, config: next });
});

app.post('/api/broadcast/run', requireAdmin, async (req, res) => {
  try {
    const prompt = String((req.body || {}).prompt || '').trim();
    await runNewsBroadcast({ prompt });
    res.json({ success: true, config: readConfig() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || String(e), config: readConfig() });
  }
});

app.post('/api/weekly/refresh', requireAdmin, (req, res) => {
  try {
    const cfg = readConfig();
    const fallbackTimezone = cfg.scheduleTimezone || 'UTC';
    const weeklyRules = normalizeWeeklyBroadcastRules(cfg.weeklyBroadcastRules, fallbackTimezone);
    const weeklyErr = validateWeeklyBroadcastRules(weeklyRules);
    if (weeklyErr) {
      return res.status(400).json({ success: false, error: weeklyErr, config: cfg });
    }
    const manualPlanned = normalizePlannedBroadcasts(cfg.plannedBroadcasts, fallbackTimezone).filter(
      (p) => p.source !== 'weekly'
    );
    const weeklyPlanned = expandWeeklyRulesToPlannedBroadcasts(weeklyRules);
    const combinedPlanned = normalizePlannedBroadcasts([...manualPlanned, ...weeklyPlanned], fallbackTimezone);
    const plannedErr = validatePlannedBroadcasts(combinedPlanned);
    if (plannedErr) {
      return res.status(400).json({ success: false, error: plannedErr, config: cfg });
    }
    const next = patchConfig({
      weeklyBroadcastRules: weeklyRules,
      plannedBroadcasts: combinedPlanned
    });
    scheduleNextBroadcast();
    return res.json({ success: true, config: next });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || String(e), config: readConfig() });
  }
});

const webDist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webDist, 'index.html'), (err) => (err ? next(err) : undefined));
  });
} else {
  app.get('/', (req, res) => {
    res.redirect(302, '/api/meta');
  });
}

const server = app.listen(BOT_PORT, '0.0.0.0', () => {
  console.log(`HTTP on ${BOT_PORT} (/health, /api/*, web: ${fs.existsSync(webDist) ? 'yes' : 'no'})`);
  const delay = process.env.PORT ? 1000 : 0;
  setTimeout(() => {
    console.log('Starting WhatsApp…');
    client.initialize().catch((e) => console.error('init:', e));
  }, delay);
});

function shutdown() {
  clearScheduleTimer();
  if (pollingInterval) clearInterval(pollingInterval);
  server.close(() => process.exit(0));
  client.destroy().catch(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
