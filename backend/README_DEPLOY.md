# GiftPep hardened build

This build removes client-authoritative payment/game state and moves financial idempotency/atomic operations into PostgreSQL.

## Mandatory deployment order

1. Revoke and rotate the old Telegram bot token and the old MTProto user session. Also generate new `ADMIN_KEY`, `RELAYER_INTERNAL_KEY`, and `TELEGRAM_WEBHOOK_SECRET`. The old values appeared in source code and must be treated as compromised.
2. In Supabase SQL Editor run `001_security_finance.sql` completely. Do not deploy the new Node server until this migration succeeds.
3. Configure the values from `.env.example`. `SUPABASE_SERVICE_ROLE_KEY` is required; do not put it in the browser or `index.html`.
4. Use Node.js 22+ (current Supabase JS no longer supports Node 18/20). Run `npm ci` if you have a lockfile, otherwise `npm install`, then `npm run check`.
5. Run `node login.js` once with the NEW relayer account/session and save the resulting `TG_USER_SESSION` only in your secret store/environment.
6. Start `node relayer.js`, then `node server.js`. The relayer port should stay bound to `127.0.0.1` unless you put it behind a private authenticated network.
7. Check `/api/webhook-info` with your new `x-admin-key` and verify Telegram points at the expected HTTPS `/webhook` URL.

## What changed

- Telegram webhook uses `secret_token`; every webhook request is verified before processing.
- Telegram Stars receipts are persistent and idempotent by charge/invoice/withdraw-intent in PostgreSQL.
- TON top-up uses a server-created intent. The wallet sends a unique `GiftPep:<intentId>` comment payload. Backend independently reads the destination wallet transaction history and matches sender, destination, exact nanoTON amount, comment, time window, and an unused transaction hash before crediting.
- Crash round state and bets are stored in PostgreSQL. The browser never receives the secret crash point/time. Bets are countdown-only and cashout is live-only. Cryptographic randomness is used.
- Upgrade accepts only `targetGiftId`; gift metadata/price is loaded from the server catalog.
- Signed Telegram `initData.user.username` is the only source for username linking. Numeric Telegram sender ID is preferred for gift deposits.
- Inventory sell/consume/craft/upgrade/pending-prize operations are atomic PostgreSQL RPCs.
- Withdraw transfer itself always uses an exact Telegram `msgId` or `slug`. Virtual game rewards are first backed/reserved against a concrete NFT on `@GiftPepeRelayer`; DB UNIQUE indexes prevent the same NFT from backing two inventory rows. Transfer state is persisted as `transferring`: after a timeout the backend reconciles the exact NFT with the relayer instead of blindly restoring a gift that may already have been sent.
- Financial in-memory receipts/intents/fallback inventories were removed.
- Public hardcoded promo codes were removed. Promo redemption and admin balance adjustments now execute atomically in PostgreSQL.
- Channel/support/relayer usernames are `@GiftPep`, `@GiftPepeSupport`, `@GiftPepeRelayer` as requested.

## Important operational notes

The migration intentionally adds UNIQUE constraints to exact Telegram gift references. If the SQL migration stops while creating one of those indexes, the old database contains duplicate rows claiming the same physical NFT. Do not simply remove the index; review those conflicting inventory rows first.

The hardened code expects your existing RPCs `balance_add`, `spend_balance`, `add_win_balance`, `credit_referral_for_deposit`, `init_user`, `apply_referral_link`, and `get_referral_stats` to exist because the original project already called them. Their definitions were not included in the uploaded files, so this migration does not replace their internal referral/business rules.

`REFERRAL_BOT_USERNAME` in `index.html` is left as the existing `xpepegiftbot` because the requested new values specified the channel, support account, and relayer account, but not a replacement bot username. Change that constant only if the actual bot username also changed.
## Test `.env` included

This package now includes a populated `.env` using the test BOT token, Telegram API ID/hash/session, Supabase URL/publishable key and admin Telegram ID from the uploaded source. New strong test-only values were generated for `ADMIN_KEY`, `RELAYER_INTERNAL_KEY`, and `TELEGRAM_WEBHOOK_SECRET`.

One required value could not be recovered because it never existed in the uploaded files: `SUPABASE_SERVICE_ROLE_KEY`. Get it from Supabase project settings and put it in `.env` before starting the hardened backend. The old `sb_publishable_...` key is preserved separately as `SUPABASE_PUBLISHABLE_KEY` but is intentionally not accepted for financial RPCs. `TONCENTER_API_KEY` is optional in the current code, though recommended to avoid public API rate limits.

`npm start`, `npm run relayer`, and `npm run relayer:login` now load `.env` through Node 22 `--env-file`. `.env` is also listed in `.gitignore`.

