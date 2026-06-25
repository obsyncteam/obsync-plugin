# Obsync Plugin for Obsidian

[Русская версия](README.ru.md)

[![Version](https://img.shields.io/badge/version-1.6.25-green.svg)](manifest.json)
[![AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Obsidian plugin for Obsync. It connects an Obsidian vault to a [self-hosted Obsync Community Edition server](https://obsync.ru/ce?utm_source=github&utm_medium=repo_readme) or to the [managed Obsync service](https://obsync.ru/?utm_source=github&utm_medium=repo_readme).

## Links

- Project site: [obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme) (the international site is in development)
- Community Edition page: [obsync.ru/ce](https://obsync.ru/ce?utm_source=github&utm_medium=repo_readme)
- Community Edition server repository: <https://github.com/obsyncteam/obsync-ce>
- Plugin releases: <https://github.com/obsyncteam/obsync-plugin/releases>

## Install from Release

Download the release archive:

```text
obsync_v1.6.25.zip
```

Unpack it into your Obsidian vault:

```text
<vault>/.obsidian/plugins/obsync/
```

Expected folder structure:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

Restart Obsidian or reload the app, then enable Obsync in Community plugins.

## Connection Modes

- **Obsync Community Edition.** Use your own server address: local address, LAN address, or public HTTPS domain.
- **Managed Obsync service.** Use [https://obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme), paste the plugin key from your account, and press `Sync`.

## Features

- Sync Markdown notes, folders, renames, deletes, and attachments.
- Work on desktop and mobile devices.
- Initial upload, initial download, reconnect, and regular sync.
- Markdown note version history on the server.
- Optional `.obsidian` sync is disabled by default.
- Protection against syncing the local Obsync plugin data back into itself.
- Note and folder publishing controls when publishing is available in the connected Obsync account.

## Build from Source

```bash
npm ci
npm run typecheck
npm run build
```

The build creates `main.js`.

## Manual Install Archive

```bash
npm run pack
```

Archive name:

```text
obsync_v1.6.25.zip
```

Archive structure:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

## License

Obsync Obsidian Plugin is licensed under `AGPL-3.0-only`.
