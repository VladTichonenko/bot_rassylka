const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(__dirname, 'bot-config.json');

const defaultConfig = () => ({
  theme: '',
  role: '',
  rules: '',
  /** Ссылка-приглашение в группу WhatsApp */
  groupInviteUrl: '',
  /** ISO 8601 — однократная рассылка */
  scheduleAt: null,
  /** IANA, для отображения и ввода даты в UI */
  scheduleTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  /** Заполняется после успешной отправки / join */
  newsTargetChatId: null,
  /** Название группы для панели (после выбора по имени или вручную) */
  newsTargetTitle: null,
  lastBroadcastAt: null,
  lastBroadcastError: null
});

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

function writeConfig(config) {
  const merged = { ...defaultConfig(), ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function patchConfig(partial) {
  const cur = readConfig();
  const next = { ...cur, ...partial };
  return writeConfig(next);
}

module.exports = {
  CONFIG_PATH,
  defaultConfig,
  readConfig,
  writeConfig,
  patchConfig
};
