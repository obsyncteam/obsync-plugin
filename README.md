# obsync Obsidian Plugin

[Русская версия](README.ru.md)

[![Version](https://img.shields.io/badge/version-1.6.8-green.svg)](manifest.json)
[![AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Obsidian plugin for obsync sync.

## Repositories

- Plugin repository: <https://github.com/obsyncteam/obsync-plugin>
- Community Edition server: <https://github.com/obsyncteam/obsync-ce>
- Website: [https://obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme) (international website is still in development)

## Connection Modes

- **Obsync service.** Use [https://obsync.ru](https://obsync.ru/?utm_source=github&utm_medium=repo_readme), paste the plugin token from your account, and press `Sync`.
- **Community Edition.** Use your own sync server URL, for example `http://127.0.0.1:4444`, a LAN address, or an HTTPS domain.

## Features

- Syncs Markdown notes, folders, renames, deletions and attachments.
- Works on desktop and mobile.
- Supports initial upload, initial download, reconnect and regular sync.
- Keeps change history for Markdown notes on the server.
- Optional `.obsidian` sync is off by default.
- Protects local obsync plugin data from sync loops.
- Adds note and folder publication controls for Obsync service accounts.

## Build

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The production build writes `main.js`.

## Manual Release Zip

```bash
npm run pack
```

The archive name is:

```text
obsync_v1.6.8.zip
```

Archive structure:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

## Obsidian Release Assets

For a GitHub Release used by Obsidian, attach:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must match `manifest.json` version.

## Disclosures

- Network: the plugin sends sync metadata and file content to the configured server URL or to the Obsync service sync route returned by the account token.
- File access: the plugin reads, creates, updates, renames and deletes files inside the currently opened Obsidian vault through Obsidian APIs.
- Token storage: the access token is stored in this vault plugin data. It is not an account password.
- Payments: the plugin can connect to Obsync service accounts. Community Edition can be self-hosted separately.

## License

obsync Obsidian Plugin is licensed under `AGPL-3.0-only`.
