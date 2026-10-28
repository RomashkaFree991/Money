#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Gift Pepe — установка и обновление одной командой (Ubuntu/Debian, root):
#
#   curl -fsSL https://raw.githubusercontent.com/RomashkaFree991/Money/ccr-d88c8651-u0njxz/deploy.sh | bash
#
# Скрипт ставит Node 22, PM2, nginx и certbot, забирает код, выкладывает
# фронтенд на moneymonkey.live, проксирует api.moneymonkey.live на Node,
# выпускает SSL и поднимает API + релеер через PM2 с автозапуском.
# Повторный запуск = обновление. .env, data/ и сессия релеера не трогаются.
# Переменные (необязательно): BRANCH, APP_DIR, DOMAIN, API_DOMAIN, EMAIL.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

main() {

REPO_URL="${REPO_URL:-https://github.com/RomashkaFree991/Money.git}"
BRANCH="${BRANCH:-ccr-d88c8651-u0njxz}"
APP_DIR="${APP_DIR:-/opt/giftpep}"
WEB_DIR="${WEB_DIR:-/var/www/giftpep}"
DOMAIN="${DOMAIN:-moneymonkey.live}"
API_DOMAIN="${API_DOMAIN:-api.moneymonkey.live}"
EMAIL="${EMAIL:-}"
ACME_DIR=/var/www/letsencrypt

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "Запустите от root"
  exec sudo -E BRANCH="$BRANCH" APP_DIR="$APP_DIR" DOMAIN="$DOMAIN" API_DOMAIN="$API_DOMAIN" EMAIL="$EMAIL" bash -c "curl -fsSL https://raw.githubusercontent.com/RomashkaFree991/Money/$BRANCH/deploy.sh | bash"
fi
export DEBIAN_FRONTEND=noninteractive

log "Системные пакеты"
apt-get update -qq
apt-get install -y -qq curl git nginx certbot rsync ca-certificates gnupg openssl </dev/null >/dev/null
if systemctl is-active --quiet apache2 2>/dev/null; then
  warn "apache2 занимает порт 80 — останавливаю"
  systemctl disable --now apache2 || true
fi

log "Node.js 22"
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs </dev/null >/dev/null
fi
node -v
command -v pm2 >/dev/null || npm install -g pm2 --silent >/dev/null
pm2 -v >/dev/null

log "Код ($BRANCH) → $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" FETCH_HEAD
  git -C "$APP_DIR" reset -q --hard FETCH_HEAD
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone -q --depth 1 -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git log -1 --format='%h %s'

log "Переменные окружения"
if [ ! -f .env ]; then
  # Ищем .env и сессию релеера от прошлой установки проекта.
  OLD_ENV="$(grep -rlsE '^SUPABASE_SERVICE_ROLE_KEY=.+' --include=.env /root /home /opt /var/www /srv 2>/dev/null | grep -v "^$APP_DIR/" | head -n1 || true)"
  if [ -n "$OLD_ENV" ]; then
    cp "$OLD_ENV" .env
    echo "Взял $OLD_ENV"
    OLD_DIR="$(dirname "$OLD_ENV")"
    [ -f "$OLD_DIR/tg-user.session" ] && [ ! -f tg-user.session ] && cp "$OLD_DIR/tg-user.session" .
    [ -d "$OLD_DIR/data" ] && mkdir -p data && cp -rn "$OLD_DIR/data/." data/ 2>/dev/null || true
  else
    cp .env.example .env
    chmod 600 .env
    die "Создан $APP_DIR/.env — заполните его (BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ...) и запустите команду ещё раз"
  fi
fi
chmod 600 .env
set_env() { # добавляет ключ, только если его ещё нет
  grep -qE "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env
}
set_env MINI_APP_URL "https://$DOMAIN"
set_env PUBLIC_BASE_URL "https://$API_DOMAIN"
set_env WEBHOOK_URL "https://$API_DOMAIN/webhook"
set_env BACKEND_URL "http://127.0.0.1:3000"
PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2 | tr -d '\r" ' || true)"
PORT="${PORT:-3000}"
for key in BOT_TOKEN SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY ADMIN_KEY TELEGRAM_WEBHOOK_SECRET RELAYER_INTERNAL_KEY; do
  grep -qE "^$key=.+" .env || die "В $APP_DIR/.env не заполнен $key"
done

log "Зависимости"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
mkdir -p data

log "Фронтенд → $WEB_DIR"
mkdir -p "$WEB_DIR" "$ACME_DIR"
rsync -a --delete index.html tonconnect-manifest.json css js assets svg "$WEB_DIR/"

log "nginx"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
NGINX_CONF=/etc/nginx/sites-available/giftpep.conf
rm -f /etc/nginx/sites-enabled/default
# Старые конфиги с этими доменами мешают новому: убираем их в бэкап.
for f in $(grep -rlsE "server_name[^;]*(${DOMAIN//./\\.}|${API_DOMAIN//./\\.})" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true); do
  [ "$(readlink -f "$f")" = "$NGINX_CONF" ] && continue
  mkdir -p /etc/nginx/giftpep-backup && mv "$f" "/etc/nginx/giftpep-backup/$(basename "$f").$(date +%s)"
  warn "Старый конфиг $f перенесён в /etc/nginx/giftpep-backup"
done

write_nginx() { # $1 = with_ssl|no_ssl
  local listen_main="listen 80;" ssl=""
  if [ "$1" = with_ssl ]; then
    listen_main="listen 443 ssl http2;"
    ssl="ssl_certificate $CERT_DIR/fullchain.pem; ssl_certificate_key $CERT_DIR/privkey.pem; ssl_protocols TLSv1.2 TLSv1.3;"
  fi
  local redirect=""
  if [ "$1" = with_ssl ]; then
    redirect="server { listen 80; server_name $DOMAIN $API_DOMAIN; location /.well-known/acme-challenge/ { root $ACME_DIR; } location / { return 301 https://\$host\$request_uri; } }"
  fi
  cat > "$NGINX_CONF" <<NGINX
map \$http_upgrade \$giftpep_connection { default upgrade; '' close; }
$redirect
server {
  $listen_main
  server_name $DOMAIN;
  $ssl
  root $WEB_DIR;
  index index.html;
  gzip on; gzip_comp_level 5; gzip_min_length 512;
  gzip_types text/css application/javascript application/json image/svg+xml text/plain;
  location /.well-known/acme-challenge/ { root $ACME_DIR; }
  location = /index.html { add_header Cache-Control "no-cache, must-revalidate"; }
  location ~* \.(?:webp|png|jpg|jpeg|gif|svg|ico|mp4)\$ { expires 7d; add_header Cache-Control "public"; try_files \$uri =404; }
  location ~* \.(?:js|css|json)\$ { expires 7d; add_header Cache-Control "public"; try_files \$uri =404; }
  location / { try_files \$uri \$uri/ /index.html; }
}
server {
  $listen_main
  server_name $API_DOMAIN;
  $ssl
  client_max_body_size 2m;
  gzip on; gzip_types application/json text/plain;
  location /.well-known/acme-challenge/ { root $ACME_DIR; }
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$giftpep_connection;
    proxy_buffering off;
    proxy_read_timeout 90s;
  }
}
NGINX
  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/giftpep.conf
  nginx -t -q || die "nginx -t: ошибка конфигурации $NGINX_CONF"
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
}

if [ -f "$CERT_DIR/fullchain.pem" ] && openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -text | grep -q "DNS:$API_DOMAIN"; then
  write_nginx with_ssl
else
  write_nginx no_ssl
fi
systemctl enable --now nginx >/dev/null 2>&1 || true

log "SSL (Let's Encrypt)"
EMAIL_ARGS=(--register-unsafely-without-email)
[ -n "$EMAIL" ] && EMAIL_ARGS=(-m "$EMAIL")
if certbot certonly --webroot -w "$ACME_DIR" -d "$DOMAIN" -d "$API_DOMAIN" --cert-name "$DOMAIN" \
     --non-interactive --agree-tos --keep-until-expiring --expand "${EMAIL_ARGS[@]}" >/tmp/giftpep-certbot.log 2>&1; then
  write_nginx with_ssl
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/giftpep-nginx.sh
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/giftpep-nginx.sh
  echo "Сертификат готов"
else
  warn "certbot не выпустил сертификат (DNS ещё не указывает на сервер?). Лог: /tmp/giftpep-certbot.log"
  [ -f "$CERT_DIR/fullchain.pem" ] && write_nginx with_ssl
fi

log "PM2"
# Останавливаем старые процессы этого проекта (server.js/relayer.js из других папок), чтобы не занимали порт.
pm2 jlist 2>/dev/null | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let list=[];try{list=JSON.parse(s)}catch{}
    for(const p of list){
      const script=String(p?.pm2_env?.pm_exec_path||"");
      if(/(^|\/)(server|relayer)\.js$/.test(script)&&!p.name.startsWith("giftpep-"))console.log(p.name);
    }
  })' | while read -r old; do
  [ -n "$old" ] && { warn "Удаляю старый PM2-процесс $old"; pm2 delete "$old" >/dev/null || true; }
done
pm2 delete giftpep-api giftpep-relayer >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs --update-env >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
systemctl enable pm2-root >/dev/null 2>&1 || true
pm2 ls

log "Проверка"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then
  echo "API: OK (http://127.0.0.1:$PORT)"
else
  pm2 logs giftpep-api --lines 40 --nostream || true
  die "API не ответил на /api/healthz — смотрите логи выше"
fi
curl -fsS -m 10 "https://$API_DOMAIN/api/healthz" >/dev/null 2>&1 && echo "https://$API_DOMAIN: OK" || warn "https://$API_DOMAIN пока недоступен снаружи"
curl -fsS -m 10 -o /dev/null "https://$DOMAIN/" 2>/dev/null && echo "https://$DOMAIN: OK" || warn "https://$DOMAIN пока недоступен снаружи"
pm2 describe giftpep-relayer >/dev/null 2>&1 || warn "Релеер не запущен: нет TG_USER_SESSION/tg-user.session. Получить: cd $APP_DIR && npm run relayer:login"

printf '\n\033[1;32m✅ Готово. Mini App: https://%s  API: https://%s\033[0m\n' "$DOMAIN" "$API_DOMAIN"
echo "Логи: pm2 logs giftpep-api   Обновление: эта же команда ещё раз"
}

main "$@"
