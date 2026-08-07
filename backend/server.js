// ══════════════════════════════════════════════════════════════════════════════
// GiftPep Backend — server.js
// Express + Supabase + Telegram Mini App
// ══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Address, beginCell, Cell } = require('@ton/core');
const path = require('path');
const fs = require('fs');

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
  BOT_TOKEN: requireEnv('BOT_TOKEN'),
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  // Financial RPCs added by 001_security_finance.sql are service-role only.
  SUPABASE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  ADMIN_KEY: requireEnv('ADMIN_KEY'),
  TELEGRAM_WEBHOOK_SECRET: requireEnv('TELEGRAM_WEBHOOK_SECRET'),
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map((s) => Number(String(s).trim())).filter(Boolean),
  PORT: Number(process.env.PORT || 3000),
  MINI_APP_URL: process.env.MINI_APP_URL || 'https://moneymonkey.live',
  WEBHOOK_URL: process.env.WEBHOOK_URL || 'https://api.moneymonkey.live/webhook',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_URL || 'https://api.moneymonkey.live',
  RELAYER_INTERNAL_KEY: requireEnv('RELAYER_INTERNAL_KEY'),
  GIFT_RECEIVER_USERNAME: (process.env.GIFT_RECEIVER_USERNAME || 'GiftPepeRelayer').replace(/^@/, ''),
  CHANNEL_USERNAME: (process.env.CHANNEL_USERNAME || 'GiftPep').replace(/^@/, ''),
  SUPPORT_USERNAME: (process.env.SUPPORT_USERNAME || 'GiftPepeSupport').replace(/^@/, ''),
  RELAYER_URL: process.env.RELAYER_URL || 'http://127.0.0.1:4011',
  INIT_DATA_MAX_AGE_SEC: Number(process.env.INIT_DATA_MAX_AGE_SEC || 600),
  TON_DESTINATION_WALLET: process.env.TON_DESTINATION_WALLET || 'UQCDWCyQut87UY6atwOwZD1mIOxcAJh4D9m1lBtj1urQ1KtD',
  TONCENTER_API_BASE: (process.env.TONCENTER_API_BASE || 'https://toncenter.com/api/v2').replace(/\/$/, ''),
  TONCENTER_API_KEY: String(process.env.TONCENTER_API_KEY || '').trim(),
  TON_INTENT_TTL_MS: Number(process.env.TON_INTENT_TTL_MS || 10 * 60 * 1000),
};

if (!/^[A-Za-z0-9_-]{16,256}$/.test(CONFIG.TELEGRAM_WEBHOOK_SECRET)) {
  throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16-256 chars using only A-Z, a-z, 0-9, _ or -');
}
if (CONFIG.ADMIN_KEY.length < 24) throw new Error('ADMIN_KEY must be at least 24 characters');
if (CONFIG.RELAYER_INTERNAL_KEY.length < 24) throw new Error('RELAYER_INTERNAL_KEY must be at least 24 characters');
if (!normalizeTonAddressEarly(CONFIG.TON_DESTINATION_WALLET)) throw new Error('TON_DESTINATION_WALLET is invalid');

function normalizeTonAddressEarly(value) {
  try { return Address.parse(String(value || '').trim()).toRawString(); }
  catch { return null; }
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: CONFIG.MINI_APP_URL, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'x-init-data', 'x-admin-key'] }));
app.use(express.json({ limit: '256kb' }));
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    error: 'Too many requests. Please try again in a moment.',
    code: 'RATE_LIMITED',
  }),
}));

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// === Bans (v8.13) =============================================================
// Кэш ban-статусов: userId -> { banned: boolean, reason: string|null, expiresAt: ms }
const banCache = new Map();
const BAN_CACHE_TTL_MS = 10_000;

async function getBanInfo(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const now = Date.now();
  const cached = banCache.get(id);
  if (cached && cached.expiresAt > now) {
    return cached.banned ? { reason: cached.reason, bannedAt: cached.bannedAt } : null;
  }
  try {
    const { data } = await sb.from('users').select('banned_at,ban_reason').eq('id', id).maybeSingle();
    if (data?.banned_at) {
      const info = { banned: true, reason: data.ban_reason || null, bannedAt: data.banned_at, expiresAt: now + BAN_CACHE_TTL_MS };
      banCache.set(id, info);
      return { reason: info.reason, bannedAt: info.bannedAt };
    }
  } catch (e) {
    // Если колонок ещё нет (миграция не прогнана) — просто не баним.
    if (!/banned_at|ban_reason|column/i.test(e?.message || '')) console.error('getBanInfo error:', e?.message || e);
  }
  banCache.set(id, { banned: false, reason: null, bannedAt: null, expiresAt: now + BAN_CACHE_TTL_MS });
  return null;
}

function invalidateBanCache(userId) {
  banCache.delete(Number(userId));
}

async function setUserBan(userId, reason) {
  const id = Number(userId);
  if (!Number.isFinite(id)) throw new Error('bad userId');
  const { error } = await sb.from('users').update({
    banned_at: new Date().toISOString(),
    ban_reason: String(reason || '').slice(0, 500) || 'Нарушение правил',
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(error.message);
  invalidateBanCache(id);
}

async function clearUserBan(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) throw new Error('bad userId');
  const { error } = await sb.from('users').update({
    banned_at: null,
    ban_reason: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(error.message);
  invalidateBanCache(id);
}

// Withdraw flow: фронт сначала платит 25⭐ комиссию, только потом мы делаем перевод.
// Withdrawal intents/receipts и transfer-снимки хранятся в PostgreSQL.
const WITHDRAW_FEE_STARS = Number(process.env.WITHDRAW_FEE_STARS || 30);
// v8.16: минимальный депозит, необходимый чтобы юзер мог выводить подарки.
const WITHDRAW_MIN_DEPOSIT_STARS = Number(process.env.WITHDRAW_MIN_DEPOSIT_STARS || 50);
// v8.16: минимальная ставка в краше.
const CRASH_MIN_BET = Number(process.env.CRASH_MIN_BET || 1);
const WITHDRAW_INTENT_TTL_MS = 15 * 60 * 1000;

// Кеш рыночных цен не является финансовым источником истины и может жить в RAM.
const MARKET_PRICES_FILE = path.join(__dirname, 'data', 'market_prices.json');
const marketPrices = new Map(); // giftId(str) -> stars(number)
const INVENTORY_HOLD_MS = 20 * 60 * 1000;

function isMissingTableError(error, tableName) {
  const msg = String(error?.message || '');
  if (!msg) return false;
  return msg.includes(`public.${tableName}`) && (
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('Could not find the table')
  );
}

const GIFT_CATALOG = [{"name":"Snake Box","price":339,"id":"6023679164349940429","image":"https://cdn.changes.tg/gifts/originals/6023679164349940429/Original.png"},{"name":"Big Year","price":340,"id":"6028283532500009446","image":"https://cdn.changes.tg/gifts/originals/6028283532500009446/Original.png"},{"name":"Xmas Stocking","price":340,"id":"6003767644426076664","image":"https://cdn.changes.tg/gifts/originals/6003767644426076664/Original.png"},{"name":"Chill Flame","price":350,"id":"5999277561060787166","image":"https://cdn.changes.tg/gifts/originals/5999277561060787166/Original.png"},{"name":"Instant Ramen","price":350,"id":"6005564615793050414","image":"https://cdn.changes.tg/gifts/originals/6005564615793050414/Original.png"},{"name":"Lunar Snake","price":350,"id":"6028426950047957932","image":"https://cdn.changes.tg/gifts/originals/6028426950047957932/Original.png"},{"name":"Vice Cream","price":350,"id":"5898012527257715797","image":"https://cdn.changes.tg/gifts/originals/5898012527257715797/Original.png"},{"name":"Victory Medal","price":350,"id":"5830340739074097859","image":"https://cdn.changes.tg/gifts/originals/5830340739074097859/Original.png"},{"name":"Winter Wreath","price":350,"id":"5983259145522906006","image":"https://cdn.changes.tg/gifts/originals/5983259145522906006/Original.png"},{"name":"Candy Cane","price":355,"id":"6003373314888696650","image":"https://cdn.changes.tg/gifts/originals/6003373314888696650/Original.png"},{"name":"Fresh Socks","price":360,"id":"5895603153683874485","image":"https://cdn.changes.tg/gifts/originals/5895603153683874485/Original.png"},{"name":"Pet Snake","price":365,"id":"6023917088358269866","image":"https://cdn.changes.tg/gifts/originals/6023917088358269866/Original.png"},{"name":"Santa Hat","price":380,"id":"5983471780763796287","image":"https://cdn.changes.tg/gifts/originals/5983471780763796287/Original.png"},{"name":"Whip Cupcake","price":380,"id":"5933543975653737112","image":"https://cdn.changes.tg/gifts/originals/5933543975653737112/Original.png"},{"name":"Ice Cream","price":389,"id":"5900177027566142759","image":"https://cdn.changes.tg/gifts/originals/5900177027566142759/Original.png"},{"name":"Pool Float","price":395,"id":"5832644211639321671","image":"https://cdn.changes.tg/gifts/originals/5832644211639321671/Original.png"},{"name":"Lol Pop","price":399,"id":"5170594532177215681","image":"https://cdn.changes.tg/gifts/originals/5170594532177215681/Original.png"},{"name":"Holiday Drink","price":400,"id":"6003735372041814769","image":"https://cdn.changes.tg/gifts/originals/6003735372041814769/Original.png"},{"name":"Happy Brownie","price":420,"id":"6006064678835323371","image":"https://cdn.changes.tg/gifts/originals/6006064678835323371/Original.png"},{"name":"Hypno Lollipop","price":420,"id":"5825895989088617224","image":"https://cdn.changes.tg/gifts/originals/5825895989088617224/Original.png"},{"name":"Tama Gadget","price":420,"id":"6023752243218481939","image":"https://cdn.changes.tg/gifts/originals/6023752243218481939/Original.png"},{"name":"Ginger Cookie","price":425,"id":"5983484377902875708","image":"https://cdn.changes.tg/gifts/originals/5983484377902875708/Original.png"},{"name":"Party Sparkler","price":430,"id":"6003643167683903930","image":"https://cdn.changes.tg/gifts/originals/6003643167683903930/Original.png"},{"name":"Spiced Wine","price":430,"id":"5913442287462908725","image":"https://cdn.changes.tg/gifts/originals/5913442287462908725/Original.png"},{"name":"Bow Tie","price":450,"id":"5895544372761461960","image":"https://cdn.changes.tg/gifts/originals/5895544372761461960/Original.png"},{"name":"Jack-in-the-Box","price":450,"id":"6005659564635063386","image":"https://cdn.changes.tg/gifts/originals/6005659564635063386/Original.png"},{"name":"Jester Hat","price":450,"id":"5933590374185435592","image":"https://cdn.changes.tg/gifts/originals/5933590374185435592/Original.png"},{"name":"Stellar Rocket","price":450,"id":"6042113507581755979","image":"https://cdn.changes.tg/gifts/originals/6042113507581755979/Original.png"},{"name":"Mousse Cake","price":460,"id":"5935877878062253519","image":"https://cdn.changes.tg/gifts/originals/5935877878062253519/Original.png"},{"name":"Money Pot","price":465,"id":"5963238670868677492","image":"https://cdn.changes.tg/gifts/originals/5963238670868677492/Original.png"},{"name":"Mood Pack","price":470,"id":"5886756255493523118","image":"https://cdn.changes.tg/gifts/originals/5886756255493523118/Original.png"},{"name":"B-Day Candle","price":498,"id":"5782984811920491178","image":"https://cdn.changes.tg/gifts/originals/5782984811920491178/Original.png"},{"name":"Clover Pin","price":498,"id":"5960747083030856414","image":"https://cdn.changes.tg/gifts/originals/5960747083030856414/Original.png"},{"name":"Hex Pot","price":500,"id":"5825801628657124140","image":"https://cdn.changes.tg/gifts/originals/5825801628657124140/Original.png"},{"name":"Pretty Posy","price":500,"id":"5933737850477478635","image":"https://cdn.changes.tg/gifts/originals/5933737850477478635/Original.png"},{"name":"Restless Jar","price":500,"id":"5870784783948186838","image":"https://cdn.changes.tg/gifts/originals/5870784783948186838/Original.png"},{"name":"Cookie Heart","price":509,"id":"6001538689543439169","image":"https://cdn.changes.tg/gifts/originals/6001538689543439169/Original.png"},{"name":"Swag Bag","price":510,"id":"6012607142387778152","image":"https://cdn.changes.tg/gifts/originals/6012607142387778152/Original.png"},{"name":"Snow Globe","price":530,"id":"5981132629905245483","image":"https://cdn.changes.tg/gifts/originals/5981132629905245483/Original.png"},{"name":"Star Notepad","price":538,"id":"5936017773737018241","image":"https://cdn.changes.tg/gifts/originals/5936017773737018241/Original.png"},{"name":"Homemade Cake","price":542,"id":"5783075783622787539","image":"https://cdn.changes.tg/gifts/originals/5783075783622787539/Original.png"},{"name":"Faith Amulet","price":544,"id":"6003456431095808759","image":"https://cdn.changes.tg/gifts/originals/6003456431095808759/Original.png"},{"name":"Easter Egg","price":550,"id":"5773668482394620318","image":"https://cdn.changes.tg/gifts/originals/5773668482394620318/Original.png"},{"name":"Snoop Dogg","price":550,"id":"6014591077976114307","image":"https://cdn.changes.tg/gifts/originals/6014591077976114307/Original.png"},{"name":"Spring Basket","price":550,"id":"5773725897517433693","image":"https://cdn.changes.tg/gifts/originals/5773725897517433693/Original.png"},{"name":"Moon Pendant","price":555,"id":"5998981470310368313","image":"https://cdn.changes.tg/gifts/originals/5998981470310368313/Original.png"},{"name":"Input Key","price":567,"id":"5870972044522291836","image":"https://cdn.changes.tg/gifts/originals/5870972044522291836/Original.png"},{"name":"Lush Bouquet","price":570,"id":"5871002671934079382","image":"https://cdn.changes.tg/gifts/originals/5871002671934079382/Original.png"},{"name":"Snow Mittens","price":570,"id":"5980789805615678057","image":"https://cdn.changes.tg/gifts/originals/5980789805615678057/Original.png"},{"name":"Witch Hat","price":570,"id":"5821384757304362229","image":"https://cdn.changes.tg/gifts/originals/5821384757304362229/Original.png"},{"name":"Desk Calendar","price":572,"id":"5782988952268964995","image":"https://cdn.changes.tg/gifts/originals/5782988952268964995/Original.png"},{"name":"Bunny Muffin","price":575,"id":"5935936766358847989","image":"https://cdn.changes.tg/gifts/originals/5935936766358847989/Original.png"},{"name":"Eternal Candle","price":575,"id":"5821205665758053411","image":"https://cdn.changes.tg/gifts/originals/5821205665758053411/Original.png"},{"name":"Evil Eye","price":575,"id":"5825480571261813595","image":"https://cdn.changes.tg/gifts/originals/5825480571261813595/Original.png"},{"name":"Jelly Bunny","price":575,"id":"5915502858152706668","image":"https://cdn.changes.tg/gifts/originals/5915502858152706668/Original.png"},{"name":"Jolly Chimp","price":575,"id":"6005880141270483700","image":"https://cdn.changes.tg/gifts/originals/6005880141270483700/Original.png"},{"name":"Light Sword","price":575,"id":"5897581235231785485","image":"https://cdn.changes.tg/gifts/originals/5897581235231785485/Original.png"},{"name":"Spy Agaric","price":575,"id":"5821261908354794038","image":"https://cdn.changes.tg/gifts/originals/5821261908354794038/Original.png"},{"name":"Timeless Book","price":575,"id":"5886387158889005864","image":"https://cdn.changes.tg/gifts/originals/5886387158889005864/Original.png"},{"name":"Joyful Bundle","price":616,"id":"5870862540036113469","image":"https://cdn.changes.tg/gifts/originals/5870862540036113469/Original.png"},{"name":"Sleigh Bell","price":691,"id":"5981026247860290310","image":"https://cdn.changes.tg/gifts/originals/5981026247860290310/Original.png"},{"name":"Hanging Star","price":697,"id":"5915733223018594841","image":"https://cdn.changes.tg/gifts/originals/5915733223018594841/Original.png"},{"name":"Berry Box","price":699,"id":"5882252952218894938","image":"https://cdn.changes.tg/gifts/originals/5882252952218894938/Original.png"},{"name":"Jingle Bells","price":700,"id":"6001473264306619020","image":"https://cdn.changes.tg/gifts/originals/6001473264306619020/Original.png"},{"name":"Sakura Flower","price":800,"id":"5167939598143193218","image":"https://cdn.changes.tg/gifts/originals/5167939598143193218/Original.png"},{"name":"Valentine Box","price":829,"id":"5868595669182186720","image":"https://cdn.changes.tg/gifts/originals/5868595669182186720/Original.png"},{"name":"Skull Flower","price":899,"id":"5839038009193792264","image":"https://cdn.changes.tg/gifts/originals/5839038009193792264/Original.png"},{"name":"Love Candle","price":903,"id":"5915550639663874519","image":"https://cdn.changes.tg/gifts/originals/5915550639663874519/Original.png"},{"name":"Crystal Ball","price":921,"id":"5841336413697606412","image":"https://cdn.changes.tg/gifts/originals/5841336413697606412/Original.png"},{"name":"Top Hat","price":928,"id":"5897593557492957738","image":"https://cdn.changes.tg/gifts/originals/5897593557492957738/Original.png"},{"name":"Snoop Cigar","price":967,"id":"6012435906336654262","image":"https://cdn.changes.tg/gifts/originals/6012435906336654262/Original.png"},{"name":"Flying Broom","price":1068,"id":"5837063436634161765","image":"https://cdn.changes.tg/gifts/originals/5837063436634161765/Original.png"},{"name":"UFC Strike","price":1085,"id":"5882260270843168924","image":"https://cdn.changes.tg/gifts/originals/5882260270843168924/Original.png"},{"name":"Trapped Heart","price":1117,"id":"5841391256135008713","image":"https://cdn.changes.tg/gifts/originals/5841391256135008713/Original.png"},{"name":"Record Player","price":1213,"id":"5856973938650776169","image":"https://cdn.changes.tg/gifts/originals/5856973938650776169/Original.png"},{"name":"Love Potion","price":1221,"id":"5868348541058942091","image":"https://cdn.changes.tg/gifts/originals/5868348541058942091/Original.png"},{"name":"Mad Pumpkin","price":1231,"id":"5841632504448025405","image":"https://cdn.changes.tg/gifts/originals/5841632504448025405/Original.png"},{"name":"Ionic Dryer","price":1362,"id":"5933937398953018107","image":"https://cdn.changes.tg/gifts/originals/5933937398953018107/Original.png"},{"name":"Sky Stilettos","price":1397,"id":"5870947077877400011","image":"https://cdn.changes.tg/gifts/originals/5870947077877400011/Original.png"},{"name":"Cupid Charm","price":1685,"id":"5868561433997870501","image":"https://cdn.changes.tg/gifts/originals/5868561433997870501/Original.png"},{"name":"Khabib’s Papakha","price":1915,"id":"5839094187366024301","image":"https://cdn.changes.tg/gifts/originals/5839094187366024301/Original.png"},{"name":"Rare Bird","price":2096,"id":"5999116401002939514","image":"https://cdn.changes.tg/gifts/originals/5999116401002939514/Original.png"},{"name":"Eternal Rose","price":2301,"id":"5882125812596999035","image":"https://cdn.changes.tg/gifts/originals/5882125812596999035/Original.png"},{"name":"Diamond Ring","price":2384,"id":"5868503709637411929","image":"https://cdn.changes.tg/gifts/originals/5868503709637411929/Original.png"},{"name":"Bling Binky","price":2421,"id":"5902339509239940491","image":"https://cdn.changes.tg/gifts/originals/5902339509239940491/Original.png"},{"name":"Voodoo Doll","price":2653,"id":"5836780359634649414","image":"https://cdn.changes.tg/gifts/originals/5836780359634649414/Original.png"},{"name":"Electric Skull","price":2838,"id":"5846192273657692751","image":"https://cdn.changes.tg/gifts/originals/5846192273657692751/Original.png"},{"name":"Signet Ring","price":2951,"id":"5936085638515261992","image":"https://cdn.changes.tg/gifts/originals/5936085638515261992/Original.png"},{"name":"Vintage Cigar","price":3017,"id":"5857140566201991735","image":"https://cdn.changes.tg/gifts/originals/5857140566201991735/Original.png"},{"name":"Neko Helmet","price":3201,"id":"5933793770951673155","image":"https://cdn.changes.tg/gifts/originals/5933793770951673155/Original.png"},{"name":"Toy Bear","price":3855,"id":"5868220813026526561","image":"https://cdn.changes.tg/gifts/originals/5868220813026526561/Original.png"},{"name":"Bonded Ring","price":3897,"id":"5870661333703197240","image":"https://cdn.changes.tg/gifts/originals/5870661333703197240/Original.png"},{"name":"Genie Lamp","price":3938,"id":"5933531623327795414","image":"https://cdn.changes.tg/gifts/originals/5933531623327795414/Original.png"},{"name":"Sharp Tongue","price":3938,"id":"5841689550203650524","image":"https://cdn.changes.tg/gifts/originals/5841689550203650524/Original.png"},{"name":"Swiss Watch","price":4069,"id":"5936043693864651359","image":"https://cdn.changes.tg/gifts/originals/5936043693864651359/Original.png"},{"name":"Low Rider","price":4641,"id":"6014675319464657779","image":"https://cdn.changes.tg/gifts/originals/6014675319464657779/Original.png"},{"name":"Kissed Frog","price":5060,"id":"5845776576658015084","image":"https://cdn.changes.tg/gifts/originals/5845776576658015084/Original.png"},{"name":"Gem Signet","price":5746,"id":"5859442703032386168","image":"https://cdn.changes.tg/gifts/originals/5859442703032386168/Original.png"},{"name":"Magic Potion","price":6577,"id":"5846226946928673709","image":"https://cdn.changes.tg/gifts/originals/5846226946928673709/Original.png"},{"name":"Artisan Brick","price":7177,"id":"6005797617768858105","image":"https://cdn.changes.tg/gifts/originals/6005797617768858105/Original.png"},{"name":"Mini Oscar","price":7637,"id":"5879737836550226478","image":"https://cdn.changes.tg/gifts/originals/5879737836550226478/Original.png"},{"name":"Ion Gem","price":7793,"id":"5843762284240831056","image":"https://cdn.changes.tg/gifts/originals/5843762284240831056/Original.png"},{"name":"Perfume Bottle","price":8714,"id":"5913517067138499193","image":"https://cdn.changes.tg/gifts/originals/5913517067138499193/Original.png"},{"name":"Westside Sign","price":8796,"id":"6014697240977737490","image":"https://cdn.changes.tg/gifts/originals/6014697240977737490/Original.png"},{"name":"Scared Cat","price":9775,"id":"5837059369300132790","image":"https://cdn.changes.tg/gifts/originals/5837059369300132790/Original.png"},{"name":"Nail Bracelet","price":11229,"id":"5870720080265871962","image":"https://cdn.changes.tg/gifts/originals/5870720080265871962/Original.png"},{"name":"Loot Bag","price":12537,"id":"5868659926187901653","image":"https://cdn.changes.tg/gifts/originals/5868659926187901653/Original.png"},{"name":"Mighty Arm","price":13638,"id":"5895518353849582541","image":"https://cdn.changes.tg/gifts/originals/5895518353849582541/Original.png"},{"name":"Astral Shard","price":14099,"id":"5933629604416717361","image":"https://cdn.changes.tg/gifts/originals/5933629604416717361/Original.png"},{"name":"Heroic Helmet","price":21859,"id":"5895328365971244193","image":"https://cdn.changes.tg/gifts/originals/5895328365971244193/Original.png"},{"name":"Precious Peach","price":35678,"id":"5933671725160989227","image":"https://cdn.changes.tg/gifts/originals/5933671725160989227/Original.png"},{"name":"Durov’s Cap","price":67592,"id":"5915521180483191380","image":"https://cdn.changes.tg/gifts/originals/5915521180483191380/Original.png"},{"name":"Heart Locket","price":172552,"id":"5868455043362980631","image":"https://cdn.changes.tg/gifts/originals/5868455043362980631/Original.png"},{"name":"Plush Pepe","price":780883,"id":"5936013938331222567","image":"https://cdn.changes.tg/gifts/originals/5936013938331222567/Original.png"}];

function validateInitDataContext(initDataStr) {
  try {
    const params = new URLSearchParams(String(initDataStr || ''));
    const hash = String(params.get('hash') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    params.delete('hash');
    const str = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(CONFIG.BOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secret).update(str).digest('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const authDate = Number(params.get('auth_date') || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate <= 0) return null;
    if (authDate > nowSec + 60) return null;
    if (nowSec - authDate > CONFIG.INIT_DATA_MAX_AGE_SEC) return null;

    return {
      user: JSON.parse(params.get('user') || 'null'),
      startParam: params.get('start_param') || null,
      authDate,
    };
  } catch {
    return null;
  }
}

function validateInitData(initDataStr) {
  return validateInitDataContext(initDataStr)?.user || null;
}

function getReqInitData(req) {
  return req.headers['x-init-data'] || req.body?.initData || '';
}

function requireUser(req, res) {
  const user = validateInitData(getReqInitData(req));
  if (!user) {
    res.status(401).json({ error: 'Invalid initData' });
    return null;
  }
  if (req._banInfo) {
    res.status(403).json({ error: 'banned', banned: true, reason: req._banInfo.reason || 'Нарушение правил', bannedAt: req._banInfo.bannedAt });
    return null;
  }
  return user;
}

function requireUserContext(req, res) {
  const context = validateInitDataContext(getReqInitData(req));
  if (!context?.user) {
    res.status(401).json({ error: 'Invalid initData' });
    return null;
  }
  if (req._banInfo) {
    res.status(403).json({ error: 'banned', banned: true, reason: req._banInfo.reason || 'Нарушение правил', bannedAt: req._banInfo.bannedAt });
    return null;
  }
  return context;
}

// Middleware: проверяем бан до того как роут что-то сделает.
app.use('/api', async (req, res, next) => {
  const init = getReqInitData(req);
  if (!init) return next();
  const user = validateInitData(init);
  if (!user) return next();
  try {
    const ban = await getBanInfo(user.id);
    if (ban) req._banInfo = ban;
  } catch (_) {}
  next();
});

function extractReferralId(startParam) {
  const match = /^ref_(\d+)$/.exec(String(startParam || '').trim());
  return match ? Number(match[1]) : null;
}

// Уведомление пригласителю в Telegram. kind ∈ 'join' | 'deposit' | 'fee'.
async function notifyReferrer(referrerId, referredUserId, kind, amount = 0, reward = 0) {
  try {
    if (!referrerId || !referredUserId) return;
    let handle = `id${referredUserId}`;
    try {
      const { data: refUser } = await sb
        .from('users')
        .select('username,first_name')
        .eq('id', Number(referredUserId))
        .maybeSingle();
      if (refUser?.username) handle = `@${refUser.username}`;
      else if (refUser?.first_name) handle = refUser.first_name;
    } catch (_) {}

    let text;
    if (kind === 'join') {
      text = `🎉 ${handle} присоединился по вашей реферальной ссылке!`;
    } else if (kind === 'deposit') {
      text = `💰 ${handle} пополнил баланс на ${amount}⭐ — вы получаете +${reward}⭐ (10%).`;
    } else if (kind === 'fee') {
      text = `💸 ${handle} оплатил комиссию ${amount}⭐ за вывод подарка — вы получаете +${reward}⭐ (10%).`;
    } else {
      return;
    }
    const tgRes = await tgApi('sendMessage', { chat_id: Number(referrerId), text }, 5000);
    if (!tgRes || tgRes.ok === false) {
      // Самая частая причина: реферер ни разу не запускал бота → Telegram возвращает
      // 403 "Forbidden: bot can't initiate conversation with a user". Логируем явно,
      // чтобы при разборе было видно «почему уведомление не дошло».
      console.warn(
        `⚠️ notifyReferrer FAILED kind=${kind} referrer=${referrerId} ref=${referredUserId} ` +
        `err=${tgRes?.error_code || '?'} ${tgRes?.description || 'no description'}`
      );
    } else {
      console.log(`✅ notifyReferrer kind=${kind} referrer=${referrerId} ref=${referredUserId} amount=${amount} reward=${reward}`);
    }
  } catch (e) {
    console.error('notifyReferrer error:', e?.message || e);
  }
}

// v8.19: применить реферальную связку из бот-deep-link или mini app — общий путь.
// Возвращает true если запись создана (новый реф), чтобы вызывающий мог уведомить.

async function getUserLogIdentity(userId) {
  const id = Number(userId || 0);
  if (!id) return 'unknown/0';
  try {
    const { data } = await sb.from('users').select('username,first_name').eq('id', id).maybeSingle();
    const handle = data?.username ? `@${data.username}` : (data?.first_name || 'user');
    return `${handle}/${id}`;
  } catch (_) {
    return `user/${id}`;
  }
}

async function logReferralJoin(referrerId, referredUserId) {
  const [inviter, invited] = await Promise.all([
    getUserLogIdentity(referrerId),
    getUserLogIdentity(referredUserId),
  ]);
  console.log(`🤝 REF JOIN inviter=${inviter} invited=${invited}`);
}

async function logReferralDeposit(referrerId, referredUserId, amount, reward, source = 'deposit') {
  const refId = Number(referrerId || 0);
  const rewardNum = Math.max(0, Math.floor(Number(reward || 0)));
  if (!refId || rewardNum <= 0) return;
  const [inviter, depositor] = await Promise.all([
    getUserLogIdentity(refId),
    getUserLogIdentity(referredUserId),
  ]);
  console.log(`💰 REF DEPOSIT inviter=${inviter} depositor=${depositor} amount=${Math.floor(Number(amount || 0))}⭐ reward=+${rewardNum}⭐ source=${source}`);
  notifyReferrer(refId, referredUserId, 'deposit', Math.floor(Number(amount || 0)), rewardNum).catch(() => null);
}

async function logDeposit(userId, amount, source = 'stars') {
  const who = await getUserLogIdentity(userId);
  console.log(`💫 DEPOSIT user=${who} amount=${Math.floor(Number(amount || 0))}⭐ source=${source}`);
}

async function applyReferralIfNew(userId, referrerId) {
  if (!userId || !referrerId) return false;
  if (Number(userId) === Number(referrerId)) {
    console.log(`↩️ self-referral ignored for user ${userId}`);
    return false;
  }
  try {
    const linkResult = await sb.rpc('giftpep_apply_referral_link_v2', {
      p_user_id: Number(userId),
      p_referrer_id: Number(referrerId),
    });
    if (linkResult.error) {
      console.error('apply_referral_link error:', linkResult.error);
      return false;
    }
    if (linkResult.data === true) {
      console.log(`🤝 referral linked: ${userId} ← ${referrerId}`);
      logReferralJoin(referrerId, userId).catch((e) => console.warn('ref join log failed:', e?.message || e));
      return true;
    }
    return false;
  } catch (e) {
    console.error('applyReferralIfNew error:', e?.message || e);
    return false;
  }
}

async function getReferralSummary(userId) {
  const { data, error } = await sb.rpc('giftpep_get_referral_stats_v2', { p_user_id: userId });
  if (error) throw new Error(error.message || 'Referral stats failed');
  const row = Array.isArray(data) ? data[0] : data;
  return {
    invitedCount: Number(row?.invited_count || 0),
    earned: Number(row?.earned || 0),
  };
}


async function applyDepositCredit(userId, amount) {
  const numericAmount = Math.max(0, Math.floor(Number(amount || 0)));
  if (!userId || numericAmount <= 0) {
    return { amount: 0, balance: await getUserBalance(userId), referral: null };
  }

  const { error } = await sb.rpc('balance_add', { p_user_id: userId, p_amount: numericAmount });
  if (error) {
    throw new Error(error.message || 'balance_add failed');
  }

  let referral = null;
  try {
    const rewardResult = await sb.rpc('giftpep_credit_referral_for_deposit_v2', {
      p_user_id: userId,
      p_deposit_amount: numericAmount,
    });
    if (rewardResult.error) {
      console.error('credit_referral_for_deposit error:', rewardResult.error);
    } else {
      const rewardRow = Array.isArray(rewardResult.data) ? rewardResult.data[0] : rewardResult.data;
      const rewardNum = Number(rewardRow?.reward || 0);
      const refId = Number(rewardRow?.referrer_id || 0);
      if (rewardNum > 0) {
        logReferralDeposit(refId, userId, numericAmount, rewardNum, 'direct').catch(() => null);
      }
    }
    referral = await getReferralSummary(userId).catch(() => null);
  } catch (error) {
    console.error('Referral credit failed:', error);
  }

  const balance = await getUserBalance(userId);
  return { amount: numericAmount, balance, referral };
}

async function tgApi(method, data = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    return r.json();
  } finally {
    clearTimeout(timeout);
  }
}

function inferWebhookUrl(req = null) {
  const explicit = String(CONFIG.WEBHOOK_URL || '').trim();
  if (explicit) {
    return explicit.endsWith('/webhook') ? explicit : `${explicit.replace(/\/$/, '')}/webhook`;
  }

  const publicBase = String(CONFIG.PUBLIC_BASE_URL || '').trim();
  if (publicBase) {
    return publicBase.endsWith('/webhook') ? publicBase : `${publicBase.replace(/\/$/, '')}/webhook`;
  }

  const envCandidates = [
    process.env.RENDER_EXTERNAL_URL,
    process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '',
    process.env.REPL_SLUG && process.env.REPL_OWNER ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : '',
    process.env.REPLIT_DOMAINS ? `https://${String(process.env.REPLIT_DOMAINS).split(',')[0]}` : '',
  ].filter(Boolean);

  if (envCandidates.length) {
    return `${String(envCandidates[0]).replace(/\/$/, '')}/webhook`;
  }

  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    if (host) return `${proto}://${host}/webhook`;
  }

  return '';
}

async function ensureTelegramWebhook(req = null) {
  const url = inferWebhookUrl(req);
  if (!url) return { ok: false, skipped: true, description: 'Webhook URL not configured' };
  return tgApi('setWebhook', {
    url,
    allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
    drop_pending_updates: false,
    secret_token: CONFIG.TELEGRAM_WEBHOOK_SECRET,
  }, 5000);
}

async function answerPreCheckout(update) {
  const q = update?.pre_checkout_query;
  const queryId = String(q?.id || '').trim();
  if (!queryId) return null;
  let ok = false;
  let errorMessage = 'Платёж не прошёл проверку';
  try {
    const payload = JSON.parse(String(q.invoice_payload || '{}'));
    const senderId = Number(q?.from?.id || 0);
    const amount = Number(q?.total_amount || 0);
    const currency = String(q?.currency || '');
    if (!senderId || currency !== 'XTR' || !Number.isInteger(amount) || amount <= 0) throw new Error('Bad payment fields');

    if (payload?.type === 'withdraw') {
      const { data: intent, error } = await sb.from('withdraw_intents')
        .select('id,user_id,fee_stars,status,expires_at').eq('id', String(payload.intentId || '')).maybeSingle();
      if (error || !intent) throw new Error('Withdraw intent not found');
      if (Number(intent.user_id) !== senderId || Number(payload.userId) !== senderId) throw new Error('Wrong payer');
      if (Number(intent.fee_stars) !== amount || intent.status !== 'created') throw new Error('Wrong withdraw amount/state');
      if (Date.now() > new Date(intent.expires_at).getTime()) throw new Error('Withdraw invoice expired');
    } else {
      if (Number(payload?.userId) !== senderId) throw new Error('Wrong payer');
      if (Number(payload?.amount) !== amount) throw new Error('Wrong amount');
      if (!/^[0-9a-f-]{36}$/i.test(String(payload?.invoiceId || ''))) throw new Error('Bad invoice id');
    }
    ok = true;
  } catch (error) {
    errorMessage = String(error?.message || errorMessage).slice(0, 180);
  }
  return tgApi('answerPreCheckoutQuery', {
    pre_checkout_query_id: queryId,
    ok,
    ...(ok ? {} : { error_message: errorMessage }),
  }, 2500);
}

async function handleBotMessage(message) {
  const text = String(message?.text || '').trim();
  const chatId = Number(message?.chat?.id);
  const senderId = Number(message?.from?.id);

  const isAdmin = CONFIG.ADMIN_IDS.includes(senderId);
  const replyTo = message?.reply_to_message?.text || '';

  // === Force-reply: списание звёзд ===
  const starsPrompt = replyTo.match(/Списание звёзд у юзера\s+(\d+)/);
  if (starsPrompt && isAdmin) {
    const targetId = Number(starsPrompt[1]);
    const amount = Math.floor(Number(String(text).replace(/[^\d-]/g, '')) || 0);
    if (!amount || amount <= 0) {
      return tgApi('sendMessage', { chat_id: chatId, text: '❌ Отменено (сумма 0 или некорректна).' }, 5000);
    }
    try {
      const newBal = await spendBalance(targetId, amount);
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ Списано ${amount}⭐ у юзера ${targetId}.\nОстаток: ${newBal}⭐`,
      }, 5000);
    } catch (e) {
      return tgApi('sendMessage', { chat_id: chatId, text: `❌ Не удалось списать: ${e?.message || e}` }, 5000);
    }
  }

  // === Force-reply: ввод цели для INFO/BAN/UNBAN/GIFT через админ-клавиатуру ===
  if (isAdmin && replyTo) {
    if (replyTo.startsWith('ℹ️ INFO — введи')) {
      return runAdminInfo(chatId, text);
    }
    if (replyTo.startsWith('🚫 BAN — введи')) {
      const parts = text.trim().split(/\s+/);
      const ident = parts.shift();
      const reason = parts.join(' ').trim() || 'Нарушение правил';
      return runAdminBan(chatId, ident, reason);
    }
    if (replyTo.startsWith('✅ UNBAN — введи')) {
      return runAdminUnban(chatId, text.trim());
    }
    if (replyTo.startsWith('🎁 GIFT — введи')) {
      return runAdminGift(chatId, text.trim());
    }
  }

  // === Reply-клавиатура: тексты-кнопки админ-панели ===
  if (isAdmin) {
    if (text === '📊 ТОП')   return runAdminTop(chatId);
    if (text === 'ℹ️ INFO')  return adminForcePrompt(chatId, 'ℹ️ INFO — введи @username или ID:');
    if (text === '🚫 BAN')   return adminForcePrompt(chatId, '🚫 BAN — введи: @username [причина]');
    if (text === '✅ UNBAN') return adminForcePrompt(chatId, '✅ UNBAN — введи @username или ID:');
    if (text === '🎁 GIFT')  return adminForcePrompt(chatId, '🎁 GIFT — введи @username или ID (покажу подарки):');
    if (text === '🛠 АДМИН' || /^\/admin(?:@\w+)?(?:\s|$)/i.test(text)) {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: '🛠 *Админ-панель GiftPep*\n\nИспользуй кнопки внизу:',
        parse_mode: 'Markdown',
        reply_markup: ADMIN_KEYBOARD,
      }, 5000);
    }
  }

  // === /ban @username причина — бан навсегда ===
  const banMatch = text.match(/^\/ban(?:@\w+)?(?:\s+(.+))?$/i);
  if (banMatch) {
    if (!CONFIG.ADMIN_IDS.includes(senderId)) {
      return tgApi('sendMessage', { chat_id: chatId, text: '⛔ Команда только для администраторов.' }, 5000);
    }
    const argsRaw = String(banMatch[1] || '').trim();
    if (!argsRaw) {
      return tgApi('sendMessage', { chat_id: chatId, text: 'Использование: `/ban @username причина`', parse_mode: 'Markdown' }, 5000);
    }
    // первый токен — username/id, остальное — причина
    const parts = argsRaw.split(/\s+/);
    const ident = parts.shift();
    const reason = parts.join(' ').trim() || 'Нарушение правил';
    let targetId = /^\d+$/.test(ident) ? Number(ident) : null;
    if (!targetId) {
      try { targetId = await getUserIdByUsername(normalizeUsername(ident)); } catch (_) { targetId = null; }
    }
    if (!targetId) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${ident}» не найден.` }, 5000);
    try {
      await setUserBan(targetId, reason);
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `🚫 Юзер \`${targetId}\` забанен навсегда.\nПричина: *${reason}*`,
        parse_mode: 'Markdown',
      }, 5000);
    } catch (e) {
      return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка бана: ${e?.message || e}` }, 5000);
    }
  }

  // === /unban @username — разбан ===
  const unbanMatch = text.match(/^\/unban(?:@\w+)?(?:\s+(.+))?$/i);
  if (unbanMatch) {
    if (!CONFIG.ADMIN_IDS.includes(senderId)) {
      return tgApi('sendMessage', { chat_id: chatId, text: '⛔ Команда только для администраторов.' }, 5000);
    }
    const ident = String(unbanMatch[1] || '').trim();
    if (!ident) return tgApi('sendMessage', { chat_id: chatId, text: 'Использование: `/unban @username`', parse_mode: 'Markdown' }, 5000);
    let targetId = /^\d+$/.test(ident) ? Number(ident) : null;
    if (!targetId) {
      try { targetId = await getUserIdByUsername(normalizeUsername(ident)); } catch (_) { targetId = null; }
    }
    if (!targetId) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${ident}» не найден.` }, 5000);
    try {
      await clearUserBan(targetId);
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ Юзер \`${targetId}\` разбанен.`,
        parse_mode: 'Markdown',
      }, 5000);
    } catch (e) {
      return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка разбана: ${e?.message || e}` }, 5000);
    }
  }

  // === /info @username — карточка юзера + кнопки Инвентарь / Звёзды ===
  const infoMatch = text.match(/^\/info(?:@\w+)?(?:\s+(.+))?$/i);
  if (infoMatch) {
    if (!CONFIG.ADMIN_IDS.includes(senderId)) {
      return tgApi('sendMessage', { chat_id: chatId, text: '⛔ Команда только для администраторов.' }, 5000);
    }
    const ident = String(infoMatch[1] || '').trim();
    if (!ident) return tgApi('sendMessage', { chat_id: chatId, text: 'Использование: `/info @username`', parse_mode: 'Markdown' }, 5000);
    let targetId = /^\d+$/.test(ident) ? Number(ident) : null;
    if (!targetId) {
      try { targetId = await getUserIdByUsername(normalizeUsername(ident)); } catch (_) { targetId = null; }
    }
    if (!targetId) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${ident}» не найден.` }, 5000);

    try {
      const { data: u } = await sb.from('users')
        .select('id,first_name,username,balance,total_deposited,banned_at,ban_reason,created_at')
        .eq('id', targetId)
        .maybeSingle();
      if (!u) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер \`${targetId}\` не в базе.`, parse_mode: 'Markdown' }, 5000);

      let inv = [];
      try { inv = await getUserInventory(targetId); } catch (_) { inv = []; }
      const giftCount = inv.length;
      const giftSum = inv.reduce((s, g) => s + Number(g.price || 0), 0);

      const handle = u.username ? `@${u.username}` : (u.first_name || `id${u.id}`);
      const banLine = u.banned_at ? `\n🚫 *ЗАБАНЕН*: ${u.ban_reason || '—'}` : '';
      const lines = [
        `👤 *${handle}* \`${u.id}\``,
        `⭐ Баланс: *${Number(u.balance || 0)}*`,
        `💰 Пополнено всего: *${Number(u.total_deposited || 0)}⭐*`,
        `🎁 Подарков: *${giftCount}* на *${giftSum}⭐*`,
        u.created_at ? `📅 Создан: ${String(u.created_at).slice(0, 10)}` : '',
        banLine,
      ].filter(Boolean).join('\n');

      return tgApi('sendMessage', {
        chat_id: chatId,
        text: lines,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: `🎁 Инвентарь (${giftCount})`, callback_data: `ig:${targetId}` },
              { text: '⭐ Списать звёзды',           callback_data: `bs:${targetId}` },
            ],
          ],
        },
      }, 5000);
    } catch (e) {
      return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${e?.message || e}` }, 5000);
    }
  }

  // === /gift @username|id — админская команда ===
  // Показывает кнопочный список подарков указанного юзера; нажатие = удалить.
  const giftMatch = text.match(/^\/gift(?:@\w+)?(?:\s+(.+))?$/i);
  if (giftMatch) {
    if (!CONFIG.ADMIN_IDS.includes(senderId)) {
      return tgApi('sendMessage', { chat_id: chatId, text: '⛔ Команда только для администраторов.' }, 5000);
    }
    const arg = String(giftMatch[1] || '').trim();
    if (!arg) {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Использование: `/gift @username` или `/gift 123456789`',
        parse_mode: 'Markdown',
      }, 5000);
    }

    // Резолвим userId по username или принимаем числовой id напрямую.
    let targetUserId = null;
    if (/^\d+$/.test(arg)) {
      targetUserId = Number(arg);
    } else {
      const uname = normalizeUsername(arg);
      if (uname) {
        try { targetUserId = await getUserIdByUsername(uname); } catch (e) { targetUserId = null; }
      }
    }
    if (!targetUserId) {
      return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${arg}» не найден.` }, 5000);
    }

    let inv = [];
    try { inv = await getUserInventory(targetUserId); } catch (e) {
      return tgApi('sendMessage', { chat_id: chatId, text: `❌ Не удалось получить инвентарь: ${e?.message || e}` }, 5000);
    }
    if (!inv.length) {
      return tgApi('sendMessage', { chat_id: chatId, text: `📭 У юзера \`${targetUserId}\` нет подарков.`, parse_mode: 'Markdown' }, 5000);
    }

    // Одна кнопка на подарок. callback_data ограничен 64 байтами, поэтому короткий формат.
    const buttons = inv.slice(0, 80).map((g) => ([{
      text: `🗑 ${String(g.name || 'gift').slice(0, 40)} · ${Number(g.price || 0)}⭐`,
      callback_data: `gd:${targetUserId}:${Number(g.id)}`,
    }]));
    const total = inv.reduce((s, g) => s + Number(g.price || 0), 0);
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: `🎁 Инвентарь юзера \`${targetUserId}\` — ${inv.length} шт. на ${total}⭐\n_Нажми на подарок чтобы удалить._`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    }, 5000);
  }

  // === /top — админская команда: список топ-10 с кнопками для удаления ===
  if (/^\/top(?:@\w+)?(?:\s|$)/i.test(text)) {
    if (!CONFIG.ADMIN_IDS.includes(senderId)) {
      return tgApi('sendMessage', { chat_id: chatId, text: '⛔ Команда только для администраторов.' }, 5000);
    }
    try {
      const { data: leaders } = await sb
        .from('users')
        .select('id,first_name,username,total_deposited')
        .gt('total_deposited', 0)
        .order('total_deposited', { ascending: false })
        .limit(10);
      if (!leaders || leaders.length === 0) {
        return tgApi('sendMessage', { chat_id: chatId, text: '📊 Топ пуст.' }, 5000);
      }
      const buttons = leaders.map((u, i) => {
        const handle = u.username ? `@${u.username}` : (u.first_name || `id${u.id}`);
        return [{
          text: `${i + 1}. ${String(handle).slice(0, 28)} · ${Number(u.total_deposited || 0)}⭐`,
          callback_data: `tr:${Number(u.id)}`,
        }];
      });
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `📊 *Топ-10* (нажми чтобы убрать из топа)`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      }, 5000);
    } catch (e) {
      return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${e?.message || e}` }, 5000);
    }
  }

  // === /start — приветствие ===
  if (!/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return null;
  const startParam = text.replace(/^\/start(?:@\w+)?\s*/i, '').trim();
  const baseMiniAppUrl = String(CONFIG.MINI_APP_URL || '').trim().replace(/\/$/, '');
  const appUrl = startParam ? `${baseMiniAppUrl}?startapp=${encodeURIComponent(startParam)}` : baseMiniAppUrl;

  // v8.19: deep-link вида /start ref_NNN — сразу фиксируем реферала,
  // не дожидаясь пока новый юзер откроет mini app. Это даёт уведомление пригласителю
  // даже если рефералу пришла обычная бот-ссылка (без app).
  try {
    const refId = extractReferralId(startParam);
    if (refId && senderId) {
      // Убедимся что юзер есть в БД (init_user идемпотентен).
      try {
        const fromUser = message?.from || {};
        await sb.rpc('init_user', {
          p_id: Number(senderId),
          p_first_name: fromUser.first_name || null,
          p_username: fromUser.username || null,
          p_photo_url: null,
        });
      } catch (e) { console.warn('init_user from /start failed:', e?.message || e); }

      const isNew = await applyReferralIfNew(senderId, refId);
      if (isNew) notifyReferrer(refId, senderId, 'join').catch(() => null);
    }
  } catch (e) {
    console.error('/start referral handling error:', e?.message || e);
  }

  const welcome =
    '🎰 *GiftPep* — топ-казино для нфт подарков\n\n' +
    '🎁 Крути краш, апгрейдь подарки и забирай нфт подарки.\n\n' +
    '👇 Жми «Играть», чтобы начать!';

  // Сначала приветствие с web_app-кнопкой.
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: welcome,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎮 Играть', web_app: { url: appUrl } }],
        [
          { text: '📣 Канал', url: `https://t.me/${CONFIG.CHANNEL_USERNAME}` },
          { text: '💬 Поддержка', url: `https://t.me/${CONFIG.SUPPORT_USERNAME}` },
        ],
      ],
    },
  }, 5000);

  // Админам сразу показываем reply-клавиатуру.
  if (isAdmin) {
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: '🛠 *Админ-панель* загружена.\nКнопки внизу 👇',
      parse_mode: 'Markdown',
      reply_markup: ADMIN_KEYBOARD,
    }, 5000);
  }
  return null;
}

// === Админ-клавиатура и хелперы для команд ====================================
const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 ТОП' },   { text: 'ℹ️ INFO' }],
    [{ text: '🚫 BAN' },   { text: '✅ UNBAN' }],
    [{ text: '🎁 GIFT' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  selective: true,
};

function adminForcePrompt(chatId, promptText) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text: promptText,
    reply_markup: { force_reply: true, selective: true },
  }, 5000);
}

async function resolveAdminTarget(ident) {
  const raw = String(ident || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  try { return await getUserIdByUsername(normalizeUsername(raw)); } catch (_) { return null; }
}

async function runAdminTop(chatId) {
  try {
    const { data: leaders } = await sb
      .from('users')
      .select('id,first_name,username,total_deposited')
      .gt('total_deposited', 0)
      .order('total_deposited', { ascending: false })
      .limit(10);
    if (!leaders || leaders.length === 0) {
      return tgApi('sendMessage', { chat_id: chatId, text: '📊 Топ пуст.' }, 5000);
    }
    const lines = ['📊 ТОП-10 (тапни чтобы убрать):', ''];
    const buttons = leaders.map((u, i) => {
      const handle = u.username ? `@${u.username}` : (u.first_name || `user`);
      const safeHandle = String(handle).slice(0, 22);
      lines.push(`${i + 1}. ${safeHandle} · id ${u.id} · ${Number(u.total_deposited || 0)}⭐`);
      return [{
        text: `${i + 1}. ${safeHandle} (${u.id}) · ${Number(u.total_deposited || 0)}⭐`,
        callback_data: `tr:${Number(u.id)}`,
      }];
    });
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      reply_markup: { inline_keyboard: buttons },
    }, 5000);
  } catch (e) {
    return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${e?.message || e}` }, 5000);
  }
}

async function runAdminInfo(chatId, ident) {
  const targetId = await resolveAdminTarget(ident);
  if (!targetId) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${ident}» не найден.` }, 5000);
  try {
    const { data: u } = await sb.from('users')
      .select('id,first_name,username,balance,total_deposited,banned_at,ban_reason,created_at')
      .eq('id', targetId)
      .maybeSingle();
    if (!u) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер ${targetId} не в базе.` }, 5000);

    let inv = [];
    try { inv = await getUserInventory(targetId); } catch (_) { inv = []; }
    const giftCount = inv.length;
    const giftSum = inv.reduce((s, g) => s + Number(g.price || 0), 0);

    const handle = u.username ? `@${u.username}` : (u.first_name || 'user');
    const banLine = u.banned_at ? `\n🚫 ЗАБАНЕН: ${u.ban_reason || '—'}` : '';
    const txt =
      `👤 ${handle}\n` +
      `🆔 ID: ${u.id}\n` +
      `⭐ Баланс: ${Number(u.balance || 0)}\n` +
      `💰 Пополнено всего: ${Number(u.total_deposited || 0)}⭐\n` +
      `🎁 Подарков: ${giftCount} на ${giftSum}⭐` +
      (u.created_at ? `\n📅 Создан: ${String(u.created_at).slice(0, 10)}` : '') +
      banLine;

    return tgApi('sendMessage', {
      chat_id: chatId,
      text: txt,
      reply_markup: {
        inline_keyboard: [[
          { text: `🎁 Инвентарь (${giftCount})`, callback_data: `ig:${targetId}` },
          { text: '⭐ Списать звёзды',           callback_data: `bs:${targetId}` },
        ]],
      },
    }, 5000);
  } catch (e) {
    return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${e?.message || e}` }, 5000);
  }
}

async function runAdminBan(chatId, ident, reason) {
  const targetId = await resolveAdminTarget(ident);
  if (!targetId) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${ident}» не найден.` }, 5000);
  try {
    await setUserBan(targetId, reason);
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: `🚫 Юзер ${targetId} забанен навсегда.\nПричина: ${reason}`,
    }, 5000);
  } catch (e) {
    return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка бана: ${e?.message || e}` }, 5000);
  }
}

async function runAdminUnban(chatId, ident) {
  const targetId = await resolveAdminTarget(ident);
  if (!targetId) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${ident}» не найден.` }, 5000);
  try {
    await clearUserBan(targetId);
    return tgApi('sendMessage', { chat_id: chatId, text: `✅ Юзер ${targetId} разбанен.` }, 5000);
  } catch (e) {
    return tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка разбана: ${e?.message || e}` }, 5000);
  }
}

async function runAdminGift(chatId, ident) {
  const targetUserId = await resolveAdminTarget(ident);
  if (!targetUserId) return tgApi('sendMessage', { chat_id: chatId, text: `❌ Юзер «${ident}» не найден.` }, 5000);
  let inv = [];
  try { inv = await getUserInventory(targetUserId); }
  catch (e) { return tgApi('sendMessage', { chat_id: chatId, text: `❌ Не удалось получить инвентарь: ${e?.message || e}` }, 5000); }
  if (!inv.length) return tgApi('sendMessage', { chat_id: chatId, text: `📭 У юзера ${targetUserId} нет подарков.` }, 5000);
  const buttons = inv.slice(0, 80).map((g) => ([{
    text: `🗑 ${String(g.name || 'gift').slice(0, 40)} · ${Number(g.price || 0)}⭐`,
    callback_data: `gd:${targetUserId}:${Number(g.id)}`,
  }]));
  const total = inv.reduce((s, g) => s + Number(g.price || 0), 0);
  return tgApi('sendMessage', {
    chat_id: chatId,
    text: `🎁 Инвентарь юзера ${targetUserId} — ${inv.length} шт. на ${total}⭐\nНажми чтобы удалить.`,
    reply_markup: { inline_keyboard: buttons },
  }, 5000);
}

// Обработка нажатий на кнопки (callback_query). Сейчас только gd:* — админское
// удаление подарка из инвентаря юзера.
async function handleBotCallback(cb) {
  const data = String(cb?.data || '');
  const fromId = Number(cb?.from?.id);
  const chatId = Number(cb?.message?.chat?.id);
  const msgId = Number(cb?.message?.message_id);

  // === ig:USERID — клик «🎁 Инвентарь» в /info: показать список подарков ===
  const igMatch = data.match(/^ig:(\d+)$/);
  if (igMatch) {
    if (!CONFIG.ADMIN_IDS.includes(fromId)) {
      return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Только для администраторов', show_alert: true }, 5000);
    }
    const targetUserId = Number(igMatch[1]);
    let inv = [];
    try { inv = await getUserInventory(targetUserId); } catch (_) { inv = []; }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id }, 5000);
    if (!inv.length) {
      return tgApi('sendMessage', { chat_id: chatId, text: `📭 У юзера \`${targetUserId}\` нет подарков.`, parse_mode: 'Markdown' }, 5000);
    }
    const buttons = inv.slice(0, 80).map((g) => ([{
      text: `🗑 ${String(g.name || 'gift').slice(0, 40)} · ${Number(g.price || 0)}⭐`,
      callback_data: `gd:${targetUserId}:${Number(g.id)}`,
    }]));
    const total = inv.reduce((s, g) => s + Number(g.price || 0), 0);
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: `🎁 Инвентарь юзера \`${targetUserId}\` — ${inv.length} шт. на ${total}⭐\n_Нажми на подарок чтобы удалить._`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    }, 5000);
  }

  // === bs:USERID — клик «⭐ Списать звёзды» в /info: спросить сумму через force_reply ===
  const bsMatch = data.match(/^bs:(\d+)$/);
  if (bsMatch) {
    if (!CONFIG.ADMIN_IDS.includes(fromId)) {
      return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Только для администраторов', show_alert: true }, 5000);
    }
    const targetId = Number(bsMatch[1]);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id }, 5000);
    return tgApi('sendMessage', {
      chat_id: chatId,
      text: `🎯 Списание звёзд у юзера ${targetId}\nОтветь на это сообщение суммой (число).`,
      reply_markup: { force_reply: true, selective: true },
    }, 5000);
  }

  // === tr:USERID — клик по юзеру в /top: показать подтверждение Да/Нет ===
  const trMatch = data.match(/^tr:(\d+)$/);
  if (trMatch) {
    if (!CONFIG.ADMIN_IDS.includes(fromId)) {
      return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Только для администраторов', show_alert: true }, 5000);
    }
    const targetId = Number(trMatch[1]);
    let handle = `id${targetId}`;
    try {
      const { data: u } = await sb.from('users').select('username,first_name').eq('id', targetId).maybeSingle();
      if (u?.username) handle = `@${u.username}`;
      else if (u?.first_name) handle = u.first_name;
    } catch (_) {}
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id }, 5000);
    const editResult = await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: `❓ Точно убрать ${handle} (id ${targetId}) из топа?\n(total_deposited будет обнулён)`,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Да, убрать', callback_data: `tc:${targetId}:1` },
          { text: '❌ Отмена',     callback_data: `tc:${targetId}:0` },
        ]],
      },
    }, 5000);
    // Fallback: если редактирование не удалось — шлём отдельным сообщением.
    if (!editResult || editResult.ok === false) {
      return tgApi('sendMessage', {
        chat_id: chatId,
        text: `❓ Точно убрать ${handle} (id ${targetId}) из топа?`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Да, убрать', callback_data: `tc:${targetId}:1` },
            { text: '❌ Отмена',     callback_data: `tc:${targetId}:0` },
          ]],
        },
      }, 5000);
    }
    return editResult;
  }

  // === tc:USERID:0|1 — подтверждение убрать из топа ===
  const tcMatch = data.match(/^tc:(\d+):(0|1)$/);
  if (tcMatch) {
    if (!CONFIG.ADMIN_IDS.includes(fromId)) {
      return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Только для администраторов', show_alert: true }, 5000);
    }
    const targetId = Number(tcMatch[1]);
    const confirm  = tcMatch[2] === '1';
    if (!confirm) {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отменено' }, 5000);
      return tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text: '❌ Отменено.' }, 5000);
    }
    try {
      const { error } = await sb.from('users')
        .update({ total_deposited: 0, updated_at: new Date().toISOString() })
        .eq('id', targetId);
      if (error) throw new Error(error.message);
    } catch (err) {
      return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: `Ошибка: ${err?.message || err}`, show_alert: true }, 5000);
    }
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Убран из топа' }, 5000);
    const r2 = await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: `✅ Юзер ${targetId} убран из топа (total_deposited = 0).`,
    }, 5000);
    if (!r2 || r2.ok === false) {
      return tgApi('sendMessage', { chat_id: chatId, text: `✅ Юзер ${targetId} убран из топа.` }, 5000);
    }
    return r2;
  }

  const m = data.match(/^gd:(\d+):(\d+)$/);
  if (!m) {
    return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Неизвестная кнопка', show_alert: false }, 5000);
  }
  if (!CONFIG.ADMIN_IDS.includes(fromId)) {
    return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Только для администраторов', show_alert: true }, 5000);
  }

  const targetUserId = Number(m[1]);
  const giftDbId = Number(m[2]);
  let consumed = null;
  try {
    consumed = await consumeInventoryGift(targetUserId, giftDbId);
  } catch (err) {
    return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: `Ошибка: ${err?.message || err}`, show_alert: true }, 5000);
  }

  // Перерисуем список без удалённого подарка.
  let inv = [];
  try { inv = await getUserInventory(targetUserId); } catch (e) { inv = []; }

  await tgApi('answerCallbackQuery', {
    callback_query_id: cb.id,
    text: `Удалён: ${consumed?.name || 'подарок'} (${Number(consumed?.price || 0)}⭐)`,
    show_alert: false,
  }, 5000);

  if (!inv.length) {
    return tgApi('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: `📭 Инвентарь юзера \`${targetUserId}\` теперь пуст.`,
      parse_mode: 'Markdown',
    }, 5000);
  }

  const buttons = inv.slice(0, 80).map((g) => ([{
    text: `🗑 ${String(g.name || 'gift').slice(0, 40)} · ${Number(g.price || 0)}⭐`,
    callback_data: `gd:${targetUserId}:${Number(g.id)}`,
  }]));
  const total = inv.reduce((s, g) => s + Number(g.price || 0), 0);
  return tgApi('editMessageText', {
    chat_id: chatId,
    message_id: msgId,
    text: `🎁 Инвентарь юзера \`${targetUserId}\` — ${inv.length} шт. на ${total}⭐\n_Нажми на подарок чтобы удалить._`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  }, 5000);
}

async function getUserBalance(userId) {
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId)) return 0;

  const { data, error } = await sb
    .from('users')
    .select('balance')
    .eq('id', numericUserId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message || 'Balance read failed');

  if (data) {
    return Number(data.balance || 0);
  }

  const created = await sb
    .from('users')
    .upsert({
      id: numericUserId,
      first_name: 'User',
      balance: 0,
      total_deposited: 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })
    .select('balance')
    .limit(1)
    .maybeSingle();

  if (created.error) throw new Error(created.error.message || 'Balance create failed');
  return Number(created.data?.balance || 0);
}

async function spendBalance(userId, amount) {
  const rpc = await sb.rpc('spend_balance', { p_user_id: Number(userId), p_amount: Number(amount) });
  if (rpc.error) throw new Error(rpc.error.message || 'Balance spend failed');
  return Number(rpc.data || 0);
}

async function addWinBalance(userId, amount) {
  const rpc = await sb.rpc('add_win_balance', { p_user_id: Number(userId), p_amount: Number(amount) });
  if (rpc.error) throw new Error(rpc.error.message || 'Balance add failed');
  return Number(rpc.data || 0);
}

function secureRandomUnit() {
  // crypto.randomInt() requires (max - min) <= 2^48 - 1.
  // Reading 6 random bytes gives an unbiased integer in [0, 2^48),
  // which we normalize to a cryptographically secure unit interval [0, 1).
  return crypto.randomBytes(6).readUIntBE(0, 6) / 281474976710656;
}

function secureRandomIndex(length) {
  const n = Number(length || 0);
  return n > 1 ? crypto.randomInt(0, n) : 0;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}


function buildGiftImage(giftId) {
  const id = String(giftId || '').trim();
  return id ? `https://cdn.changes.tg/gifts/originals/${id}/Original.png` : '';
}

function findGiftInCatalog(gift) {
  if (!gift) return null;
  const explicitGiftId = String(gift.giftId || gift.gift_id || '').trim();
  const rawId = String(gift.id || '').trim();
  const name = String(gift.name || gift.gift_name || '').trim().toLowerCase();

  if (explicitGiftId) {
    const byGiftId = GIFT_CATALOG.find((entry) => String(entry.id || entry.giftId || '').trim() === explicitGiftId);
    if (byGiftId) return byGiftId;
  }

  if (rawId) {
    const byCatalogId = GIFT_CATALOG.find((entry) => String(entry.id || entry.giftId || '').trim() === rawId);
    if (byCatalogId) return byCatalogId;
  }

  if (name) {
    const byName = GIFT_CATALOG.find((entry) => String(entry.name || '').trim().toLowerCase() === name);
    if (byName) return byName;
  }
  return null;
}

function normalizeGift(gift) {
  if (!gift) return null;
  const explicitGiftId = String(gift.giftId || gift.gift_id || '').trim();
  const rawId = String(gift.id || '').trim();
  const catalogGift = findGiftInCatalog(gift);
  const catalogId = String(catalogGift?.id || '').trim();
  const normalizedGiftId = explicitGiftId || catalogId || rawId;
  return {
    id: normalizedGiftId,
    name: String(gift.name || gift.gift_name || catalogGift?.name || 'Gift'),
    price: Number(gift.price || gift.gift_price || catalogGift?.price || 0),
    image: String(
      gift.image
      || gift.gift_image
      || catalogGift?.image
      || (normalizedGiftId ? buildGiftImage(normalizedGiftId) : '')
    ),
  };
}

function getBestGiftForStars(stars) {
  const budget = Number(stars || 0);
  let result = null;
  for (const gift of GIFT_CATALOG) {
    const price = Number(gift?.price || 0);
    if (price <= budget && (!result || price > Number(result.price || 0))) {
      result = gift;
    }
  }
  return normalizeGift(result);
}

function isCatalogGiftValid(gift) {
  const giftId = String(gift?.id || gift?.giftId || '').trim();
  const name = String(gift?.name || '').trim();
  const price = Number(gift?.price || 0);
  const image = String(gift?.image || '').trim();

  return !!giftId && !!name && price > 0 && !!image && image.includes(giftId);
}

function pickCraftRewardGift(targetStars) {
  const target = Math.max(1, Math.floor(Number(targetStars || 0)));
  const sorted = [...GIFT_CATALOG]
    .filter(isCatalogGiftValid)
    .sort((a, b) => Number(a.price || 0) - Number(b.price || 0));

  if (!sorted.length) {
    throw new Error('Craft catalog is empty');
  }

  const affordable = sorted.filter((gift) => Number(gift.price || 0) <= target);
  const poolBase = affordable.length ? affordable : sorted.slice(0, Math.min(6, sorted.length));
  const tail = poolBase.slice(Math.max(0, poolBase.length - Math.min(8, poolBase.length)));
  const pool = tail.length ? tail : poolBase;

  let closest = pool[0];
  let bestDistance = Math.abs(Number(pool[0]?.price || 0) - target);
  for (const gift of pool) {
    const distance = Math.abs(Number(gift?.price || 0) - target);
    if (distance < bestDistance) {
      closest = gift;
      bestDistance = distance;
    }
  }

  const closePool = pool.filter((gift) => Math.abs(Number(gift?.price || 0) - Number(closest?.price || 0)) <= 40);
  const picked = closePool[secureRandomIndex(closePool.length)] || closest;
  const normalized = normalizeGift(picked);

  if (!normalized?.id || !normalized?.name || !normalized?.image || !normalized?.price) {
    throw new Error('Craft reward is invalid');
  }

  return normalized;
}

function pickCrashGiftForPayout(payout, selectedGift = null) {
  const numericPayout = Math.max(0, Math.floor(Number(payout || 0)));
  const normalizedSelected = normalizeGift(selectedGift);
  const selectedCatalog = findGiftInCatalog(selectedGift || normalizedSelected);
  const selectedBasePrice = Number(selectedCatalog?.price || normalizedSelected?.price || 0);
  const bestGift = getBestGiftForStars(numericPayout);
  const bestBasePrice = Number(bestGift?.price || 0);
  const selectedId = String(normalizedSelected?.giftId || normalizedSelected?.id || '');
  const bestId = String(bestGift?.giftId || bestGift?.id || '');

  if (bestGift && normalizedSelected && selectedBasePrice <= numericPayout) {
    if (bestId && bestId !== selectedId && bestBasePrice >= selectedBasePrice) {
      return normalizeGift({ ...bestGift, price: numericPayout });
    }
    return normalizeGift({ ...normalizedSelected, price: numericPayout });
  }

  if (bestGift) {
    return normalizeGift({ ...bestGift, price: numericPayout });
  }

  if (normalizedSelected && selectedBasePrice <= numericPayout) {
    return normalizeGift({ ...normalizedSelected, price: numericPayout });
  }

  // Crash cashout is gift-based. If the payout is below the current cheapest
  // catalog price, use the cheapest valid gift as the visual/inventory template
  // but keep its credited value equal to the actual payout. This prevents the
  // old null-gift path from crediting payout Stars directly to the balance.
  if (numericPayout > 0) {
    const cheapest = [...GIFT_CATALOG]
      .filter(isCatalogGiftValid)
      .sort((a, b) => Number(a.price || 0) - Number(b.price || 0))[0] || null;
    if (cheapest) return normalizeGift({ ...cheapest, price: numericPayout });
  }

  return null;
}

function buildCrashBetState(bet, { viewer = false, phase = 'countdown', liveMultiplier = 1 } = {}) {
  if (!bet) return null;
  const amount = Number(bet.amount || 0);
  const won = !!bet.cashedOut;
  const lost = !won && phase === 'ended';
  const displayAmount = won
    ? Number(bet.payout || 0)
    : (phase === 'live' ? Math.max(0, Math.floor(amount * liveMultiplier)) : amount);
  const basePreviewGift = won
    ? normalizeGift(bet.awardedGift) || getBestGiftForStars(displayAmount)
    : getBestGiftForStars(displayAmount);
  const previewGift = basePreviewGift ? normalizeGift({ ...basePreviewGift, price: displayAmount }) : null;
  return {
    userId: bet.userId,
    firstName: bet.firstName || 'User',
    photoUrl: bet.photoUrl || null,
    amount,
    betAmount: amount,
    roundId: bet.roundId,
    cashedOut: won,
    payout: Number(bet.payout || 0),
    currentPayout: displayAmount,
    displayAmount,
    previewGift,
    status: won ? 'won' : (lost ? 'lost' : (phase === 'countdown' ? 'pending' : 'active')),
    isViewer: viewer,
  };
}

async function getPendingPrize(userId) {
  if (!userId) return null;
  const { data, error } = await sb
    .from('user_pending_prizes')
    .select('gift_id,gift_name,gift_price,gift_image,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Pending prize read failed');
  if (!data) return null;
  return normalizeGift({ id: data.gift_id, name: data.gift_name, price: data.gift_price, image: data.gift_image });
}

async function clearPendingPrize(userId) {
  const { data, error } = await sb.rpc('pending_prize_take', { p_user_id: Number(userId) });
  if (error) throw new Error(error.message || 'Pending prize delete failed');
  if (!data) return null;
  return normalizeGift({ id: data.gift_id, name: data.gift_name, price: data.gift_price, image: data.gift_image });
}

async function getUserInventory(userId) {
  const { data, error } = await sb
    .from('user_gifts')
    .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,tg_msg_id,tg_slug,tg_is_unique,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message || 'Inventory read failed');
  return (data || []).map((row) => ({
    id: Number(row.id), giftId: String(row.gift_id || ''), name: String(row.gift_name || 'Gift'),
    price: Number(row.gift_price || 0), image: String(row.gift_image || ''),
    tgMsgId: row.tg_msg_id ? Number(row.tg_msg_id) : null, tgSlug: row.tg_slug || null,
    tgIsUnique: typeof row.tg_is_unique === 'boolean' ? row.tg_is_unique : null,
    withdrawAt: row.withdraw_available_at || null, createdAt: row.created_at || null,
  }));
}

async function ensureExactGiftBacking(userId, gift) {
  if (!gift) throw new Error('Gift not found');
  if (gift.tgIsUnique === false) throw new Error('Вывод доступен только для unique/NFT подарков');
  if (gift.tgMsgId || gift.tgSlug) return gift;

  let response;
  try {
    response = await fetch(`${CONFIG.RELAYER_URL}/resolve-exact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relayer-key': CONFIG.RELAYER_INTERNAL_KEY },
      body: JSON.stringify({ giftId: gift.giftId, giftName: gift.name, giftPrice: gift.price }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    console.warn(`⚠️ withdraw relayer unavailable during reserve: ${cause?.message || cause}`);
    const error = new Error('Сервис вывода временно недоступен. Попробуйте позже.');
    error.code = 'RELAYER_UNAVAILABLE';
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    if (response.status >= 500) {
      const error = new Error('Сервис вывода временно недоступен. Попробуйте позже.');
      error.code = 'RELAYER_UNAVAILABLE';
      throw error;
    }
    throw new Error(payload?.error || 'Не удалось найти NFT для вывода');
  }
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];

  for (const candidate of candidates) {
    const msgId = Number(candidate?.msgId || 0) || null;
    const slug = candidate?.slug ? String(candidate.slug).trim() : null;
    if (!msgId && !slug) continue;
    const update = {
      tg_msg_id: msgId,
      tg_slug: slug,
      tg_is_unique: true,
    };
    const { data, error } = await sb.from('user_gifts')
      .update(update)
      .eq('user_id', Number(userId))
      .eq('id', Number(gift.id))
      .is('tg_msg_id', null)
      .is('tg_slug', null)
      .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,tg_msg_id,tg_slug,tg_is_unique,created_at')
      .maybeSingle();
    if (data) {
      return {
        id: Number(data.id), giftId: String(data.gift_id || ''), name: String(data.gift_name || 'Gift'),
        price: Number(data.gift_price || 0), image: String(data.gift_image || ''),
        tgMsgId: data.tg_msg_id ? Number(data.tg_msg_id) : null, tgSlug: data.tg_slug || null,
        tgIsUnique: data.tg_is_unique === true, withdrawAt: data.withdraw_available_at || null,
        createdAt: data.created_at || null,
      };
    }
    if (error && !/duplicate key|unique/i.test(String(error.message || ''))) {
      throw new Error(error.message || 'Gift backing reservation failed');
    }

    // A concurrent request may have backed this same inventory row already.
    const { data: current } = await sb.from('user_gifts')
      .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,tg_msg_id,tg_slug,tg_is_unique,created_at')
      .eq('user_id', Number(userId)).eq('id', Number(gift.id)).maybeSingle();
    if (current?.tg_msg_id || current?.tg_slug) {
      return {
        id: Number(current.id), giftId: String(current.gift_id || ''), name: String(current.gift_name || 'Gift'),
        price: Number(current.gift_price || 0), image: String(current.gift_image || ''),
        tgMsgId: current.tg_msg_id ? Number(current.tg_msg_id) : null, tgSlug: current.tg_slug || null,
        tgIsUnique: current.tg_is_unique === true, withdrawAt: current.withdraw_available_at || null,
        createdAt: current.created_at || null,
      };
    }
  }
  throw new Error('Нет свободного физического NFT этой коллекции на аккаунте @GiftPepeRelayer');
}

async function addGiftToInventory(userId, gift, opts = {}) {
  const normalized = normalizeGift(gift);
  if (!normalized) throw new Error('Gift is required');
  const withdrawAt = INVENTORY_HOLD_MS > 0 ? new Date(Date.now() + INVENTORY_HOLD_MS).toISOString() : null;
  const insertPayload = {
    user_id: Number(userId), gift_id: normalized.id, gift_name: normalized.name,
    gift_price: normalized.price, gift_image: normalized.image, withdraw_available_at: withdrawAt,
    tg_msg_id: opts.tgMsgId != null ? Number(opts.tgMsgId) || null : null,
    tg_slug: opts.tgSlug ? String(opts.tgSlug) : null,
    tg_is_unique: typeof opts.tgIsUnique === 'boolean' ? opts.tgIsUnique : null,
  };
  const { data, error } = await sb.from('user_gifts').insert(insertPayload)
    .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,tg_msg_id,tg_slug,tg_is_unique,created_at').single();
  if (error) throw new Error(error.message || 'Gift save failed');
  return {
    id: Number(data.id), giftId: String(data.gift_id || ''), name: String(data.gift_name || 'Gift'),
    price: Number(data.gift_price || 0), image: String(data.gift_image || ''),
    tgMsgId: data.tg_msg_id ? Number(data.tg_msg_id) : null, tgSlug: data.tg_slug || null,
    tgIsUnique: typeof data.tg_is_unique === 'boolean' ? data.tg_is_unique : null,
    withdrawAt: data.withdraw_available_at || null, createdAt: data.created_at || null,
  };
}

async function consumeInventoryGift(userId, giftDbId) {
  const { data, error } = await sb.rpc('inventory_take_gift', {
    p_user_id: Number(userId), p_gift_id: Number(giftDbId),
  });
  if (error) throw new Error(error.message || 'Gift consume failed');
  return {
    id: Number(data.id), giftId: String(data.gift_id || ''), name: String(data.gift_name || 'Gift'),
    price: Number(data.gift_price || 0), image: String(data.gift_image || ''),
    withdrawAt: data.withdraw_available_at || null, createdAt: data.created_at || null,
  };
}

async function sellInventoryGift(userId, giftDbId) {
  const { data, error } = await sb.rpc('inventory_sell_gift', {
    p_user_id: Number(userId), p_gift_id: Number(giftDbId),
  });
  if (error) throw new Error(error.message || 'Sell failed');
  return { soldPrice: Number(data?.soldPrice || 0), newBalance: Number(data?.newBalance || 0) };
}

function normalizeWithdrawSnapshot(row) {
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    user_id: Number(row.user_id || 0),
    gift_id: String(row.gift_id || ''),
    gift_name: String(row.gift_name || 'Gift'),
    gift_price: Number(row.gift_price || 0),
    gift_image: String(row.gift_image || ''),
    withdraw_available_at: row.withdraw_available_at || null,
    tg_msg_id: row.tg_msg_id ? Number(row.tg_msg_id) : null,
    tg_slug: row.tg_slug || null,
    tg_is_unique: typeof row.tg_is_unique === 'boolean' ? row.tg_is_unique : null,
    created_at: row.created_at || null,
  };
}

async function relayerExactGiftExists(row) {
  const gift = normalizeWithdrawSnapshot(row);
  if (!gift?.tg_msg_id && !gift?.tg_slug) throw new Error('Exact Telegram gift reference is missing');
  const response = await fetch(`${CONFIG.RELAYER_URL}/exists-exact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relayer-key': CONFIG.RELAYER_INTERNAL_KEY },
    body: JSON.stringify({ msgId: gift.tg_msg_id, slug: gift.tg_slug }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || typeof data.exists !== 'boolean') {
    throw new Error(data?.error || 'Relayer reconciliation failed');
  }
  return data.exists;
}

async function sendExactGiftViaRelayer(row, targetUserId, targetUsername) {
  const gift = normalizeWithdrawSnapshot(row);
  if (!gift?.tg_msg_id && !gift?.tg_slug) throw new Error('Exact Telegram gift reference is missing');
  let response;
  try {
    response = await fetch(`${CONFIG.RELAYER_URL}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relayer-key': CONFIG.RELAYER_INTERNAL_KEY },
      body: JSON.stringify({
        userId: Number(targetUserId), username: targetUsername || null,
        msgId: gift.tg_msg_id, slug: gift.tg_slug,
        giftId: gift.gift_id, giftName: gift.gift_name, giftPrice: gift.gift_price,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (cause) {
    const error = new Error(`Relayer connection lost: ${cause?.message || cause}`);
    error.transferUncertain = true;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.error || 'Не удалось передать подарок (релеер)');
    error.transferDefinitiveFailure = true;
    throw error;
  }
  return data;
}

async function markWithdrawCompleted(intentId, userId) {
  const { error } = await sb.rpc('withdraw_mark_completed', {
    p_intent_id: String(intentId), p_user_id: Number(userId),
  });
  if (error) throw new Error(error.message || 'Withdraw completion failed');
}

async function restoreWithdrawGift(intentId, userId) {
  const { error } = await sb.rpc('withdraw_restore_transfer', {
    p_intent_id: String(intentId), p_user_id: Number(userId),
  });
  if (error) throw new Error(error.message || 'Withdraw restore failed');
}

async function withdrawInventoryGift(intent, targetUserId, targetUsername = null) {
  const userId = Number(intent?.user_id || 0);
  const intentId = String(intent?.id || '');
  if (!userId || !intentId) throw new Error('Bad withdraw intent');

  if (intent.status === 'completed') {
    const snapshot = normalizeWithdrawSnapshot(intent.gift_snapshot);
    return {
      duplicate: true,
      sentGift: snapshot ? normalizeGift({
        id: snapshot.gift_id, name: snapshot.gift_name, price: snapshot.gift_price, image: snapshot.gift_image,
      }) : null,
    };
  }

  let claimedRow = normalizeWithdrawSnapshot(intent.gift_snapshot);
  if (intent.status === 'transferring') {
    if (!claimedRow) throw new Error('Transfer snapshot missing');
    try {
      const exists = await relayerExactGiftExists(claimedRow);
      // Exact saved gift disappeared after we entered transferring: the previous transfer most likely
      // succeeded but its HTTP response was lost. Never restore a possibly already-sent NFT.
      if (!exists) {
        await markWithdrawCompleted(intentId, userId);
        return {
          reconciled: true,
          sentGift: normalizeGift({ id: claimedRow.gift_id, name: claimedRow.gift_name, price: claimedRow.gift_price, image: claimedRow.gift_image }),
        };
      }
    } catch (error) {
      const uncertain = new Error('Статус предыдущей отправки пока нельзя подтвердить. Повторите вывод позже — повторная комиссия не нужна.');
      uncertain.code = 'TRANSFER_STATUS_UNKNOWN';
      throw uncertain;
    }
  } else if (intent.status === 'paid') {
    const { data, error } = await sb.rpc('withdraw_claim_for_transfer', {
      p_intent_id: intentId, p_user_id: userId,
    });
    if (error) throw new Error(error.message || 'Gift claim failed');
    claimedRow = normalizeWithdrawSnapshot(data);
  } else {
    throw new Error('Withdraw intent is not paid');
  }

  if (!claimedRow) throw new Error('Gift transfer snapshot missing');

  try {
    await sendExactGiftViaRelayer(claimedRow, targetUserId, targetUsername);
    await markWithdrawCompleted(intentId, userId);
    return {
      sentGift: normalizeGift({ id: claimedRow.gift_id, name: claimedRow.gift_name, price: claimedRow.gift_price, image: claimedRow.gift_image }),
    };
  } catch (error) {
    if (error.transferDefinitiveFailure) {
      await restoreWithdrawGift(intentId, userId);
      throw error;
    }

    // Network timeout/disconnect is ambiguous: reconcile against the relayer's actual saved gifts.
    try {
      const stillExists = await relayerExactGiftExists(claimedRow);
      if (!stillExists) {
        await markWithdrawCompleted(intentId, userId);
        return {
          reconciled: true,
          sentGift: normalizeGift({ id: claimedRow.gift_id, name: claimedRow.gift_name, price: claimedRow.gift_price, image: claimedRow.gift_image }),
        };
      }
      await restoreWithdrawGift(intentId, userId);
      throw error;
    } catch (reconcileError) {
      if (reconcileError === error || !reconcileError?.message?.includes('reconciliation')) {
        if (reconcileError === error) throw error;
      }
      const uncertain = new Error('Статус отправки пока нельзя подтвердить. Повторите позже — повторная комиссия не нужна.');
      uncertain.code = 'TRANSFER_STATUS_UNKNOWN';
      throw uncertain;
    }
  }
}

async function sellAllInventoryGifts(userId) {
  const { data, error } = await sb.rpc('inventory_sell_all', { p_user_id: Number(userId) });
  if (error) throw new Error(error.message || 'Sell all failed');
  return {
    soldCount: Number(data?.soldCount || 0), soldTotal: Number(data?.soldTotal || 0),
    newBalance: Number(data?.newBalance || 0),
  };
}


function sampleCraftMultiplier() {
  const r = secureRandomUnit();
  if (r < 0.52) return Number((0.55 + secureRandomUnit() * 0.55).toFixed(3));
  if (r < 0.82) return Number((1.05 + secureRandomUnit() * 0.45).toFixed(3));
  if (r < 0.95) return Number((1.45 + secureRandomUnit() * 0.55).toFixed(3));
  return Number((2.0 + secureRandomUnit() * 0.7).toFixed(3));
}

const CRASH = { countdownMs: 10000, resetMs: 3000, growthMs: 8000, historyLimit: 12 };

function mapCrashBetRow(row) {
  if (!row) return null;
  return {
    userId: Number(row.user_id), firstName: row.first_name || 'User', photoUrl: row.photo_url || null,
    amount: Number(row.amount || 0), roundId: Number(row.round_id || 0),
    placedAt: row.placed_at ? new Date(row.placed_at).getTime() : 0,
    cashedOut: !!row.cashed_out, payout: Number(row.payout || 0),
    awardedGift: row.awarded_gift ? normalizeGift(row.awarded_gift) : null,
  };
}

async function getCrashInternalState() {
  const { data, error } = await sb.rpc('crash_sync_state');
  if (error) throw new Error(error.message || 'Crash state unavailable');
  const raw = typeof data === 'string' ? JSON.parse(data) : (data || {});
  return {
    roundId: Number(raw.roundId || 0), phase: String(raw.phase || 'countdown'),
    countdownEndsAt: Number(raw.countdownEndsAt || 0), liveStartAt: Number(raw.liveStartAt || 0),
    crashAt: Number(raw.crashAt || 0), crashMultiplier: Number(raw.crashMultiplier || 1),
    nextRoundAt: Number(raw.nextRoundAt || 0), growthMs: Number(raw.growthMs || CRASH.growthMs),
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

function currentCrashMultiplier(state, now = Date.now()) {
  if (!state) return 1;
  if (state.phase === 'ended') return round2(state.crashMultiplier || 1);
  if (state.phase !== 'live') return 1;
  const elapsed = Math.max(0, Number(now) - Number(state.liveStartAt || now));
  const mult = Math.exp(elapsed / Number(state.growthMs || CRASH.growthMs));
  return Math.min(Number(state.crashMultiplier || 1), mult);
}

async function getCrashBets(roundId) {
  const { data, error } = await sb.from('crash_bets')
    .select('round_id,user_id,first_name,photo_url,amount,placed_at,cashed_out,payout,cashed_out_at,awarded_gift')
    .eq('round_id', Number(roundId)).order('placed_at', { ascending: true });
  if (error) throw new Error(error.message || 'Crash bets unavailable');
  return (data || []).map(mapCrashBetRow).filter(Boolean);
}

async function serializeCrashState(userId = null) {
  const state = await getCrashInternalState();
  const [bets, pendingPrize] = await Promise.all([
    getCrashBets(state.roundId),
    userId ? getPendingPrize(userId) : Promise.resolve(null),
  ]);
  const liveMultiplier = currentCrashMultiplier(state);
  const activeBets = bets.map((bet) => buildCrashBetState(bet, {
    viewer: userId ? String(bet.userId) === String(userId) : false,
    phase: state.phase,
    liveMultiplier,
  }));
  const viewer = userId ? activeBets.find((b) => String(b.userId) === String(userId)) || null : null;

  // IMPORTANT: crashMultiplier/crashAt are intentionally never returned to the browser.
  return {
    serverNow: Date.now(), roundId: state.roundId, phase: state.phase,
    countdownEndsAt: state.countdownEndsAt, liveStartAt: state.liveStartAt,
    growthMs: state.growthMs, nextRoundAt: state.nextRoundAt,
    lastCrashMultiplier: state.phase === 'ended' ? round2(state.crashMultiplier) : round2(liveMultiplier),
    history: state.history.map((entry) => ({ roundId: Number(entry.roundId || 0), multiplier: Number(entry.multiplier || 1) })),
    betsCount: bets.length, activeBets, pendingPrize, viewerBet: viewer,
  };
}

app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, now: Date.now() });
});

app.post('/api/init', async (req, res) => {
  const context = requireUserContext(req, res);
  if (!context) return;
  const user = context.user;

  const { data, error } = await sb.rpc('init_user', {
    p_id: user.id,
    p_first_name: user.first_name || 'User',
    p_username: user.username || null,
    p_photo_url: user.photo_url || null,
  });

  if (error) {
    console.error('init_user error:', error);
    return res.status(500).json({ error: error.message });
  }

  const referrerId = extractReferralId(context.startParam);
  const currentUserId = Number(user.id);

  if (referrerId) {
    const isNew = await applyReferralIfNew(currentUserId, referrerId);
    if (isNew) {
      notifyReferrer(referrerId, user.id, 'join').catch(() => null);
    }
  }

  res.json(data?.[0] ?? {});
});

app.get('/api/balance', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.set('Cache-Control', 'no-store');

  const { data, error } = await sb
    .from('users')
    .select('balance,total_deposited')
    .eq('id', user.id)
    .single();

  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

app.get('/api/referral', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  try {
    const summary = await getReferralSummary(user.id);
    res.json({
      invitedCount: summary.invitedCount,
      earned: summary.earned,
      referrerLink: `ref_${user.id}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Referral stats failed' });
  }
});


app.get('/api/inventory', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  try {
    const [items, pendingPrize] = await Promise.all([
      getUserInventory(user.id),
      getPendingPrize(user.id),
    ]);
    res.json({ items, pendingPrize });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Inventory failed' });
  }
});

app.post('/api/inventory/sell', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const giftId = Number(req.body.giftId || 0);
  if (!giftId) return res.status(400).json({ error: 'Missing giftId' });

  try {
    const result = await sellInventoryGift(user.id, giftId);
    const items = await getUserInventory(user.id);
    res.json({ ok: true, ...result, items });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Sell failed' });
  }
});

// Шаг 1. Юзер жмёт «Вывести» → создаём Stars-инвойс на WITHDRAW_FEE_STARS звёзд.
// Сам вывод произойдёт только после оплаты этого инвойса (см. /webhook).
app.post('/api/inventory/withdraw-invoice', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const giftId = Number(req.body.giftId || 0);
  if (!giftId) return res.status(400).json({ error: 'Missing giftId' });

  const policy = await getWithdrawPolicy().catch(() => ({ mode: 'none', userIds: [] }));
  const policyCheck = checkWithdrawAllowed(policy, user.id);
  if (!policyCheck.allowed) return res.status(403).json({ error: policyCheck.message });
  if (!user.username) return res.status(400).json({ error: 'Сделайте @username чтобы получить подарок' });

  const { data: u, error: userError } = await sb.from('users').select('total_deposited').eq('id', user.id).maybeSingle();
  if (userError) return res.status(500).json({ error: 'Deposit check failed' });
  const deposited = Number(u?.total_deposited || 0);
  if (deposited < WITHDRAW_MIN_DEPOSIT_STARS) {
    const need = WITHDRAW_MIN_DEPOSIT_STARS - deposited;
    return res.status(403).json({ error: `Для вывода нужно пополнение от ${WITHDRAW_MIN_DEPOSIT_STARS}⭐ (не хватает ${need}⭐).` });
  }

  // Если комиссия уже оплачена или перевод находится в reconciliation, новый invoice не создаём.
  const { data: existingIntent, error: existingIntentError } = await sb.from('withdraw_intents')
    .select('id,status,fee_stars')
    .eq('user_id', Number(user.id)).eq('gift_db_id', giftId)
    .in('status', ['paid', 'transferring'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existingIntentError) return res.status(500).json({ error: 'Withdraw intent lookup failed' });
  if (existingIntent) {
    res.set('Cache-Control', 'no-store');
    return res.json({
      alreadyPaid: true, intentId: existingIntent.id, status: existingIntent.status,
      fee: Number(existingIntent.fee_stars || WITHDRAW_FEE_STARS),
    });
  }

  const inv = await getUserInventory(user.id);
  let owned = inv.find((g) => Number(g?.id) === giftId);
  if (!owned) return res.status(404).json({ error: 'Gift not found in inventory' });
  if (owned.withdrawAt) {
    const unlockAt = new Date(owned.withdrawAt).getTime();
    if (Number.isFinite(unlockAt) && Date.now() < unlockAt) {
      return res.status(409).json({
        error: `До вывода подарка осталось ${Math.ceil((unlockAt - Date.now()) / 1000)}с`,
        code: 'LOCAL_HOLD', unlockAt: owned.withdrawAt,
      });
    }
  }
  try {
    owned = await ensureExactGiftBacking(user.id, owned);
  } catch (error) {
    if (error?.code === 'RELAYER_UNAVAILABLE') {
      return res.status(503).json({
        error: 'Сервис вывода временно недоступен. Попробуйте позже.',
        code: 'RELAYER_UNAVAILABLE',
      });
    }
    return res.status(409).json({ error: error.message || 'Не удалось зарезервировать NFT для вывода' });
  }

  const intentId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + WITHDRAW_INTENT_TTL_MS).toISOString();
  const { error: intentError } = await sb.from('withdraw_intents').insert({
    id: intentId, user_id: Number(user.id), gift_db_id: giftId,
    fee_stars: WITHDRAW_FEE_STARS, status: 'created', expires_at: expiresAt,
  });
  if (intentError) return res.status(500).json({ error: intentError.message || 'Withdraw intent create failed' });

  const result = await tgApi('createInvoiceLink', {
    title: 'Комиссия за вывод подарка',
    description: `Комиссия ${WITHDRAW_FEE_STARS}⭐ за отправку «${owned.name || 'подарка'}» в Telegram`,
    payload: JSON.stringify({ type: 'withdraw', userId: Number(user.id), intentId }),
    currency: 'XTR',
    prices: [{ label: `${WITHDRAW_FEE_STARS} звёзд`, amount: WITHDRAW_FEE_STARS }],
  });
  if (!result.ok) {
    await sb.from('withdraw_intents').delete().eq('id', intentId).catch(() => null);
    return res.status(500).json({ error: result.description || 'Invoice failed' });
  }

  res.set('Cache-Control', 'no-store');
  res.json({ invoiceLink: result.result, intentId, fee: WITHDRAW_FEE_STARS, expiresAt });
});

app.post('/api/inventory/withdraw', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const giftId = Number(req.body.giftId || 0);
  const intentId = String(req.body.intentId || '').trim();
  if (!giftId) return res.status(400).json({ error: 'Missing giftId' });
  if (!intentId) return res.status(400).json({ error: 'Missing intentId' });

  const { data: intent, error: intentError } = await sb.from('withdraw_intents')
    .select('id,user_id,gift_db_id,fee_stars,status,telegram_charge_id,expires_at,gift_snapshot,completed_at')
    .eq('id', intentId).eq('user_id', Number(user.id)).maybeSingle();
  if (intentError || !intent || Number(intent.gift_db_id) !== giftId) {
    return res.status(403).json({ error: 'Invoice not found, retry withdraw' });
  }
  if (!['paid', 'transferring', 'completed'].includes(String(intent.status))) {
    return res.status(402).json({ error: 'Сначала оплатите комиссию' });
  }

  try {
    const result = await withdrawInventoryGift(intent, user.id, user.username || null);
    const items = await getUserInventory(user.id);
    return res.json({ ok: true, ...result, items, message: 'Подарок отправлен в Telegram' });
  } catch (error) {
    const rawMsg = String(error?.message || 'Withdraw failed');
    if (error?.code === 'TRANSFER_STATUS_UNKNOWN') {
      return res.status(503).json({
        error: rawMsg, code: 'TRANSFER_STATUS_UNKNOWN', retryWithoutPayment: true,
      });
    }

    const tooEarly = rawMsg.match(/STARGIFT_TRANSFER_TOO_EARLY_(\d+)/i);
    if (tooEarly) {
      const secs = Number(tooEarly[1] || 0);
      let refunded = false;
      if (intent.telegram_charge_id) {
        const r = await tgApi('refundStarPayment', {
          user_id: Number(user.id), telegram_payment_charge_id: intent.telegram_charge_id,
        }).catch(() => null);
        refunded = !!r?.ok;
      }
      if (refunded) {
        await sb.from('withdraw_intents')
          .update({ status: 'refunded', refunded_at: new Date().toISOString() })
          .eq('id', intentId).eq('status', 'paid');
      }
      return res.status(400).json({
        error: refunded
          ? `Подарок ещё нельзя передавать. Комиссия ${WITHDRAW_FEE_STARS}⭐ возвращена.`
          : 'Подарок ещё нельзя передавать. Попробуйте позже.',
        code: 'TOO_EARLY', unlockSeconds: secs, refunded,
      });
    }
    return res.status(400).json({ error: rawMsg });
  }
});

app.post('/api/inventory/sell-all', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  try {
    const result = await sellAllInventoryGifts(user.id);
    res.json({ ok: true, ...result, items: [] });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Sell all failed' });
  }
});

// Промокоды существуют только в БД. Публичные hardcoded-коды удалены из исходников.
app.post('/api/promo/redeem', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const code = String(req.body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите промокод' });

  try {
    const db = await applyDbPromo(user.id, code);
    if (!db) return res.status(400).json({ error: 'Промокод не найден' });
    if (!db.ok) return res.status(400).json({ error: db.message || 'Промокод недоступен' });

    const [balanceData, referral] = await Promise.all([
      getUserBalance(user.id),
      getReferralSummary(user.id).catch(() => null),
    ]);
    return res.json({
      ok: true, reward: Number(db.reward || 0), gift: db.gift || null,
      message: db.message || 'Промокод активирован', balance: Number(balanceData || 0), referral,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Promo redeem failed' });
  }
});

app.post('/api/crash/prize/resolve', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const action = String(req.body.action || '').trim();
  if (!['sell', 'claim'].includes(action)) return res.status(400).json({ error: 'Bad action' });
  try {
    const { data, error } = await sb.rpc('pending_prize_resolve', {
      p_user_id: Number(user.id), p_action: action,
    });
    if (error) throw new Error(error.message || 'Prize resolve failed');
    const claimedDb = data?.claimedGift || null;
    const claimedGift = claimedDb ? {
      id: Number(claimedDb.id), giftId: String(claimedDb.gift_id || ''), name: String(claimedDb.gift_name || 'Gift'),
      price: Number(claimedDb.gift_price || 0), image: String(claimedDb.gift_image || ''),
      withdrawAt: claimedDb.withdraw_available_at || null, createdAt: claimedDb.created_at || null,
    } : null;
    const [items, state] = await Promise.all([getUserInventory(user.id), serializeCrashState(user.id)]);
    return res.json({
      ok: true, action, newBalance: Number(data?.newBalance || 0), claimedGift,
      items, state,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Prize resolve failed' });
  }
});

app.get('/api/payment-status', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.set('Cache-Control', 'no-store');
  const invoiceId = String(req.query.invoiceId || '').trim();
  if (!invoiceId) return res.status(400).json({ error: 'Missing invoiceId' });

  const { data: receipt, error } = await sb.from('payment_receipts')
    .select('invoice_id,user_id,amount,created_at')
    .eq('invoice_id', invoiceId).eq('kind', 'deposit').maybeSingle();
  if (error) return res.status(500).json({ error: 'Receipt lookup failed' });
  if (!receipt || String(receipt.user_id) !== String(user.id)) return res.json({ applied: false });

  const [balance, referral] = await Promise.all([
    getUserBalance(user.id).catch(() => null), getReferralSummary(user.id).catch(() => null),
  ]);
  return res.json({
    applied: true, amount: Number(receipt.amount || 0),
    appliedAt: new Date(receipt.created_at).getTime(), balance, referral,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Авто-синхронизация цен подарков с Telegram NFT-маркета.
// Раз в сутки бэкэнд просит у релеера минимальную цену по каждому gift_id,
// мутирует GIFT_CATALOG[i].price и кеширует на диск.
// Фронт подтягивает overlay через GET /api/market-prices при загрузке.
// ──────────────────────────────────────────────────────────────────────────────
function loadMarketPricesFromDisk() {
  try {
    if (!fs.existsSync(MARKET_PRICES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(MARKET_PRICES_FILE, 'utf8') || '{}');
    const map = raw && typeof raw === 'object' ? (raw.prices || raw) : {};
    for (const [k, v] of Object.entries(map)) {
      const stars = Number(v);
      if (!Number.isFinite(stars) || stars <= 0) continue;
      marketPrices.set(String(k), stars);
    }
    applyMarketPricesToCatalog();
    console.log(`📈 loaded ${marketPrices.size} market prices from disk`);
  } catch (e) {
    console.warn('market prices load failed:', e?.message || e);
  }
}

function saveMarketPricesToDisk() {
  try {
    fs.mkdirSync(path.dirname(MARKET_PRICES_FILE), { recursive: true });
    const obj = {};
    for (const [k, v] of marketPrices) obj[k] = v;
    fs.writeFileSync(MARKET_PRICES_FILE, JSON.stringify({
      updatedAt: new Date().toISOString(),
      prices: obj,
    }, null, 2));
  } catch (e) {
    console.warn('market prices save failed:', e?.message || e);
  }
}

function applyMarketPricesToCatalog() {
  let changed = 0;
  for (const entry of GIFT_CATALOG) {
    const id = String(entry.id || entry.giftId || '');
    if (!id) continue;
    const mp = marketPrices.get(id);
    if (Number.isFinite(mp) && mp > 0 && Number(entry.price) !== mp) {
      entry.price = mp;
      changed++;
    }
  }
  if (changed) console.log(`📈 applied ${changed} market prices to catalog`);
}

async function syncMarketPricesOnce() {
  const giftIds = GIFT_CATALOG.map((g) => String(g.id || g.giftId || '')).filter(Boolean);
  if (!giftIds.length) return { ok: true, updated: 0 };
  try {
    const r = await fetch(`${CONFIG.RELAYER_URL}/market-min-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relayer-key': CONFIG.RELAYER_INTERNAL_KEY },
      body: JSON.stringify({ giftIds }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) {
      console.warn('market sync failed:', data?.error || r.status);
      return { ok: false, error: data?.error || `HTTP ${r.status}` };
    }
    const prices = data.prices || {};
    let updated = 0;
    for (const [id, stars] of Object.entries(prices)) {
      const n = Number(stars);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (marketPrices.get(String(id)) !== n) updated++;
      marketPrices.set(String(id), n);
    }
    applyMarketPricesToCatalog();
    saveMarketPricesToDisk();
    console.log(`📈 market sync: ${updated} prices updated, ${marketPrices.size} total`);
    return { ok: true, updated, total: marketPrices.size };
  } catch (e) {
    console.warn('market sync error:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Публичный overlay для фронта (frontend подмешает в свой GIFT_CATALOG).
app.get('/api/market-prices', (req, res) => {
  const obj = {};
  for (const [k, v] of marketPrices) obj[k] = v;
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ ok: true, prices: obj, updatedAt: new Date().toISOString() });
});

// Ручной триггер синка (для админа/cron-задач извне).
app.post('/api/admin/sync-market-prices', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-admin-key'], CONFIG.ADMIN_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const out = await syncMarketPricesOnce();
  res.json(out);
});

function normalizeTonAddress(value) {
  try { return Address.parse(String(value || '').trim()).toRawString(); }
  catch { return null; }
}

function parseTonToNano(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  const nano = BigInt(whole) * 1000000000n + BigInt((frac + '000000000').slice(0, 9));
  return nano > 0n ? nano : null;
}

function buildTonIntentPayload(intentId) {
  return beginCell()
    .storeUint(0, 32)
    .storeStringTail(`GiftPep:${String(intentId)}`)
    .endCell()
    .toBoc()
    .toString('base64');
}

function readTonMessageComment(message) {
  const decoded = String(message?.message || '').trim();
  if (decoded) return decoded;
  const body = String(message?.msg_data?.body || '').trim();
  if (!body) return '';
  try {
    const cells = Cell.fromBoc(Buffer.from(body, 'base64'));
    if (!cells.length) return '';
    const slice = cells[0].beginParse();
    if (slice.remainingBits < 32 || slice.loadUint(32) !== 0) return '';
    return slice.loadStringTail();
  } catch {
    return '';
  }
}

async function findTonPaymentOnChain(intent) {
  const expectedSource = normalizeTonAddress(intent.wallet_address);
  const expectedDestination = normalizeTonAddress(intent.destination_address);
  if (!expectedSource || !expectedDestination) throw new Error('Bad TON address in intent');
  const expectedValue = BigInt(String(intent.amount_nano));
  const expectedComment = `GiftPep:${String(intent.id)}`;
  const createdMs = new Date(intent.created_at).getTime();
  const expiresMs = new Date(intent.expires_at).getTime();

  let lt = '';
  let hash = '';
  for (let page = 0; page < 3; page++) {
    const qs = new URLSearchParams({
      address: intent.destination_address,
      limit: '100',
      archival: 'false',
    });
    if (lt && hash) { qs.set('lt', lt); qs.set('hash', hash); }
    const headers = CONFIG.TONCENTER_API_KEY ? { 'X-API-Key': CONFIG.TONCENTER_API_KEY } : {};
    const response = await fetch(`${CONFIG.TONCENTER_API_BASE}/getTransactions?${qs}`, { headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok || !Array.isArray(body.result)) {
      throw new Error(body?.error || `TON Center HTTP ${response.status}`);
    }

    let reachedOlder = false;
    for (const tx of body.result) {
      const msg = tx?.in_msg;
      if (!msg) continue;
      const txMs = Number(tx?.utime || 0) * 1000;
      if (txMs && txMs < createdMs - 120000) reachedOlder = true;
      if (!txMs || txMs < createdMs - 120000 || txMs > expiresMs + 120000) continue;
      const source = normalizeTonAddress(msg.source);
      const destination = normalizeTonAddress(msg.destination);
      let value;
      try { value = BigInt(String(msg.value || '0')); } catch { continue; }
      if (source !== expectedSource || destination !== expectedDestination || value !== expectedValue) continue;
      if (readTonMessageComment(msg) !== expectedComment) continue;
      const txHash = String(tx?.transaction_id?.hash || msg?.hash || '').trim();
      if (!txHash) continue;
      return { txHash, utime: Number(tx.utime || 0), source, destination, value: value.toString() };
    }
    if (reachedOlder || body.result.length < 100) break;
    const last = body.result[body.result.length - 1];
    lt = String(last?.transaction_id?.lt || '');
    hash = String(last?.transaction_id?.hash || '');
    if (!lt || !hash) break;
    if (!CONFIG.TONCENTER_API_KEY) await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  return null;
}

app.post('/api/invoice', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const amount = parseInt(req.body.amount, 10);
  if (!amount || amount < 1 || amount > 100000) {
    return res.status(400).json({ error: 'Bad amount' });
  }

  const invoiceId = crypto.randomUUID();

  const result = await tgApi('createInvoiceLink', {
    title: 'Пополнение баланса',
    description: `Пополнить на ${amount} ⭐`,
    payload: JSON.stringify({ userId: user.id, amount, invoiceId }),
    currency: 'XTR',
    prices: [{ label: `${amount} звёзд`, amount }],
  });

  if (!result.ok) {
    console.error('invoice error:', result);
    return res.status(500).json({ error: result.description });
  }

  res.set('Cache-Control', 'no-store');
  res.json({ invoiceLink: result.result, invoiceId });
});


app.post('/api/ton/topup/intent', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const walletAddress = String(req.body?.walletAddress || '').trim();
  const walletRaw = normalizeTonAddress(walletAddress);
  const baseNano = parseTonToNano(req.body?.amountTon);
  if (!walletRaw || !baseNano) return res.status(400).json({ error: 'Bad TON payment data' });

  const starsAmount = Number((baseNano * 90n) / 1000000000n);
  if (!Number.isSafeInteger(starsAmount) || starsAmount < 1 || starsAmount > 100000) {
    return res.status(400).json({ error: 'Bad TON amount' });
  }

  const intentId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CONFIG.TON_INTENT_TTL_MS).toISOString();
  const { error } = await sb.from('ton_deposit_intents').insert({
    id: intentId, user_id: Number(user.id), wallet_address: walletAddress,
    destination_address: CONFIG.TON_DESTINATION_WALLET, amount_nano: baseNano.toString(),
    stars_amount: starsAmount, status: 'created', expires_at: expiresAt,
  });
  if (error) {
    console.error('TON intent create failed:', {
      code: error.code || null,
      message: error.message || String(error),
      details: error.details || null,
      hint: error.hint || null,
    });
    return res.status(500).json({ error: error.message || 'TON intent create failed' });
  }
  return res.json({
    ok: true, intentId, destination: CONFIG.TON_DESTINATION_WALLET,
    amountNano: baseNano.toString(), payload: buildTonIntentPayload(intentId), starsAmount, expiresAt,
  });
});

app.post('/api/ton/topup/credit', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const intentId = String(req.body?.intentId || '').trim();
  if (!intentId) return res.status(400).json({ error: 'Missing TON intentId' });

  try {
    const { data: intent, error } = await sb.from('ton_deposit_intents')
      .select('id,user_id,wallet_address,destination_address,amount_nano,stars_amount,status,tx_hash,created_at,expires_at,credited_at')
      .eq('id', intentId).eq('user_id', Number(user.id)).maybeSingle();
    if (error || !intent) return res.status(404).json({ error: 'TON intent not found' });
    if (intent.status === 'credited') {
      return res.json({
        ok: true, duplicate: true, amount: Number(intent.stars_amount || 0),
        balance: await getUserBalance(user.id), referral: await getReferralSummary(user.id).catch(() => null),
      });
    }

    const match = await findTonPaymentOnChain(intent);
    if (!match) {
      if (Date.now() > new Date(intent.expires_at).getTime() + 120000) {
        await sb.from('ton_deposit_intents').update({ status: 'expired' }).eq('id', intentId).eq('status', 'created');
        return res.status(410).json({ error: 'TON payment intent expired' });
      }
      return res.status(409).json({ error: 'TON transaction is not confirmed yet', pending: true });
    }

    const { data: applied, error: applyError } = await sb.rpc('apply_ton_deposit', {
      p_intent_id: intentId, p_tx_hash: match.txHash,
    });
    if (applyError) throw new Error(applyError.message || 'TON credit failed');
    if (applied?.applied) {
      const creditedAmount = Number(applied?.amount || intent.stars_amount || 0);
      logDeposit(user.id, creditedAmount, 'ton').catch(() => null);
      logReferralDeposit(applied?.referrerId, user.id, creditedAmount, applied?.referralReward, 'ton').catch(() => null);
    }
    return res.json({
      ok: true, txHash: match.txHash, amount: Number(applied?.amount || intent.stars_amount || 0),
      balance: Number(applied?.balance || 0), referral: await getReferralSummary(user.id).catch(() => null),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'TON topup failed' });
  }
});

app.get('/api/top', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { data: leaders, error } = await sb
    .from('users')
    .select('id,first_name,photo_url,total_deposited')
    .gt('total_deposited', 0)
    .order('total_deposited', { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ error: error.message });

  let myRank = null;
  const userId = parseInt(req.query.userId, 10);
  if (Number.isFinite(userId)) {
    const { data: me, error: meError } = await sb
      .from('users')
      .select('total_deposited')
      .eq('id', userId)
      .single();

    if (!meError && Number(me?.total_deposited || 0) > 0) {
      const { count } = await sb
        .from('users')
        .select('id', { count: 'exact', head: true })
        .gt('total_deposited', Number(me.total_deposited || 0));
      myRank = Number(count || 0) + 1;
    }
  }

  res.json({ leaders: leaders ?? [], myRank });
});


app.post('/api/upgrade/spin', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const sourceGiftId = Number(req.body?.sourceGiftId || 0);
  const targetGiftId = String(req.body?.targetGiftId || '').trim();
  const targetGift = normalizeGift(findGiftInCatalog({ id: targetGiftId }));
  if (!sourceGiftId) return res.status(400).json({ error: 'Source gift is required' });
  if (!targetGift) return res.status(400).json({ error: 'Target gift is required' });

  try {
    const inventory = await getUserInventory(user.id);
    const sourceGift = inventory.find((item) => Number(item.id) === sourceGiftId);
    if (!sourceGift) return res.status(400).json({ error: 'Source gift not found' });
    if (Number(targetGift.price || 0) <= Number(sourceGift.price || 0)) {
      return res.status(400).json({ error: 'Target gift must be more expensive' });
    }

    // TEST MATH MODE ONLY.
    // Visible chance = raw mathematical price ratio, e.g. 349/350 => 99.7%.
    // Actual test chance = visible chance - 15 percentage points, rounded, capped at 85%.
    // Do not use this mismatch in production without clearly disclosing the actual probability.
    const sourcePrice = Number(sourceGift.price || 0);
    const targetPrice = Number(targetGift.price || 1);
    const chance = Math.max(0.1, Math.min(99.9, Math.round(((sourcePrice / targetPrice) * 100) * 10) / 10));
    const actualChance = Math.max(1, Math.min(85, Math.round(chance - 15)));
    const safeBlueDeg = Math.max(0.36, Math.min(359.64, (chance / 100) * 360));
    const isWin = secureRandomUnit() * 100 < actualChance;
    const lossDeg = 360 - safeBlueDeg;
    const winMargin = Math.min(8, Math.max(0.05, safeBlueDeg / 4));
    const lossMargin = Math.min(8, Math.max(0.05, lossDeg / 4));
    const landingAngle = isWin
      ? winMargin + secureRandomUnit() * Math.max(0.001, safeBlueDeg - winMargin * 2)
      : safeBlueDeg + lossMargin + secureRandomUnit() * Math.max(0.001, lossDeg - lossMargin * 2);
    console.log(`🧪 UPGRADE TEST user=${user.id} ${sourcePrice}→${targetPrice} display=${chance}% actual=${actualChance}% result=${isWin ? 'WIN' : 'LOSE'}`);

    const { data, error } = await sb.rpc('inventory_upgrade_apply', {
      p_user_id: Number(user.id), p_source_gift_id: sourceGiftId, p_is_win: isWin,
      p_target: { id: targetGift.id, name: targetGift.name, price: targetGift.price, image: targetGift.image },
    });
    if (error) throw new Error(error.message || 'Upgrade transaction failed');

    const wonDb = data?.wonGift || null;
    const wonGift = wonDb ? {
      id: Number(wonDb.id), giftId: String(wonDb.gift_id || ''), name: String(wonDb.gift_name || 'Gift'),
      price: Number(wonDb.gift_price || 0), image: String(wonDb.gift_image || ''),
      withdrawAt: wonDb.withdraw_available_at || null, createdAt: wonDb.created_at || null,
    } : null;
    const items = await getUserInventory(user.id);
    return res.json({
      ok: true, chance, actualChance, blueDeg: Number(safeBlueDeg.toFixed(3)), landingAngle: Number(landingAngle.toFixed(3)),
      isWin, sourceGift, targetGift, wonGift, items, serverNow: Date.now(),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Upgrade failed' });
  }
});

app.post('/api/craft/spin', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const giftIds = Array.isArray(req.body?.giftIds) ? req.body.giftIds.map((id) => Number(id || 0)).filter(Boolean) : [];
  const uniqueIds = [...new Set(giftIds)].slice(0, 10);
  if (uniqueIds.length < 3) return res.status(400).json({ error: 'Choose at least 3 gifts' });

  try {
    const inventory = await getUserInventory(user.id);
    const selected = uniqueIds.map((id) => inventory.find((item) => Number(item.id) === id)).filter(Boolean);
    if (selected.length !== uniqueIds.length) return res.status(400).json({ error: 'Some gifts were not found' });

    const totalPrice = selected.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const multiplier = sampleCraftMultiplier();
    const targetRewardPrice = Math.max(1, Math.floor(totalPrice * multiplier));
    const craftedGift = normalizeGift(pickCraftRewardGift(targetRewardPrice));
    if (!craftedGift?.id || !craftedGift?.name || !craftedGift?.image || !craftedGift?.price) throw new Error('Craft reward is invalid');

    const { data, error } = await sb.rpc('inventory_craft_apply', {
      p_user_id: Number(user.id), p_gift_ids: uniqueIds,
      p_reward: { id: craftedGift.id, name: craftedGift.name, price: craftedGift.price, image: craftedGift.image },
    });
    if (error) throw new Error(error.message || 'Craft transaction failed');

    const wonDb = data?.wonGift || {};
    const savedGift = {
      id: Number(wonDb.id), giftId: String(wonDb.gift_id || ''), name: String(wonDb.gift_name || 'Gift'),
      price: Number(wonDb.gift_price || 0), image: String(wonDb.gift_image || ''),
      withdrawAt: wonDb.withdraw_available_at || null, createdAt: wonDb.created_at || null,
    };
    const items = await getUserInventory(user.id);
    return res.json({
      ok: true, consumed: selected, totalPrice, multiplier, rewardPrice: Number(savedGift.price || 0),
      wonGift: savedGift, items, serverNow: Date.now(),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Craft failed' });
  }
});

app.get('/api/crash/state', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    res.json(await serializeCrashState(user.id));
  } catch (error) {
    console.error('crash state error:', {
      message: error?.message || String(error),
      code: error?.code || null,
      details: error?.details || null,
      hint: error?.hint || null,
    });
    res.status(503).json({ error: error.message || 'Crash unavailable' });
  }
});

app.post('/api/crash/bet', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const amount = parseInt(req.body.amount, 10);
  if (!amount || amount < CRASH_MIN_BET) {
    return res.status(400).json({ error: `Минимальная ставка ${CRASH_MIN_BET}⭐` });
  }
  try {
    const { data, error } = await sb.rpc('crash_place_bet', {
      p_user_id: Number(user.id),
      p_first_name: user.first_name || user.username || 'User',
      p_photo_url: user.photo_url || null,
      p_amount: amount,
    });
    if (error) throw new Error(error.message || 'Bet failed');
    return res.json({ ok: true, newBalance: Number(data?.newBalance || 0), state: await serializeCrashState(user.id) });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Bet failed' });
  }
});

app.post('/api/crash/cashout', async (req, res) => {
  const requestReceivedAtMs = Date.now();
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const state = await getCrashInternalState();
    const roundId = Number(req.body?.roundId || 0);
    if (!roundId || roundId !== state.roundId || !state.liveStartAt || !state.crashAt
        || requestReceivedAtMs < state.liveStartAt || requestReceivedAtMs >= state.crashAt) {
      return res.status(400).json({ error: 'Round is not live' });
    }

    const { data: betRow, error: betError } = await sb.from('crash_bets')
      .select('round_id,user_id,amount,cashed_out')
      .eq('round_id', roundId).eq('user_id', Number(user.id)).maybeSingle();
    if (betError) throw new Error(betError.message);
    if (!betRow) return res.status(400).json({ error: 'No active bet' });
    if (betRow.cashed_out) return res.status(400).json({ error: 'Already cashed out' });

    // Freeze the authoritative payout at the moment the HTTP cashout request reached our server.
    // Database/network latency after this point must not keep increasing the player's payout.
    const estimatePayout = Math.max(0, Math.floor(Number(betRow.amount || 0) * currentCrashMultiplier(state, requestReceivedAtMs)));
    const awardedGift = pickCrashGiftForPayout(estimatePayout, null);
    if (!awardedGift) {
      throw new Error('Crash gift catalog is unavailable');
    }
    const { data, error } = await sb.rpc('crash_settle_bet_at', {
      p_user_id: Number(user.id),
      p_round_id: roundId,
      p_cashout_at: new Date(requestReceivedAtMs).toISOString(),
      p_awarded_gift: awardedGift ? { id: awardedGift.id, name: awardedGift.name, image: awardedGift.image, price: awardedGift.price } : null,
    });
    if (error) throw new Error(error.message || 'Cash out failed');

    const pendingPrize = await getPendingPrize(user.id);
    console.log(`🎁 CRASH CASHOUT user=${user.id} round=${roundId} payout=${Number(data?.payout || 0)} gift=${pendingPrize?.name || awardedGift.name} balance_unchanged=${Number(data?.newBalance || 0)}`);
    return res.json({
      ok: true,
      payout: Number(data?.payout || 0),
      newBalance: Number(data?.newBalance || 0),
      pendingPrize,
      awardedGift: pendingPrize,
      state: await serializeCrashState(user.id),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Cash out failed' });
  }
});

app.post('/webhook', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-telegram-bot-api-secret-token'], CONFIG.TELEGRAM_WEBHOOK_SECRET)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const u = req.body || {};
  try {
    if (u.pre_checkout_query) {
      const result = await answerPreCheckout(u);
      if (!result?.ok) console.error('pre_checkout answer error:', result);
      return res.sendStatus(200);
    }

    if (u.message?.successful_payment) {
      const p = u.message.successful_payment;
      const senderId = Number(u.message?.from?.id || 0);
      const currency = String(p.currency || '');
      const totalAmount = Number(p.total_amount || 0);
      const chargeId = String(p.telegram_payment_charge_id || '').trim();
      const providerChargeId = String(p.provider_payment_charge_id || '').trim() || null;
      if (!senderId || currency !== 'XTR' || !Number.isInteger(totalAmount) || totalAmount <= 0 || !chargeId) {
        throw new Error('Invalid successful_payment fields');
      }
      const payload = JSON.parse(String(p.invoice_payload || '{}'));

      if (payload?.type === 'withdraw') {
        if (Number(payload.userId) !== senderId) throw new Error('withdraw userId mismatch');
        const { data, error } = await sb.rpc('apply_withdraw_fee_payment', {
          p_charge_id: chargeId,
          p_provider_charge_id: providerChargeId,
          p_intent_id: String(payload.intentId || ''),
          p_user_id: senderId,
          p_amount: totalAmount,
          p_currency: currency,
          p_payload: payload,
        });
        if (error) throw new Error(error.message || 'Withdraw payment apply failed');
        console.log(`💸 withdraw fee payment ${data?.applied ? 'applied' : 'duplicate'}: user ${senderId}`);
        return res.sendStatus(200);
      }

      const amount = Number(payload?.amount || 0);
      const invoiceId = String(payload?.invoiceId || '').trim();
      if (Number(payload?.userId) !== senderId || amount !== totalAmount || !invoiceId) {
        throw new Error('Deposit payment mismatch');
      }
      const { data, error } = await sb.rpc('apply_telegram_star_payment', {
        p_charge_id: chargeId,
        p_provider_charge_id: providerChargeId,
        p_invoice_id: invoiceId,
        p_user_id: senderId,
        p_amount: totalAmount,
        p_currency: currency,
        p_payload: payload,
      });
      if (error) throw new Error(error.message || 'Payment apply failed');
      if (data?.applied) {
        logDeposit(senderId, totalAmount, 'telegram-stars').catch(() => null);
        logReferralDeposit(data?.referrerId, senderId, totalAmount, data?.referralReward, 'telegram-stars').catch(() => null);
      }
      console.log(`💫 payment ${data?.applied ? 'applied' : 'duplicate'}: user ${senderId} +${totalAmount}⭐`);
      return res.sendStatus(200);
    }

    // Для финансовых событий ошибка должна дать Telegram 5xx, чтобы update повторился.
    // Обычные callbacks/messages обрабатываем best-effort и всегда подтверждаем 200,
    // иначе частично выполненный обработчик может повторить побочный эффект.
    if (u.callback_query) {
      try { await handleBotCallback(u.callback_query); }
      catch (error) { console.error('bot callback error:', error?.message || error); }
      return res.sendStatus(200);
    }
    if (u.message?.text) {
      try { await handleBotMessage(u.message); }
      catch (error) { console.error('bot message error:', error?.message || error); }
      return res.sendStatus(200);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error('Financial webhook processing error:', error?.message || error);
    // Telegram повторит update; уникальные DB receipts делают retry идемпотентным.
    return res.sendStatus(500);
  }
});

app.post('/api/set-webhook', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-admin-key'], CONFIG.ADMIN_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await tgApi('setWebhook', {
    url: req.body.url,
    allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
    secret_token: CONFIG.TELEGRAM_WEBHOOK_SECRET,
  }));
});


app.post('/api/set-webhook-self', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-admin-key'], CONFIG.ADMIN_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await ensureTelegramWebhook(req));
});

app.get('/api/webhook-info', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-admin-key'], CONFIG.ADMIN_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await tgApi('getWebhookInfo'));
});

// ══════════════════════════════════════════════════════════════════════════════
// GIFT RELAYER — пополнение инвентаря через NFT-подарок на @GiftPepeRelayer
// ══════════════════════════════════════════════════════════════════════════════

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

async function getUserIdByUsername(username) {
  const uname = normalizeUsername(username);
  if (!uname) return null;
  const { data, error } = await sb.from('tg_username_links').select('user_id').eq('username', uname).maybeSingle();
  if (error) throw new Error(error.message || 'Username lookup failed');
  return data?.user_id ? Number(data.user_id) : null;
}

async function linkUsernameToUser(userId, username) {
  const uname = normalizeUsername(username);
  if (!uname || !userId) throw new Error('username и userId обязательны');
  const { data, error } = await sb.rpc('link_signed_tg_username', {
    p_user_id: Number(userId), p_username: uname,
  });
  if (error) throw new Error(error.message || 'Username link failed');
  return { username: String(data?.username || uname), userId: Number(data?.userId || userId) };
}

// Юзер мини-аппы привязывает свой Telegram-username, чтобы подарки от него засчитывались
app.post('/api/me/link-tg', async (req, res) => {
  const context = requireUserContext(req, res);
  if (!context) return;
  const user = context.user;

  // Username берём ТОЛЬКО из подписанного Telegram initData.
  const username = normalizeUsername(user.username || '');
  if (!username) {
    return res.status(400).json({
      error: 'У тебя не установлен username в Telegram. Зайди в Настройки → Username и задай его.',
    });
  }

  try {
    const result = await linkUsernameToUser(user.id, username);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Link failed' });
  }
});

app.get('/api/me/link-tg', async (req, res) => {
  const context = requireUserContext(req, res);
  if (!context) return;
  const user = context.user;

  // Возвращаем текущую привязку и инструкции
  const { data: linkedRow } = await sb.from('tg_username_links').select('username').eq('user_id', user.id).maybeSingle();
  const linkedUsername = linkedRow?.username || null;

  res.json({
    linkedUsername,
    suggestedUsername: normalizeUsername(user.username || '') || null,
    receiver: `@${CONFIG.GIFT_RECEIVER_USERNAME}`,
  });
});

// Информация для UI о том, как пополнить подарком
app.get('/api/deposit/gift/info', (req, res) => {
  res.json({
    receiverUsername: `@${CONFIG.GIFT_RECEIVER_USERNAME}`,
    instructions: [
      'Привяжи свой Telegram username в мини-аппе.',
      `Отправь NFT-подарок на аккаунт @${CONFIG.GIFT_RECEIVER_USERNAME}.`,
      'Подарок появится в инвентаре в течение минуты.',
    ],
  });
});

// Внутренний эндпойнт, вызывается релеером после получения подарка
app.post('/api/relayer/credit-gift', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-relayer-key'], CONFIG.RELAYER_INTERNAL_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    senderUsername,
    senderTgId,
    giftId,
    msgId,
    slug,
    isUnique,
    fallbackName,
    fallbackImage,
    fallbackPrice,
  } = req.body || {};

  if (!giftId) {
    return res.status(400).json({ error: 'giftId required' });
  }

  // Для exact withdrawal и persistent idempotency msg_id обязателен.
  const numericMsgId = Number(msgId || 0);
  if (!numericMsgId) return res.status(400).json({ error: 'msgId required' });

  // Telegram numeric sender id is authoritative. Username is only a fallback for legacy users.
  let userId = null;
  if (senderTgId) {
    const { data } = await sb
      .from('users')
      .select('id')
      .eq('id', Number(senderTgId))
      .maybeSingle();
    if (data?.id) userId = Number(data.id);
  }
  if (!userId && senderUsername) userId = await getUserIdByUsername(senderUsername);

  if (!userId) {
    // Логируем «осиротевший» подарок — пусть админ разрулит вручную
    console.warn(`🎁 unrouted gift: sender=@${senderUsername || '?'} tgId=${senderTgId || '?'} giftId=${giftId}`);
    await sb.from('unrouted_gifts').insert({
      sender_username: senderUsername || null,
      sender_tg_id: senderTgId ? Number(senderTgId) : null,
      gift_id: String(giftId),
      msg_id: msgId ? Number(msgId) : null,
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return res.status(404).json({ error: 'No user linked to this sender' });
  }

  // Найти подарок в каталоге: сначала по giftId, потом по имени (для NFT-уникалок
  // giftId — это id экземпляра, а не каталога; имя приходит как «Snake Box #96057»,
  // в каталоге — «Snake Box». Отрезаем хвост с # и пробуем снова.
  let catalogGift = findGiftInCatalog({ id: String(giftId) });
  if (!catalogGift && fallbackName) {
    const baseName = String(fallbackName).replace(/\s*#.*$/, '').trim();
    catalogGift = findGiftInCatalog({ name: baseName })
      || findGiftInCatalog({ name: fallbackName });
  }

  // Если подарка нет в нашем каталоге — НЕ добавляем в инвентарь.
  // Логируем в unrouted_gifts, чтобы админ мог разрулить вручную.
  if (!catalogGift) {
    console.warn(`🎁 gift not in catalog: giftId=${giftId} name="${fallbackName || ''}" from @${senderUsername || senderTgId}`);
    await sb.from('unrouted_gifts').insert({
      sender_username: senderUsername || null,
      sender_tg_id: senderTgId ? Number(senderTgId) : null,
      gift_id: String(giftId),
      msg_id: msgId ? Number(msgId) : null,
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return res.status(404).json({ error: 'Gift not in catalog', reason: 'not_in_catalog' });
  }

  const giftPayload = normalizeGift(catalogGift);

  if (!giftPayload?.id || !giftPayload?.name || !giftPayload?.image) {
    return res.status(400).json({ error: 'Gift cannot be normalized' });
  }

  try {
    const uniqueFlag = typeof isUnique === 'boolean' ? isUnique : (isUnique === 'true' ? true : (isUnique === 'false' ? false : null));
    const { data: credited, error: creditError } = await sb.rpc('credit_relayer_gift', {
      p_msg_id: numericMsgId,
      p_user_id: Number(userId),
      p_gift: { id: giftPayload.id, name: giftPayload.name, price: giftPayload.price, image: giftPayload.image },
      p_slug: slug || null,
      p_is_unique: uniqueFlag,
    });
    if (creditError) throw new Error(creditError.message || 'Gift credit failed');
    if (credited?.duplicate) return res.json({ ok: true, duplicate: true, userId });
    const row = credited?.gift || {};
    const saved = {
      id: Number(row.id), giftId: String(row.gift_id || giftPayload.id), name: String(row.gift_name || giftPayload.name),
      price: Number(row.gift_price || giftPayload.price), image: String(row.gift_image || giftPayload.image),
      tgMsgId: row.tg_msg_id ? Number(row.tg_msg_id) : numericMsgId, tgSlug: row.tg_slug || slug || null,
      tgIsUnique: typeof row.tg_is_unique === 'boolean' ? row.tg_is_unique : uniqueFlag,
      withdrawAt: row.withdraw_available_at || null, createdAt: row.created_at || null,
    };
    console.log(`🎁 deposit gift +${giftPayload.name} (${giftPayload.price}⭐) → user ${userId} from @${senderUsername || senderTgId}`);
    logDeposit(userId, giftPayload.price, 'telegram-gift').catch(() => null);
    logReferralDeposit(credited?.referrerId, userId, giftPayload.price, credited?.referralReward, 'telegram-gift').catch(() => null);

    // DM юзеру: подарок добавлен + кнопка «Посмотреть в инвентаре» → мини-апп.
    try {
      const baseMiniAppUrl = String(CONFIG.MINI_APP_URL || '').trim().replace(/\/$/, '');
      const inventoryUrl = baseMiniAppUrl ? `${baseMiniAppUrl}?startapp=inventory` : '';
      const dmPayload = {
        chat_id: Number(userId),
        text: `🎁 ${giftPayload.name} успешно добавлен вам в инвентарь`,
      };
      if (inventoryUrl) {
        dmPayload.reply_markup = {
          inline_keyboard: [[
            { text: 'Посмотреть в инвентаре', web_app: { url: inventoryUrl } },
          ]],
        };
      }
      tgApi('sendMessage', dmPayload, 5000).catch(() => {});
    } catch (e) {
      console.warn('deposit DM failed:', e?.message || e);
    }

    res.json({ ok: true, userId, gift: saved });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Credit failed' });
  }
});

// Список «осиротевших» подарков (для админки)
app.get('/api/admin/unrouted-gifts', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-admin-key'], CONFIG.ADMIN_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { data, error } = await sb
    .from('unrouted_gifts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error && !isMissingTableError(error, 'unrouted_gifts')) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ items: data || [] });
});

// Ручное зачисление «осиротевшего» подарка указанному юзеру
app.post('/api/admin/credit-unrouted', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-admin-key'], CONFIG.ADMIN_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const userId = Number(req.body?.userId || 0);
  const giftId = String(req.body?.giftId || '');
  if (!userId || !giftId) return res.status(400).json({ error: 'userId и giftId обязательны' });

  const catalogGift = findGiftInCatalog({ id: giftId });
  if (!catalogGift) return res.status(404).json({ error: 'Gift not in catalog' });
  try {
    const saved = await addGiftToInventory(userId, normalizeGift(catalogGift));
    res.json({ ok: true, gift: saved });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Credit failed' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ТОП: 7-дневный цикл с авто-выдачей подарков топ-1/2/3 и обнулением.
// ══════════════════════════════════════════════════════════════════════════════
const TOP_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_REWARD_GIFT_NAMES = ['Khabib’s Papakha', 'Crystal Ball', 'Berry Box'];

function getTopRewardGifts() {
  return TOP_REWARD_GIFT_NAMES.map((name) => {
    const g = GIFT_CATALOG.find((x) => String(x?.name || '') === name);
    return g ? normalizeGift(g) : null;
  });
}

async function getTopCycleStart() {
  try {
    const { data } = await sb.from('app_state').select('value').eq('key', 'top_cycle_start').maybeSingle();
    const v = data?.value;
    const ts = v && typeof v === 'object' ? Number(v.startedAt || 0) : Number(v || 0);
    if (Number.isFinite(ts) && ts > 0) return ts;
  } catch (e) {}
  // Инициализируем — сейчас.
  const now = Date.now();
  await setTopCycleStart(now).catch(() => {});
  return now;
}

async function setTopCycleStart(ms) {
  await sb.from('app_state').upsert({
    key: 'top_cycle_start',
    value: { startedAt: Number(ms) },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
}

let topRolloverBusy = false;
async function rolloverTopCycleIfDue() {
  if (topRolloverBusy) return { rolled: false, reason: 'busy' };
  topRolloverBusy = true;
  try {
    const startedAt = await getTopCycleStart();
    const endsAt = startedAt + TOP_CYCLE_MS;
    if (Date.now() < endsAt) return { rolled: false, endsAt };

    // 1) Берём текущий топ-3.
    const { data: leaders, error: leadersErr } = await sb
      .from('users')
      .select('id,first_name,total_deposited')
      .gt('total_deposited', 0)
      .order('total_deposited', { ascending: false })
      .limit(3);
    if (leadersErr) throw new Error(leadersErr.message);

    // 2) Выдаём подарки топ-1/2/3.
    const rewards = getTopRewardGifts();
    const awarded = [];
    for (let i = 0; i < (leaders || []).length; i++) {
      const gift = rewards[i];
      const leader = leaders[i];
      if (!gift || !leader) continue;
      try {
        await addGiftToInventory(Number(leader.id), gift);
        awarded.push({ userId: Number(leader.id), gift: gift.name, place: i + 1 });
        // DM победителю.
        try {
          await tgApi('sendMessage', {
            chat_id: Number(leader.id),
            text: `🏆 Поздравляем! Вы заняли ${i + 1} место в топе. Награда «${gift.name}» добавлена в инвентарь.`,
          });
        } catch (e) {}
      } catch (e) {
        console.warn('top reward award failed:', e?.message || e);
      }
    }

    // 3) Обнуляем total_deposited у всех.
    await sb.from('users').update({ total_deposited: 0, updated_at: new Date().toISOString() }).gt('total_deposited', 0);

    // 4) Стартуем новый 7-дневный цикл.
    const newStart = Date.now();
    await setTopCycleStart(newStart);
    console.log(`🏁 top cycle rolled over. awarded=${JSON.stringify(awarded)} newCycleEndsAt=${new Date(newStart + TOP_CYCLE_MS).toISOString()}`);
    return { rolled: true, awarded, endsAt: newStart + TOP_CYCLE_MS };
  } catch (e) {
    console.error('top rollover failed:', e?.message || e);
    return { rolled: false, error: e?.message || String(e) };
  } finally {
    topRolloverBusy = false;
  }
}

app.get('/api/top/cycle', async (req, res) => {
  try {
    // Лениво проверяем — вдруг пора катить.
    await rolloverTopCycleIfDue();
    const startedAt = await getTopCycleStart();
    const endsAt = startedAt + TOP_CYCLE_MS;
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, startedAt, endsAt, durationMs: TOP_CYCLE_MS });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'cycle failed' });
  }
});

app.post('/api/admin/top/rollover', async (req, res) => {
  if (!safeSecretEqual(req.headers['x-admin-key'], CONFIG.ADMIN_KEY)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Принудительный rollover: сбрасываем стартовое время в прошлое.
  await setTopCycleStart(Date.now() - TOP_CYCLE_MS - 1000).catch(() => {});
  const result = await rolloverTopCycleIfDue();
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════════════════
// АДМИНКА В МИНИ-АППЕ (auth по Telegram ID из ADMIN_IDS).
// ══════════════════════════════════════════════════════════════════════════════

function isAdminUser(user) {
  return !!(user && CONFIG.ADMIN_IDS.includes(Number(user.id)));
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!isAdminUser(user)) {
    res.status(403).json({ error: 'Доступ только для администраторов' });
    return null;
  }
  return user;
}

// --- Промокоды из БД (поддержка звёзд И подарков) ----------------------------
async function applyDbPromo(userId, rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return null;

  // Метаданные подарка выбирает сервер из собственного каталога, а само погашение
  // (проверка лимита + redemption + награда) выполняется одной SQL-транзакцией.
  const { data: rows, error: lookupError } = await sb
    .from('promo_codes')
    .select('code,reward,max_uses_per_user,active,reward_gift_id')
    .ilike('code', code)
    .eq('active', true)
    .limit(1);
  if (lookupError) throw new Error(lookupError.message || 'Promo lookup failed');
  const promo = rows?.[0] || null;
  if (!promo) return null;

  let rewardGift = null;
  if (promo.reward_gift_id) {
    const catalogGift = findGiftInCatalog({ id: String(promo.reward_gift_id) });
    if (!catalogGift) throw new Error('Подарок промокода не найден в каталоге');
    const g = normalizeGift(catalogGift);
    rewardGift = { id: g.id, name: g.name, price: g.price, image: g.image };
  }

  const { data, error } = await sb.rpc('promo_redeem_atomic', {
    p_user_id: Number(userId),
    p_code: String(promo.code),
    p_reward_gift: rewardGift,
  });
  if (error) {
    const msg = String(error.message || 'Promo redeem failed');
    if (/already activated|limit/i.test(msg)) return { ok: false, message: 'Промокод уже активирован' };
    throw new Error(msg);
  }

  const giftDb = data?.gift || null;
  const gift = giftDb ? {
    id: Number(giftDb.id), giftId: String(giftDb.gift_id || ''), name: String(giftDb.gift_name || 'Gift'),
    price: Number(giftDb.gift_price || 0), image: String(giftDb.gift_image || ''),
    withdrawAt: giftDb.withdraw_available_at || null, createdAt: giftDb.created_at || null,
  } : null;
  const reward = Number(data?.reward || 0);
  return {
    ok: true, reward, gift,
    message: gift ? `Промокод активирован: подарок «${gift.name}»` : `Промокод активирован: +${reward}⭐`,
  };
}

// --- Политика запрета вывода (app_state.key='withdraw_policy') ---------------
async function getWithdrawPolicy() {
  try {
    const { data } = await sb.from('app_state').select('value').eq('key', 'withdraw_policy').maybeSingle();
    const v = data?.value || {};
    return {
      mode: ['all', 'user', 'none'].includes(v.mode) ? v.mode : 'none',
      userIds: Array.isArray(v.userIds) ? v.userIds.map((x) => Number(x)).filter(Boolean) : [],
    };
  } catch {
    return { mode: 'none', userIds: [] };
  }
}

async function setWithdrawPolicy(policy) {
  await sb.from('app_state').upsert(
    { key: 'withdraw_policy', value: policy, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  return policy;
}

function checkWithdrawAllowed(policy, userId) {
  if (policy.mode === 'all') {
    return { allowed: false, message: 'Вывод временно отключен администрацией' };
  }
  if (policy.mode === 'user' && policy.userIds.includes(Number(userId))) {
    return { allowed: false, message: 'Вывод для вашего аккаунта временно отключен' };
  }
  return { allowed: true };
}

// --- Эндпойнты админки -------------------------------------------------------
app.get('/api/admin/me', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ isAdmin: isAdminUser(user), userId: user.id });
});

app.post('/api/admin/balance/grant', async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const targetId = Number(req.body?.userId || 0);
  const amount = Math.floor(Number(req.body?.amount || 0));
  if (!targetId) return res.status(400).json({ error: 'Введите userId' });
  if (!amount) return res.status(400).json({ error: 'Введите сумму (можно отрицательную)' });

  try {
    const { data: balance, error } = await sb.rpc('admin_adjust_balance', {
      p_user_id: targetId, p_delta: amount,
    });
    if (error) throw new Error(error.message || 'Balance adjustment failed');
    res.json({ ok: true, userId: targetId, granted: amount, balance: Number(balance || 0) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Grant failed' });
  }
});

app.post('/api/admin/promo/create', async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите код' });
  const maxUses = Math.max(1, Math.floor(Number(req.body?.maxUses || 1)));
  const giftId = req.body?.giftId ? String(req.body.giftId).trim() : null;

  try {
    if (giftId) {
      const gift = GIFT_CATALOG.find((g) => String(g.id || g.giftId || '') === giftId);
      if (!gift) return res.status(400).json({ error: 'Подарок не найден' });
      const { error } = await sb.from('promo_codes').upsert(
        { code, reward: Number(gift.price || 0), max_uses_per_user: maxUses, active: true, reward_gift_id: giftId },
        { onConflict: 'code' }
      );
      if (error) throw new Error(error.message);
      return res.json({ ok: true, code, maxUses, gift: { id: gift.id, name: gift.name, price: gift.price } });
    }

    const reward = Math.floor(Number(req.body?.reward || 0));
    if (!reward || reward <= 0) return res.status(400).json({ error: 'Введите награду в звёздах' });
    const { error } = await sb.from('promo_codes').upsert(
      { code, reward, max_uses_per_user: maxUses, active: true, reward_gift_id: null },
      { onConflict: 'code' }
    );
    if (error) throw new Error(error.message);
    res.json({ ok: true, code, reward, maxUses });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Promo create failed' });
  }
});

app.get('/api/admin/promo/list', async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const { data, error } = await sb
    .from('promo_codes')
    .select('code,reward,max_uses_per_user,active,reward_gift_id')
    .order('code', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ items: data || [] });
});

app.post('/api/admin/promo/delete', async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите код' });
  const { error } = await sb.from('promo_codes').delete().eq('code', code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/admin/withdraw-policy', async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  res.json(await getWithdrawPolicy());
});

app.post('/api/admin/withdraw-policy', async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const mode = String(req.body?.mode || 'none');
  if (!['all', 'user', 'none'].includes(mode)) return res.status(400).json({ error: 'Bad mode' });
  let userIds = [];
  if (mode === 'user') {
    const raw = req.body?.userIds ?? req.body?.userId;
    userIds = (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Boolean);
    if (!userIds.length) return res.status(400).json({ error: 'Укажи хотя бы один userId' });
  }
  const policy = await setWithdrawPolicy({ mode, userIds });
  res.json({ ok: true, policy });
});

app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 Server on port ${CONFIG.PORT}`);
  try {
    const webhookResult = await ensureTelegramWebhook();
    if (webhookResult?.ok) {
      console.log('✅ Webhook is set');
    } else if (!webhookResult?.skipped) {
      console.log('⚠️ Webhook setup failed:', webhookResult?.description || webhookResult);
    }
  } catch (error) {
    console.log('⚠️ Webhook setup failed:', error?.message || error);
  }

  // 1) Сразу подтягиваем сохранённые рыночные цены с диска (если есть).
  loadMarketPricesFromDisk();
  // 2) Первый синк через 30 сек после старта (даём релееру подняться).
  setTimeout(() => { syncMarketPricesOnce().catch(() => {}); }, 30 * 1000);
  // 3) Дальше — раз в сутки.
  setInterval(() => { syncMarketPricesOnce().catch(() => {}); }, 24 * 60 * 60 * 1000).unref?.();

  // 4) Проверяем/инициализируем persistent Crash state сразу при старте.
  try {
    const crashState = await getCrashInternalState();
    console.log(`✅ Crash DB ready: round=${crashState.roundId} phase=${crashState.phase}`);
  } catch (error) {
    console.error('❌ Crash DB init failed:', {
      message: error?.message || String(error),
      code: error?.code || null,
      details: error?.details || null,
      hint: error?.hint || null,
    });
  }

  // 5) Инициализируем 7-дневный цикл топа (если ещё не).
  getTopCycleStart().catch(() => {});
  // 6) Проверяем — пора ли катить топ — каждую минуту.
  setInterval(() => { rolloverTopCycleIfDue().catch(() => {}); }, 60 * 1000).unref?.();
});
