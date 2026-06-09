# Obsync Obsidian Plugin

[Русская версия](README.ru.md)

[![Version](https://img.shields.io/badge/version-1.6.9-green.svg)](manifest.json)
[![AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Obsidian plugin for Obsync sync. It connects an Obsidian vault to a [self-hosted Obsync Community Edition server](https://obsync.ru/ce?utm_source=github&utm_medium=repo_readme) or to the [hosted Obsync service](https://obsync.ru/?utm_source=github&utm_medium=repo_readme).

## Links

- Website: [obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme)
- Community Edition page: [obsync.ru/ce](https://obsync.ru/ce?utm_source=github&utm_medium=repo_readme)
- Community Edition server repository: <https://github.com/obsyncteam/obsync-ce>
- Plugin releases: <https://github.com/obsyncteam/obsync-plugin/releases>

The international website is in development.

## Install From Release

Download the release archive:

```text
obsync_v1.6.9.zip
```

Unpack it into your Obsidian vault:

```text
<vault>/.obsidian/plugins/obsync/
```

Expected folder contents:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

Restart Obsidian or reload the app, then enable Obsync in Community plugins.

## Connection Modes

- **Obsync Community Edition.** Use your own server URL: a local address, a LAN address or a public HTTPS domain.
- **Hosted Obsync service.** Use [https://obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme), paste the plugin token from your account, and press `Sync`.

## Features

- Syncs Markdown notes, folders, renames, deletions and attachments.
- Works on desktop and mobile.
- Supports initial upload, initial download, reconnect and regular sync.
- Keeps change history for Markdown notes on the server.
- Optional `.obsidian` sync is off by default.
- Protects local Obsync plugin data from sync loops.
- Adds note and folder publication controls when publishing is available for the connected Obsync account.

## Build From Source

```bash
npm ci
npm run typecheck
npm run build
```

The production build writes `main.js`.

## Manual Release Zip

```bash
npm run pack
```

The archive name is:

```text
obsync_v1.6.9.zip
```

Archive structure:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

## License

Obsync Obsidian Plugin is licensed under `AGPL-3.0-only`.
