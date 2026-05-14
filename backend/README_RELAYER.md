# Gift Relayer — пополнение подарком через @MoneyMonkeyGift

Юзер мини-аппы отправляет NFT-подарок на аккаунт `@MoneyMonkeyGift`, релеер ловит
сервисное сообщение через MTProto и зачисляет подарок в инвентарь.

## Архитектура

```
Telegram user ──gift──▶ @MoneyMonkeyGift (userbot)
                              │
                              │ MTProto NewMessage event
                              ▼
                       relayer.js (gramjs)
                              │
                              │ POST /api/relayer/credit-gift
                              ▼
                       server.js  ─▶ Supabase (user_gifts)
```

## Сопоставление подарок ↔ юзер

По **username отправителя**. Юзер в мини-аппе один раз привязывает свой Telegram
username через `POST /api/me/link-tg`. Когда от него прилетает подарок, релеер
видит `sender.username`, ищет в таблице `tg_username_links` и зачисляет.

Если отправитель не привязан → подарок пишется в `unrouted_gifts`, админ
разруливает руками через `POST /api/admin/credit-unrouted`.

## Установка

```bash
cd backend
npm install
```

## 1. Миграция БД

Открой Supabase SQL Editor и прогони `sql/migration_gift_relayer.sql`.

## 2. Получить session userbot-аккаунта

Один раз, локально, с телефоном на руках:

```bash
TG_API_ID=33158474 \
TG_API_HASH=xxx \
node login.js
```

Скрипт спросит телефон @MoneyMonkeyGift, код из Telegram, 2FA — и распечатает
длинную строку `TG_USER_SESSION=...`. Сохрани её как секрет.

## 3. Переменные окружения

```env
# Бэкенд
PORT=3000
BOT_TOKEN=...
SUPABASE_URL=...
SUPABASE_KEY=...
ADMIN_KEY=...
MINI_APP_URL=https://moneymonkey.live
PUBLIC_BASE_URL=https://api.moneymonkey.live

# Общий секрет между server.js и relayer.js
RELAYER_INTERNAL_KEY=<длинная-случайная-строка>

# Релеер
TG_API_ID=33158474
TG_API_HASH=...
TG_USER_SESSION=<из шага 2>
BACKEND_URL=http://localhost:3000        # как relayer обращается к server.js
GIFT_RECEIVER_USERNAME=MoneyMonkeyGift
```

## 4. Запуск

В двух процессах (или через pm2 / systemd):

```bash
npm start        # API + игровая логика
npm run relayer  # MTProto userbot
```

## Новые эндпойнты в server.js

| Метод | Путь                          | Описание                                                   |
|-------|-------------------------------|------------------------------------------------------------|
| GET   | `/api/me/link-tg`             | Текущая привязка + подсказка username из initData          |
| POST  | `/api/me/link-tg`             | Привязать username (из body или из initData) к user.id     |
| GET   | `/api/deposit/gift/info`      | Текст инструкций и адрес @MoneyMonkeyGift для UI           |
| POST  | `/api/relayer/credit-gift`    | Internal. Релеер шлёт `x-relayer-key`. Зачисляет подарок.  |
| GET   | `/api/admin/unrouted-gifts`   | Admin. Список «осиротевших» подарков.                      |
| POST  | `/api/admin/credit-unrouted`  | Admin. Вручную выдать подарок юзеру.                       |

### POST /api/relayer/credit-gift

```json
{
  "senderUsername": "vasya",
  "senderTgId": "123456789",
  "giftId": "6023679164349940429",
  "msgId": 42,
  "fallbackName": "Snake Box",
  "fallbackPrice": 339,
  "fallbackImage": null
}
```

Заголовок: `x-relayer-key: <RELAYER_INTERNAL_KEY>`.

Ответы:
- `200 { ok: true, userId, gift }` — зачислено
- `200 { ok: true, duplicate: true }` — повтор по `msgId`
- `404 { error: "No user linked to this sender" }` — попало в `unrouted_gifts`
- `403` — неверный ключ

## Что важно знать

- **Userbot — это полный доступ к аккаунту.** Сессия лежит в `TG_USER_SESSION`
  и эквивалентна паролю. Никогда не пушь её в git, держи только в секретах.
- Telegram ToS userbot-релееры для коммерческих целей — серая зона. Используй
  на свой страх; аккаунт могут заблокировать.
- Релеер ловит и `MessageActionStarGift` (обычный звёздный подарок), и
  `MessageActionStarGiftUnique` (уникальный/NFT). Идентификация по `gift.id`
  совпадает с `GIFT_CATALOG` в `server.js`.
- Дедуп по `msg_id` — в памяти процесса (Set до 10k записей). Для прод-надёжности
  раскомментируй использование таблицы `processed_gift_messages` из миграции.
- У отправителя должен быть установлен публичный username, иначе релеер не
  узнает кто прислал. Без username подарок улетает в `unrouted_gifts`.

## Что прикрутить во фронт (index.html)

В личном кабинете добавить блок «Пополнить подарком»:

1. `GET /api/me/link-tg` — показать текущую привязку или предложить привязать.
2. Кнопка «Привязать @username» → `POST /api/me/link-tg`.
3. `GET /api/deposit/gift/info` — показать инструкцию и юзернейм получателя
   (`tg://resolve?domain=MoneyMonkeyGift` как deep link).
4. После отправки подарка — поллить `/api/inventory`, новый айтем появится
   автоматически (релеер зачислит через `/api/relayer/credit-gift`).
