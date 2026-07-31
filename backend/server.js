// ══════════════════════════════════════════════════════════════════════════════
// GiftPepe Backend — server.js
// Express + Supabase + Telegram Mini App
// ══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '8638688598:AAHuORvvRCMFf_BDPWgZobFEL3BwXc4gnRI', // test bot token
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://fqpuvmvylevrnunsescf.supabase.co',
  SUPABASE_KEY: process.env.SUPABASE_KEY || 'sb_publishable_er2vwdrEh-XRKLZqxf1FhQ_sR0MncqZ',
  ADMIN_KEY: process.env.ADMIN_KEY || 'GiftPepe_2026',
  // Список Telegram-айди админов через запятую (без пробелов) — для внутренней админки в мини-аппе.
  ADMIN_IDS: (process.env.ADMIN_IDS || '5345465097,8667321828').split(',').map((s) => Number(String(s).trim())).filter(Boolean),
  PORT: process.env.PORT || 3000,
  MINI_APP_URL: process.env.MINI_APP_URL || 'https://moneymonkey.live',
  WEBHOOK_URL: process.env.WEBHOOK_URL || 'https://api.moneymonkey.live/webhook',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_URL || 'https://api.moneymonkey.live',
  // Gift relayer config (used by relayer.js)
  RELAYER_INTERNAL_KEY: process.env.RELAYER_INTERNAL_KEY || 'relayer_dev_secret_change_me',
  GIFT_RECEIVER_USERNAME: (process.env.GIFT_RECEIVER_USERNAME || 'MoneyMonkeyGift').replace(/^@/, ''),
  RELAYER_URL: process.env.RELAYER_URL || 'http://127.0.0.1:4011',
};

const app = express();
app.use(cors());
app.use(express.json());

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const paymentReceipts = new Map();

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
// Промежуточные «intent»-ы храним в памяти: {userId, giftDbId, paid, createdAt}.
const WITHDRAW_FEE_STARS = Number(process.env.WITHDRAW_FEE_STARS || 30);
// v8.16: минимальный депозит, необходимый чтобы юзер мог выводить подарки.
const WITHDRAW_MIN_DEPOSIT_STARS = Number(process.env.WITHDRAW_MIN_DEPOSIT_STARS || 50);
// v8.16: минимальная ставка в краше.
const CRASH_MIN_BET = Number(process.env.CRASH_MIN_BET || 1);
const WITHDRAW_INTENT_TTL_MS = 15 * 60 * 1000;
const pendingWithdrawIntents = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, intent] of pendingWithdrawIntents) {
    if (now - intent.createdAt > WITHDRAW_INTENT_TTL_MS) pendingWithdrawIntents.delete(id);
  }
}, 60 * 1000).unref?.();

// Кеш «рыночных» (минимальных) цен подарков из Telegram NFT-маркета.
// Обновляется раз в сутки через relayer (payments.GetResaleStarGifts).
const MARKET_PRICES_FILE = path.join(__dirname, 'data', 'market_prices.json');
const marketPrices = new Map(); // giftId(str) -> stars(number)
const tonReceipts = new Map();
const pendingPrizeMemory = new Map();
const inventoryMemory = new Map();
let inventorySeq = 1;
const LATE_CRASH_BET_GRACE_MS = 1400;
const LATE_CRASH_CASHOUT_GRACE_MS = 2600;
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

function getMemoryInventory(userId) {
  return (inventoryMemory.get(String(userId)) || []).map((item) => ({ ...item }));
}

function setMemoryInventory(userId, items) {
  inventoryMemory.set(String(userId), items.map((item) => ({ ...item })));
}
const GIFT_CATALOG = [{"name":"Snake Box","price":339,"id":"6023679164349940429","image":"https://cdn.changes.tg/gifts/originals/6023679164349940429/Original.png"},{"name":"Big Year","price":340,"id":"6028283532500009446","image":"https://cdn.changes.tg/gifts/originals/6028283532500009446/Original.png"},{"name":"Xmas Stocking","price":340,"id":"6003767644426076664","image":"https://cdn.changes.tg/gifts/originals/6003767644426076664/Original.png"},{"name":"Chill Flame","price":350,"id":"5999277561060787166","image":"https://cdn.changes.tg/gifts/originals/5999277561060787166/Original.png"},{"name":"Instant Ramen","price":350,"id":"6005564615793050414","image":"https://cdn.changes.tg/gifts/originals/6005564615793050414/Original.png"},{"name":"Lunar Snake","price":350,"id":"6028426950047957932","image":"https://cdn.changes.tg/gifts/originals/6028426950047957932/Original.png"},{"name":"Vice Cream","price":350,"id":"5898012527257715797","image":"https://cdn.changes.tg/gifts/originals/5898012527257715797/Original.png"},{"name":"Victory Medal","price":350,"id":"5830340739074097859","image":"https://cdn.changes.tg/gifts/originals/5830340739074097859/Original.png"},{"name":"Winter Wreath","price":350,"id":"5983259145522906006","image":"https://cdn.changes.tg/gifts/originals/5983259145522906006/Original.png"},{"name":"Candy Cane","price":355,"id":"6003373314888696650","image":"https://cdn.changes.tg/gifts/originals/6003373314888696650/Original.png"},{"name":"Fresh Socks","price":360,"id":"5895603153683874485","image":"https://cdn.changes.tg/gifts/originals/5895603153683874485/Original.png"},{"name":"Pet Snake","price":365,"id":"6023917088358269866","image":"https://cdn.changes.tg/gifts/originals/6023917088358269866/Original.png"},{"name":"Santa Hat","price":380,"id":"5983471780763796287","image":"https://cdn.changes.tg/gifts/originals/5983471780763796287/Original.png"},{"name":"Whip Cupcake","price":380,"id":"5933543975653737112","image":"https://cdn.changes.tg/gifts/originals/5933543975653737112/Original.png"},{"name":"Ice Cream","price":389,"id":"5900177027566142759","image":"https://cdn.changes.tg/gifts/originals/5900177027566142759/Original.png"},{"name":"Pool Float","price":395,"id":"5832644211639321671","image":"https://cdn.changes.tg/gifts/originals/5832644211639321671/Original.png"},{"name":"Lol Pop","price":399,"id":"5170594532177215681","image":"https://cdn.changes.tg/gifts/originals/5170594532177215681/Original.png"},{"name":"Holiday Drink","price":400,"id":"6003735372041814769","image":"https://cdn.changes.tg/gifts/originals/6003735372041814769/Original.png"},{"name":"Happy Brownie","price":420,"id":"6006064678835323371","image":"https://cdn.changes.tg/gifts/originals/6006064678835323371/Original.png"},{"name":"Hypno Lollipop","price":420,"id":"5825895989088617224","image":"https://cdn.changes.tg/gifts/originals/5825895989088617224/Original.png"},{"name":"Tama Gadget","price":420,"id":"6023752243218481939","image":"https://cdn.changes.tg/gifts/originals/6023752243218481939/Original.png"},{"name":"Ginger Cookie","price":425,"id":"5983484377902875708","image":"https://cdn.changes.tg/gifts/originals/5983484377902875708/Original.png"},{"name":"Party Sparkler","price":430,"id":"6003643167683903930","image":"https://cdn.changes.tg/gifts/originals/6003643167683903930/Original.png"},{"name":"Spiced Wine","price":430,"id":"5913442287462908725","image":"https://cdn.changes.tg/gifts/originals/5913442287462908725/Original.png"},{"name":"Bow Tie","price":450,"id":"5895544372761461960","image":"https://cdn.changes.tg/gifts/originals/5895544372761461960/Original.png"},{"name":"Jack-in-the-Box","price":450,"id":"6005659564635063386","image":"https://cdn.changes.tg/gifts/originals/6005659564635063386/Original.png"},{"name":"Jester Hat","price":450,"id":"5933590374185435592","image":"https://cdn.changes.tg/gifts/originals/5933590374185435592/Original.png"},{"name":"Stellar Rocket","price":450,"id":"6042113507581755979","image":"https://cdn.changes.tg/gifts/originals/6042113507581755979/Original.png"},{"name":"Mousse Cake","price":460,"id":"5935877878062253519","image":"https://cdn.changes.tg/gifts/originals/5935877878062253519/Original.png"},{"name":"Money Pot","price":465,"id":"5963238670868677492","image":"https://cdn.changes.tg/gifts/originals/5963238670868677492/Original.png"},{"name":"Mood Pack","price":470,"id":"5886756255493523118","image":"https://cdn.changes.tg/gifts/originals/5886756255493523118/Original.png"},{"name":"B-Day Candle","price":498,"id":"5782984811920491178","image":"https://cdn.changes.tg/gifts/originals/5782984811920491178/Original.png"},{"name":"Clover Pin","price":498,"id":"5960747083030856414","image":"https://cdn.changes.tg/gifts/originals/5960747083030856414/Original.png"},{"name":"Hex Pot","price":500,"id":"5825801628657124140","image":"https://cdn.changes.tg/gifts/originals/5825801628657124140/Original.png"},{"name":"Pretty Posy","price":500,"id":"5933737850477478635","image":"https://cdn.changes.tg/gifts/originals/5933737850477478635/Original.png"},{"name":"Restless Jar","price":500,"id":"5870784783948186838","image":"https://cdn.changes.tg/gifts/originals/5870784783948186838/Original.png"},{"name":"Cookie Heart","price":509,"id":"6001538689543439169","image":"https://cdn.changes.tg/gifts/originals/6001538689543439169/Original.png"},{"name":"Swag Bag","price":510,"id":"6012607142387778152","image":"https://cdn.changes.tg/gifts/originals/6012607142387778152/Original.png"},{"name":"Snow Globe","price":530,"id":"5981132629905245483","image":"https://cdn.changes.tg/gifts/originals/5981132629905245483/Original.png"},{"name":"Star Notepad","price":538,"id":"5936017773737018241","image":"https://cdn.changes.tg/gifts/originals/5936017773737018241/Original.png"},{"name":"Homemade Cake","price":542,"id":"5783075783622787539","image":"https://cdn.changes.tg/gifts/originals/5783075783622787539/Original.png"},{"name":"Faith Amulet","price":544,"id":"6003456431095808759","image":"https://cdn.changes.tg/gifts/originals/6003456431095808759/Original.png"},{"name":"Easter Egg","price":550,"id":"5773668482394620318","image":"https://cdn.changes.tg/gifts/originals/5773668482394620318/Original.png"},{"name":"Snoop Dogg","price":550,"id":"6014591077976114307","image":"https://cdn.changes.tg/gifts/originals/6014591077976114307/Original.png"},{"name":"Spring Basket","price":550,"id":"5773725897517433693","image":"https://cdn.changes.tg/gifts/originals/5773725897517433693/Original.png"},{"name":"Moon Pendant","price":555,"id":"5998981470310368313","image":"https://cdn.changes.tg/gifts/originals/5998981470310368313/Original.png"},{"name":"Input Key","price":567,"id":"5870972044522291836","image":"https://cdn.changes.tg/gifts/originals/5870972044522291836/Original.png"},{"name":"Lush Bouquet","price":570,"id":"5871002671934079382","image":"https://cdn.changes.tg/gifts/originals/5871002671934079382/Original.png"},{"name":"Snow Mittens","price":570,"id":"5980789805615678057","image":"https://cdn.changes.tg/gifts/originals/5980789805615678057/Original.png"},{"name":"Witch Hat","price":570,"id":"5821384757304362229","image":"https://cdn.changes.tg/gifts/originals/5821384757304362229/Original.png"},{"name":"Desk Calendar","price":572,"id":"5782988952268964995","image":"https://cdn.changes.tg/gifts/originals/5782988952268964995/Original.png"},{"name":"Bunny Muffin","price":575,"id":"5935936766358847989","image":"https://cdn.changes.tg/gifts/originals/5935936766358847989/Original.png"},{"name":"Eternal Candle","price":575,"id":"5821205665758053411","image":"https://cdn.changes.tg/gifts/originals/5821205665758053411/Original.png"},{"name":"Evil Eye","price":575,"id":"5825480571261813595","image":"https://cdn.changes.tg/gifts/originals/5825480571261813595/Original.png"},{"name":"Jelly Bunny","price":575,"id":"5915502858152706668","image":"https://cdn.changes.tg/gifts/originals/5915502858152706668/Original.png"},{"name":"Jolly Chimp","price":575,"id":"6005880141270483700","image":"https://cdn.changes.tg/gifts/originals/6005880141270483700/Original.png"},{"name":"Light Sword","price":575,"id":"5897581235231785485","image":"https://cdn.changes.tg/gifts/originals/5897581235231785485/Original.png"},{"name":"Spy Agaric","price":575,"id":"5821261908354794038","image":"https://cdn.changes.tg/gifts/originals/5821261908354794038/Original.png"},{"name":"Timeless Book","price":575,"id":"5886387158889005864","image":"https://cdn.changes.tg/gifts/originals/5886387158889005864/Original.png"},{"name":"Joyful Bundle","price":616,"id":"5870862540036113469","image":"https://cdn.changes.tg/gifts/originals/5870862540036113469/Original.png"},{"name":"Sleigh Bell","price":691,"id":"5981026247860290310","image":"https://cdn.changes.tg/gifts/originals/5981026247860290310/Original.png"},{"name":"Hanging Star","price":697,"id":"5915733223018594841","image":"https://cdn.changes.tg/gifts/originals/5915733223018594841/Original.png"},{"name":"Berry Box","price":699,"id":"5882252952218894938","image":"https://cdn.changes.tg/gifts/originals/5882252952218894938/Original.png"},{"name":"Jingle Bells","price":700,"id":"6001473264306619020","image":"https://cdn.changes.tg/gifts/originals/6001473264306619020/Original.png"},{"name":"Sakura Flower","price":800,"id":"5167939598143193218","image":"https://cdn.changes.tg/gifts/originals/5167939598143193218/Original.png"},{"name":"Valentine Box","price":829,"id":"5868595669182186720","image":"https://cdn.changes.tg/gifts/originals/5868595669182186720/Original.png"},{"name":"Skull Flower","price":899,"id":"5839038009193792264","image":"https://cdn.changes.tg/gifts/originals/5839038009193792264/Original.png"},{"name":"Love Candle","price":903,"id":"5915550639663874519","image":"https://cdn.changes.tg/gifts/originals/5915550639663874519/Original.png"},{"name":"Crystal Ball","price":921,"id":"5841336413697606412","image":"https://cdn.changes.tg/gifts/originals/5841336413697606412/Original.png"},{"name":"Top Hat","price":928,"id":"5897593557492957738","image":"https://cdn.changes.tg/gifts/originals/5897593557492957738/Original.png"},{"name":"Snoop Cigar","price":967,"id":"6012435906336654262","image":"https://cdn.changes.tg/gifts/originals/6012435906336654262/Original.png"},{"name":"Flying Broom","price":1068,"id":"5837063436634161765","image":"https://cdn.changes.tg/gifts/originals/5837063436634161765/Original.png"},{"name":"UFC Strike","price":1085,"id":"5882260270843168924","image":"https://cdn.changes.tg/gifts/originals/5882260270843168924/Original.png"},{"name":"Trapped Heart","price":1117,"id":"5841391256135008713","image":"https://cdn.changes.tg/gifts/originals/5841391256135008713/Original.png"},{"name":"Record Player","price":1213,"id":"5856973938650776169","image":"https://cdn.changes.tg/gifts/originals/5856973938650776169/Original.png"},{"name":"Love Potion","price":1221,"id":"5868348541058942091","image":"https://cdn.changes.tg/gifts/originals/5868348541058942091/Original.png"},{"name":"Mad Pumpkin","price":1231,"id":"5841632504448025405","image":"https://cdn.changes.tg/gifts/originals/5841632504448025405/Original.png"},{"name":"Ionic Dryer","price":1362,"id":"5933937398953018107","image":"https://cdn.changes.tg/gifts/originals/5933937398953018107/Original.png"},{"name":"Sky Stilettos","price":1397,"id":"5870947077877400011","image":"https://cdn.changes.tg/gifts/originals/5870947077877400011/Original.png"},{"name":"Cupid Charm","price":1685,"id":"5868561433997870501","image":"https://cdn.changes.tg/gifts/originals/5868561433997870501/Original.png"},{"name":"Khabib’s Papakha","price":1915,"id":"5839094187366024301","image":"https://cdn.changes.tg/gifts/originals/5839094187366024301/Original.png"},{"name":"Rare Bird","price":2096,"id":"5999116401002939514","image":"https://cdn.changes.tg/gifts/originals/5999116401002939514/Original.png"},{"name":"Eternal Rose","price":2301,"id":"5882125812596999035","image":"https://cdn.changes.tg/gifts/originals/5882125812596999035/Original.png"},{"name":"Diamond Ring","price":2384,"id":"5868503709637411929","image":"https://cdn.changes.tg/gifts/originals/5868503709637411929/Original.png"},{"name":"Bling Binky","price":2421,"id":"5902339509239940491","image":"https://cdn.changes.tg/gifts/originals/5902339509239940491/Original.png"},{"name":"Voodoo Doll","price":2653,"id":"5836780359634649414","image":"https://cdn.changes.tg/gifts/originals/5836780359634649414/Original.png"},{"name":"Electric Skull","price":2838,"id":"5846192273657692751","image":"https://cdn.changes.tg/gifts/originals/5846192273657692751/Original.png"},{"name":"Signet Ring","price":2951,"id":"5936085638515261992","image":"https://cdn.changes.tg/gifts/originals/5936085638515261992/Original.png"},{"name":"Vintage Cigar","price":3017,"id":"5857140566201991735","image":"https://cdn.changes.tg/gifts/originals/5857140566201991735/Original.png"},{"name":"Neko Helmet","price":3201,"id":"5933793770951673155","image":"https://cdn.changes.tg/gifts/originals/5933793770951673155/Original.png"},{"name":"Toy Bear","price":3855,"id":"5868220813026526561","image":"https://cdn.changes.tg/gifts/originals/5868220813026526561/Original.png"},{"name":"Bonded Ring","price":3897,"id":"5870661333703197240","image":"https://cdn.changes.tg/gifts/originals/5870661333703197240/Original.png"},{"name":"Genie Lamp","price":3938,"id":"5933531623327795414","image":"https://cdn.changes.tg/gifts/originals/5933531623327795414/Original.png"},{"name":"Sharp Tongue","price":3938,"id":"5841689550203650524","image":"https://cdn.changes.tg/gifts/originals/5841689550203650524/Original.png"},{"name":"Swiss Watch","price":4069,"id":"5936043693864651359","image":"https://cdn.changes.tg/gifts/originals/5936043693864651359/Original.png"},{"name":"Low Rider","price":4641,"id":"6014675319464657779","image":"https://cdn.changes.tg/gifts/originals/6014675319464657779/Original.png"},{"name":"Kissed Frog","price":5060,"id":"5845776576658015084","image":"https://cdn.changes.tg/gifts/originals/5845776576658015084/Original.png"},{"name":"Gem Signet","price":5746,"id":"5859442703032386168","image":"https://cdn.changes.tg/gifts/originals/5859442703032386168/Original.png"},{"name":"Magic Potion","price":6577,"id":"5846226946928673709","image":"https://cdn.changes.tg/gifts/originals/5846226946928673709/Original.png"},{"name":"Artisan Brick","price":7177,"id":"6005797617768858105","image":"https://cdn.changes.tg/gifts/originals/6005797617768858105/Original.png"},{"name":"Mini Oscar","price":7637,"id":"5879737836550226478","image":"https://cdn.changes.tg/gifts/originals/5879737836550226478/Original.png"},{"name":"Ion Gem","price":7793,"id":"5843762284240831056","image":"https://cdn.changes.tg/gifts/originals/5843762284240831056/Original.png"},{"name":"Perfume Bottle","price":8714,"id":"5913517067138499193","image":"https://cdn.changes.tg/gifts/originals/5913517067138499193/Original.png"},{"name":"Westside Sign","price":8796,"id":"6014697240977737490","image":"https://cdn.changes.tg/gifts/originals/6014697240977737490/Original.png"},{"name":"Scared Cat","price":9775,"id":"5837059369300132790","image":"https://cdn.changes.tg/gifts/originals/5837059369300132790/Original.png"},{"name":"Nail Bracelet","price":11229,"id":"5870720080265871962","image":"https://cdn.changes.tg/gifts/originals/5870720080265871962/Original.png"},{"name":"Loot Bag","price":12537,"id":"5868659926187901653","image":"https://cdn.changes.tg/gifts/originals/5868659926187901653/Original.png"},{"name":"Mighty Arm","price":13638,"id":"5895518353849582541","image":"https://cdn.changes.tg/gifts/originals/5895518353849582541/Original.png"},{"name":"Astral Shard","price":14099,"id":"5933629604416717361","image":"https://cdn.changes.tg/gifts/originals/5933629604416717361/Original.png"},{"name":"Heroic Helmet","price":21859,"id":"5895328365971244193","image":"https://cdn.changes.tg/gifts/originals/5895328365971244193/Original.png"},{"name":"Precious Peach","price":35678,"id":"5933671725160989227","image":"https://cdn.changes.tg/gifts/originals/5933671725160989227/Original.png"},{"name":"Durov’s Cap","price":67592,"id":"5915521180483191380","image":"https://cdn.changes.tg/gifts/originals/5915521180483191380/Original.png"},{"name":"Heart Locket","price":172552,"id":"5868455043362980631","image":"https://cdn.changes.tg/gifts/originals/5868455043362980631/Original.png"},{"name":"Plush Pepe","price":780883,"id":"5936013938331222567","image":"https://cdn.changes.tg/gifts/originals/5936013938331222567/Original.png"}];

function validateInitDataContext(initDataStr) {
  try {
    const params = new URLSearchParams(String(initDataStr || ''));
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const str = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(CONFIG.BOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if (hash !== expected) return null;
    return {
      user: JSON.parse(params.get('user') || 'null'),
      startParam: params.get('start_param') || null,
      authDate: Number(params.get('auth_date') || 0),
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
async function applyReferralIfNew(userId, referrerId) {
  if (!userId || !referrerId) return false;
  if (Number(userId) === Number(referrerId)) {
    console.log(`↩️ self-referral ignored for user ${userId}`);
    return false;
  }
  try {
    const linkResult = await sb.rpc('apply_referral_link', {
      p_user_id: Number(userId),
      p_referrer_id: Number(referrerId),
    });
    if (linkResult.error) {
      console.error('apply_referral_link error:', linkResult.error);
      return false;
    }
    if (linkResult.data === true) {
      console.log(`🤝 referral linked: ${userId} ← ${referrerId}`);
      return true;
    }
    return false;
  } catch (e) {
    console.error('applyReferralIfNew error:', e?.message || e);
    return false;
  }
}

async function getReferralSummary(userId) {
  const { data, error } = await sb.rpc('get_referral_stats', { p_user_id: userId });
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
    const rewardResult = await sb.rpc('credit_referral_for_deposit', {
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
        console.log(`🤝 referral bonus +${rewardNum}⭐ for ${refId}`);
        // Уведомляем пригласителя — кто и на сколько пополнил.
        notifyReferrer(refId, userId, 'deposit', numericAmount, rewardNum).catch(() => null);
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
  }, 5000);
}

async function answerPreCheckout(update) {
  const queryId = String(update?.pre_checkout_query?.id || '').trim();
  if (!queryId) return null;
  return tgApi('answerPreCheckoutQuery', {
    pre_checkout_query_id: queryId,
    ok: true,
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
        text: '🛠 *Админ-панель MoneyMonkey*\n\nИспользуй кнопки внизу:',
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
    '🎰 *MoneyMonkey* — топ-казино для нфт подарков\n\n' +
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
          { text: '📣 Канал', url: 'https://t.me/MoneyMonkeyi' },
          { text: '💬 Поддержка', url: 'https://t.me/MoneyMonkeySupport' },
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
  const rpc = await sb.rpc('spend_balance', { p_user_id: userId, p_amount: amount });
  if (!rpc.error) return Number(rpc.data || 0);

  const currentBalance = await getUserBalance(userId);
  if (currentBalance < amount) throw new Error('Not enough balance');

  const nextBalance = currentBalance - amount;
  const { data, error } = await sb
    .from('users')
    .update({ balance: nextBalance })
    .eq('id', userId)
    .select('balance')
    .single();

  if (error) throw new Error(error.message || rpc.error.message || 'Balance spend failed');
  return Number(data?.balance ?? nextBalance);
}

async function addWinBalance(userId, amount) {
  const rpc = await sb.rpc('add_win_balance', { p_user_id: userId, p_amount: amount });
  if (!rpc.error) return Number(rpc.data || 0);

  const currentBalance = await getUserBalance(userId);
  const nextBalance = currentBalance + amount;
  const { data, error } = await sb
    .from('users')
    .update({ balance: nextBalance })
    .eq('id', userId)
    .select('balance')
    .single();

  if (error) throw new Error(error.message || rpc.error.message || 'Balance add failed');
  return Number(data?.balance ?? nextBalance);
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
  const picked = closePool[Math.floor(Math.random() * Math.max(1, closePool.length))] || closest;
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

  return null;
}

function buildCrashBetState(bet, { viewer = false, phase = crashGame.phase, liveMultiplier = 1 } = {}) {
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
  const memoryPrize = pendingPrizeMemory.get(String(userId)) || null;
  if (memoryPrize) return normalizeGift(memoryPrize);

  const { data, error } = await sb
    .from('user_pending_prizes')
    .select('gift_id,gift_name,gift_price,gift_image,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error, 'user_pending_prizes')) {
      return null;
    }
    return null;
  }
  if (!data) return null;
  const normalized = normalizeGift({
    id: data.gift_id,
    name: data.gift_name,
    price: data.gift_price,
    image: data.gift_image,
  });
  if (normalized) {
    pendingPrizeMemory.set(String(userId), normalized);
  }
  return normalized;
}

async function upsertPendingPrize(userId, gift) {
  const normalized = normalizeGift(gift);
  if (!userId || !normalized) return null;
  pendingPrizeMemory.set(String(userId), normalized);

  const { error: deleteError } = await sb.from('user_pending_prizes').delete().eq('user_id', userId);
  if (deleteError && !isMissingTableError(deleteError, 'user_pending_prizes')) {
    throw new Error(deleteError.message || 'Pending prize cleanup failed');
  }

  const { error } = await sb.from('user_pending_prizes').insert({
    user_id: userId,
    gift_id: normalized.id,
    gift_name: normalized.name,
    gift_price: normalized.price,
    gift_image: normalized.image,
    created_at: new Date().toISOString(),
  });
  if (error) {
    if (isMissingTableError(error, 'user_pending_prizes')) {
      return normalized;
    }
    throw new Error(error.message || 'Pending prize save failed');
  }
  return normalized;
}

async function clearPendingPrize(userId) {
  if (!userId) return null;
  const memoryPrize = pendingPrizeMemory.get(String(userId)) || null;
  const pending = memoryPrize ? normalizeGift(memoryPrize) : await getPendingPrize(userId);
  const { error } = await sb.from('user_pending_prizes').delete().eq('user_id', userId);
  pendingPrizeMemory.delete(String(userId));
  if (error && !isMissingTableError(error, 'user_pending_prizes')) {
    throw new Error(error.message || 'Pending prize delete failed');
  }
  return pending;
}

async function getUserInventory(userId) {
  const { data, error } = await sb
    .from('user_gifts')
    .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingTableError(error, 'user_gifts')) {
      return getMemoryInventory(userId);
    }
    throw new Error(error.message || 'Inventory read failed');
  }

  return (data || []).map((row) => ({
    id: Number(row.id),
    giftId: String(row.gift_id || ''),
    name: String(row.gift_name || 'Gift'),
    price: Number(row.gift_price || 0),
    image: String(row.gift_image || ''),
    withdrawAt: row.withdraw_available_at || null,
    createdAt: row.created_at || null,
  }));
}

async function addGiftToInventory(userId, gift, opts = {}) {
  const normalized = normalizeGift(gift);
  if (!normalized) throw new Error('Gift is required');
  const withdrawAt = INVENTORY_HOLD_MS > 0 ? new Date(Date.now() + INVENTORY_HOLD_MS).toISOString() : null;
  const tgMsgId = opts.tgMsgId != null ? Number(opts.tgMsgId) || null : null;
  const tgSlug = opts.tgSlug ? String(opts.tgSlug) : null;
  const tgIsUnique = opts.tgIsUnique === true || opts.tgIsUnique === 'true' || opts.tgIsUnique === 1
    ? true
    : (opts.tgIsUnique === false ? false : null);
  const insertPayload = {
    user_id: userId,
    gift_id: normalized.id,
    gift_name: normalized.name,
    gift_price: normalized.price,
    gift_image: normalized.image,
    withdraw_available_at: withdrawAt,
  };
  if (tgMsgId) insertPayload.tg_msg_id = tgMsgId;
  if (tgSlug) insertPayload.tg_slug = tgSlug;
  if (tgIsUnique !== null) insertPayload.tg_is_unique = tgIsUnique;

  const fullSelect = 'id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,tg_msg_id,tg_slug,tg_is_unique,created_at';
  let { data, error } = await sb
    .from('user_gifts')
    .insert(insertPayload)
    .select(fullSelect)
    .single();

  // Если каких-то новых колонок ещё нет — повторяем без них (мягкая совместимость)
  if (error && /tg_msg_id|tg_slug|tg_is_unique/i.test(String(error.message || ''))) {
    delete insertPayload.tg_msg_id;
    delete insertPayload.tg_slug;
    delete insertPayload.tg_is_unique;
    ({ data, error } = await sb
      .from('user_gifts')
      .insert(insertPayload)
      .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,created_at')
      .single());
  }

  if (error) {
    if (isMissingTableError(error, 'user_gifts')) {
      const item = {
        id: inventorySeq++,
        giftId: normalized.id,
        name: normalized.name,
        price: normalized.price,
        image: normalized.image,
        tgMsgId,
        tgSlug,
        tgIsUnique,
        withdrawAt,
        createdAt: new Date().toISOString(),
      };
      const items = getMemoryInventory(userId);
      items.unshift(item);
      setMemoryInventory(userId, items);
      return item;
    }
    throw new Error(error.message || 'Gift save failed');
  }

  return {
    id: Number(data.id),
    giftId: String(data.gift_id || ''),
    name: String(data.gift_name || 'Gift'),
    price: Number(data.gift_price || 0),
    image: String(data.gift_image || ''),
    tgMsgId: data.tg_msg_id ? Number(data.tg_msg_id) : tgMsgId,
    tgSlug: data.tg_slug || tgSlug || null,
    tgIsUnique: typeof data.tg_is_unique === 'boolean' ? data.tg_is_unique : tgIsUnique,
    withdrawAt: data.withdraw_available_at || null,
    createdAt: data.created_at || null,
  };
}

async function consumeInventoryGift(userId, giftDbId) {
  const numericId = Number(giftDbId || 0);
  if (!numericId) throw new Error('Gift not found');

  const { data, error } = await sb
    .from('user_gifts')
    .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,created_at')
    .eq('user_id', userId)
    .eq('id', numericId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error, 'user_gifts')) {
      const items = getMemoryInventory(userId);
      const idx = items.findIndex((entry) => Number(entry.id) === numericId);
      if (idx === -1) throw new Error('Gift not found');
      const [removed] = items.splice(idx, 1);
      setMemoryInventory(userId, items);
      return {
        id: Number(removed.id),
        giftId: String(removed.giftId || ''),
        name: String(removed.name || 'Gift'),
        price: Number(removed.price || 0),
        image: String(removed.image || ''),
        withdrawAt: removed.withdrawAt || null,
        createdAt: removed.createdAt || null,
      };
    }
    throw new Error(error.message || 'Gift not found');
  }

  if (!data) throw new Error('Gift not found');

  const { error: deleteError } = await sb
    .from('user_gifts')
    .delete()
    .eq('user_id', userId)
    .eq('id', numericId);

  if (deleteError) throw new Error(deleteError.message || 'Gift delete failed');

  return {
    id: Number(data.id),
    giftId: String(data.gift_id || ''),
    name: String(data.gift_name || 'Gift'),
    price: Number(data.gift_price || 0),
    image: String(data.gift_image || ''),
    withdrawAt: data.withdraw_available_at || null,
    createdAt: data.created_at || null,
  };
}

async function sellInventoryGift(userId, giftDbId) {
  const { data, error } = await sb
    .from('user_gifts')
    .select('id,gift_price')
    .eq('user_id', userId)
    .eq('id', giftDbId)
    .single();

  if (error) {
    if (isMissingTableError(error, 'user_gifts')) {
      const items = getMemoryInventory(userId);
      const item = items.find((entry) => Number(entry.id) === Number(giftDbId));
      if (!item) throw new Error('Gift not found');
      setMemoryInventory(userId, items.filter((entry) => Number(entry.id) !== Number(giftDbId)));
      const newBalance = await addWinBalance(userId, Number(item.price || 0));
      return { soldPrice: Number(item.price || 0), newBalance };
    }
    throw new Error(error.message || 'Gift not found');
  }
  if (!data) throw new Error('Gift not found');

  const { error: deleteError } = await sb
    .from('user_gifts')
    .delete()
    .eq('user_id', userId)
    .eq('id', giftDbId);

  if (deleteError) throw new Error(deleteError.message || 'Gift delete failed');

  const newBalance = await addWinBalance(userId, Number(data.gift_price || 0));
  return {
    soldPrice: Number(data.gift_price || 0),
    newBalance,
  };
}

async function withdrawInventoryGift(userId, targetUserId, giftDbId, targetUsername = null) {
  // Стратегия: «claim by delete». Сначала атомарно удаляем строку из БД, и только
  // если удалось — зовём релеер. При неудаче релеера — восстанавливаем подарок,
  // чтобы юзер не потерял его. Это закрывает гонку двойного вывода.

  let claimedRow = null;
  let memoryFallback = false;

  // Попытка 1: SELECT со всеми tg_* колонками (если они есть)
  let selectRes = await sb
    .from('user_gifts')
    .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at,tg_msg_id,tg_slug,tg_is_unique')
    .eq('user_id', userId)
    .eq('id', giftDbId)
    .maybeSingle();

  if (selectRes.error && /tg_msg_id|tg_slug|tg_is_unique/i.test(String(selectRes.error.message || ''))) {
    // Колонок нет — селект без них
    selectRes = await sb
      .from('user_gifts')
      .select('id,gift_id,gift_name,gift_price,gift_image,withdraw_available_at')
      .eq('user_id', userId)
      .eq('id', giftDbId)
      .maybeSingle();
  }

  if (selectRes.error) {
    if (isMissingTableError(selectRes.error, 'user_gifts')) {
      const items = getMemoryInventory(userId);
      const item = items.find((entry) => Number(entry.id) === Number(giftDbId));
      if (!item) throw new Error('Gift not found');
      claimedRow = {
        id: Number(item.id),
        gift_id: item.giftId,
        gift_name: item.name,
        gift_price: item.price,
        gift_image: item.image,
        withdraw_available_at: item.withdrawAt || null,
        tg_msg_id: item.tgMsgId || null,
        tg_slug: item.tgSlug || null,
        tg_is_unique: typeof item.tgIsUnique === 'boolean' ? item.tgIsUnique : null,
      };
      memoryFallback = true;
    } else {
      throw new Error(selectRes.error.message || 'Gift not found');
    }
  } else {
    claimedRow = selectRes.data;
  }

  if (!claimedRow) throw new Error('Gift not found');

  // Холд после получения подарка
  if (claimedRow.withdraw_available_at) {
    const unlockAt = new Date(claimedRow.withdraw_available_at).getTime();
    if (Number.isFinite(unlockAt) && Date.now() < unlockAt) {
      const ms = unlockAt - Date.now();
      const total = Math.ceil(ms / 1000);
      const d = Math.floor(total / 86400);
      const h = Math.floor((total % 86400) / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const parts = [];
      if (d > 0) parts.push(`${d}д`);
      if (d > 0 || h > 0) parts.push(`${h}ч`);
      parts.push(`${m}м`, `${s}с`);
      throw new Error(`До вывода подарка осталось ${parts.join('')}`);
    }
  }

  // Атомарный клейм: DELETE...RETURNING. Если строка уже удалена параллельным
  // запросом, .select().single() вернёт ошибку «no rows» — значит, второй вывод
  // отвалится.
  if (!memoryFallback) {
    const { data: deletedRow, error: delErr } = await sb
      .from('user_gifts')
      .delete()
      .eq('user_id', userId)
      .eq('id', giftDbId)
      .select('id')
      .maybeSingle();
    if (delErr) throw new Error(delErr.message || 'Gift claim failed');
    if (!deletedRow) throw new Error('Подарок уже выводится или удалён');
  } else {
    const items = getMemoryInventory(userId);
    if (!items.some((e) => Number(e.id) === Number(giftDbId))) {
      throw new Error('Подарок уже выводится или удалён');
    }
    setMemoryInventory(userId, items.filter((e) => Number(e.id) !== Number(giftDbId)));
  }

  // Зовём релеер (MTProto userbot). Передаём точный msg_id, если есть, —
  // тогда релеер передаст ИМЕННО этот NFT и не перепутает экземпляры.
  let relayerData = null;
  try {
    const relayerResp = await fetch(`${CONFIG.RELAYER_URL}/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relayer-key': CONFIG.RELAYER_INTERNAL_KEY,
      },
      body: JSON.stringify({
        userId: Number(targetUserId),
        username: targetUsername || null,
        msgId: claimedRow.tg_msg_id ? Number(claimedRow.tg_msg_id) : null,
        slug: claimedRow.tg_slug || null,
        isUnique: typeof claimedRow.tg_is_unique === 'boolean' ? claimedRow.tg_is_unique : null,
        giftId: String(claimedRow.gift_id || ''),
        giftName: String(claimedRow.gift_name || ''),
        giftPrice: Number(claimedRow.gift_price || 0),
      }),
    });
    relayerData = await relayerResp.json().catch(() => ({}));
    if (!relayerResp.ok || !relayerData?.ok) {
      throw new Error(relayerData?.error || 'Не удалось передать подарок (релеер)');
    }
  } catch (transferErr) {
    // Откатываем клейм — возвращаем подарок юзеру
    try {
      if (!memoryFallback) {
        const restorePayload = {
          id: claimedRow.id,
          user_id: userId,
          gift_id: claimedRow.gift_id,
          gift_name: claimedRow.gift_name,
          gift_price: claimedRow.gift_price,
          gift_image: claimedRow.gift_image,
          withdraw_available_at: claimedRow.withdraw_available_at,
          ...(claimedRow.tg_msg_id ? { tg_msg_id: claimedRow.tg_msg_id } : {}),
          ...(claimedRow.tg_slug ? { tg_slug: claimedRow.tg_slug } : {}),
          ...(typeof claimedRow.tg_is_unique === 'boolean' ? { tg_is_unique: claimedRow.tg_is_unique } : {}),
        };
        let restoreErr = (await sb.from('user_gifts').insert(restorePayload)).error;
        if (restoreErr && /tg_msg_id|tg_slug|tg_is_unique/i.test(String(restoreErr.message || ''))) {
          delete restorePayload.tg_msg_id;
          delete restorePayload.tg_slug;
          delete restorePayload.tg_is_unique;
          restoreErr = (await sb.from('user_gifts').insert(restorePayload)).error;
        }
        if (restoreErr) throw new Error(restoreErr.message || 'restore failed');
      } else {
        const items = getMemoryInventory(userId);
        items.unshift({
          id: Number(claimedRow.id),
          giftId: claimedRow.gift_id,
          name: claimedRow.gift_name,
          price: claimedRow.gift_price,
          image: claimedRow.gift_image,
          tgMsgId: claimedRow.tg_msg_id || null,
          tgSlug: claimedRow.tg_slug || null,
          tgIsUnique: typeof claimedRow.tg_is_unique === 'boolean' ? claimedRow.tg_is_unique : null,
          withdrawAt: claimedRow.withdraw_available_at || null,
          createdAt: new Date().toISOString(),
        });
        setMemoryInventory(userId, items);
      }
    } catch (rollbackErr) {
      console.error('❌ withdraw rollback failed:', rollbackErr?.message || rollbackErr);
    }
    throw new Error(transferErr?.message || 'Relayer недоступен');
  }

  return {
    sentGift: normalizeGift({
      id: claimedRow.gift_id,
      name: claimedRow.gift_name,
      price: claimedRow.gift_price,
      image: claimedRow.gift_image,
    }),
  };
}

async function sellAllInventoryGifts(userId) {
  const items = await getUserInventory(userId);
  const total = items.reduce((sum, item) => sum + Number(item.price || 0), 0);
  if (!items.length) {
    return { soldCount: 0, soldTotal: 0, newBalance: await getUserBalance(userId) };
  }

  const ids = items.map((item) => item.id);
  const { error } = await sb.from('user_gifts').delete().eq('user_id', userId).in('id', ids);
  if (error && !isMissingTableError(error, 'user_gifts')) throw new Error(error.message || 'Sell all failed');
  if (error && isMissingTableError(error, 'user_gifts')) {
    setMemoryInventory(userId, []);
  }

  const newBalance = total > 0 ? await addWinBalance(userId, total) : await getUserBalance(userId);
  return {
    soldCount: items.length,
    soldTotal: total,
    newBalance,
  };
}


function sampleCrashTarget() {
  // v8.10: ещё немного смягчили — 45% на самый низ.
  // v8.18: 55% на флор, средние диапазоны чуть выше.
  const r = Math.random();
  if (r < 0.55) return round2(1.01 + Math.random() * 0.49);   // 55%   : 1.01–1.50
  if (r < 0.85) return round2(1.50 + Math.random() * 1.00);   // 30%   : 1.50–2.50
  if (r < 0.95) return round2(2.50 + Math.random() * 1.50);   // 10%   : 2.50–4.00
  if (r < 0.99) return round2(4.00 + Math.random() * 3.00);   // 4%    : 4.00–7.00
  return round2(7.00 + Math.random() * 8.00);                  // 1%    : 7.00–15.00
}

function sampleCraftMultiplier() {
  const r = Math.random();
  if (r < 0.52) return Number((0.55 + Math.random() * 0.55).toFixed(3));
  if (r < 0.82) return Number((1.05 + Math.random() * 0.45).toFixed(3));
  if (r < 0.95) return Number((1.45 + Math.random() * 0.55).toFixed(3));
  return Number((2.0 + Math.random() * 0.7).toFixed(3));
}

const CRASH = {
  countdownMs: 10000,
  resetMs: 3000,
  growthMs: 8000,
  historyLimit: 12,
};

const crashGame = {
  roundId: 0,
  phase: 'countdown',
  countdownEndsAt: 0,
  liveStartAt: 0,
  liveEndsAt: 0,
  crashTarget: 1.0,
  lastCrashMultiplier: 1.0,
  nextRoundAt: 0,
  growthMs: CRASH.growthMs,
  history: [],
  bets: new Map(),
  timers: {
    start: null,
    end: null,
    next: null,
  },
};

function clearCrashTimers() {
  clearTimeout(crashGame.timers.start);
  clearTimeout(crashGame.timers.end);
  clearTimeout(crashGame.timers.next);
  crashGame.timers.start = null;
  crashGame.timers.end = null;
  crashGame.timers.next = null;
}

function currentCrashMultiplier(now = Date.now()) {
  syncCrashByTime();

  if (crashGame.phase !== 'live') {
    return Number(crashGame.lastCrashMultiplier || 1);
  }
  const elapsed = Math.max(0, now - crashGame.liveStartAt);
  const mult = Math.exp(elapsed / Number(crashGame.growthMs || CRASH.growthMs));
  return Math.min(Number(crashGame.crashTarget || 1), mult);
}

function finishCrashRound(now = Date.now()) {
  if (crashGame.phase === 'ended') return;
  crashGame.phase = 'ended';
  crashGame.lastCrashMultiplier = round2(crashGame.crashTarget);
  crashGame.liveEndsAt = now;
  crashGame.nextRoundAt = now + CRASH.resetMs;
  crashGame.history.unshift({
    roundId: crashGame.roundId,
    multiplier: round2(crashGame.crashTarget),
  });
  crashGame.history = crashGame.history.slice(0, CRASH.historyLimit);
  clearTimeout(crashGame.timers.end);
  crashGame.timers.end = null;
  clearTimeout(crashGame.timers.next);
  crashGame.timers.next = setTimeout(startCrashRound, CRASH.resetMs);
}

function startCrashLive(now = Date.now()) {
  if (crashGame.phase === 'live') return;
  crashGame.phase = 'live';
  crashGame.liveStartAt = now;
  const durationMs = Math.max(
    400,
    Math.round(crashGame.growthMs * Math.log(Math.max(crashGame.crashTarget, 1.01)))
  );
  crashGame.liveEndsAt = now + durationMs;
  crashGame.lastCrashMultiplier = 1.0;
  clearTimeout(crashGame.timers.start);
  crashGame.timers.start = null;
  clearTimeout(crashGame.timers.end);
  crashGame.timers.end = setTimeout(() => finishCrashRound(Date.now()), durationMs);
}

function syncCrashByTime(now = Date.now()) {
  if (crashGame.phase === 'countdown' && crashGame.countdownEndsAt && now >= crashGame.countdownEndsAt) {
    startCrashLive(now);
  }
  if (crashGame.phase === 'live' && crashGame.liveEndsAt && now >= crashGame.liveEndsAt) {
    finishCrashRound(now);
  }
  if (crashGame.phase === 'ended' && crashGame.nextRoundAt && now >= crashGame.nextRoundAt) {
    startCrashRound();
    syncCrashByTime(now);
  }
}

function serializeViewerBet(userId) {
  if (!userId) return null;
  const bet = crashGame.bets.get(String(userId));
  if (!bet) return null;
  const now = Date.now();
  const liveMultiplier = crashGame.phase === 'live' ? currentCrashMultiplier(now) : Number(crashGame.lastCrashMultiplier || 1);
  return buildCrashBetState(bet, { viewer: true, phase: crashGame.phase, liveMultiplier });
}

function serializeActiveBets(userId = null) {
  const now = Date.now();
  const liveMultiplier = crashGame.phase === 'live' ? currentCrashMultiplier(now) : Number(crashGame.lastCrashMultiplier || 1);
  return [...crashGame.bets.values()]
    .filter((bet) => bet.roundId === crashGame.roundId)
    .sort((a, b) => Number(a.placedAt || 0) - Number(b.placedAt || 0))
    .map((bet) => buildCrashBetState(bet, {
      viewer: userId ? String(bet.userId) === String(userId) : false,
      phase: crashGame.phase,
      liveMultiplier,
    }))
    .filter(Boolean);
}

async function serializeCrashState(userId = null) {
  syncCrashByTime();
  const pendingPrize = userId ? await getPendingPrize(userId) : null;
  return {
    serverNow: Date.now(),
    roundId: crashGame.roundId,
    phase: crashGame.phase,
    countdownEndsAt: crashGame.countdownEndsAt || 0,
    liveStartAt: crashGame.liveStartAt,
    liveEndsAt: crashGame.liveEndsAt || 0,
    growthMs: crashGame.growthMs,
    crashTarget: Number(crashGame.crashTarget),
    lastCrashMultiplier: Number(
      crashGame.phase === 'live' ? round2(currentCrashMultiplier()) : round2(crashGame.lastCrashMultiplier || 1)
    ),
    nextRoundAt: crashGame.nextRoundAt || 0,
    history: crashGame.history.map((entry) => ({
      roundId: entry.roundId,
      multiplier: Number(entry.multiplier),
    })),
    betsCount: crashGame.bets.size,
    activeBets: serializeActiveBets(userId),
    pendingPrize,
    viewerBet: serializeViewerBet(userId),
  };
}

function startCrashRound() {
  clearCrashTimers();
  crashGame.roundId += 1;
  crashGame.phase = 'countdown';
  crashGame.countdownEndsAt = Date.now() + CRASH.countdownMs;
  crashGame.liveStartAt = 0;
  crashGame.liveEndsAt = 0;
  crashGame.crashTarget = sampleCrashTarget();
  crashGame.lastCrashMultiplier = 1.0;
  crashGame.nextRoundAt = 0;
  crashGame.growthMs = CRASH.growthMs;
  crashGame.bets = new Map();

  crashGame.timers.start = setTimeout(() => startCrashLive(Date.now()), CRASH.countdownMs);
}

startCrashRound();

app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, now: Date.now() });
});

app.post('/api/init', async (req, res) => {
  ensureTelegramWebhook(req).catch(() => null);
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
  await ensureTelegramWebhook(req).catch(() => null);
  const user = requireUser(req, res);
  if (!user) return;

  const giftId = Number(req.body.giftId || 0);
  if (!giftId) return res.status(400).json({ error: 'Missing giftId' });

  // Проверка глобального запрета вывода (см. админку: all / user / none).
  const _wp = await getWithdrawPolicy().catch(() => ({ mode: 'none', userIds: [] }));
  const _wpCheck = checkWithdrawAllowed(_wp, user.id);
  if (!_wpCheck.allowed) return res.status(403).json({ error: _wpCheck.message });

  if (!user.username) {
    return res.status(400).json({ error: 'Сделайте @username чтобы получить подарок' });
  }

  // v8.16: вывод доступен только после депозита от WITHDRAW_MIN_DEPOSIT_STARS звёзд.
  try {
    const { data: u } = await sb.from('users')
      .select('total_deposited')
      .eq('id', user.id)
      .maybeSingle();
    const deposited = Number(u?.total_deposited || 0);
    if (deposited < WITHDRAW_MIN_DEPOSIT_STARS) {
      const need = WITHDRAW_MIN_DEPOSIT_STARS - deposited;
      return res.status(403).json({
        error: `Для вывода нужно пополнение от ${WITHDRAW_MIN_DEPOSIT_STARS}⭐ (не хватает ${need}⭐).`,
      });
    }
  } catch (e) {
    req.log?.warn?.({ err: e }, 'withdraw deposit check failed');
  }

  // Проверяем, что подарок реально принадлежит юзеру и его можно вывести
  // (используем существующий инвентарь, без удаления — удалим в момент перевода).
  const inv = await getUserInventory(user.id);
  const owned = (inv || []).find((g) => Number(g?.id) === giftId);
  if (!owned) return res.status(404).json({ error: 'Gift not found in inventory' });

  const intentId = crypto.randomUUID();
  pendingWithdrawIntents.set(intentId, {
    userId: user.id,
    giftDbId: giftId,
    paid: false,
    createdAt: Date.now(),
  });

  const result = await tgApi('createInvoiceLink', {
    title: 'Комиссия за вывод подарка',
    description: `Комиссия ${WITHDRAW_FEE_STARS}⭐ за отправку «${owned.name || 'подарка'}» в Telegram`,
    payload: JSON.stringify({ type: 'withdraw', userId: user.id, intentId }),
    currency: 'XTR',
    prices: [{ label: `${WITHDRAW_FEE_STARS} звёзд`, amount: WITHDRAW_FEE_STARS }],
  });
  if (!result.ok) {
    pendingWithdrawIntents.delete(intentId);
    console.error('withdraw invoice error:', result);
    return res.status(500).json({ error: result.description || 'Invoice failed' });
  }

  res.set('Cache-Control', 'no-store');
  res.json({ invoiceLink: result.result, intentId, fee: WITHDRAW_FEE_STARS });
});

// Шаг 2. Фронт вызывает после успешной оплаты инвойса.
app.post('/api/inventory/withdraw', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const giftId = Number(req.body.giftId || 0);
  const intentId = String(req.body.intentId || '').trim();
  if (!giftId) return res.status(400).json({ error: 'Missing giftId' });
  if (!intentId) return res.status(400).json({ error: 'Missing intentId' });

  const intent = pendingWithdrawIntents.get(intentId);
  if (!intent || intent.userId !== user.id || intent.giftDbId !== giftId) {
    return res.status(403).json({ error: 'Invoice not found, retry withdraw' });
  }
  if (!intent.paid) {
    return res.status(402).json({ error: 'Сначала оплатите комиссию' });
  }

  try {
    const result = await withdrawInventoryGift(user.id, user.id, giftId, user.username || null);
    pendingWithdrawIntents.delete(intentId);
    const items = await getUserInventory(user.id);
    res.json({
      ok: true,
      ...result,
      items,
      message: 'Подарок отправлен в Telegram',
    });
  } catch (error) {
    const rawMsg = String(error?.message || 'Withdraw failed');

    // Ловим STARGIFT_TRANSFER_TOO_EARLY_<секунд> — подарок ещё нельзя передавать
    // (Telegram холд). Возвращаем юзеру комиссию и показываем понятный текст.
    const tooEarly = rawMsg.match(/STARGIFT_TRANSFER_TOO_EARLY_(\d+)/i);
    if (tooEarly) {
      const secs = Number(tooEarly[1] || 0);
      let unlockText = 'позже';
      if (Number.isFinite(secs) && secs > 0) {
        const d = Math.floor(secs / 86400);
        const h = Math.floor((secs % 86400) / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const parts = [];
        if (d > 0) parts.push(`${d}д`);
        if (d > 0 || h > 0) parts.push(`${h}ч`);
        if (d === 0) parts.push(`${m}м`);
        unlockText = `через ${parts.join(' ')}`;
      }

      // Рефанд комиссии (Stars Bot API: refundStarPayment).
      let refunded = false;
      try {
        if (intent.chargeId) {
          const r = await tgApi('refundStarPayment', {
            user_id: Number(user.id),
            telegram_payment_charge_id: intent.chargeId,
          });
          refunded = !!r?.ok;
          if (!r?.ok) console.error('refundStarPayment failed:', r);
        }
      } catch (refundErr) {
        console.error('refundStarPayment error:', refundErr?.message || refundErr);
      }

      // Intent больше не нужен — подарок остался на месте, комиссия возвращена.
      pendingWithdrawIntents.delete(intentId);

      const msg = refunded
        ? `Подарок ещё нельзя передавать (Telegram-холд). Попробуйте ${unlockText}. Комиссия ${WITHDRAW_FEE_STARS}⭐ возвращена.`
        : `Подарок ещё нельзя передавать (Telegram-холд). Попробуйте ${unlockText}.`;
      return res.status(400).json({ error: msg, code: 'TOO_EARLY', unlockSeconds: secs, refunded });
    }

    // Прочие ошибки — оплата уже снята, оставляем intent paid, чтобы фронт мог
    // ретраить в течение TTL без повторной комиссии.
    res.status(400).json({ error: rawMsg });
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

// Захардкоженные промокоды (не идут в топ — total_deposited не трогаем,
// учёт активаций — в таблице manual_promo_redemptions).
const HARDCODED_PROMOS = {
  MONEYMONKEYBONUS100000PROMOKOD: { reward: 100000, maxUses: 10 },
  MONEYMONKEY1500: { reward: 1500, maxUses: 1 },
};

async function applyHardcodedPromo(userId, code) {
  const def = HARDCODED_PROMOS[code];
  if (!def) return null;

  // Проверяем, что юзер ещё не активировал этот промокод
  const { data: mine, error: mineErr } = await sb
    .from('manual_promo_redemptions')
    .select('user_id')
    .eq('code', code)
    .eq('user_id', Number(userId))
    .maybeSingle();
  if (mineErr && !isMissingTableError(mineErr, 'manual_promo_redemptions')) {
    throw new Error(mineErr.message || 'Promo lookup failed');
  }
  if (mine?.user_id) {
    return { ok: false, message: 'Промокод уже активирован' };
  }

  // Глобальный лимит активаций
  const { count, error: countErr } = await sb
    .from('manual_promo_redemptions')
    .select('user_id', { count: 'exact', head: true })
    .eq('code', code);
  if (countErr && !isMissingTableError(countErr, 'manual_promo_redemptions')) {
    throw new Error(countErr.message || 'Promo count failed');
  }
  if (Number(count || 0) >= def.maxUses) {
    return { ok: false, message: 'Лимит активаций промокода исчерпан' };
  }

  // Фиксируем активацию (если упадёт по unique — значит, кто-то опередил).
  const { error: insertErr } = await sb
    .from('manual_promo_redemptions')
    .insert({ user_id: Number(userId), code, redeemed_at: new Date().toISOString() });
  if (insertErr) {
    if (isMissingTableError(insertErr, 'manual_promo_redemptions')) {
      throw new Error('Таблица manual_promo_redemptions не создана. Запусти миграцию.');
    }
    if (/duplicate key|unique/i.test(insertErr.message || '')) {
      return { ok: false, message: 'Промокод уже активирован' };
    }
    throw new Error(insertErr.message || 'Promo insert failed');
  }

  // Кредитим только баланс. total_deposited НЕ трогаем — в топ юзер не попадёт.
  const balanceRpc = await sb.rpc('balance_add', { p_user_id: Number(userId), p_amount: def.reward });
  if (balanceRpc.error) {
    throw new Error(balanceRpc.error.message || 'balance_add failed');
  }

  return { ok: true, reward: def.reward, message: 'Промокод активирован' };
}

app.post('/api/promo/redeem', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const code = String(req.body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Введите промокод' });

  try {
    // Сначала проверяем захардкоженные промокоды
    const hard = await applyHardcodedPromo(user.id, code.toUpperCase());
    if (hard) {
      if (!hard.ok) return res.status(400).json({ error: hard.message || 'Промокод недоступен' });
      const balance = await getUserBalance(user.id);
      const referral = await getReferralSummary(user.id).catch(() => null);
      return res.json({
        ok: true,
        reward: Number(hard.reward || 0),
        message: hard.message || 'Промокод активирован',
        balance: Number(balance || 0),
        referral,
      });
    }

    // DB-промики (таблица promo_codes). Поддерживаем и звёзды, и подарки.
    const db = await applyDbPromo(user.id, code);
    if (!db) {
      return res.status(400).json({ error: 'Промокод не найден' });
    }
    if (!db.ok) {
      return res.status(400).json({ error: db.message || 'Промокод недоступен' });
    }

    const [balanceData, referral] = await Promise.all([
      getUserBalance(user.id),
      getReferralSummary(user.id).catch(() => null),
    ]);

    res.json({
      ok: true,
      reward: Number(db.reward || 0),
      gift: db.gift || null,
      message: db.message || 'Промокод активирован',
      balance: Number(balanceData || 0),
      referral,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Promo redeem failed' });
  }
});

app.post('/api/crash/prize/resolve', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const action = String(req.body.action || '').trim();
  if (!['sell', 'claim'].includes(action)) {
    return res.status(400).json({ error: 'Bad action' });
  }

  try {
    const pendingPrize = await clearPendingPrize(user.id);
    if (!pendingPrize) {
      return res.status(404).json({ error: 'Prize not found' });
    }

    let newBalance = await getUserBalance(user.id);
    let claimedGift = null;

    if (action === 'sell') {
      newBalance = await addWinBalance(user.id, Number(pendingPrize.price || 0));
    } else {
      const savedGift = await addGiftToInventory(user.id, pendingPrize);
      claimedGift = {
        ...savedGift,
        giftId: String(savedGift?.giftId || pendingPrize?.id || ''),
        name: String(savedGift?.name || pendingPrize?.name || 'Gift'),
        price: Number(savedGift?.price || pendingPrize?.price || 0),
        image: String(savedGift?.image || pendingPrize?.image || ''),
      };
    }

    const [items, state] = await Promise.all([
      getUserInventory(user.id),
      serializeCrashState(user.id),
    ]);

    res.json({
      ok: true,
      action,
      prize: pendingPrize,
      newBalance,
      claimedGift,
      items,
      state,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Prize resolve failed' });
  }
});

app.get('/api/payment-status', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.set('Cache-Control', 'no-store');

  const invoiceId = String(req.query.invoiceId || '');
  if (!invoiceId) {
    return res.status(400).json({ error: 'Missing invoiceId' });
  }

  const receipt = paymentReceipts.get(invoiceId);
  if (!receipt || String(receipt.userId) !== String(user.id)) {
    return res.json({ applied: false });
  }

  let balance = null;
  let referral = null;
  try {
    balance = await getUserBalance(user.id);
    referral = await getReferralSummary(user.id);
  } catch {}

  res.json({
    applied: true,
    amount: Number(receipt.amount || 0),
    appliedAt: Number(receipt.appliedAt || 0),
    balance,
    referral,
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
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const out = await syncMarketPricesOnce();
  res.json(out);
});

app.post('/api/invoice', async (req, res) => {
  await ensureTelegramWebhook(req).catch(() => null);
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


app.post('/api/ton/topup/credit', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const amountTon = Number(req.body?.amountTon || 0);
  const starsAmount = Math.max(0, Math.floor(amountTon * 90));
  const txBoc = String(req.body?.txBoc || '').trim();
  const walletAddress = String(req.body?.walletAddress || '').trim();
  if (!Number.isFinite(amountTon) || amountTon <= 0) {
    return res.status(400).json({ error: 'Bad TON amount' });
  }
  if (!Number.isFinite(starsAmount) || starsAmount <= 0) {
    return res.status(400).json({ error: 'Amount is too small' });
  }

  const receiptKey = txBoc || `${user.id}:${walletAddress}:${starsAmount}:${Math.round(amountTon * 1e9)}`;
  const existing = tonReceipts.get(receiptKey);
  if (existing && String(existing.userId) === String(user.id)) {
    return res.json({
      ok: true,
      duplicate: true,
      amountTon: existing.amountTon,
      amount: existing.amount,
      balance: await getUserBalance(user.id).catch(() => null),
      referral: await getReferralSummary(user.id).catch(() => null),
    });
  }

  try {
    const credited = await applyDepositCredit(user.id, starsAmount);
    tonReceipts.set(receiptKey, {
      userId: Number(user.id),
      amountTon: Number(amountTon),
      amount: Number(starsAmount),
      walletAddress,
      txBoc,
      appliedAt: Date.now(),
    });
    return res.json({
      ok: true,
      amountTon: Number(amountTon),
      amount: Number(starsAmount),
      balance: credited.balance,
      referral: credited.referral,
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
  const targetGift = normalizeGift(req.body?.targetGift || findGiftInCatalog(req.body?.targetGiftId || req.body?.targetGift || null));
  if (!sourceGiftId) {
    return res.status(400).json({ error: 'Source gift is required' });
  }
  if (!targetGift) {
    return res.status(400).json({ error: 'Target gift is required' });
  }

  try {
    const inventory = await getUserInventory(user.id);
    const sourceGift = inventory.find((item) => Number(item.id) === sourceGiftId);
    if (!sourceGift) {
      return res.status(400).json({ error: 'Source gift not found' });
    }
    if (Number(targetGift.price || 0) <= Number(sourceGift.price || 0)) {
      return res.status(400).json({ error: 'Target gift must be more expensive' });
    }

    // House edge v8.10: chance = (src/target) * 55, потолок 60%.
    const chance = Math.max(1, Math.min(60, Math.round((Number(sourceGift.price || 0) / Number(targetGift.price || 1)) * 55)));
    const blueDeg = Math.max(12, Math.min(348, (chance / 100) * 360));
    const isWin = Math.random() * 100 < chance;
    const safeBlueDeg = Math.max(12, Math.min(348, blueDeg));
    const winMargin = Math.min(8, Math.max(1, safeBlueDeg / 4));
    const lossMargin = Math.min(8, Math.max(1, (360 - safeBlueDeg) / 4));
    const landingAngle = isWin
      ? winMargin + Math.random() * Math.max(0.001, safeBlueDeg - winMargin * 2)
      : safeBlueDeg + lossMargin + Math.random() * Math.max(0.001, 360 - safeBlueDeg - lossMargin * 2);
    const consumedGift = await consumeInventoryGift(user.id, sourceGiftId);

    let wonGift = null;
    if (isWin) {
      try {
        wonGift = await addGiftToInventory(user.id, targetGift);
      } catch (addError) {
        await addGiftToInventory(user.id, consumedGift).catch(() => null);
        throw addError;
      }
    }

    const items = await getUserInventory(user.id);
    return res.json({
      ok: true,
      chance,
      blueDeg: Number(safeBlueDeg.toFixed(3)),
      landingAngle: Number(landingAngle.toFixed(3)),
      isWin,
      sourceGift: consumedGift,
      targetGift,
      wonGift,
      items,
      serverNow: Date.now(),
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
  if (uniqueIds.length < 3) {
    return res.status(400).json({ error: 'Choose at least 3 gifts' });
  }

  try {
    const inventory = await getUserInventory(user.id);
    const selected = uniqueIds.map((id) => inventory.find((item) => Number(item.id) === id)).filter(Boolean);
    if (selected.length !== uniqueIds.length) {
      return res.status(400).json({ error: 'Some gifts were not found' });
    }

    const consumed = [];
    try {
      for (const giftId of uniqueIds) {
        consumed.push(await consumeInventoryGift(user.id, giftId));
      }
    } catch (consumeError) {
      for (const gift of consumed) {
        await addGiftToInventory(user.id, gift).catch(() => null);
      }
      throw consumeError;
    }

    const totalPrice = consumed.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const multiplier = sampleCraftMultiplier();
    const targetRewardPrice = Math.max(1, Math.floor(totalPrice * multiplier));
    const templateGift = pickCraftRewardGift(targetRewardPrice);
    const craftedGift = normalizeGift(templateGift);
    if (!craftedGift?.id || !craftedGift?.name || !craftedGift?.image || !craftedGift?.price) {
      throw new Error('Craft reward is invalid');
    }
    const rewardPrice = Number(craftedGift?.price || targetRewardPrice);

    let savedGift = null;
    try {
      savedGift = await addGiftToInventory(user.id, craftedGift);
    } catch (addError) {
      for (const gift of consumed) {
        await addGiftToInventory(user.id, gift).catch(() => null);
      }
      throw addError;
    }

    const items = await getUserInventory(user.id);
    return res.json({
      ok: true,
      consumed,
      totalPrice,
      multiplier,
      rewardPrice,
      wonGift: savedGift,
      items,
      serverNow: Date.now(),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Craft failed' });
  }
});

app.get('/api/crash/state', async (req, res) => {
  syncCrashByTime();
  const user = validateInitData(getReqInitData(req));
  res.json(await serializeCrashState(user?.id || null));
});

app.post('/api/crash/bet', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  syncCrashByTime();

  const now = Date.now();
  const lateCountdownGrace = crashGame.phase === 'live'
    && crashGame.liveStartAt
    && (now - Number(crashGame.liveStartAt || 0)) <= LATE_CRASH_BET_GRACE_MS
    && Number(req.body?.roundId || 0) === Number(crashGame.roundId || 0);

  if (crashGame.phase !== 'countdown' && !lateCountdownGrace) {
    return res.status(400).json({ error: 'Round already started' });
  }

  const amount = parseInt(req.body.amount, 10);
  if (!amount || amount < CRASH_MIN_BET) {
    return res.status(400).json({ error: `Минимальная ставка ${CRASH_MIN_BET}⭐` });
  }

  if (crashGame.bets.has(String(user.id))) {
    return res.status(400).json({ error: 'Bet already placed' });
  }

  try {
    const newBalance = await spendBalance(user.id, amount);
    crashGame.bets.set(String(user.id), {
      userId: user.id,
      firstName: user.first_name || user.username || 'User',
      photoUrl: user.photo_url || null,
      amount,
      roundId: crashGame.roundId,
      placedAt: now,
      cashedOut: false,
      payout: 0,
    });

    return res.json({
      ok: true,
      newBalance,
      state: await serializeCrashState(user.id),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Bet failed' });
  }
});

app.post('/api/crash/cashout', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  syncCrashByTime();

  const bet = crashGame.bets.get(String(user.id));
  if (!bet || bet.roundId !== crashGame.roundId) {
    return res.status(400).json({ error: 'No active bet' });
  }
  if (bet.cashedOut) {
    return res.status(400).json({ error: 'Already cashed out' });
  }

  const now = Date.now();
  const endedRecently = crashGame.phase === 'ended'
    && crashGame.liveEndsAt
    && (now - Number(crashGame.liveEndsAt || 0)) <= LATE_CRASH_CASHOUT_GRACE_MS
    && Number(req.body?.roundId || 0) === Number(crashGame.roundId || 0);

  if (crashGame.phase !== 'live' && !endedRecently) {
    return res.status(400).json({ error: 'Round is not live' });
  }

  const serverMultiplier = crashGame.phase === 'live'
    ? currentCrashMultiplier(now)
    : Math.max(1, Math.min(Number(crashGame.lastCrashMultiplier || 1), Number(req.body?.clientMultiplier || 1)));
  const serverPayout = Math.max(0, Math.floor(Number(bet.amount) * serverMultiplier));
  const clientPayout = Math.max(0, Math.floor(Number(req.body?.clientPayout || 0)));
  const maxPossiblePayout = Math.max(0, Math.floor(Number(bet.amount || 0) * Number(crashGame.crashTarget || 1)));
  const payoutTolerance = Math.max(150, Math.floor(serverPayout * 0.08));
  const clampedClientPayout = clientPayout > 0 ? Math.min(clientPayout, maxPossiblePayout || clientPayout) : 0;
  const payout = clampedClientPayout > 0
    ? Math.max(0, Math.min(serverPayout, clampedClientPayout))
    : serverPayout;

  try {
    let newBalance = await getUserBalance(user.id);
    bet.cashedOut = true;
    bet.payout = payout;
    bet.cashedOutAt = now;
    bet.selectedGift = normalizeGift(req.body?.selectedGift || null);
    bet.awardedGift = pickCrashGiftForPayout(payout, bet.selectedGift || null);

    let pendingPrize = bet.awardedGift;
    if (pendingPrize) {
      pendingPrize = await upsertPendingPrize(user.id, pendingPrize);
      bet.awardedGift = pendingPrize;
    } else if (payout > 0) {
      // Если выигрыш меньше минимальной цены NFT-подарка, начисляем звезды сразу на баланс.
      newBalance = await addWinBalance(user.id, payout);
    }

    return res.json({
      ok: true,
      payout,
      serverPayout,
      clientPayout,
      newBalance,
      pendingPrize,
      awardedGift: bet.awardedGift || null,
      state: await serializeCrashState(user.id),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Cash out failed' });
  }
});

app.post('/webhook', async (req, res) => {
  const u = req.body || {};
  res.sendStatus(200);

  if (u.pre_checkout_query) {
    try {
      const result = await answerPreCheckout(u);
      if (!result?.ok) {
        console.error('pre_checkout approve error:', result);
      }
    } catch (error) {
      console.error('pre_checkout approve error:', error);
    }
    return;
  }

  if (u.message?.successful_payment) {
    const p = u.message.successful_payment;
    const senderId = u.message.from.id;
    try {
      const payload = JSON.parse(p.invoice_payload);
      // Комиссия за вывод подарка — НЕ зачисляем на баланс, помечаем intent оплаченным.
      if (payload && payload.type === 'withdraw') {
        const { userId, intentId } = payload;
        if (Number(userId) !== senderId) {
          console.error('withdraw userId mismatch!');
        } else {
          const intent = pendingWithdrawIntents.get(String(intentId));
          if (intent) {
            intent.paid = true;
            intent.chargeId = p.telegram_payment_charge_id || null;
            console.log(`💸 withdraw fee paid: user ${userId} intent ${intentId}`);
            // Реферальный бонус 10% от комиссии за вывод (например, 30⭐ → +3⭐ рефереру).
            try {
              const rr = await sb.rpc('credit_referral_for_deposit', {
                p_user_id: Number(userId),
                p_deposit_amount: WITHDRAW_FEE_STARS,
              });
              if (rr.error) {
                console.error('credit_referral_for_deposit (fee) error:', rr.error);
              } else {
                const row = Array.isArray(rr.data) ? rr.data[0] : rr.data;
                const rewardNum = Number(row?.reward || 0);
                const refId = Number(row?.referrer_id || 0);
                if (rewardNum > 0 && refId) {
                  notifyReferrer(refId, userId, 'fee', WITHDRAW_FEE_STARS, rewardNum).catch(() => null);
                }
              }
            } catch (refErr) {
              console.error('credit_referral_for_deposit (fee) exception:', refErr?.message || refErr);
            }
          } else {
            console.warn(`withdraw intent ${intentId} not found (TTL?)`);
          }
        }
        return;
      }
      // Обычное пополнение баланса
      const { userId, amount, invoiceId } = payload;
      if (Number(userId) !== senderId) {
        console.error('userId mismatch!');
      } else {
        const credited = await applyDepositCredit(userId, amount);
        paymentReceipts.set(String(invoiceId || `${userId}:${Date.now()}`), {
          userId: Number(userId),
          amount: Number(amount),
          appliedAt: Date.now(),
          balance: credited.balance,
        });
        console.log(`💫 user ${userId} +${amount}⭐`);
      }
    } catch (e) {
      console.error('Payment error:', e);
    }
    return;
  }

  if (u.callback_query) {
    try {
      await handleBotCallback(u.callback_query);
    } catch (error) {
      console.error('bot callback error:', error);
    }
    return;
  }

  if (u.message?.text) {
    try {
      await handleBotMessage(u.message);
    } catch (error) {
      console.error('bot message error:', error);
    }
  }
});

app.post('/api/set-webhook', async (req, res) => {
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await tgApi('setWebhook', {
    url: req.body.url,
    allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
  }));
});


app.post('/api/set-webhook-self', async (req, res) => {
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await ensureTelegramWebhook(req));
});

app.get('/api/webhook-info', async (req, res) => {
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await tgApi('getWebhookInfo'));
});

// ══════════════════════════════════════════════════════════════════════════════
// GIFT RELAYER — пополнение инвентаря через NFT-подарок на @MoneyMonkeyGift
// ══════════════════════════════════════════════════════════════════════════════

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

// Кэш в памяти: username -> userId (fallback если таблицы tg_username_links нет в БД)
const usernameLinkMemory = new Map();
// Дедуп обработанных сервисных сообщений с подарками (по msg_id)
const processedGiftMessages = new Set();

async function getUserIdByUsername(username) {
  const uname = normalizeUsername(username);
  if (!uname) return null;
  const cached = usernameLinkMemory.get(uname);
  if (cached) return cached;

  const { data, error } = await sb
    .from('tg_username_links')
    .select('user_id')
    .eq('username', uname)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error, 'tg_username_links')) return null;
    return null;
  }
  if (data?.user_id) {
    usernameLinkMemory.set(uname, Number(data.user_id));
    return Number(data.user_id);
  }
  return null;
}

async function linkUsernameToUser(userId, username) {
  const uname = normalizeUsername(username);
  if (!uname || !userId) throw new Error('username и userId обязательны');

  usernameLinkMemory.set(uname, Number(userId));

  // Если у этого юзера уже была другая привязка — очищаем
  for (const [key, val] of usernameLinkMemory.entries()) {
    if (val === Number(userId) && key !== uname) {
      usernameLinkMemory.delete(key);
    }
  }

  const { error } = await sb
    .from('tg_username_links')
    .upsert(
      { username: uname, user_id: Number(userId), updated_at: new Date().toISOString() },
      { onConflict: 'username' },
    );

  if (error && !isMissingTableError(error, 'tg_username_links')) {
    throw new Error(error.message || 'Username link failed');
  }
  return { username: uname, userId: Number(userId) };
}

// Юзер мини-аппы привязывает свой Telegram-username, чтобы подарки от него засчитывались
app.post('/api/me/link-tg', async (req, res) => {
  const context = requireUserContext(req, res);
  if (!context) return;
  const user = context.user;

  // Если в body передан username — используем его, иначе берём из initData
  const provided = String(req.body?.username || '').trim();
  const username = normalizeUsername(provided || user.username || '');
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
  let linkedUsername = null;
  for (const [uname, uid] of usernameLinkMemory.entries()) {
    if (uid === Number(user.id)) { linkedUsername = uname; break; }
  }
  if (!linkedUsername) {
    const { data } = await sb
      .from('tg_username_links')
      .select('username')
      .eq('user_id', user.id)
      .maybeSingle();
    if (data?.username) linkedUsername = data.username;
  }

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
  if (req.headers['x-relayer-key'] !== CONFIG.RELAYER_INTERNAL_KEY) {
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

  // Дедуп по msg_id
  const dedupKey = String(msgId || `${senderTgId || senderUsername}:${giftId}:${Date.now()}`);
  if (processedGiftMessages.has(dedupKey)) {
    return res.json({ ok: true, duplicate: true });
  }

  // Найти юзера: сначала по username, потом по tg_id (если совпадает с users.id)
  let userId = null;
  if (senderUsername) {
    userId = await getUserIdByUsername(senderUsername);
  }
  if (!userId && senderTgId) {
    const { data } = await sb
      .from('users')
      .select('id')
      .eq('id', Number(senderTgId))
      .maybeSingle();
    if (data?.id) userId = Number(data.id);
  }

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
    const saved = await addGiftToInventory(userId, giftPayload, {
      tgMsgId: msgId,
      tgSlug: slug || null,
      tgIsUnique: typeof isUnique === 'boolean' ? isUnique : (isUnique === 'true' ? true : (isUnique === 'false' ? false : null)),
    });
    processedGiftMessages.add(dedupKey);
    if (processedGiftMessages.size > 10000) {
      const first = processedGiftMessages.values().next().value;
      processedGiftMessages.delete(first);
    }
    console.log(`🎁 deposit gift +${giftPayload.name} (${giftPayload.price}⭐) → user ${userId} from @${senderUsername || senderTgId}`);

    // Прибавляем стоимость подарка к total_deposited, чтобы юзер появлялся в топе.
    // Баланс при этом НЕ трогаем — сам подарок и есть «депозит».
    const price = Math.max(0, Math.floor(Number(giftPayload.price || 0)));
    if (price > 0) {
      try {
        const { data: cur } = await sb
          .from('users')
          .select('total_deposited')
          .eq('id', userId)
          .maybeSingle();
        const next = Number(cur?.total_deposited || 0) + price;
        await sb
          .from('users')
          .update({ total_deposited: next, updated_at: new Date().toISOString() })
          .eq('id', userId);
      } catch (e) {
        console.warn('total_deposited bump failed:', e?.message || e);
      }

      // Реферальный бонус 10% — пригласившему. Подарок засчитывается как пополнение.
      try {
        const rewardResult = await sb.rpc('credit_referral_for_deposit', {
          p_user_id: userId,
          p_deposit_amount: price,
        });
        if (rewardResult.error) {
          console.error('credit_referral_for_deposit (gift) error:', rewardResult.error);
        } else {
          const rewardRow = Array.isArray(rewardResult.data) ? rewardResult.data[0] : rewardResult.data;
          if (Number(rewardRow?.reward || 0) > 0) {
            console.log(`🤝 referral bonus (gift) +${rewardRow.reward}⭐ for ${rewardRow.referrer_id}`);
          }
        }
      } catch (e) {
        console.warn('referral credit (gift) failed:', e?.message || e);
      }
    }

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
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) {
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
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) {
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
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) {
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

  // Регистронезависимый поиск
  const { data: rows, error } = await sb
    .from('promo_codes')
    .select('code,reward,max_uses_per_user,active,reward_gift_id')
    .ilike('code', code)
    .limit(5);
  if (error) {
    console.error('promo_codes lookup error:', error.message);
    return null;
  }
  const promo = (rows || []).find((r) => r.active);
  if (!promo) return null;

  const { count, error: cntErr } = await sb
    .from('manual_promo_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('code', promo.code);
  if (cntErr) {
    console.error('manual_promo_redemptions count error:', cntErr.message);
  }
  if ((count || 0) >= Number(promo.max_uses_per_user || 1)) {
    return { ok: false, message: 'Промокод уже активирован' };
  }

  // СНАЧАЛА фиксируем активацию (атомарно через UNIQUE индекс),
  // и только потом кредитим — иначе race-condition даёт x2 при одновременных запросах.
  // ВАЖНО: пишем только колонки, которые точно есть в схеме (user_id, code, redeemed_at).
  const rewardStars = promo.reward_gift_id ? 0 : Math.max(0, Math.floor(Number(promo.reward || 0)));
  const { error: insErr } = await sb.from('manual_promo_redemptions').insert({
    user_id: Number(userId),
    code: promo.code,
    redeemed_at: new Date().toISOString(),
  });
  if (insErr) {
    if (/duplicate key|unique/i.test(insErr.message || '')) {
      return { ok: false, message: 'Промокод уже активирован' };
    }
    console.error('manual_promo_redemptions insert error:', insErr.message);
    throw new Error(insErr.message || 'Promo insert failed');
  }

  // Активация записана — теперь начисляем награду.
  let giftPayload = null;
  if (promo.reward_gift_id) {
    const catalogGift = GIFT_CATALOG.find((g) => String(g.id || g.giftId || '') === String(promo.reward_gift_id));
    if (!catalogGift) return { ok: false, message: 'Подарок промокода не найден в каталоге' };
    const saved = await addGiftToInventory(Number(userId), normalizeGift(catalogGift));
    giftPayload = saved || normalizeGift(catalogGift);
  } else if (rewardStars > 0) {
    const rpc = await sb.rpc('balance_add', { p_user_id: Number(userId), p_amount: rewardStars });
    if (rpc.error) throw new Error(rpc.error.message || 'balance_add failed');
  }

  return {
    ok: true,
    reward: rewardStars,
    gift: giftPayload,
    message: giftPayload
      ? `Промокод активирован: подарок «${giftPayload.name}»`
      : `Промокод активирован: +${rewardStars}⭐`,
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
    if (amount > 0) {
      const rpc = await sb.rpc('balance_add', { p_user_id: targetId, p_amount: amount });
      if (rpc.error) throw new Error(rpc.error.message);
    } else {
      // Списание — через update users.balance
      const cur = await getUserBalance(targetId);
      const next = Math.max(0, cur + amount); // amount отрицательный
      const { error } = await sb.from('users').update({ balance: next, updated_at: new Date().toISOString() }).eq('id', targetId);
      if (error) throw new Error(error.message);
    }
    const balance = await getUserBalance(targetId);
    res.json({ ok: true, userId: targetId, granted: amount, balance });
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

  // 4) Инициализируем 7-дневный цикл топа (если ещё не).
  getTopCycleStart().catch(() => {});
  // 5) Проверяем — пора ли катить топ — каждую минуту.
  setInterval(() => { rolloverTopCycleIfDue().catch(() => {}); }, 60 * 1000).unref?.();
});
