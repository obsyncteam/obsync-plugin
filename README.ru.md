# Плагин Obsync для Obsidian

[English version](README.md)

[![Версия](https://img.shields.io/badge/version-1.6.9-green.svg)](manifest.json)
[![AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Плагин Obsidian для Obsync. Он подключает хранилище Obsidian к [self-hosted серверу Obsync Community Edition](https://obsync.ru/ce?utm_source=github&utm_medium=repo_readme) или к [облачному сервису Obsync](https://obsync.ru/?utm_source=github&utm_medium=repo_readme), а затем синхронизирует Markdown-заметки, папки, вложения и последние версии Markdown-заметок между компьютером и телефоном.

## Ссылки

- Сайт проекта: [obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme) (международная версия сайта еще в разработке)
- Страница Community Edition: [obsync.ru/ce](https://obsync.ru/ce?utm_source=github&utm_medium=repo_readme)
- Репозиторий сервера Community Edition: <https://github.com/obsyncteam/obsync-ce>
- Релизы плагина: <https://github.com/obsyncteam/obsync-plugin/releases>

## Установка из релиза

Скачайте архив релиза:

```text
obsync_v1.6.9.zip
```

Распакуйте его в хранилище Obsidian:

```text
<хранилище>/.obsidian/plugins/obsync/
```

Ожидаемая структура папки:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

Перезапустите Obsidian или перезагрузите приложение, затем включите Obsync в Community plugins.

## Режимы подключения

- **Obsync Community Edition.** Используйте адрес своего сервера: локальный адрес, LAN-адрес или публичный HTTPS-домен.
- **Облачный сервис Obsync.** Используйте [https://obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme), вставьте ключ плагина из личного кабинета и нажмите `Синхронизировать`.

## Возможности

- Синхронизация Markdown-заметок, папок, переименований, удалений и вложений.
- Работа на компьютере и мобильных устройствах.
- Начальная загрузка, начальное скачивание, переподключение и обычная синхронизация.
- История изменений Markdown-заметок на сервере.
- Опциональная синхронизация `.obsidian` выключена по умолчанию.
- Защита локальных данных плагина Obsync от циклической синхронизации.
- Управление публикацией заметок и папок, если публикация доступна в подключенном аккаунте Obsync.

## Сборка из исходников

```bash
npm ci
npm run typecheck
npm run build
```

Сборка создает `main.js`.

## Архив для ручной установки

```bash
npm run pack
```

Имя архива:

```text
obsync_v1.6.9.zip
```

Структура архива:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

## Лицензия

Obsync Obsidian Plugin распространяется под лицензией `AGPL-3.0-only`.
