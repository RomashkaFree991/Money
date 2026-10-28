// ══════════════════════════════════════════════════════════════════════════════
// Mines — поле 5×5, от 3 до 12 мин.
// Мины расставляются на сервере до первого хода; браузер видит только открытые
// клетки и sha256-коммит расстановки, который раскрывается после окончания игры.
// Выигрыш ниже флора самого дешёвого NFT зачисляется в Stars, а от флора и выше
// автоматически превращается в подарок в инвентаре (как в Crash).
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MINES_CELLS = 25;
const MINES_MIN_COUNT = 3;
const MINES_MAX_COUNT = 12;
// Возврат игроку 96%: множитель = 0.96 / P(открыть k безопасных клеток подряд).
const MINES_RTP = 0.96;

function minesMultiplier(minesCount, opened) {
  let probability = 1;
  for (let i = 0; i < opened; i += 1) {
    probability *= (MINES_CELLS - minesCount - i) / (MINES_CELLS - i);
  }
  if (opened <= 0 || probability <= 0) return 1;
  return Math.floor((MINES_RTP / probability) * 100) / 100;
}

function minesMultiplierTable(minesCount) {
  const safe = MINES_CELLS - minesCount;
  return Array.from({ length: safe }, (_, index) => minesMultiplier(minesCount, index + 1));
}

function placeMines(minesCount) {
  const cells = Array.from({ length: MINES_CELLS }, (_, index) => index);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, minesCount).sort((a, b) => a - b);
}

function commitHash(mines, salt) {
  return crypto.createHash('sha256').update(`giftpep:mines:${mines.join(',')}:${salt}`).digest('hex');
}

function registerMinesRoutes(app, deps) {
  const {
    requireUser, spendBalance, addWinBalance, getUserBalance, addGiftToInventory,
    pickGiftForPayout, getGiftFloorStars, maxPayoutStars, dataDir,
  } = deps;
  const minBet = Math.max(1, Number(process.env.MINES_MIN_BET || 10));
  const maxBet = Math.max(minBet, Number(process.env.MINES_MAX_BET || 50000));
  const storeFile = path.join(dataDir, 'mines_games.json');

  // userId -> активная игра. Один процесс PM2, поэтому RAM + файл на диске
  // достаточно; после рестарта незавершённые игры восстанавливаются из файла.
  const games = new Map();
  const userLocks = new Map();

  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${storeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...games.values()]));
      fs.renameSync(tmp, storeFile);
    } catch (error) {
      console.error('💣 MINES persist failed:', error?.message || error);
    }
  }

  try {
    if (fs.existsSync(storeFile)) {
      const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8') || '[]');
      for (const game of Array.isArray(saved) ? saved : []) {
        if (game?.userId && game.status === 'active') games.set(String(game.userId), game);
        else if (game?.status === 'settling') console.error('💣 MINES game interrupted during payout, check manually:', game.id, game.userId);
      }
      if (games.size) console.log(`💣 MINES restored ${games.size} active games`);
    }
  } catch (error) {
    console.warn('💣 MINES restore failed:', error?.message || error);
  }

  // Все запросы одного игрока выполняются строго по очереди: двойной тап
  // «Забрать» или параллельное открытие клеток не могут выплатить дважды.
  function withUserLock(userId, task) {
    const key = String(userId);
    const previous = userLocks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    userLocks.set(key, next);
    next.finally(() => { if (userLocks.get(key) === next) userLocks.delete(key); }).catch(() => {});
    return next;
  }

  function currentPayout(game) {
    const raw = Math.floor(Number(game.bet) * minesMultiplier(game.minesCount, game.opened.length));
    return Math.min(maxPayoutStars, raw);
  }

  function publicGame(game) {
    if (!game) return null;
    const finished = game.status !== 'active';
    const opened = game.opened.length;
    return {
      id: game.id,
      status: game.status,
      bet: game.bet,
      minesCount: game.minesCount,
      opened: [...game.opened],
      multiplier: minesMultiplier(game.minesCount, opened),
      nextMultiplier: opened < MINES_CELLS - game.minesCount ? minesMultiplier(game.minesCount, opened + 1) : null,
      payout: opened ? currentPayout(game) : 0,
      hash: game.hash,
      mines: finished ? [...game.mines] : null,
      salt: finished ? game.salt : null,
      hitCell: game.hitCell ?? null,
      result: game.result || null,
    };
  }

  function configPayload() {
    const tables = {};
    for (let count = MINES_MIN_COUNT; count <= MINES_MAX_COUNT; count += 1) tables[count] = minesMultiplierTable(count);
    return {
      cells: MINES_CELLS, minMines: MINES_MIN_COUNT, maxMines: MINES_MAX_COUNT,
      minBet, maxBet, maxPayout: maxPayoutStars, giftFloor: getGiftFloorStars(), tables,
    };
  }

  async function settleWin(userId, game) {
    const payout = currentPayout(game);
    game.status = 'settling';
    persist();
    const floor = getGiftFloorStars();
    const gift = payout >= floor ? pickGiftForPayout(payout) : null;
    let result;
    try {
      if (gift) {
        const saved = await addGiftToInventory(userId, gift);
        // Подарок уже сохранён — сбой чтения баланса не должен откатывать игру.
        const newBalance = await getUserBalance(userId).catch(() => null);
        result = { kind: 'gift', payout, gift: saved, newBalance };
      } else {
        result = { kind: 'stars', payout, gift: null, newBalance: await addWinBalance(userId, payout) };
      }
    } catch (error) {
      // Выплата не прошла — игра снова активна, игрок может нажать «Забрать» ещё раз.
      game.status = 'active';
      persist();
      throw error;
    }
    game.status = 'won';
    game.result = { kind: result.kind, payout, gift: result.gift ? { name: result.gift.name, image: result.gift.image, price: result.gift.price } : null };
    games.delete(String(userId));
    persist();
    console.log(`💣 MINES WIN user=${userId} bet=${game.bet} mines=${game.minesCount} opened=${game.opened.length} payout=${payout} kind=${result.kind}${gift ? ` gift=${gift.name}` : ''}`);
    return result;
  }

  app.get('/api/mines/state', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, config: configPayload(), game: publicGame(games.get(String(user.id))) });
  });

  app.post('/api/mines/start', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const amount = parseInt(req.body?.amount, 10);
    const minesCount = parseInt(req.body?.mines, 10);
    if (!Number.isFinite(amount) || amount < minBet) return res.status(400).json({ error: `Минимальная ставка ${minBet}⭐`, code: 'BET_TOO_SMALL' });
    if (amount > maxBet) return res.status(400).json({ error: `Максимальная ставка ${maxBet}⭐`, code: 'BET_TOO_BIG' });
    if (!Number.isFinite(minesCount) || minesCount < MINES_MIN_COUNT || minesCount > MINES_MAX_COUNT) {
      return res.status(400).json({ error: `Мин должно быть от ${MINES_MIN_COUNT} до ${MINES_MAX_COUNT}`, code: 'BAD_MINES' });
    }
    try {
      const payload = await withUserLock(user.id, async () => {
        const existing = games.get(String(user.id));
        if (existing) return { status: 409, body: { error: 'Сначала завершите текущую игру', code: 'GAME_ACTIVE', game: publicGame(existing) } };
        let newBalance;
        try {
          newBalance = await spendBalance(user.id, amount);
        } catch (error) {
          const message = String(error?.message || '');
          if (/insufficient|balance|недостат/i.test(message)) return { status: 402, body: { error: 'Недостаточно Stars', code: 'INSUFFICIENT_BALANCE' } };
          throw error;
        }
        const mines = placeMines(minesCount);
        const salt = crypto.randomBytes(16).toString('hex');
        const game = {
          id: crypto.randomUUID(), userId: Number(user.id), bet: amount, minesCount, mines, salt,
          hash: commitHash(mines, salt), opened: [], status: 'active', createdAt: Date.now(),
        };
        games.set(String(user.id), game);
        persist();
        return { status: 200, body: { ok: true, newBalance, game: publicGame(game) } };
      });
      return res.status(payload.status).json(payload.body);
    } catch (error) {
      console.error('💣 MINES start failed:', error?.message || error);
      return res.status(500).json({ error: 'Не удалось начать игру. Попробуйте ещё раз' });
    }
  });

  app.post('/api/mines/reveal', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const cell = parseInt(req.body?.cell, 10);
    if (!Number.isInteger(cell) || cell < 0 || cell >= MINES_CELLS) return res.status(400).json({ error: 'Bad cell' });
    try {
      const payload = await withUserLock(user.id, async () => {
        const game = games.get(String(user.id));
        if (!game || game.status !== 'active') return { status: 409, body: { error: 'Нет активной игры', code: 'NO_GAME' } };
        if (game.opened.includes(cell)) return { status: 200, body: { ok: true, game: publicGame(game) } };
        if (game.mines.includes(cell)) {
          game.status = 'lost';
          game.hitCell = cell;
          games.delete(String(user.id));
          persist();
          console.log(`💣 MINES LOSS user=${user.id} bet=${game.bet} mines=${game.minesCount} opened=${game.opened.length}`);
          return { status: 200, body: { ok: true, game: publicGame(game) } };
        }
        game.opened.push(cell);
        const allSafeOpened = game.opened.length >= MINES_CELLS - game.minesCount;
        if (allSafeOpened || currentPayout(game) >= maxPayoutStars) {
          const result = await settleWin(user.id, game);
          return { status: 200, body: { ok: true, autoCashout: true, ...result, game: publicGame(game) } };
        }
        persist();
        return { status: 200, body: { ok: true, game: publicGame(game) } };
      });
      return res.status(payload.status).json(payload.body);
    } catch (error) {
      console.error('💣 MINES reveal failed:', error?.message || error);
      return res.status(500).json({ error: 'Ошибка хода. Обновите игру' });
    }
  });

  app.post('/api/mines/cashout', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const payload = await withUserLock(user.id, async () => {
        const game = games.get(String(user.id));
        if (!game || game.status !== 'active') return { status: 409, body: { error: 'Нет активной игры', code: 'NO_GAME' } };
        if (!game.opened.length) return { status: 400, body: { error: 'Откройте хотя бы одну клетку', code: 'NOTHING_OPENED' } };
        const result = await settleWin(user.id, game);
        return { status: 200, body: { ok: true, ...result, game: publicGame(game) } };
      });
      return res.status(payload.status).json(payload.body);
    } catch (error) {
      console.error('💣 MINES cashout failed:', error?.message || error);
      return res.status(500).json({ error: 'Не удалось забрать выигрыш. Попробуйте ещё раз' });
    }
  });
}

module.exports = { registerMinesRoutes, minesMultiplier, minesMultiplierTable, MINES_MIN_COUNT, MINES_MAX_COUNT };
