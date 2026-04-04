const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const botDir = __dirname;
const parentEnv = path.join(botDir, '..', '.env');
const localEnv = path.join(botDir, '.env');

// 1) bot/.env — только то, что специфично для этого бота (сессия WhatsApp, BOT_PORT …)
if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
}
// 2) корень reilway/.env — общие ключи (AI_API_KEY, API_TOKEN_INSTANCE, …) перекрывают bot/.env
if (fs.existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv, override: true });
}
