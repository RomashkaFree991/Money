// ══════════════════════════════════════════════════════════════════════════════
// MoneyMonkey Relayer — MTProto userbot для @MoneyMonkeyGift
//
// Что умеет:
//   1. Слушать входящие NFT-подарки на свой аккаунт и слать /api/relayer/credit-gift
//      → подарок появляется в инвентаре нужного юзера в мини-аппе.
//   2. Поднимать локальный HTTP-сервер для бэкэнда (POST /transfer):
//      backend зовёт его, когда юзер жмёт «Вывести», и релеер реально передаёт
//      NFT-подарок получателю через payments.TransferStarGift.
//
// Запуск:
//   1. Один раз: node login.js  — получить TG_USER_SESSION
//   2. Боевой:   node relayer.js
// ══════════════════════════════════════════════════════════════════════════════

const http = require('http');
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
  HTTP_PORT: Number(process.env.RELAYER_HTTP_PORT || 4011),
  HTTP_HOST: process.env.RELAYER_HTTP_HOST || '127.0.0.1',
};

if (!CONFIG.SESSION) {
  console.error('❌ TG_USER_SESSION не задан. Сначала запусти: node login.js');
  process.exit(1);
}

const stringSession = new StringSession(CONFIG.SESSION);
let tgClient = null;

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

function extractGiftFromAction(action) {
  if (!action) return null;
  const className = action.className || action.CONSTRUCTOR_ID || '';
  const isStarGift = String(className).includes('StarGift');
  if (!isStarGift) return null;

  const gift = action.gift || action.starGift || null;
  if (!gift) return null;

  const giftId = String(gift.id || gift.giftId || '');
  if (!giftId) return null;

  const stars = Number(gift.stars || gift.convertStars || action.convertStars || 0);
  const title = String(gift.title || gift.name || '');
  const slug = String(gift.slug || '');
  const isUnique = String(className).includes('Unique');

  return {
    giftId,
    isUnique,
    slug: slug || null,
    fallbackPrice: stars,
    fallbackName: title || slug || null,
    raw: className,
  };
}

async function resolveSender(client, message) {
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
    slug: gift.slug,
    isUnique: gift.isUnique,
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

// ────────────────────────────────────────────────────────────────────────────
// ВЫВОД (TransferStarGift)
//
// Логика: ищем у себя в "сохранённых подарках" уникальный NFT с подходящим
// названием (и при возможности — с подходящей ценой в звёздах), и передаём
// его получателю через payments.TransferStarGift.
//
// Требования Telegram:
//   • подарок должен быть НЕ обычным звёздным, а уникальным (NFT)
//   • с момента получения подарка должно пройти достаточно времени
//     (обычно ~24ч-7 дней — Telegram периодически меняет)
//   • на аккаунте релеера должны быть звёзды на комиссию передачи
// ────────────────────────────────────────────────────────────────────────────
function normalizeName(s) {
  return String(s || '').replace(/\s*#.*$/, '').trim().toLowerCase();
}

async function findSavedGift(client, { giftName, giftPrice }) {
  const targetName = normalizeName(giftName);
  const me = await client.getMe();
  const meInput = await client.getInputEntity(me);

  let offset = '';
  for (let page = 0; page < 10; page++) {
    let resp;
    try {
      resp = await client.invoke(new Api.payments.GetSavedStarGifts({
        peer: meInput,
        offset,
        limit: 100,
      }));
    } catch (err) {
      throw new Error('GetSavedStarGifts failed: ' + (err?.message || err));
    }

    const gifts = resp?.gifts || [];
    for (const sg of gifts) {
      const inner = sg.gift || sg;
      const isUnique = String(inner?.className || '').includes('Unique');
      const title = String(inner?.title || inner?.slug || '');
      const slug = String(inner?.slug || '') || null;
      const stars = Number(inner?.stars || sg?.convertStars || 0);

      if (!isUnique) continue;
      if (normalizeName(title) !== targetName) continue;
      // Если указана цена — допускаем небольшое отклонение
      if (giftPrice && stars && Math.abs(stars - giftPrice) > Math.max(50, giftPrice * 0.5)) continue;

      const msgId = Number(sg.msgId || sg.savedId || sg.savedStarGiftId || 0);
      if (!msgId && !slug) continue;

      return { msgId, slug, isUnique, title, stars, raw: sg };
    }

    offset = resp?.nextOffset || '';
    if (!offset) break;
  }
  return null;
}

async function transferGiftToUser(client, { userId, giftName, giftPrice }) {
  if (!giftName) throw new Error('giftName обязателен для поиска подарка');
  const target = await client.getInputEntity(Number(userId));

  // Всегда идём от профиля релеера: ищем первый подходящий NFT по имени
  // (и опционально по цене) в сохранённых подарках, и его передаём.
  const saved = await findSavedGift(client, { giftName, giftPrice });
  if (!saved) {
    throw new Error(`NFT-подарок «${giftName}» не найден в сохранённых на аккаунте релеера`);
  }

  // payments.TransferStarGift работает только для уникальных (NFT) подарков.
  // Идентификатор — slug (если есть), иначе msgId.
  let stargift;
  if (saved.slug) {
    stargift = new Api.InputSavedStarGiftSlug({ slug: saved.slug });
  } else if (saved.msgId) {
    stargift = new Api.InputSavedStarGiftUser({ msgId: saved.msgId });
  } else {
    throw new Error('У найденного подарка нет ни slug, ни msgId');
  }

  try {
    await client.invoke(new Api.payments.TransferStarGift({
      stargift,
      toId: target,
    }));
  } catch (err) {
    throw new Error('TransferStarGift failed: ' + (err?.message || err));
  }

  return { ok: true, msgId: saved.msgId, slug: saved.slug, title: saved.title };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP сервер для бэкэнда
// ────────────────────────────────────────────────────────────────────────────
function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; if (buf.length > 1e6) { req.destroy(); reject(new Error('payload too large')); } });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers['x-relayer-key'] !== CONFIG.RELAYER_INTERNAL_KEY) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && req.url === '/transfer') {
        if (!tgClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Telegram client not ready' }));
          return;
        }
        const body = await readJson(req);
        const userId = Number(body.userId || 0);
        const giftName = String(body.giftName || '');
        const giftPrice = Number(body.giftPrice || 0);
        if (!userId || !giftName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'userId and giftName required' }));
          return;
        }

        console.log(`📤 transfer request: «${giftName}» (${giftPrice}⭐) → user ${userId}`);
        try {
          const out = await transferGiftToUser(tgClient, { userId, giftName, giftPrice });
          console.log(`   ✅ sent msgId=${out.msgId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...out }));
        } catch (err) {
          console.warn(`   ❌ transfer failed: ${err?.message || err}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
    }
  });
  server.listen(CONFIG.HTTP_PORT, CONFIG.HTTP_HOST, () => {
    console.log(`🌐 Relayer HTTP listening on ${CONFIG.HTTP_HOST}:${CONFIG.HTTP_PORT}`);
  });
}

async function main() {
  const client = new TelegramClient(stringSession, CONFIG.API_ID, CONFIG.API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  await client.connect();
  tgClient = client;

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

  client.addEventHandler(async (update) => {
    try {
      const cls = update?.className || '';
      if (cls.includes('NewMessage') || cls.includes('NewChannelMessage')) {
        const m = update.message;
        const mCls = m?.className || '';
        const aCls = m?.action?.className || '';
        console.log(`📥 raw ${cls} → message=${mCls} action=${aCls || '-'}`);

        if (mCls === 'MessageService' && m?.action) {
          await handleMessage(client, { message: m });
        }
      }
    } catch (err) {
      console.error('raw handler error:', err?.message || err);
    }
  }, new Raw({}));

  startHttpServer();

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
