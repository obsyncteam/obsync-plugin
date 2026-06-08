# obsync Obsidian Plugin

[English version](README.md)

[![Версия](https://img.shields.io/badge/version-1.6.8-green.svg)](manifest.json)
[![AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Плагин Obsidian для синхронизации obsync.

## Репозитории

- Репозиторий плагина: <https://github.com/obsyncteam/obsync-plugin>
- Сервер Community Edition: <https://github.com/obsyncteam/obsync-ce>
- Сайт: [https://obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme) (международная версия сайта еще в разработке)

## Режимы подключения

- **Obsync service.** Используйте [https://obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme), вставьте ключ плагина из личного кабинета и нажмите `Синхронизировать`.
- **Community Edition.** Используйте адрес своего sync-сервера, например `http://127.0.0.1:4444`, LAN-адрес или HTTPS-домен.

## Возможности

- Синхронизация Markdown-заметок, папок, переименований, удалений и вложений.
- Работа на компьютере и мобильных устройствах.
- Начальная загрузка, начальное скачивание, переподключение и обычная синхронизация.
- История изменений Markdown-заметок на сервере.
- Опциональная синхронизация `.obsidian` выключена по умолчанию.
- Защита локальных данных плагина obsync от циклической синхронизации.
- Управление публикацией заметок и папок для аккаунтов Obsync service.

## Сборка

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Production-сборка создает `main.js`.

## Архив для ручной установки

```bash
npm run pack
```

Имя архива:

```text
obsync_v1.6.8.zip
```

Структура архива:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

## Assets для Obsidian Release

Для GitHub Release, который использует Obsidian, прикрепите:

- `main.js`
- `manifest.json`
- `styles.css`

Release tag должен совпадать с версией в `manifest.json`.

## Disclosures

- Network: плагин отправляет sync metadata и содержимое файлов на настроенный Server URL или на sync route Obsync service, полученный по account token.
- File access: плагин читает, создает, обновляет, переименовывает и удаляет файлы внутри текущего Obsidian vault через Obsidian APIs.
- Token storage: access token хранится в plugin data этого vault. Это не пароль аккаунта.
- Payments: плагин может подключаться к аккаунтам Obsync service. Community Edition можно запускать отдельно на своем сервере.

## Лицензия

obsync Obsidian Plugin распространяется под лицензией `AGPL-3.0-only`.
