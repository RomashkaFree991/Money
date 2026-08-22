// ══════════════════════════════════════════════════════════════════════════════
// GiftPep Relayer — MTProto userbot для @GiftPepeReleyer
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
const crypto = require('crypto');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage, Raw } = require('telegram/events');
const { Api } = require('telegram');

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function safeSecretEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

const CONFIG = {
  API_ID: Number(requireEnv('TG_API_ID')),
  API_HASH: requireEnv('TG_API_HASH'),
  SESSION: requireEnv('TG_USER_SESSION'),
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:3000',
  RELAYER_INTERNAL_KEY: requireEnv('RELAYER_INTERNAL_KEY'),
  RECEIVER_USERNAME: (process.env.GIFT_RECEIVER_USERNAME || 'GiftPepeReleyer').replace(/^@/, ''),
  HTTP_PORT: Number(process.env.RELAYER_HTTP_PORT || 4011),
  HTTP_HOST: process.env.RELAYER_HTTP_HOST || '127.0.0.1',
};

if (CONFIG.RELAYER_INTERNAL_KEY.length < 24) {
  throw new Error('RELAYER_INTERNAL_KEY must be at least 24 characters');
}
if (!Number.isSafeInteger(CONFIG.API_ID) || CONFIG.API_ID <= 0) throw new Error('TG_API_ID is invalid');

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
// Логика: передаём только конкретный сохранённый NFT по точному msgId или slug.
// Никакого fuzzy-поиска по имени/цене в transfer-пути нет.
//
// Требования Telegram:
//   • подарок должен быть НЕ обычным звёздным, а уникальным (NFT)
//   • с момента получения подарка должно пройти достаточно времени
//     (обычно ~24ч-7 дней — Telegram периодически меняет)
//   • на аккаунте релеера должны быть звёзды на комиссию передачи
// ────────────────────────────────────────────────────────────────────────────
function normalizeGiftName(value) {
  return String(value || '').replace(/\s*#.*$/, '').trim().toLowerCase();
}

// Used only to reserve a physical NFT for a virtual game reward.
// The actual /transfer endpoint never does fuzzy matching: it receives the exact msgId/slug selected here.
async function findSavedGiftCandidates(client, { giftId, giftName, giftPrice, limit = 25 }) {
  const targetId = String(giftId || '').trim();
  const targetName = normalizeGiftName(giftName);
  if (!targetId && !targetName) return [];

  const me = await client.getMe();
  const meInput = await client.getInputEntity(me);
  const exact = [];
  const byName = [];
  let offset = '';

  for (let page = 0; page < 10 && exact.length + byName.length < limit * 3; page++) {
    const resp = await client.invoke(new Api.payments.GetSavedStarGifts({ peer: meInput, offset, limit: 100 }));
    for (const sg of resp?.gifts || []) {
      const inner = sg.gift || sg;
      if (!String(inner?.className || '').includes('Unique')) continue;
      const candidateIds = [
        inner?.id, inner?.giftId, inner?.gift_id, sg?.giftId, sg?.gift_id,
        inner?.gift?.id, inner?.gift?.giftId,
      ].map((v) => (v == null ? '' : String(v))).filter(Boolean);
      const title = String(inner?.title || inner?.slug || '');
      const slug = String(inner?.slug || '').trim() || null;
      const msgId = Number(sg?.msgId || sg?.savedId || sg?.savedStarGiftId || 0) || null;
      if (!slug && !msgId) continue;
      const stars = Number(inner?.stars || sg?.convertStars || 0);
      const item = { msgId, slug, giftId: candidateIds[0] || '', title, stars, isUnique: true };
      const idMatched = !!targetId && candidateIds.includes(targetId);
      if (idMatched) exact.push(item);
      else if (targetName && normalizeGiftName(title) === targetName) {
        if (!giftPrice || !stars || Math.abs(stars - Number(giftPrice)) <= Math.max(50, Number(giftPrice) * 0.5)) byName.push(item);
      }
    }
    offset = String(resp?.nextOffset || '');
    if (!offset) break;
  }

  // Exact collection/template id matches are always preferred. Name matches are a compatibility fallback.
  const seen = new Set();
  return [...exact, ...byName].filter((item) => {
    const key = item.slug ? `slug:${item.slug}` : `msg:${item.msgId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.max(1, Math.min(50, Number(limit) || 25)));
}

async function savedGiftExistsExact(client, { msgId, slug }) {
  const wantedMsgId = Number(msgId || 0) || null;
  const wantedSlug = String(slug || '').trim() || null;
  if (!wantedMsgId && !wantedSlug) throw new Error('msgId or slug required');

  const me = await client.getMe();
  const meInput = await client.getInputEntity(me);
  let offset = '';
  for (let page = 0; page < 50; page++) {
    const resp = await client.invoke(new Api.payments.GetSavedStarGifts({ peer: meInput, offset, limit: 100 }));
    for (const sg of resp?.gifts || []) {
      const inner = sg.gift || sg;
      const candidateSlug = String(inner?.slug || '').trim() || null;
      const candidateMsgIds = [sg?.msgId, sg?.savedId, sg?.savedStarGiftId]
        .map((v) => Number(v || 0)).filter(Boolean);
      if ((wantedSlug && candidateSlug === wantedSlug) || (wantedMsgId && candidateMsgIds.includes(wantedMsgId))) {
        return true;
      }
    }
    offset = String(resp?.nextOffset || '');
    if (!offset) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Never report a false negative when the account is larger than our safety scan limit.
  throw new Error('Exact gift scan limit reached');
}

async function resolveTargetEntity(client, { username, userId }) {
  const NO_USERNAME_MSG = 'Сделайте @username чтобы получить подарок';

  // 1) По username — самый надёжный путь: gramjs внутри сделает
  //    contacts.ResolveUsername и сам подтянет access_hash.
  if (username) {
    const clean = String(username).replace(/^@/, '').trim();
    if (clean) {
      try {
        return await client.getInputEntity(clean);
      } catch (e) {
        // падаем в фолбэк
      }
    }
  }
  // 2) По числовому ID — сработает только если юзер уже есть в кэше клиента
  //    (был в диалогах/контактах). Иначе Telegram отдаёт PEER_ID_INVALID.
  if (userId) {
    try {
      return await client.getInputEntity(Number(userId));
    } catch (e) {
      throw new Error(NO_USERNAME_MSG);
    }
  }
  throw new Error(NO_USERNAME_MSG);
}

async function transferGiftToUser(client, { userId, username, msgId, slug, giftId, giftName, giftPrice }) {
  if (!msgId && !slug) throw new Error('Для безопасного вывода обязателен точный msgId или slug');
  const target = await resolveTargetEntity(client, { username, userId });

  let stargift;
  if (slug && typeof Api.InputSavedStarGiftSlug === 'function') {
    stargift = new Api.InputSavedStarGiftSlug({ slug: String(slug) });
  } else if (msgId && typeof Api.InputSavedStarGiftUser === 'function') {
    stargift = new Api.InputSavedStarGiftUser({ msgId: Number(msgId) });
  } else {
    throw new Error('Версия gramjs не поддерживает точный InputSavedStarGift* reference');
  }

  const InputInvoiceCtor = Api.InputInvoiceStarGiftTransfer;
  if (typeof InputInvoiceCtor === 'function') {
    try {
      const invoice = new InputInvoiceCtor({ stargift, toId: target });
      const form = await client.invoke(new Api.payments.GetPaymentForm({ invoice }));
      const rawFormId = form?.formId ?? form?.form_id;
      if (rawFormId === undefined || rawFormId === null) throw new Error('GetPaymentForm returned no formId');
      const formId = typeof rawFormId === 'bigint' ? rawFormId : BigInt(rawFormId);
      await client.invoke(new Api.payments.SendStarsForm({ formId, invoice }));
      console.log(`   💸 exact transfer ok: msgId=${msgId || '-'} slug=${slug || '-'} gift=${giftId || giftName || '?'}`);
      return { ok: true, msgId: Number(msgId || 0) || null, slug: slug || null, title: giftName || null, giftId: giftId || null, via: 'invoice' };
    } catch (err) {
      const msg = String(err?.message || err);
      const recoverable = /UNKNOWN|CONSTRUCTOR|MISSING|not (a )?function/i.test(msg);
      if (!recoverable) throw new Error('Transfer via invoice failed: ' + msg);
      console.warn('   ⚠️ invoice flow unsupported, fallback to direct: ' + msg);
    }
  }

  try {
    await client.invoke(new Api.payments.TransferStarGift({ stargift, toId: target }));
  } catch (err) {
    throw new Error('TransferStarGift failed: ' + (err?.message || err));
  }
  return { ok: true, msgId: Number(msgId || 0) || null, slug: slug || null, title: giftName || null, giftId: giftId || null, via: 'direct' };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP сервер для бэкэнда
// ────────────────────────────────────────────────────────────────────────────
// Минимальная цена перепродажи NFT-подарка по его gift_id.
// Использует payments.GetResaleStarGifts с сортировкой по цене.
// Если у установленной версии gramjs этого конструктора нет — возвращает null.
async function fetchMinResalePrice(client, giftId) {
  const Ctor = Api.payments?.GetResaleStarGifts;
  if (typeof Ctor !== 'function') {
    throw new Error('GetResaleStarGifts not supported by installed gramjs');
  }
  let res;
  try {
    res = await client.invoke(new Ctor({
      sortByPrice: true,
      giftId: BigInt(giftId),
      offset: '',
      limit: 1,
    }));
  } catch (e) {
    // Часто бывает у нерезалабельных / отсутствующих в маркете подарков.
    throw e;
  }
  const list = res?.gifts || [];
  if (!list.length) return null;
  const first = list[0];
  // У unique-gift поле resellStars / resell_stars; иногда stars.
  const stars = Number(
    first?.resellStars ?? first?.resell_stars ?? first?.stars ?? 0
  );
  return Number.isFinite(stars) && stars > 0 ? stars : null;
}

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
      if (!safeSecretEqual(req.headers['x-relayer-key'], CONFIG.RELAYER_INTERNAL_KEY)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && req.url === '/market-min-prices') {
        if (!tgClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Telegram client not ready' }));
          return;
        }
        const body = await readJson(req);
        const giftIds = Array.isArray(body.giftIds) ? body.giftIds.map(String) : [];
        if (!giftIds.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'giftIds required' }));
          return;
        }
        const prices = {};
        let okCount = 0; let failCount = 0;
        for (const id of giftIds) {
          try {
            const stars = await fetchMinResalePrice(tgClient, id);
            if (Number.isFinite(stars) && stars > 0) {
              prices[id] = stars;
              okCount++;
            }
          } catch (e) {
            failCount++;
            // Не логируем каждый промах — их много, если подарка нет в перепродаже.
          }
          // Лёгкая пауза, чтобы не ловить FLOOD_WAIT.
          await new Promise((r) => setTimeout(r, 120));
        }
        console.log(`📈 market-min-prices: ok=${okCount} fail=${failCount}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, prices }));
        return;
      }

      if (req.method === 'POST' && req.url === '/resolve-exact') {
        if (!tgClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Telegram client not ready' }));
          return;
        }
        const body = await readJson(req);
        const giftId = body.giftId ? String(body.giftId).trim() : '';
        const giftName = String(body.giftName || '').trim();
        const giftPrice = Number(body.giftPrice || 0);
        if (!giftId && !giftName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'giftId or giftName required' }));
          return;
        }
        try {
          const candidates = await findSavedGiftCandidates(tgClient, { giftId, giftName, giftPrice, limit: 30 });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, candidates }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/exists-exact') {
        if (!tgClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Telegram client not ready' }));
          return;
        }
        const body = await readJson(req);
        const msgId = Number(body.msgId || 0) || null;
        const slug = body.slug ? String(body.slug).trim() : null;
        if (!msgId && !slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'msgId or slug required' }));
          return;
        }
        try {
          const exists = await savedGiftExistsExact(tgClient, { msgId, slug });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, exists }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
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
        const username = body.username ? String(body.username).replace(/^@/, '').trim() : null;
        const giftName = String(body.giftName || '');
        const giftId = body.giftId ? String(body.giftId).trim() : '';
        const giftPrice = Number(body.giftPrice || 0);
        const msgId = Number(body.msgId || 0) || null;
        const slug = body.slug ? String(body.slug).trim() : null;
        if ((!userId && !username) || (!msgId && !slug)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '(userId|username) and exact (msgId|slug) required' }));
          return;
        }

        console.log(`📤 exact transfer request: msgId=${msgId || '-'} slug=${slug || '-'} id=${giftId || '-'} «${giftName}» → @${username || ''}/${userId || '?'}`);
        try {
          const out = await transferGiftToUser(tgClient, { userId, username, msgId, slug, giftId, giftName, giftPrice });
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
    throw new Error(`Session принадлежит @${myUsername}, а ожидается @${CONFIG.RECEIVER_USERNAME}`);
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
