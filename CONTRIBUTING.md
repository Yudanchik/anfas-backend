# Ветки и окружения Anfas

Единый порядок работы для frontend, NestJS backend и Strapi CMS.

## Ветки

- `dev` — интеграционная ветка и будущий dev-стенд.
- `main` — стабильная ветка и будущий production-стенд; основная ветка репозитория.
- Рабочие ветки создаются от актуальной `dev`: `feat/user-profile`, `fix/session-expiry`, `chore/update-dependencies`, `docs/local-startup`, `refactor/auth-store`, `test/auth-regression`.
- Новые ветки создаём без префикса `codex/`. Старые исторические ветки можно оставить до отдельной уборки.

Рабочий порядок: обновить `dev` → создать тематическую ветку → внести изменения и выполнить нужные проверки → push рабочей ветки → PR в `dev` → проверка → squash merge. Релиз: отдельный PR `dev` → `main`, после проверки dev-стенда и явного разрешения на production. Не отправлять изменения напрямую в `main` и не выполнять force push основных веток.

Коммиты: `feat: добавить личный кабинет`, `fix: исправить выход из аккаунта`; заголовок и описание по-русски, с поведением и выполненными проверками.

## Раздельные стенды

| Проект | Dev | Production |
| --- | --- | --- |
| Frontend | ветка `dev`, API/CMS dev | ветка `main`, API/CMS production |
| NestJS | ветка `dev`, база `anfas_backend_dev` | ветка `main`, база `anfas_backend_prod` |
| Strapi | ветка `dev`, база `anfas_cms_dev` | ветка `main`, база `anfas_cms_prod` |

Это целевая схема размещения, а не уже созданные серверные базы. Локальные `anfas_backend` и `anfas_cms` остаются локальными, их имена и данные не меняются.

Для каждого окружения нужны собственные переменные, роли/пароли БД, секреты, резервные копии и хранилище Strapi uploads. Dev не должен обращаться к production-базам, API или uploads. Базы можно разместить на одном PostgreSQL-сервере с отдельными ролями и правами. Контейнеры, порты и volumes должны иметь разные имена; локальный Compose пока предназначен для одного локального окружения.

Для NestJS отдельно задаются `DATABASE_URL`, `FRONTEND_ORIGINS` и `NODE_ENV`; для Strapi — параметры БД, APP_KEYS, соли, JWT-секреты и адрес CMS. Production требует HTTPS и защищённых cookie. Секреты не помещать в Git и публичные переменные frontend `VITE_*`.

В будущем workflow должны использовать GitHub environments `development` и `production` с раздельными секретами и адресами. В этом этапе для backend/CMS созданы ветки; серверы и автоматический деплой ещё не настроены. Frontend уже имеет отдельный workflow REG.RU для dev/production.

## Проверки

Backend: `pnpm check`, `pnpm build`, `pnpm test` при работающей локальной PostgreSQL. Strapi: `pnpm check`, `pnpm build`; parity-команды проверяют контент только нужного запущенного экземпляра через `STRAPI_URL`. Frontend: `pnpm check`, `pnpm build` и браузерные проверки изменённых сценариев.
