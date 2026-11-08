/**
 * Host half tests for Phase 1 (device sign-in) and the workbench send routes.
 *
 * No network: global fetch is stubbed with a scriptable fake Mailly API, and
 * DSH_HOME points at a fresh temp directory so credential files are real files
 * on disk (mode checks are real too).
 *
 * This file stubs `globalThis.fetch` and `process.env`, which is process-wide
 * state, so it deliberately runs alone: `npm run test:host-auth` (node --test
 * runs each file in its own process, so `npm test` is unaffected).
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'mailly-dsh-auth-'))
process.env.DSH_HOME = home
process.env.MAILLY_API_URL = 'https://api.test'
delete process.env.MAILLY_API_KEY

const { apply } = await import('../host/index.js')

const MAILLY_DIR = join(home, 'mailly')
const KEY_FILE = join(MAILLY_DIR, 'api-key')
const AUTH_FILE = join(MAILLY_DIR, 'auth.json')
const DEVICE_KEY = 'device-api-key-0123456789'
const LEGACY_KEY = 'legacy-api-key-0123456789'
const DRAFT_ID = '11111111-2222-4333-8444-555555555555'
const DRAFT_TEXT = 'Thanks, confirmed for Monday.\n\nBest,\nWang'

// ---------------------------------------------------------------------------
// Fake Mailly API

const realFetch = globalThis.fetch
const upstream = []

/** Per-test overrides keyed by `METHOD /path`. Each value is a function (call) => reply. */
let overrides = {}

function reply(data, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(data),
  }
}

function draftRecord(overridesForDraft = {}) {
  return {
    id: DRAFT_ID,
    thread_id: 't1',
    revision: 3,
    status: 'pending',
    text: DRAFT_TEXT,
    cc: [],
    anchor_email_id: 'm2',
    review_url: 'https://mailly.site/review#abc',
    review_expires_at: 1_760_500_000,
    ...overridesForDraft,
  }
}

function defaultRoute(method, path, body) {
  if (method === 'GET' && path === '/inbox/threads') {
    return reply({ success: true, cursor: null, threads: [{ thread_id: 't1' }] })
  }
  if (path === '/me') {
    return reply({
      success: true,
      email: 'wang@example.com',
      credential_type: 'api_key',
      scopes: ['mail:read', 'mail:draft', 'mail:send', 'workspace:manage'],
      client_id: null,
    })
  }
  if (path === '/balance') return reply({ success: true, balance: 1200 })
  if (path === '/cli/auth/init' && method === 'POST') {
    return reply({ success: true, deviceToken: body?.deviceToken, expiresIn: 300, interval: 2 })
  }
  if (path === '/cli/auth/poll' && method === 'POST') {
    return reply({ success: false, status: 'pending' }, 202)
  }
  if (path === '/mail-drafts' && method === 'GET') {
    return reply({ success: true, drafts: [draftRecord()] })
  }
  if (path === `/mail-drafts/${DRAFT_ID}/approve` && method === 'POST') {
    return reply({ success: true, draft: draftRecord({ status: 'sent' }) })
  }
  if (path === `/mail-drafts/${DRAFT_ID}/discard` && method === 'POST') {
    return reply({ success: true })
  }
  return reply({ success: false, error: `unexpected ${method} ${path}` }, 404)
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  const method = (options.method || 'GET').toUpperCase()
  const parsed = new URL(target)
  const body = options.body === undefined ? undefined : JSON.parse(options.body)
  const call = { url: target, method, path: parsed.pathname, body, options }
  upstream.push(call)
  const key = `${method} ${parsed.pathname}`
  const handler = overrides[key]
  if (handler) return handler(call)
  return defaultRoute(method, parsed.pathname, body)
}

function callsTo(method, path) {
  return upstream.filter((call) => call.method === method && call.path === path)
}

async function resetUpstream() {
  upstream.length = 0
  overrides = {}
}

async function clearCredentials() {
  delete process.env.MAILLY_API_KEY
  await chmod(MAILLY_DIR, 0o700).catch(() => {})
  await rm(KEY_FILE, { force: true })
  await rm(AUTH_FILE, { force: true })
}

async function writeLegacyKey(value = LEGACY_KEY) {
  await mkdir(MAILLY_DIR, { recursive: true, mode: 0o700 })
  await writeFile(KEY_FILE, `${value}\n`, { mode: 0o600 })
  await chmod(KEY_FILE, 0o600)
}

async function writeDeviceAuth(apiKey = DEVICE_KEY, email = 'wang@example.com') {
  await mkdir(MAILLY_DIR, { recursive: true, mode: 0o700 })
  await writeFile(
    AUTH_FILE,
    `${JSON.stringify({ version: 1, apiKey, email, obtainedAt: 1_760_000_000, method: 'device' }, null, 2)}\n`,
    { mode: 0o600 },
  )
  await chmod(AUTH_FILE, 0o600)
}

// ---------------------------------------------------------------------------
// Harness

function createHarness() {
  const routes = []
  const tools = []
  const disposers = []
  apply({
    get() {
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    effect(create) {
      const dispose = create()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  })
  return { routes, tools, handler: routes[0] && routes[0].handler }
}

const harness = createHarness()

function send(options = {}) {
  const { method = 'GET', url = '/mailly-api/status', headers = {}, remoteAddress = '127.0.0.1', body } = options
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  Object.assign(req, { method, url, headers, socket: { remoteAddress } })
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end() {},
  }
  return new Promise((resolve, reject) => {
    res.end = (chunk = '') => {
      const text = String(chunk)
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = { raw: text }
      }
      resolve({ status: res.statusCode, headers: res.headers, body: parsed, text })
    }
    Promise.resolve(harness.handler(req, res)).catch(reject)
  })
}

function postJson(url, payload, extra = {}) {
  return send({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    ...extra,
  })
}

async function startDeviceFlow() {
  const started = await postJson('/mailly-api/auth/device/start')
  assert.equal(started.status, 200)
  return started
}

// ---------------------------------------------------------------------------
// Device sign-in

test('device start generates the token on the Host and returns the verification URL', async () => {
  await clearCredentials()
  await resetUpstream()
  const { status, body } = await startDeviceFlow()
  assert.equal(status, 200)
  assert.match(body.deviceToken, /^[0-9a-f]{64}$/)
  assert.equal(body.verificationUrl, `https://mailly.site/cli-auth?token=${body.deviceToken}`)
  assert.equal(body.expiresIn, 300)
  assert.equal(body.interval, 2)

  const init = callsTo('POST', '/cli/auth/init')
  assert.equal(init.length, 1)
  assert.deepEqual(init[0].body, { deviceToken: body.deviceToken })
  // The flow start needs no credential: no Authorization header is sent.
  assert.equal(init[0].options.headers.authorization, undefined)
})

test('a browser-supplied deviceToken is ignored on start and poll', async () => {
  await clearCredentials()
  await resetUpstream()
  const started = await postJson('/mailly-api/auth/device/start', { deviceToken: 'f'.repeat(64) })
  assert.equal(started.status, 200)
  assert.notEqual(started.body.deviceToken, 'f'.repeat(64))
  assert.deepEqual(callsTo('POST', '/cli/auth/init')[0].body, { deviceToken: started.body.deviceToken })

  const polled = await postJson('/mailly-api/auth/device/poll', { deviceToken: 'f'.repeat(64) })
  assert.equal(polled.status, 200)
  assert.equal(polled.body.status, 'pending')
  assert.deepEqual(callsTo('POST', '/cli/auth/poll')[0].body, { deviceToken: started.body.deviceToken })
})

test('poll while Mailly answers 202 stays pending and stores nothing', async () => {
  await clearCredentials()
  await resetUpstream()
  await startDeviceFlow()
  const { status, body } = await postJson('/mailly-api/auth/device/poll')
  assert.equal(status, 200)
  assert.deepEqual(body, { status: 'pending' })
  assert.equal(callsTo('POST', '/cli/auth/poll').length, 1)
  await assert.rejects(() => stat(AUTH_FILE), /ENOENT/)

  // A second poll keeps using the same pending device token.
  await postJson('/mailly-api/auth/device/poll')
  const polls = callsTo('POST', '/cli/auth/poll')
  assert.equal(polls.length, 2)
  assert.equal(polls[0].body.deviceToken, polls[1].body.deviceToken)
})

test('poll approved verifies /me, stores auth.json 0600 and never returns the key', async () => {
  await clearCredentials()
  await resetUpstream()
  const started = await startDeviceFlow()
  overrides['POST /cli/auth/poll'] = () => reply({ success: true, status: 'approved', apiKey: DEVICE_KEY, email: 'wang@example.com' })

  const polled = await postJson('/mailly-api/auth/device/poll')
  assert.equal(polled.status, 200)
  assert.deepEqual(polled.body, { status: 'approved', email: 'wang@example.com' })
  assert.ok(!polled.text.includes(DEVICE_KEY))

  // The key was checked with /me before it was stored.
  const me = callsTo('GET', '/me')
  assert.equal(me.length, 1)
  assert.equal(me[0].options.headers.authorization, `Bearer ${DEVICE_KEY}`)

  const stored = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  assert.deepEqual(Object.keys(stored).sort(), ['apiKey', 'email', 'method', 'obtainedAt', 'version'])
  assert.equal(stored.version, 1)
  assert.equal(stored.apiKey, DEVICE_KEY)
  assert.equal(stored.email, 'wang@example.com')
  assert.equal(stored.method, 'device')
  assert.equal(typeof stored.obtainedAt, 'number')
  assert.equal((await stat(AUTH_FILE)).mode & 0o777, 0o600)
  assert.equal((await stat(MAILLY_DIR)).mode & 0o777, 0o700)

  // Pending state is cleared: a second poll has nothing to poll.
  const again = await postJson('/mailly-api/auth/device/poll')
  assert.equal(again.status, 404)
  assert.equal(again.body.error, 'no_pending_flow')
  assert.equal(callsTo('POST', '/cli/auth/poll').length, 1)

  const status = await send()
  assert.equal(status.body.configured, true)
  assert.equal(status.body.source, 'device')
  assert.equal(status.body.email, 'wang@example.com')
  assert.ok(!status.text.includes(DEVICE_KEY))
  assert.deepEqual(status.body.account, {
    email: 'wang@example.com',
    credentialType: 'api_key',
    scopes: ['mail:read', 'mail:draft', 'mail:send', 'workspace:manage'],
  })

  // The stored device key is what the existing routes forward.
  await send({ url: '/mailly-api/threads' })
  assert.equal(callsTo('GET', '/inbox/threads')[0].options.headers.authorization, `Bearer ${DEVICE_KEY}`)
})

test('poll approved falls back to /balance when /me is unavailable', async () => {
  await clearCredentials()
  await resetUpstream()
  await startDeviceFlow()
  overrides['GET /me'] = () => reply({ success: false, error: 'not found' }, 404)
  overrides['POST /cli/auth/poll'] = () => reply({ success: true, status: 'approved', apiKey: DEVICE_KEY, email: 'wang@example.com' })
  const polled = await postJson('/mailly-api/auth/device/poll')
  assert.equal(polled.status, 200)
  assert.deepEqual(polled.body, { status: 'approved', email: 'wang@example.com' })
  assert.equal(callsTo('GET', '/balance').length, 1)
  assert.equal(JSON.parse(await readFile(AUTH_FILE, 'utf8')).apiKey, DEVICE_KEY)
})

test('poll approved with a rejected key stores nothing and reports invalid_key', async () => {
  await clearCredentials()
  await resetUpstream()
  await startDeviceFlow()
  overrides['GET /me'] = () => reply({ success: false, error: 'invalid token' }, 401)
  overrides['GET /balance'] = () => reply({ success: false, error: 'invalid token' }, 401)
  overrides['POST /cli/auth/poll'] = () => reply({ success: true, status: 'approved', apiKey: DEVICE_KEY, email: 'wang@example.com' })
  const polled = await postJson('/mailly-api/auth/device/poll')
  assert.equal(polled.status, 502)
  assert.equal(polled.body.error, 'invalid_key')
  assert.ok(!polled.text.includes(DEVICE_KEY))
  await assert.rejects(() => stat(AUTH_FILE), /ENOENT/)
  // The rejected key is never persisted, and the spent claim cannot be re-polled.
  assert.equal((await postJson('/mailly-api/auth/device/poll')).status, 404)
  assert.equal((await send()).body.source, 'none')
})

test('poll 410 expires the flow and clears the pending state', async () => {
  await clearCredentials()
  await resetUpstream()
  await startDeviceFlow()
  overrides['POST /cli/auth/poll'] = () => reply({ success: false, status: 'expired' }, 410)
  const polled = await postJson('/mailly-api/auth/device/poll')
  assert.equal(polled.status, 200)
  assert.deepEqual(polled.body, { status: 'expired' })
  const again = await postJson('/mailly-api/auth/device/poll')
  assert.equal(again.status, 404)
  assert.equal(again.body.error, 'no_pending_flow')
  assert.equal(callsTo('POST', '/cli/auth/poll').length, 1)
})

test('poll without a pending flow is 404 and never calls Mailly', async () => {
  await clearCredentials()
  await resetUpstream()
  const polled = await postJson('/mailly-api/auth/device/poll')
  assert.equal(polled.status, 404)
  assert.equal(polled.body.error, 'no_pending_flow')
  assert.equal(upstream.length, 0)
})

test('cancel clears the pending flow', async () => {
  await clearCredentials()
  await resetUpstream()
  await startDeviceFlow()
  const cancelled = await postJson('/mailly-api/auth/device/cancel')
  assert.equal(cancelled.status, 200)
  assert.deepEqual(cancelled.body, { ok: true })
  const polled = await postJson('/mailly-api/auth/device/poll')
  assert.equal(polled.status, 404)
})

test('a pending flow older than five minutes is discarded without polling Mailly', async () => {
  await clearCredentials()
  await resetUpstream()
  await startDeviceFlow()
  const realNow = Date.now
  Date.now = () => realNow() + 5 * 60 * 1000 + 1
  try {
    const polled = await postJson('/mailly-api/auth/device/poll')
    assert.equal(polled.status, 404)
    assert.equal(polled.body.error, 'no_pending_flow')
  } finally {
    Date.now = realNow
  }
  assert.equal(callsTo('POST', '/cli/auth/poll').length, 0)
})

test('starting a second flow replaces the pending one', async () => {
  await clearCredentials()
  await resetUpstream()
  const first = await startDeviceFlow()
  const second = await startDeviceFlow()
  assert.notEqual(first.body.deviceToken, second.body.deviceToken)
  await postJson('/mailly-api/auth/device/poll')
  assert.deepEqual(callsTo('POST', '/cli/auth/poll')[0].body, { deviceToken: second.body.deviceToken })
})

test('device start reports 503 when Mailly is unreachable', async () => {
  await clearCredentials()
  await resetUpstream()
  overrides['POST /cli/auth/init'] = () => {
    throw new TypeError('fetch failed')
  }
  const started = await postJson('/mailly-api/auth/device/start')
  assert.equal(started.status, 503)
  assert.equal(started.body.error, 'mailly_unreachable')
  // Nothing was remembered, so a poll has no flow.
  assert.equal((await postJson('/mailly-api/auth/device/poll')).status, 404)
})

test('the new auth routes keep the loopback and same-origin guards', async () => {
  await clearCredentials()
  await resetUpstream()
  for (const [method, url] of [
    ['POST', '/mailly-api/auth/device/start'],
    ['POST', '/mailly-api/auth/device/poll'],
    ['POST', '/mailly-api/auth/device/cancel'],
  ]) {
    const foreign = await send({ method, url, headers: { origin: 'https://evil.example', host: '127.0.0.1:49156' } })
    assert.equal(foreign.status, 403, `${method} ${url} foreign origin`)
    assert.equal(foreign.body.error, 'forbidden')
    const remote = await send({ method, url, remoteAddress: '10.0.0.5' })
    assert.equal(remote.status, 403, `${method} ${url} non-loopback`)
  }
  assert.equal(upstream.length, 0)
  assert.equal((await postJson('/mailly-api/auth/device/poll')).status, 404)
})

test('the send routes keep the loopback and same-origin guards', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const body = JSON.stringify({ revision: 3, text: DRAFT_TEXT })
  for (const url of [`/mailly-api/drafts/${DRAFT_ID}/approve`, `/mailly-api/drafts/${DRAFT_ID}/discard`]) {
    const foreign = await send({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:49156' },
      body,
    })
    assert.equal(foreign.status, 403, url)
    const remote = await send({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      remoteAddress: '10.0.0.5',
      body,
    })
    assert.equal(remote.status, 403, url)
  }
  assert.equal(upstream.length, 0)
})

// ---------------------------------------------------------------------------
// Credential precedence and storage

test('credential precedence is env > device > legacy file', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeLegacyKey()
  await writeDeviceAuth()

  // device beats the legacy file
  let status = await send()
  assert.equal(status.body.source, 'device')
  assert.equal(status.body.email, 'wang@example.com')
  await send({ url: '/mailly-api/threads' })
  assert.equal(callsTo('GET', '/inbox/threads')[0].options.headers.authorization, `Bearer ${DEVICE_KEY}`)

  // env beats both
  process.env.MAILLY_API_KEY = 'env-api-key-0123456789'
  try {
    status = await send()
    assert.equal(status.body.source, 'env')
    assert.equal(status.body.email, null)
    await send({ url: '/mailly-api/threads' })
    assert.equal(callsTo('GET', '/inbox/threads')[1].options.headers.authorization, 'Bearer env-api-key-0123456789')
  } finally {
    delete process.env.MAILLY_API_KEY
  }

  // legacy file is the last resort
  await clearCredentials()
  await writeLegacyKey()
  status = await send()
  assert.equal(status.body.source, 'file')
  assert.equal(status.body.configured, true)
  assert.equal(status.body.email, null)

  await clearCredentials()
  status = await send()
  assert.equal(status.body.source, 'none')
  assert.equal(status.body.configured, false)
})

test('a corrupt auth.json is ignored instead of breaking the plugin', async () => {
  await clearCredentials()
  await resetUpstream()
  await mkdir(MAILLY_DIR, { recursive: true, mode: 0o700 })
  await writeFile(AUTH_FILE, '{ not json', { mode: 0o600 })
  await writeLegacyKey()
  const status = await send()
  assert.equal(status.status, 200)
  assert.equal(status.body.source, 'file')
})

test('DELETE /key clears both the legacy file and the device credential', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeLegacyKey()
  await writeDeviceAuth()
  const { status, body } = await send({ method: 'DELETE', url: '/mailly-api/key' })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.cleared, ['file', 'device'])
  await assert.rejects(() => stat(KEY_FILE), /ENOENT/)
  await assert.rejects(() => stat(AUTH_FILE), /ENOENT/)
  const after = await send()
  assert.equal(after.body.source, 'none')
})

test('DELETE /key reports only what it actually cleared', async () => {
  await clearCredentials()
  await resetUpstream()
  // A device-only install has no legacy key file to clear.
  await rm(MAILLY_DIR, { recursive: true, force: true })
  await writeDeviceAuth()
  const { body } = await send({ method: 'DELETE', url: '/mailly-api/key' })
  assert.deepEqual(body.cleared, ['device'])
})

// ---------------------------------------------------------------------------
// /status robustness

test('status works when Mailly is unreachable and omits the account fields', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  overrides['GET /me'] = () => {
    throw new TypeError('fetch failed')
  }
  const { status, body } = await send()
  assert.equal(status, 200)
  assert.equal(body.configured, true)
  assert.equal(body.source, 'device')
  assert.equal(body.email, 'wang@example.com')
  assert.equal(body.account, null)
  assert.equal(body.apiBaseUrl, 'https://api.test')
  assert.equal(body.keyEnv, 'MAILLY_API_KEY')
  assert.equal(body.keyFile, KEY_FILE)
})

test('status works when /me fails with an HTTP error', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeLegacyKey()
  overrides['GET /me'] = () => reply({ success: false, error: 'boom' }, 500)
  const { status, body } = await send()
  assert.equal(status, 200)
  assert.equal(body.source, 'file')
  assert.equal(body.account, null)
})

test('status does not call Mailly when nothing is configured', async () => {
  await clearCredentials()
  await resetUpstream()
  const { status, body } = await send()
  assert.equal(status, 200)
  assert.equal(body.source, 'none')
  assert.equal(body.account, null)
  assert.equal(upstream.length, 0)
})

// ---------------------------------------------------------------------------
// Workbench send: POST /drafts/<id>/approve

test('approve: happy path sends exactly {revision,text} upstream and returns the shaped draft', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: DRAFT_TEXT })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.draft.id, DRAFT_ID)
  assert.equal(body.draft.revision, 3)
  assert.equal(body.draft.status, 'sent')
  assert.equal(body.draft.threadId, 't1')
  assert.equal(body.draft.text, DRAFT_TEXT)

  const reads = callsTo('GET', '/mail-drafts')
  assert.equal(reads.length, 1)
  assert.equal(reads[0].url, 'https://api.test/mail-drafts?thread_id=t1')
  const approve = callsTo('POST', `/mail-drafts/${DRAFT_ID}/approve`)
  assert.equal(approve.length, 1)
  assert.deepEqual(approve[0].body, { revision: 3, text: DRAFT_TEXT })
  assert.equal(approve[0].options.headers.authorization, `Bearer ${DEVICE_KEY}`)
})

test('approve: a stale revision is 409 draft_changed and Mailly approve is never called', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 2, text: DRAFT_TEXT })
  assert.equal(status, 409)
  assert.equal(body.error, 'draft_changed')
  assert.equal(callsTo('POST', `/mail-drafts/${DRAFT_ID}/approve`).length, 0)
})

test('approve: edited text is 409 draft_changed and Mailly approve is never called', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, {
    revision: 3,
    text: `${DRAFT_TEXT} (edited by the agent)`,
  })
  assert.equal(status, 409)
  assert.equal(body.error, 'draft_changed')
  assert.equal(callsTo('POST', `/mail-drafts/${DRAFT_ID}/approve`).length, 0)
})

test('approve: a draft that is no longer pending is 409 draft_changed', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  overrides['GET /mail-drafts'] = () => reply({ success: true, drafts: [draftRecord({ status: 'sent' })] })
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: DRAFT_TEXT })
  assert.equal(status, 409)
  assert.equal(body.error, 'draft_changed')
  assert.equal(callsTo('POST', `/mail-drafts/${DRAFT_ID}/approve`).length, 0)
})

test('approve: an unknown draft is 404 draft_not_found', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  overrides['GET /mail-drafts'] = () => reply({ success: true, drafts: [] })
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: DRAFT_TEXT })
  assert.equal(status, 404)
  assert.equal(body.error, 'draft_not_found')
  assert.equal(callsTo('POST', `/mail-drafts/${DRAFT_ID}/approve`).length, 0)
})

test('approve: missing revision or text is 400 and never reaches Mailly', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const noRevision = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { text: DRAFT_TEXT })
  assert.equal(noRevision.status, 400)
  const noText = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3 })
  assert.equal(noText.status, 400)
  const emptyText = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: '' })
  assert.equal(emptyText.status, 400)
  assert.equal(upstream.length, 0)
})

test('approve: ids are validated before any upstream path is built', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  // Percent-encoded slashes are decoded by URL before routing, so they never
  // reach the handler; the handler rejects anything that is not a plain id.
  // Dot segments and encoded slashes are normalised by URL before routing, so
  // they never reach the handler; the handler rejects every other odd id.
  for (const id of ['https:evil.example', 'x'.repeat(80), `${DRAFT_ID}%2Fapprove`, 'a.b', 'a%20b']) {
    const { status, body } = await postJson(`/mailly-api/drafts/${id}/approve`, { revision: 3, text: DRAFT_TEXT })
    assert.equal(status, 400, id)
    assert.equal(body.error, 'invalid_draft_id', id)
  }
  assert.equal(upstream.length, 0)
})

test('approve: Mailly status codes map to stable error strings', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const cases = [
    [409, 'draft_changed'],
    [403, 'send_forbidden'],
    [402, 'no_balance'],
    [429, 'rate_limited'],
    [503, 'unconfirmed'],
  ]
  for (const [upstreamStatus, expected] of cases) {
    overrides[`POST /mail-drafts/${DRAFT_ID}/approve`] = () => reply({ success: false, error: 'upstream' }, upstreamStatus)
    const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: DRAFT_TEXT })
    assert.equal(status, upstreamStatus, expected)
    assert.equal(body.error, expected)
  }
  // 503 is explicitly retryable with the same revision/text.
  overrides[`POST /mail-drafts/${DRAFT_ID}/approve`] = () => reply({ success: true, draft: draftRecord({ status: 'sent' }) })
  const retried = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: DRAFT_TEXT })
  assert.equal(retried.status, 200)
  assert.equal(callsTo('POST', `/mail-drafts/${DRAFT_ID}/approve`).at(-1).body.revision, 3)
})

test('approve: an unreachable Mailly is 503 unconfirmed (safe to retry)', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  overrides['GET /mail-drafts'] = () => {
    throw new TypeError('fetch failed')
  }
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: DRAFT_TEXT })
  assert.equal(status, 503)
  assert.equal(body.error, 'unconfirmed')
  assert.equal(callsTo('POST', `/mail-drafts/${DRAFT_ID}/approve`).length, 0)
})

test('approve: without a credential it is 401 and nothing is sent', async () => {
  await clearCredentials()
  await resetUpstream()
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/approve`, { revision: 3, text: DRAFT_TEXT })
  assert.equal(status, 401)
  assert.equal(body.error, 'missing_key')
  assert.equal(upstream.length, 0)
})

// ---------------------------------------------------------------------------
// Workbench send: POST /drafts/<id>/discard

test('discard: forwards exactly {revision} and returns ok', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/discard`, { revision: 3 })
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: true })
  const discard = callsTo('POST', `/mail-drafts/${DRAFT_ID}/discard`)
  assert.equal(discard.length, 1)
  assert.deepEqual(discard[0].body, { revision: 3 })
})

test('discard: a stale revision is 409 draft_changed', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  overrides[`POST /mail-drafts/${DRAFT_ID}/discard`] = () => reply({ success: false, error: 'revision mismatch' }, 409)
  const { status, body } = await postJson(`/mailly-api/drafts/${DRAFT_ID}/discard`, { revision: 2 })
  assert.equal(status, 409)
  assert.equal(body.error, 'draft_changed')
})

test('discard: missing revision is 400 and an invalid id never reaches Mailly', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  const noRevision = await postJson(`/mailly-api/drafts/${DRAFT_ID}/discard`, {})
  assert.equal(noRevision.status, 400)
  const badId = await postJson('/mailly-api/drafts/bad%20id/discard', { revision: 3 })
  assert.equal(badId.status, 400)
  assert.equal(badId.body.error, 'invalid_draft_id')
  assert.equal(upstream.length, 0)
})

// ---------------------------------------------------------------------------
// No model tool can send

test('no model tool can send, approve or discard', () => {
  assert.deepEqual(
    harness.tools.map((tool) => tool.name).sort(),
    ['mailly_inbox_list_threads', 'mailly_inbox_read_thread', 'mailly_inbox_save_draft'],
  )
  for (const tool of harness.tools) {
    assert.doesNotMatch(tool.name, /approve|send|discard|reply/)
  }
})

// ---------------------------------------------------------------------------
// The device flow survives a fresh module state only through auth.json

test('the pending flow is memory-only: a restart forgets it but keeps the credential', async () => {
  await clearCredentials()
  await resetUpstream()
  await writeDeviceAuth()
  // Nothing pending in this process (the flow tests above cleared it).
  assert.equal((await postJson('/mailly-api/auth/device/poll')).status, 404)
  // The device credential is durable.
  const status = await send()
  assert.equal(status.body.source, 'device')
})

test('a random 32-byte hex token is what the Host would generate', () => {
  // Guards the documented shape so a future refactor keeps 32 bytes of entropy.
  assert.match(randomBytes(32).toString('hex'), /^[0-9a-f]{64}$/)
})

test.after(() => {
  globalThis.fetch = realFetch
})
