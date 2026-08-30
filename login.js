// ══════════════════════════════════════════════════════════════════════════════
// Одноразовый скрипт авторизации userbot-аккаунта @GiftPepeReleyer.
// Получает StringSession и печатает её в консоль — сохрани в env TG_USER_SESSION.
//
// Запуск:
//   TG_API_ID=... TG_API_HASH=... node login.js
// ══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const API_ID = Number(process.env.TG_API_ID || 0);
const API_HASH = String(process.env.TG_API_HASH || '').trim();
const SESSION_FILE = path.resolve(process.env.TG_SESSION_FILE || path.join(process.cwd(), 'tg-user.session'));
if (!API_ID || !API_HASH) throw new Error('Set TG_API_ID and TG_API_HASH in environment');

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      const stdin = process.openStdin();
      process.stdin.on('data', () => {});
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      // primitive masking — gramjs ставит свой prompt в любом случае
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

(async () => {
  let savedSession = '';
  try { if (fs.existsSync(SESSION_FILE)) savedSession = fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch (error) { throw new Error(`Cannot read session file: ${error.message}`); }
  const stringSession = new StringSession(savedSession);
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  if (savedSession) console.log(`🔐 Найдена сохранённая сессия: ${SESSION_FILE}`);
  else console.log('🔐 Сейчас войдём в аккаунт. Введи телефон в международном формате, например +79991234567');

  await client.start({
    phoneNumber: () => ask('Phone (+...): '),
    password: () => ask('2FA password (если включён): ', { hidden: true }),
    phoneCode: () => ask('Code из Telegram: '),
    onError: (err) => console.error('Login error:', err?.message || err),
  });

  const me = await client.getMe();
  const session = client.session.save();
  fs.writeFileSync(SESSION_FILE, `${session}\n`, { mode: 0o600 });
  try { fs.chmodSync(SESSION_FILE, 0o600); } catch {}

  console.log('\n──────────────────────────────────────────────');
  console.log(`✅ Logged in as @${me.username || me.id} (id=${me.id})`);
  console.log('──────────────────────────────────────────────');
  console.log(`\n✅ Сессия сохранена в защищённый файл: ${SESSION_FILE}`);
  console.log('\nЕсли предпочитаешь env вместо файла:\n');
  console.log(`TG_USER_SESSION=${session}\n`);
  console.log('Никому её не показывай — это полный доступ к аккаунту.');
  console.log('──────────────────────────────────────────────');

  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('❌ Login failed:', err?.message || err);
  process.exit(1);
});
