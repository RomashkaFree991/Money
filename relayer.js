// ══════════════════════════════════════════════════════════════════════════════
// GiftPepe Relayer — MTProto userbot для @MoneyMonkeyGift
// Слушает входящие NFT-подарки и зачисляет их в инвентарь юзеров мини-аппы.
//
// Запуск:
//   1. Один раз: node login.js  — получить TG_USER_SESSION
//   2. Боевой:   node relayer.js
// ══════════════════════════════════════════════════════════════════════════════

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');

// ⚠️ ТЕСТ. Все значения захардкожены. Перед продом убрать в env и ротировать сессию.
const HARDCODED_SESSION = '1AgAOMTQ5LjE1NC4xNjcuNTABu8Yln+F5cKdbtRgX+YwJ3ZkhJB9cFig97VCx7zLfNz05kstTF7WxUsT6pZveL+pj2NB2Lqs0bEdWk9m92pA00MzwNS5p1Fq/5VLogR6HuZ8KgtyFJEl9fBslshLj5d9SDbXZ2UgZ4p3gf2iigHM8pr40b6jimgQ5E7JPicZ8GCWDfRQP8WynzMJ5VDmfn2CsF38O/3dJZzjbVRyfEErFH9yHydKkLNJGVVw36Ae3InH/eMHQ3fju4hi7bBLTnGoVb3YsqgWrCCFyKCtjtxDUIDWva9FnkCMoNo+irrwLbLvstaOm+AyG0kuim/xIbhD/re9vkZp3akReB9Yr1tn0z6Q=';

const CONFIG = {
  API_ID: Number(process.env.TG_API_ID || 33158474),
  API_HASH: process.env.TG_API_HASH || '71410e8b59db496be638b6fc5a9634b1',
  SESSION: process.env.TG_USER_SESSION || HARDCODED_SESSION,
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:3000',
  RELAYER_INTERNAL_KEY: process.env.RELAYER_INTERNAL_KEY || 'relayer_dev_secret_change_me',
  RECEIVER_USERNAME: (process.env.GIFT_RECEIVER_USERNAME || 'MoneyMonkeyGift').replace(/^@/, ''),
};

if (!CONFIG.SESSION) {
  console.error('❌ TG_USER_SESSION не задан. Сначала запусти: node login.js');
  process.exit(1);
}

const stringSession = new StringSession(CONFIG.SESSION);

async function creditGift(payload) {
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/relayer/credit-gift`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relayer-key': CONFIG.RELAYER_INTERNAL_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`⚠️ credit-gift HTTP ${res.status}: ${data?.error || 'unknown'}`);
      return { ok: false, ...data };
    }
    return { ok: true, ...data };
  } catch (error) {
    console.error('❌ credit-gift failed:', error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

// Извлекает gift_id и метаданные из действия (action) сервисного сообщения о подарке.
// Поддерживает: MessageActionStarGift (обычный звёздный подарок),
// MessageActionStarGiftUnique (уникальный/NFT-подарок).
function extractGiftFromAction(action) {
  if (!action) return null;
  const className = action.className || action.CONSTRUCTOR_ID || '';
  const isStarGift = String(className).includes('StarGift');
  if (!isStarGift) return null;

  // gift может быть на самом action.gift или вложен глубже
  const gift = action.gift || action.starGift || null;
  if (!gift) return null;

  // У regular star-gift поле id (BigInt). У unique — id уникального экземпляра,
  // а вид определяется gift.slug или gift.title.
  const giftId = String(gift.id || gift.giftId || '');
  if (!giftId) return null;

  const stars = Number(gift.stars || gift.convertStars || action.convertStars || 0);
  const title = String(gift.title || gift.slug || gift.name || '');

  return {
    giftId,
    isUnique: String(className).includes('Unique'),
    fallbackPrice: stars,
    fallbackName: title || null,
    raw: className,
  };
}

async function resolveSender(client, message) {
  try {
    const sender = await message.getSender().catch(() => null);
    if (!sender) {
      // fallback через peer
      const fromId = message.fromId || message.peerId;
      const id = fromId?.userId || fromId?.user_id || null;
      return { id: id ? String(id) : null, username: null };
    }
    return {
      id: sender.id ? String(sender.id) : null,
      username: sender.username || null,
      firstName: sender.firstName || null,
    };
  } catch {
    return { id: null, username: null };
  }
}

async function handleMessage(client, event) {
  const message = event.message;
  if (!message) return;

  // Нас интересуют только входящие сервисные сообщения нам в личку
  if (message.out) return;
  if (!message.action) return;

  const gift = extractGiftFromAction(message.action);
  if (!gift) return;

  const sender = await resolveSender(client, message);
  if (!sender.id && !sender.username) {
    console.warn(`🎁 received gift ${gift.giftId} but no sender info, msg=${message.id}`);
    return;
  }

  console.log(
    `🎁 incoming ${gift.raw} from @${sender.username || '?'} (${sender.id || '?'}): giftId=${gift.giftId} ~${gift.fallbackPrice}⭐`,
  );

  const result = await creditGift({
    senderUsername: sender.username,
    senderTgId: sender.id,
    giftId: gift.giftId,
    msgId: message.id,
    fallbackName: gift.fallbackName,
    fallbackPrice: gift.fallbackPrice,
    fallbackImage: null,
  });

  if (result.ok && !result.duplicate) {
    console.log(`   ✅ credited to user ${result.userId}`);
  } else if (result.duplicate) {
    console.log('   ↩️  duplicate, skipped');
  } else {
    console.log(`   ❌ not credited: ${result.error || 'unknown'}`);
  }
}

async function main() {
  const client = new TelegramClient(stringSession, CONFIG.API_ID, CONFIG.API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  await client.connect();

  const me = await client.getMe();
  const myUsername = (me?.username || '').toLowerCase();
  if (CONFIG.RECEIVER_USERNAME && myUsername && myUsername !== CONFIG.RECEIVER_USERNAME.toLowerCase()) {
    console.warn(
      `⚠️ Session принадлежит @${myUsername}, а ожидается @${CONFIG.RECEIVER_USERNAME}. ` +
      'Продолжаю, но проверь, что вошёл в правильный аккаунт.',
    );
  }

  console.log(`✅ Relayer started as @${myUsername || me?.id} → backend=${CONFIG.BACKEND_URL}`);

  client.addEventHandler((event) => {
    handleMessage(client, event).catch((err) => {
      console.error('handler error:', err?.message || err);
    });
  }, new NewMessage({}));

  // Держим процесс живым
  process.on('SIGINT', async () => {
    console.log('\n👋 Stopping relayer...');
    await client.disconnect().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('❌ Relayer fatal:', err?.message || err);
  process.exit(1);
});
