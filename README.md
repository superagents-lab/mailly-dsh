# mailly-dsh

Mailly's workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

It puts the Mailly inbox inside the Harness: a **Mailly** entry in the left sidebar opens a full inbox page
(conversation list, message reader, reply drafting), and the agent working beside it is a normal DSH session
with Mailly tools.

- **The page** reads mail through the Host half. The Mailly API key stays on the machine and never enters the
  browser.
- **The agent** reads a conversation with `mailly_inbox_read_thread` and saves a reply draft with
  `mailly_inbox_save_draft`. Sending stays in Mailly, where the user reviews the draft.
- **Hand to agent** opens a new DSH session with the task already written into the composer, so one
  conversation gets one session.

Email bodies are flattened to plain text before they reach the model or the page; original HTML is neither
rendered nor trusted, and the agent is told to treat mail as external data.

## Why this is its own repository

The MCP repository ([superagents-lab/mailly-mcp](https://github.com/superagents-lab/mailly-mcp)) ships the
hosted MCP server and the thin client packages for Claude, ChatGPT and Codex. This repository ships a client
**application**: a DSH Host plugin (routes, credentials, model tools) plus a DSH Client plugin (React page).
It shares no build-time code with the MCP repository — only the Mailly REST contract — so it versions,
tests and releases independently.

## Layout

```
package.json       bundle manifest, Client module declaration, scripts
cordis.patch.yml   one Host row: @mailly/dsh
host/index.js      Host half: /mailly-api/* routes, key storage, model tools
client/index.js    Client half: sidebar entry + the inbox page
locale/            plugin-manager display text (en, zh)
icon.svg           Mailly icon
test/              node --test suites (host routes and the page flow)
```

## Install

DSH installs a local package directory as a bundle:

```
plugin_manager install_bundle
  target: /path/to/mailly-dsh
```

The plugin appears in **Plugins** as “Mailly workbench”. Installing it adds three model tools, the sidebar
entry, and the `/mailly-api/*` routes. Reload the Web page if the Mailly entry does not appear immediately.

Once the package is published to npm, the same bundle installs by package name instead of by path.

## Connect an account

Open the Mailly entry and paste a Mailly API key — create one at
<https://mailly.site/app/developers>. The key is written to `$DSH_HOME/mailly/api-key` (mode 0600) and never
reaches the browser. The page's **更换 key / Change key** control clears it and reopens the connect card.

Prefer environment configuration? Set `MAILLY_API_KEY` before starting the Harness and it wins over the stored
file. `MAILLY_API_URL` overrides the API endpoint (default `https://api.mailly.site`).

Use a key whose scopes match what the agent should do. A key without `send` still reads mail and saves drafts;
keep `send` for the Mailly review page only.

## Model tools

| Tool | Effect |
|---|---|
| `mailly_inbox_list_threads` | Lists conversations (subject, sender, snippet, unread). Search covers metadata, not bodies. |
| `mailly_inbox_read_thread` | Reads one conversation in order: sender, time, plain-text body, plus drafts already saved for it. |
| `mailly_inbox_save_draft` | Saves a reply draft through `POST /mail-drafts`. Never sends. A retried call reuses the same idempotency key, so no duplicate drafts. |

## Host routes

All under `http://127.0.0.1:<port>/mailly-api`, loopback and same-origin only:

| Route | Purpose |
|---|---|
| `GET /status` | Whether a key is configured, its source, API base. |
| `POST /key`, `DELETE /key` | Store or clear the API key after a `/balance` check. |
| `GET /threads?q=&limit=` | Trimmed conversation list. |
| `GET /thread?id=` | Trimmed conversation plus its drafts. |
| `POST /drafts` | Save a reply draft. |
| `GET /balance` | Credit balance. |

The routes are a fixed surface, not a proxy: unknown paths answer 404 instead of reaching Mailly, and no
route accepts a caller-chosen upstream URL.

## Develop

```
npm run check   # node --check both halves
npm test        # node --test: host routes + the page flow, no network or credentials
```

Both suites run against a fake Mailly API and a minimal React stand-in, so they work in CI without a
Harness installation.

## Not in this version

- OAuth sign-in (Mailly API key only).
- Sending from the workbench. Mailly's review page is the send button.
- Inbound-mail automation. A later step points a Mailly inbox webhook at the DSH webhook runtime so a new
  email starts a session by itself.

## License

MIT
