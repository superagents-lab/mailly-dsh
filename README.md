# mailly-dsh

Mailly's workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

It puts the Mailly inbox inside the Harness in two places, both fed by the same Host half:

- **The full inbox** — the **Mailly** entry in the left sidebar opens a page with the conversation list, the
  reader, reply drafting, and an agent panel beside it.
- **The Mailly tab** — expand the right sidebar and pick **Mailly** from its guide (the same way the file,
  browser and terminal tabs are opened). It is one column that drills from the list into a conversation, so
  the mail sits next to the conversation you are already having.

The Mailly credential never enters the browser, no model tool can send, and mail HTML is rendered only after a
sanitizing pass inside a frame that cannot run scripts.

## What it does

| | |
|---|---|
| Read mail | Conversation list with search, sender avatars and unread marks; a reader that renders the authored HTML. |
| Draft replies | Save a plain-text draft from the page or let the agent write one. |
| Send | Two-step, human-only: the exact draft text, an explicit "I reviewed this exact text" toggle, then Send. The Host re-reads the draft and refuses if the revision or text moved. |
| Hand to agent | Carries the whole conversation into the agent's prompt — no read round-trip. |
| Sign in | Mailly device authorization, or a pasted API key. |
| Inbound automation | Optional long poll that starts one DSH session per conversation thread. |

## Trust boundaries

- **The page** reads mail through the Host half over same-origin `/mailly-api/*` routes. The credential stays
  on the machine.
- **The agent** reads a conversation with `mailly_inbox_read_thread` and saves a reply draft with
  `mailly_inbox_save_draft`. No model tool can send.
- **Sending** is the one route that can deliver mail (`POST /drafts/<id>/approve`), and it only reaches Mailly
  after re-reading the draft and matching revision and text byte-for-byte against what the page showed. No
  model tool calls it, and the page never calls it without a human click. Mailly's review page stays available
  as the other send path.
- **Mail HTML** is authored by strangers. The Host runs an allowlist pass (dangerous elements lose their
  subtree, unknown tags lose only their tag, attributes and URLs are filtered, links open outside) and the page
  renders the result in a frame with `sandbox="allow-same-origin"` — no scripts, no forms, no popups — under a
  CSP of `default-src 'none'`. Images load like a mail client and can be turned off per message. The body sits
  on a light paper surface in both themes, because authored mail carries its own colours.
- **The model only ever receives the plain-text body**, and the agent is told to treat mail as external data.

## Why this is its own repository

The MCP repository ([superagents-lab/mailly-mcp](https://github.com/superagents-lab/mailly-mcp)) ships the
hosted MCP server and the thin client packages for Claude, ChatGPT and Codex. This repository ships a client
**application**: a DSH Host plugin (routes, credentials, model tools) plus a DSH Client plugin (React page,
sidebar tab). It shares no build-time code with the MCP repository — only the Mailly REST contract — so it
versions, tests and releases independently.

## Layout

```
package.json           bundle manifest, Client module declaration, scripts
cordis.patch.yml       one Host row: @mailly/dsh
host/index.js          Host half: /mailly-api/* routes, credential storage, model tools, agent sessions
host/automation.js     inbound long poll: cursor, dedupe, one session per thread, backoff
client/index.js        Client half: sidebar entry, full inbox page, right-sidebar tab
locale/                plugin-manager display text (en, zh)
icon.svg               Mailly icon
docs/design/           verified Mailly and DSH contracts behind the next features
test/                  node --test suites: host routes, credentials, page flow, automation
```

## Install

DSH installs a local package directory as a bundle:

```
plugin_manager install_bundle
  target: /path/to/mailly-dsh
```

The plugin appears in **Plugins** as “Mailly workbench”. Installing it adds three model tools, the left-sidebar
entry, the `/mailly-api/*` routes, and — when the right sidebar is present — the Mailly tab and its guide card.
If the entry does not appear, reload the Web page once.

Once the package is published to npm, the same bundle installs by package name instead of by path.

## Connect an account

Open the Mailly entry and choose **使用 Mailly 账号登录 / Sign in with Mailly**. The workbench starts a Mailly
device-authorization flow and opens the Mailly page in a new tab (the same link is shown with a copy button).
Approve it there; the page polls until Mailly approves, then loads the inbox. The connected address is shown
next to **更换凭据 / Change key**.

Prefer a key? **改用 API key / Use an API key** reveals the paste form — create a key at
<https://mailly.site/app/developers>.

Credential precedence, first hit wins:

1. `MAILLY_API_KEY` in the Harness process environment (`source: 'env'`, never written to disk).
2. `$DSH_HOME/mailly/auth.json` from "Sign in with Mailly" (`source: 'device'`).
3. `$DSH_HOME/mailly/api-key` from the paste form (`source: 'file'`).

`MAILLY_API_URL` overrides the API endpoint (default `https://api.mailly.site`).

Use a credential whose scopes match what the agent should do. A credential without `mail:send` still reads
mail and saves drafts; both views hide the send control and keep the Mailly review link.

### Files on disk

Everything the plugin keeps lives in `$DSH_HOME/mailly/`, owner-only:

| File | Holds |
|---|---|
| `api-key` | The pasted API key (mode 0600). |
| `auth.json` | The device credential: `{ version, apiKey, email, obtainedAt, method: 'device' }` (0600). |
| `sessions.json` | The conversation → DSH session map used by the agent panel (0600). |
| `automation.json` | Inbound automation state: cursor, thread map, dedupe ring, hourly window (0600). |

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
| `GET /status` | Whether a credential is configured, its source (`env` / `device` / `file` / `none`), the connected email and account scopes when known, API base. |
| `POST /auth/device/start` | Start "Sign in with Mailly"; returns `{ deviceToken, verificationUrl, expiresIn, interval }`. |
| `POST /auth/device/poll` | One poll of the sign-in flow: `{ status: 'pending' }`, `{ status: 'approved', email }` or `{ status: 'expired' }`. |
| `POST /auth/device/cancel` | Abandon the pending sign-in flow. |
| `POST /key`, `DELETE /key` | Store or clear the pasted API key after a `/balance` check. `DELETE` also clears the device credential. |
| `GET /threads?q=&limit=` | Trimmed conversation list. |
| `GET /thread?id=` | Trimmed conversation plus its drafts (each with `revision` and `text`), and the sanitized `html` of every message beside its plain text. |
| `POST /drafts` | Save a reply draft. |
| `POST /drafts/<id>/approve` | Human-confirmed send: body `{ revision, text }`. `200 { ok, draft }`; `409 draft_changed`; `403 send_forbidden`; `402 no_balance`; `429 rate_limited`; `503 unconfirmed`. |
| `POST /drafts/<id>/discard` | Discard a draft: body `{ revision }`; `200 { ok: true }`, `409` when the revision moved. |
| `GET /balance` | Credit balance. |
| `GET /automation`, `PUT /automation` | Inbound automation state (`enabled`, `cursor`, `threadCount`, `hourlyCount`, `lastError`, `available`, `running`); `PUT` takes `{ enabled }`. |
| `POST /agent/session` | Open (or reuse) the DSH session for one conversation: body `{ thread_id, prompt? }` → `{ sessionId, threadId }`; `409 agent_unavailable` without a session service. |
| `POST /agent/prompt` | Queue a prompt in that session: body `{ session_id, text }` → `{ accepted: true }`. |
| `GET /agent?session=` | The session transcript as plain text messages (`user` / `assistant`), newest 60. |

The routes are a fixed surface, not a proxy: unknown paths answer 404 instead of reaching Mailly, and no
route accepts a caller-chosen upstream URL. No route returns the credential.

## Handing a conversation to the agent

Both views carry the conversation itself into the prompt — every message as plain text, the message a reply
anchors to, and any drafts already saved — so the agent starts from exactly what the reader sees and needs no
read round-trip. `mailly_inbox_read_thread` stays available for whatever it decides it still needs. The prompt
states that mail is external data and that sending is the human's decision.

- **Full inbox:** **Hand to agent** opens the agent panel beside the reader. Each conversation owns one DSH
  session (mapped in `sessions.json`); later questions go to the same session, and the panel shows the
  transcript while you keep reading.
- **Sidebar tab:** there is no agent panel — the conversation is already next to it — so **Send to agent**
  inserts the prompt into the composer for you to review and send. If the composer cannot take it, the prompt
  is queued in the current session instead.

## Inbound automation

Off by default. When enabled (`PUT /mailly-api/automation { enabled: true }`), the Host long-polls Mailly's
`GET /inbox/messages/wait` and starts a DSH session for each new email — one session per conversation thread:
a follow-up in a thread prompts that thread's existing session instead of creating another. The session is
told to read the thread and save a reply draft; it never sends. State lives in `automation.json`, so a restart
neither repeats nor skips mail. At most five sessions start per hour; poll failures back off up to 60 s. Long
polling is used because Mailly refuses loopback webhook URLs, so a laptop-only Host needs no public address.

## Reloading while developing

A linked checkout is read on every activation, so a code change goes live without restarting DeepSeek Harness:
turn the bundle off and on in **Plugins**, or let the Harness reload it.

- **Host code** (`host/*.js`) is live immediately: the route handler dispatches through a process-wide runtime
  that each activation repoints, so a reloaded plugin answers with the new code even if an earlier activation
  left its route behind.
- **Client code** (`client/index.js`) registers its slots on every activation, and both surfaces render through
  a runtime indirection that a reloaded bundle repoints. Every registration an activation makes — including the
  locale dictionaries — is owned by its fiber, so a reload disposes it cleanly and the next activation starts
  from scratch. A reload must never skip registration, or the entry disappears until a restart.

Only a change to the package's own `package.json` or to the Harness itself always needs a restart.

## Develop

```
npm run check   # node --check both halves
npm test        # node --test: 120 cases, no network or credentials
```

Four suites run against a fake Mailly API, a fake DSH session service, and a minimal React stand-in, so they
work in CI without a Harness installation: `test/host.test.mjs` (routes, shaping, tools, agent routes),
`test/host.auth.test.mjs` (credentials, device flow, send), `test/client.test.mjs` (both surfaces, prompt
building, HTML frame), `test/automation.test.mjs` (long poll, dedupe, backoff, state file).

## Not in this version

- Scoped OAuth 2.1 sign-in. "Sign in with Mailly" is Mailly's device-authorization flow, which hands back the
  account's API key rather than scoped tokens.
- Webhook delivery for inbound mail. The long-poll transport above needs no public URL; a Mailly webhook would
  need a tunnel and a signed receiver.
- Sending without a human click. The workbench deliberately has no such path.

## License

MIT
