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
const { NewMessage, Raw } = require('telegram/events');
const { Api } = require('telegram');

// ⚠️ ТЕСТ. Все значения захардкожены. Перед продом убрать в env и ротировать сессию.
const HARDCODED_SESSION = '1AgAOMTQ5LjE1NC4xNjcuNTABu0HscdvSd5c+93MuVoGGmdmDilBe2IM2bn5CORAmHizRhBmUUlAgVqse8ktJcp8k0aY+FK93u/gTFJHzSAGth2TEpL4rUhCi58kd4JKDhA9elpDjm9NuUvALr+hVs/I9A6bSfZQ2J8Xp1toh2U4u9ck+VozzzAkmD/+w0zn3Tsexr6MQeczM1rafRtv3QzxWhJ50UYW0Q1BXWVPsBLwWMzHE2PiFdVb96W7aGIeCnUg9ewOC/02hWOpz4rBWMln6fzGBkeqb+LThu3xcQfjNtb4Po/eAwtC7ofePW5NGmT6Ss83vm2RynBajC2jI7qEeNdJd9+QKy0qQcuSmQUXD6q0=';

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
  // Сначала пробуем встроенный метод (на Custom message wrapper)
  try {
    if (typeof message.getSender === 'function') {
      const sender = await message.getSender().catch(() => null);
      if (sender) {
        return {
          id: sender.id ? String(sender.id) : null,
          username: sender.username || null,
          firstName: sender.firstName || null,
        };
      }
    }
  } catch {}

  // Fallback: достаём userId из peerId/fromId и резолвим через getEntity
  const fromId = message.fromId || message.peerId;
  const rawId = fromId?.userId || fromId?.user_id || null;
  if (!rawId) return { id: null, username: null };
  const id = String(rawId);

  try {
    const entity = await client.getEntity(fromId).catch(() => null);
    if (entity) {
      return {
        id,
        username: entity.username || null,
        firstName: entity.firstName || null,
      };
    }
  } catch {}
  return { id, username: null };
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

  // NewMessage — ловит обычные сообщения
  client.addEventHandler((event) => {
    handleMessage(client, event).catch((err) => {
      console.error('handler error:', err?.message || err);
    });
  }, new NewMessage({}));

  // Raw — ловит ВСЕ обновления, включая сервисные (MessageService с подарком)
  client.addEventHandler(async (update) => {
    try {
      const cls = update?.className || '';
      // Логируем все апдейты для диагностики
      if (cls.includes('NewMessage') || cls.includes('NewChannelMessage')) {
        const m = update.message;
        const mCls = m?.className || '';
        const aCls = m?.action?.className || '';
        console.log(`📥 raw ${cls} → message=${mCls} action=${aCls || '-'}`);

        if (mCls === 'MessageService' && m?.action) {
          // Собираем псевдо-event и пускаем через тот же handler
          await handleMessage(client, { message: m });
        }
      }
    } catch (err) {
      console.error('raw handler error:', err?.message || err);
    }
  }, new Raw({}));

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
