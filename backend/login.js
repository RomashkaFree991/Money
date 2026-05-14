// ══════════════════════════════════════════════════════════════════════════════
// Одноразовый скрипт авторизации userbot-аккаунта (например @MoneyMonkeyGift).
// Получает StringSession и печатает её в консоль — сохрани в env TG_USER_SESSION.
//
// Запуск:
//   TG_API_ID=33158474 TG_API_HASH=xxx node login.js
// ══════════════════════════════════════════════════════════════════════════════

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const API_ID = Number(process.env.TG_API_ID || 33158474);
const API_HASH = process.env.TG_API_HASH || '71410e8b59db496be638b6fc5a9634b1';

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
  const stringSession = new StringSession('');
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  console.log('🔐 Сейчас войдём в аккаунт. Введи телефон в международном формате, например +79991234567');

  await client.start({
    phoneNumber: () => ask('Phone (+...): '),
    password: () => ask('2FA password (если включён): '),
    phoneCode: () => ask('Code из Telegram: '),
    onError: (err) => console.error('Login error:', err?.message || err),
  });

  const me = await client.getMe();
  const session = client.session.save();

  console.log('\n──────────────────────────────────────────────');
  console.log(`✅ Logged in as @${me.username || me.id} (id=${me.id})`);
  console.log('──────────────────────────────────────────────');
  console.log('\nДобавь в env переменную:\n');
  console.log(`TG_USER_SESSION=${session}\n`);
  console.log('Никому её не показывай — это полный доступ к аккаунту.');
  console.log('──────────────────────────────────────────────');

  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('❌ Login failed:', err?.message || err);
  process.exit(1);
});
