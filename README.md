# Панель аналитики HTTP

Панель для чтения и визуализации HTTP analytics-логов из нескольких локальных сервисов.

Решение состоит из:

- `React`-фронта с графиками и фильтрами;
- `Node.js + Express` API, которое читает JSONL/JSON-lines логи с диска;
- кеширующего индексатора, который не парсит неизмененные файлы повторно;
- файлов для запуска на обычном VPS без контейнеров: `systemd`, `Nginx`, `GitHub Actions`.

## Что показывает панель

- общее количество запросов;
- успешные, ошибочные и `unknown` запросы;
- среднее, `p95` и максимальное время ответа;
- таймлайн по часам, дням или месяцам;
- распределение по провайдерам и источникам;
- распределение по HTTP status;
- топ endpoint'ов;
- последние запросы с кратким `request/response preview`.

## Поддерживаемые форматы логов

### 1. `abcp-b24-garage-sync`

Формат:

- `logs/http-requests-YYYY-MM-DD.jsonl`
- JSONL-аудит из `abcp_b24_garage_sync/request_audit.py`

Чтобы логи писались:

- включить `REQUEST_AUDIT_ENABLED=true`

### 2. `abcp_b24_sync`

Формат:

- `logs/http_requests/request_analytics_YYYY-MM-DD.log`
- JSON Lines из `request_analytics.py`

Чтобы логи писались:

- включить `REQUEST_ANALYTICS_ENABLED=1`
- убедиться, что `REQUEST_ANALYTICS_DIR=logs/http_requests`

### 3. `ABCP2Bitrix`

Формат:

- `ABCP2Bitrix.Infrastructure/logs/http-analytics/http-requests-YYYY-MM-DD.jsonl`
- structured JSONL из `ABCP2Bitrix/Diagnostics/HttpRequestAnalytics.cs`

Чтобы логи писались:

- включить `EnableHttpRequestAnalytics=true` в `ABCP2Bitrix.Infrastructure/server_config.json`

## Конфигурация источников

Файл источников задается через `SOURCES_CONFIG_PATH`.

Готовые варианты:

- `config/sources.local.json` — уже настроен под ваши текущие локальные папки;
- `config/sources.example.json` — пример для Linux/VPS.

Каждый источник описывается так:

```json
{
  "id": "garage-sync",
  "name": "ABCP B24 Garage Sync",
  "rootPath": "/opt/abcp-b24-garage-sync",
  "include": ["logs/http-requests-*.jsonl"],
  "format": "garage-jsonl"
}
```

## Локальный запуск

1. Установить Node.js 22+.
2. Убедиться, что логи реально создаются в трех исходных проектах.
3. Проверить `.env` и `config/sources.local.json`.
4. Запустить:

```bash
npm install
npm run dev
```

По умолчанию:

- фронт: `http://localhost:5173`
- backend/API: `http://localhost:3030`

Dev-режим доступен по сети сразу после `npm run dev`:

- фронт слушает `0.0.0.0:5173`;
- backend слушает `0.0.0.0:3030`;
- открывать панель с других машин нужно по адресу вида `http://<IP_ВАШЕГО_СЕРВЕРА_ИЛИ_ПК>:5173`.

Если доступ из сети не открывается, обычно проблема уже не в приложении, а в firewall Windows/Linux. В этом случае нужно разрешить входящие подключения на порты `5173` и `3030`.

Production:

```bash
npm run test
npm run build
npm start
```

## Переменные окружения

См. `.env.example`.

Основные:

- `PORT` — порт backend-сервера;
- `HOST` — адрес bind;
- `REFRESH_INTERVAL_MS` — как часто сервер перепроверяет файлы;
- `MAX_RECENT_REQUESTS` — максимальный размер страницы для блока последних запросов;
- `SNIPPET_LENGTH` — длина preview из request/response;
- `SOURCES_CONFIG_PATH` — путь до JSON-файла с источниками;

## Очистка истории

В панели есть кнопка `Очистить историю` с тремя режимами:

- `Архивировать` — сжимает старые log-файлы в `.gz` и переносит их в `.query-analytics-archive/<timestamp>/`;
- `Удалить старые логи` — безвозвратно удаляет старые log-файлы до выбранной даты, включая уже архивированные копии;
- `Полная очистка` — удаляет старые log-файлы и очищает ранее созданный архив этого источника.

Защитные правила для всех режимов:

- файлы за текущий день не трогаются;
- файлы, которые изменялись в последние 10 минут, не трогаются;
- после операции индекс панели автоматически пересобирается.

## Что уже готово в репозитории

- `server/config.ts` — runtime config и загрузка `sources.json`;
- `server/analytics/parser.ts` — нормализация трех форматов логов;
- `server/analytics/indexer.ts` — кеширование файлов и пересканирование;
- `src/App.tsx` — React dashboard;
- `deploy/query-analytics.service` — unit-файл для `systemd`;
- `deploy/remote-deploy.sh` — безопасный deploy по SSH-архиву с сохранением локальных конфигов;
- `.github/workflows/deploy.yml` — CI/CD с упаковкой релиза и доставкой на VPS без `git pull` на сервере;
- `deploy/nginx.query-analytics.conf` — reverse proxy для Nginx.

## VPS и автодеплой

Подробная инструкция:

- `docs/DEPLOY.md`

Там есть:

- подготовка VPS;
- запуск без контейнеров;
- `systemd` service;
- `Nginx` reverse proxy;
- `GitHub Actions` autodeploy;
- список нужных секретов и команд.

## Проверка

Проверено командами:

```bash
npm run typecheck
npm run test
npm run build
```
