# Развертывание на VPS и автодеплой

Ниже рекомендованный вариант: `Node.js + systemd + Nginx + GitHub Actions`.

## 1. Что понадобится на сервере

- Ubuntu/Debian VPS;
- `git`;
- `node` 22+ и `npm`;
- `nginx`, если панель будет доступна по домену;
- доступ к логам трех сервисов с того же сервера.

Рекомендуемый путь приложения:

```bash
/opt/query-analytics
```

## 2. Первый деплой на VPS

### 2.1. Склонировать проект

```bash
sudo mkdir -p /opt/query-analytics
sudo chown -R $USER:$USER /opt/query-analytics
git clone <YOUR_REPOSITORY_URL> /opt/query-analytics
cd /opt/query-analytics
```

### 2.2. Подготовить `.env`

```bash
cp .env.example .env
```

Минимально изменить:

```dotenv
PORT=3030
HOST=0.0.0.0
REFRESH_INTERVAL_MS=15000
MAX_RECENT_REQUESTS=80
SNIPPET_LENGTH=800
SOURCES_CONFIG_PATH=./config/sources.local.json
```

### 2.3. Подготовить `sources.local.json`

Проще всего начать с примера:

```bash
cp config/sources.example.json config/sources.local.json
```

И затем вписать реальные абсолютные пути к вашим проектам на сервере:

```json
[
  {
    "id": "garage-sync",
    "name": "ABCP B24 Garage Sync",
    "rootPath": "/opt/abcp-b24-garage-sync",
    "include": ["logs/http-requests-*.jsonl"],
    "format": "garage-jsonl"
  },
  {
    "id": "abcp-b24-sync",
    "name": "ABCP B24 Sync",
    "rootPath": "/opt/abcp_b24_sync",
    "include": ["logs/http_requests/request_analytics_*.log"],
    "format": "request-analytics"
  },
  {
    "id": "abcp2bitrix",
    "name": "ABCP2Bitrix",
    "rootPath": "/opt/ABCP2Bitrix",
    "include": ["ABCP2Bitrix.Infrastructure/logs/http-analytics/http-requests-*.jsonl"],
    "format": "dotnet-jsonl"
  }
]
```

## 3. Установка зависимостей и первая сборка

```bash
cd /opt/query-analytics
npm ci
npm run build
```

Проверка:

```bash
curl http://127.0.0.1:3030/healthz
```

Эта команда сработает после запуска сервиса. Ниже показано, как оформить его через `systemd`.

## 4. Запуск через systemd

Готовый unit-файл:

- `deploy/query-analytics.service`

Скопировать и адаптировать:

```bash
sudo cp deploy/query-analytics.service /etc/systemd/system/query-analytics.service
sudo nano /etc/systemd/system/query-analytics.service
```

Обязательно проверить:

- `User=www-data` — заменить на нужного пользователя;
- `Group=www-data` — заменить при необходимости;
- `WorkingDirectory=/opt/query-analytics` — путь до приложения;
- `ExecStart=/usr/bin/node /opt/query-analytics/dist/server/server/index.js` — путь до Node и entrypoint.

После этого:

```bash
sudo systemctl daemon-reload
sudo systemctl enable query-analytics.service
sudo systemctl start query-analytics.service
sudo systemctl status query-analytics.service --no-pager
```

Логи сервиса:

```bash
journalctl -u query-analytics.service -f
```

## 5. Публикация через Nginx

Пример конфига:

- `deploy/nginx.query-analytics.conf`

Скопировать и адаптировать:

```bash
sudo cp deploy/nginx.query-analytics.conf /etc/nginx/sites-available/query-analytics
sudo ln -s /etc/nginx/sites-available/query-analytics /etc/nginx/sites-enabled/query-analytics
sudo nginx -t
sudo systemctl reload nginx
```

Что нужно поменять:

- `server_name analytics.example.com;`

Дальше подключить TLS, например через `certbot`.

## 6. Включение analytics-логов в исходных сервисах

### `abcp-b24-garage-sync`

В `.env`:

```dotenv
REQUEST_AUDIT_ENABLED=true
```

Появятся файлы:

```text
logs/http-requests-YYYY-MM-DD.jsonl
```

### `abcp_b24_sync`

В `.env`:

```dotenv
REQUEST_ANALYTICS_ENABLED=1
REQUEST_ANALYTICS_DIR=logs/http_requests
```

Появятся файлы:

```text
logs/http_requests/request_analytics_YYYY-MM-DD.log
```

### `ABCP2Bitrix`

В `ABCP2Bitrix.Infrastructure/server_config.json`:

```json
"RuntimeOptions": {
  "EnableHttpRequestAnalytics": true
}
```

Появятся файлы:

```text
ABCP2Bitrix.Infrastructure/logs/http-analytics/http-requests-YYYY-MM-DD.jsonl
```

## 7. Автодеплой через GitHub Actions

Готовый workflow:

- `.github/workflows/deploy.yml`

Серверный deploy script:

- `deploy/remote-deploy.sh`

### 7.1. Что должно быть на сервере до включения CI/CD

1. Репозиторий уже клонирован в `/opt/query-analytics`.
2. На сервере настроен доступ к Git origin:
   - либо через deploy key;
   - либо через HTTPS token.
3. Рабочие файлы уже созданы:
   - `.env`
   - `config/sources.local.json`
4. `systemd`-сервис уже установлен и запускается вручную:
   - `query-analytics.service`

### 7.2. Какие GitHub Secrets нужны

- `VPS_HOST` — IP или домен VPS.
- `VPS_USER` — SSH user.
- `VPS_SSH_KEY` — приватный SSH ключ для входа на VPS.
- `VPS_APP_DIR` — путь до приложения, обычно `/opt/query-analytics`.
- `VPS_SERVICE_NAME` — имя systemd-сервиса, обычно `query-analytics.service`.

### 7.3. Как работает pipeline

На каждый `push` в `main`:

1. GitHub Actions делает `npm ci`.
2. Гоняет `npm run test`.
3. Делает `npm run build`.
4. По SSH заходит на VPS.
5. На VPS выполняется `deploy/remote-deploy.sh`:
   - `git fetch`
   - `git pull --ff-only`
   - `npm ci`
   - `npm run build`
   - `sudo systemctl restart query-analytics.service`

## 8. Ручной деплой без CI/CD

Если нужно просто обновить панель руками:

```bash
cd /opt/query-analytics
git pull --ff-only
npm ci
npm run build
sudo systemctl restart query-analytics.service
```

## 9. Диагностика

### Сервис не стартует

Проверить:

```bash
sudo systemctl status query-analytics.service --no-pager
journalctl -u query-analytics.service -f
```

### Панель пустая

Проверить:

1. Что реально создаются analytics-файлы в исходных проектах.
2. Что `rootPath` в `config/sources.local.json` указывает на правильный абсолютный путь.
3. Что `include` совпадает с реальным именем файлов.

### `healthz` отвечает, но графики пустые

Скорее всего:

- путь правильный, но файлов пока нет;
- либо аналитика в одном из сервисов выключена;
- либо шаблон `include` не совпадает с именем файлов.
