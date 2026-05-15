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
  BOT_TOKEN: process.env.BOT_TOKEN || '8838459279:AAGagwOSSBK0VPc4HXq7QrKHUofnQNs8Lg0', // test bot token
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://fqpuvmvylevrnunsescf.supabase.co',
  SUPABASE_KEY: process.env.SUPABASE_KEY || 'sb_publishable_er2vwdrEh-XRKLZqxf1FhQ_sR0MncqZ',
  ADMIN_KEY: process.env.ADMIN_KEY || 'GiftPepe_2026',
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

// Withdraw flow: фронт сначала платит 25⭐ комиссию, только потом мы делаем перевод.
// Промежуточные «intent»-ы храним в памяти: {userId, giftDbId, paid, createdAt}.
const WITHDRAW_FEE_STARS = Number(process.env.WITHDRAW_FEE_STARS || 25);
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
  return user;
}

function requireUserContext(req, res) {
  const context = validateInitDataContext(getReqInitData(req));
  if (!context?.user) {
    res.status(401).json({ error: 'Invalid initData' });
    return null;
  }
  return context;
}

function extractReferralId(startParam) {
  const match = /^ref_(\d+)$/.exec(String(startParam || '').trim());
  return match ? Number(match[1]) : null;
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
      if (Number(rewardRow?.reward || 0) > 0) {
        console.log(`🤝 referral bonus +${rewardRow.reward}⭐ for ${rewardRow.referrer_id}`);
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
    allowed_updates: ['message', 'pre_checkout_query'],
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
  if (!/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return null;
  const startParam = text.replace(/^\/start(?:@\w+)?\s*/i, '').trim();
  const baseMiniAppUrl = String(CONFIG.MINI_APP_URL || '').trim().replace(/\/$/, '');
  const appUrl = startParam ? `${baseMiniAppUrl}?startapp=${encodeURIComponent(startParam)}` : baseMiniAppUrl;

  const welcome =
    '🎰 *MoneyMonkey* — топ-казино для нфт подарков\n\n' +
    '🎁 Крути краш, апгрейдь подарки и забирай нфт подарки.\n\n' +
    '👇 Жми «Играть», чтобы начать!';
  return tgApi('sendMessage', {
    chat_id: Number(message.chat.id),
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
  const r = Math.random();
  if (r < 0.42) return round2(1.01 + Math.random() * 0.74);
  if (r < 0.74) return round2(1.75 + Math.random() * 2.05);
  if (r < 0.91) return round2(3.8 + Math.random() * 4.7);
  if (r < 0.98) return round2(8.5 + Math.random() * 9.5);
  return round2(18 + Math.random() * 14);
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

  // Safety: never count a user as their own referral, even if they open their own startapp link.
  if (referrerId && referrerId === currentUserId) {
    console.log(`↩️ self-referral ignored for user ${currentUserId}`);
  } else if (referrerId) {
    const linkResult = await sb.rpc('apply_referral_link', {
      p_user_id: user.id,
      p_referrer_id: referrerId,
    });
    if (linkResult.error) {
      console.error('apply_referral_link error:', linkResult.error);
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

  if (!user.username) {
    return res.status(400).json({ error: 'Сделайте @username чтобы получить подарок' });
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
    // Оплата уже снята — оставляем intent paid, чтобы фронт мог ретраить
    // в течение TTL без повторной комиссии.
    res.status(400).json({ error: error.message || 'Withdraw failed' });
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

    const rpc = await sb.rpc('apply_promo_code', {
      p_user_id: user.id,
      p_code: code,
    });
    if (rpc.error) throw new Error(rpc.error.message || 'Promo redeem failed');

    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    if (!row?.ok) {
      return res.status(400).json({ error: row?.message || 'Промокод недоступен' });
    }

    const [balanceData, referral] = await Promise.all([
      getUserBalance(user.id),
      getReferralSummary(user.id).catch(() => null),
    ]);

    res.json({
      ok: true,
      reward: Number(row.reward || 0),
      message: row.message || 'Промокод активирован',
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

    // House edge: chance = (src/target) * 75, потолок 75% (раньше было *100, потолок 95%)
    const chance = Math.max(1, Math.min(75, Math.round((Number(sourceGift.price || 0) / Number(targetGift.price || 1)) * 75)));
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
  if (!amount || amount < 1) {
    return res.status(400).json({ error: 'Bad amount' });
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
            console.log(`💸 withdraw fee paid: user ${userId} intent ${intentId}`);
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
    allowed_updates: ['message', 'pre_checkout_query'],
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
