# mailly-dsh

Mailly's workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

It puts the Mailly inbox inside the Harness: a **Mailly** entry in the left sidebar opens a full inbox page
(conversation list, message reader, reply drafting), and the agent working beside it is a normal DSH session
with Mailly tools.

- **The page** reads mail through the Host half. The Mailly credential stays on the machine and never enters the
  browser.
- **The agent** reads a conversation with `mailly_inbox_read_thread` and saves a reply draft with
  `mailly_inbox_save_draft`. No model tool can send.
- **Sending always goes through a human review.** In the workbench it is a two-step confirmation: the exact
  draft text, then an explicit "I reviewed this exact text" toggle, then a Send button. The Host re-checks the
  draft's revision and text before Mailly is asked to send, and refuses if anything moved. The Mailly review
  page stays available as the other send path.
- **Hand to agent** opens a new DSH session with the task already written into the composer, so one
  conversation gets one session. The prompt says "do not send" and never offers a send step.

The page renders a mail's authored HTML the way a mail client does, but never trusts it: the Host runs an
allowlist pass (dangerous elements lose their subtree, attributes and URLs are filtered, links open outside),
and the page renders the result inside a frame with no script permission and a CSP that blocks remote loads —
tracking pixels stay blocked until the reader asks for images. **The model only ever receives the plain-text
body**, and the agent is told to treat mail as external data.

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
host/index.js      Host half: /mailly-api/* routes, credential storage, model tools
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

Open the Mailly entry and choose **使用 Mailly 账号登录 / Sign in with Mailly**. The workbench starts a Mailly
device-authorization flow and opens the Mailly page in a new tab (the same link is shown with a copy button).
Approve it there; the page polls until Mailly approves, then loads the inbox. The connected address is shown
next to **更换凭据 / Change key**.

Prefer a key? **改用 API key / Use an API key** reveals the paste form — create a key at
<https://mailly.site/app/developers>. The key is written to `$DSH_HOME/mailly/api-key` (mode 0600) and never
reaches the browser. The sign-in flow writes `$DSH_HOME/mailly/auth.json` (mode 0600, `{ version, apiKey,
email, obtainedAt, method: 'device' }`).

Credential precedence, first hit wins:

1. `MAILLY_API_KEY` in the Harness process environment (`source: 'env'`, never written to disk).
2. `$DSH_HOME/mailly/auth.json` from "Sign in with Mailly" (`source: 'device'`).
3. `$DSH_HOME/mailly/api-key` from the paste form (`source: 'file'`).

`MAILLY_API_URL` overrides the API endpoint (default `https://api.mailly.site`).

Use a credential whose scopes match what the agent should do. A credential without `mail:send` still reads
mail and saves drafts; the workbench hides the send control and keeps the Mailly review link.

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
| `GET /thread?id=` | Trimmed conversation plus its drafts (each with `revision` and `text`). |
| `POST /drafts` | Save a reply draft. |
| `POST /drafts/<id>/approve` | Human-confirmed send: body `{ revision, text }`. `200 { ok, draft }`; `409 draft_changed`; `403 send_forbidden`; `402 no_balance`; `429 rate_limited`; `503 unconfirmed`. |
| `POST /drafts/<id>/discard` | Discard a draft: body `{ revision }`; `200 { ok: true }`, `409` when the revision moved. |
| `GET /balance` | Credit balance. |
| `GET /automation`, `PUT /automation` | Inbound automation state (`enabled`, `cursor`, `threadCount`, `hourlyCount`, `lastError`, `available`, `running`); `PUT` takes `{ enabled }`. |
| `POST /agent/session` | Open (or reuse) the DSH session for one conversation: body `{ thread_id, prompt? }` → `{ sessionId, threadId }`; `409 agent_unavailable` without a session service. |
| `POST /agent/prompt` | Queue a follow-up in that session: body `{ session_id, text }` → `{ accepted: true }`. |
| `GET /agent?session=` | The session transcript as plain text messages (`user` / `assistant`), newest 60. |

The routes are a fixed surface, not a proxy: unknown paths answer 404 instead of reaching Mailly, and no
route accepts a caller-chosen upstream URL. No route returns the credential.

`approve` is the only route that can send, and it only reaches Mailly after re-reading the draft and matching
the revision and text byte-for-byte against what the page showed. No model tool calls it, and the page never
calls it without a human click.

## Two places to read mail

- **The full inbox** (the Mailly entry in the left sidebar) is the browsing surface: list, reader, drafts,
  and the agent panel.
- **The Mailly tab in the right sidebar** sits beside the conversation: one column that drills from the list
  into a conversation, with the same HTML bodies, drafts and two-step send. There is no agent panel there —
  the conversation is already next to it — so **Send to agent** queues the hand-off prompt straight into the
  current Session (`POST /mailly-api/agent/prompt`). Open it from the Mailly button in the conversation
  header.

Both views read through the same Host routes; the tab is registered only when the right sidebar is present,
so a profile without it keeps the full page working.

## Agent beside the inbox

**Hand to agent** opens the agent panel next to the conversation instead of leaving the page. Each Mailly
conversation owns one DSH session (mapped in `$DSH_HOME/mailly/sessions.json`, mode 0600): the first hand-off
starts it with the draft task, later questions go to the same session, and the panel shows the transcript
while you keep reading the mail. The panel never sends anything.

The hand-off prompt carries the conversation itself — every message as plain text, the message a reply
anchors to, and any drafts already saved — so the agent starts from exactly what the reader sees and needs no
read round-trip. `mailly_inbox_read_thread` stays available for whatever the agent decides it still needs.

## Inbound automation

Off by default. When enabled (`PUT /mailly-api/automation { enabled: true }`), the Host long-polls Mailly's
`GET /inbox/messages/wait` and starts a DSH session for each new email — one session per conversation thread:
a follow-up in a thread prompts that thread's existing session instead of creating another. The session is
told to read the thread and save a reply draft; it never sends. State (cursor, thread-to-session map, dedupe
ring, hourly window) lives in `$DSH_HOME/mailly/automation.json` (mode 0600), so a restart neither repeats
nor skips mail. At most five sessions start per hour; poll failures back off up to 60 s. Long polling is used
because Mailly refuses loopback webhook URLs, so a laptop-only Host needs no public address.

## Reloading while developing

A linked checkout is read on every activation, so a code change goes live without restarting DeepSeek
Harness: turn the bundle off and on in **Plugins**, or let the Harness reload it.

- **Host code** (`host/*.js`) is live immediately: the route handler dispatches through a process-wide
  runtime that each activation repoints, so a reloaded plugin answers with the new code even if an earlier
  activation left its route behind.
- **Client code** (`client/index.js`) hot-swaps the page: a reloaded bundle hands its page component to the
  one already on screen, so the full inbox picks up new code without a page reload.
- **A new slot registration** (a new sidebar entry, tab, or header button) needs one page reload, because the
  page's module loader keeps the instance that first registered the slots. Restart DeepSeek Harness once after
  adding one; later code changes in the same slots hot-swap as above.

Only a change to the package's own `package.json` or to the Harness itself always needs a restart.

## Develop

```
npm run check   # node --check both halves
npm test        # node --test: host routes + the page flow, no network or credentials
```

Both suites run against a fake Mailly API and a minimal React stand-in, so they work in CI without a
Harness installation.

## Not in this version

- Scoped OAuth 2.1 sign-in. "Sign in with Mailly" is Mailly's device-authorization flow, which hands back the
  account's API key rather than scoped tokens.
- Webhook delivery for inbound mail. The long-poll transport above needs no public URL; a Mailly webhook
  would need a tunnel and a signed receiver.

## License

MIT
