/**
 * Host half tests: route surface, credential handling, request shaping and the
 * three model tools. No network: global fetch is stubbed with a fake Mailly API.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'mailly-dsh-'))
process.env.DSH_HOME = home
process.env.MAILLY_API_URL = 'https://api.test'
process.env.MAILLY_API_KEY = 'test-api-key'

const { apply } = await import('../host/index.js')

// ---------------------------------------------------------------------------
// Fake Mailly API

const upstream = []

const realFetch = globalThis.fetch

function reply(data, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(data),
  }
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  upstream.push({ url: target, options })
  const path = new URL(target).pathname

  if (path === '/balance') return reply({ success: true, balance: 1200 })
  if (path === '/inbox/threads') {
    return reply({
      success: true,
      cursor: null,
      threads: [
        {
          thread_id: 't1',
          unread_count: 2,
          message_count: 3,
          last_received_at: 1_760_000_000,
          latest_message: {
            id: 'm2',
            subject: '预算确认',
            snippet: '麻烦确认一下',
            from_name: '林薇',
            from_address: 'lin@example.com',
            direction: 'inbound',
          },
        },
      ],
    })
  }
  if (path === '/inbox/threads/t1') {
    return reply({
      success: true,
      thread_id: 't1',
      messages: [
        {
          id: 'm1',
          direction: 'inbound',
          from_name: '林薇',
          from_address: 'lin@example.com',
          to_address: 'me@example.com',
          subject: '预算确认',
          received_at: 1_759_990_000,
          text_body: '第一封正文',
        },
        {
          id: 'm2',
          direction: 'inbound',
          from_name: '林薇',
          from_address: 'lin@example.com',
          to_address: 'me@example.com',
          subject: '预算确认',
          received_at: 1_760_000_000,
          html_body: '<p>第二封<b>正文</b></p>',
        },
      ],
    })
  }
  if (path === '/mail-drafts' && options.method === 'POST') {
    return reply({
      success: true,
      draft: { id: 'd1', thread_id: 't1', revision: 1, status: 'pending', review_url: 'https://mailly.site/review/abc' },
    })
  }
  return reply({ success: false, error: `unexpected ${options.method} ${path}` }, 404)
}

// ---------------------------------------------------------------------------
// Harness

function createHarness({ routeError, services = {} } = {}) {
  const routes = []
  const tools = []
  const disposers = []
  apply({
    get(name) {
      return services[name]
    },
    webServer: {
      register(route) {
        if (routeError) throw routeError
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
  return {
    routes,
    tools,
    handler: routes[0] && routes[0].handler,
    dispose() {
      while (disposers.length) disposers.pop()()
    },
  }
}

function send(handler, options = {}) {
  const { method = 'GET', url = '/mailly-api/status', headers = {}, remoteAddress = '127.0.0.1', body } = options
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  Object.assign(req, { method, url, headers, socket: { remoteAddress } })
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk = '') {
      this.body = String(chunk)
      this.finished = true
    },
  }
  return new Promise((resolve, reject) => {
    res.end = (chunk = '') => {
      res.body = String(chunk)
      res.finished = true
      resolve({ status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : null })
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const harness = createHarness()

// ---------------------------------------------------------------------------
// Tests

test('registers one prefix route and the three inbox tools', () => {
  assert.equal(harness.routes.length, 1)
  assert.deepEqual({ kind: harness.routes[0].kind, path: harness.routes[0].path }, { kind: 'prefix', path: '/mailly-api' })
  assert.deepEqual(
    harness.tools.map((tool) => tool.name).sort(),
    ['mailly_inbox_list_threads', 'mailly_inbox_read_thread', 'mailly_inbox_save_draft'],
  )
  for (const tool of harness.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('ownership of the route is an effect, so unloading releases it', () => {
  const first = createHarness()
  assert.equal(first.routes.length, 1)
  first.dispose()
  assert.equal(first.routes.length, 0)
  // A fresh activation after disposal must not hit a duplicate route.
  const second = createHarness()
  assert.equal(second.routes.length, 1)
})

test('a stale activation owning the route keeps the model tools available', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const stale = createHarness({ routeError: new Error('webserver: duplicate prefix route "/mailly-api"') })
    assert.equal(stale.routes.length, 0)
    assert.equal(stale.tools.length, 3)
    assert.match(warnings.join('\n'), /previous activation/)
  } finally {
    console.warn = originalWarn
  }
})

test('an unrelated route error still fails the activation', () => {
  assert.throws(
    () => createHarness({ routeError: new Error('webserver: duplicate prefix route "/other"') }),
    /duplicate prefix route "\/other"/,
  )
})

test('every tool declares a string result that matches the rendered text', async () => {
  const tool = harness.tools.find((entry) => entry.name === 'mailly_inbox_list_threads')
  assert.deepEqual(tool.output.schema, { type: 'string' })
  const value = await tool.execute({}, { signal: new AbortController().signal })
  assert.equal(typeof value, 'string')
  assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: value }])
  for (const entry of harness.tools) assert.deepEqual(entry.output.schema, { type: 'string' })
})

test('status reports the environment credential', async () => {
  const { status, body } = await send(harness.handler)
  assert.equal(status, 200)
  assert.equal(body.configured, true)
  assert.equal(body.source, 'env')
  assert.equal(body.apiBaseUrl, 'https://api.test')
})

test('rejects foreign origins and non-loopback peers', async () => {
  const foreign = await send(harness.handler, { headers: { origin: 'https://evil.example', host: '127.0.0.1:49156' } })
  assert.equal(foreign.status, 403)

  const remote = await send(harness.handler, { remoteAddress: '10.0.0.5' })
  assert.equal(remote.status, 403)
})

test('asks for a key when none is configured', async () => {
  const saved = process.env.MAILLY_API_KEY
  delete process.env.MAILLY_API_KEY
  try {
    const { status, body } = await send(harness.handler, { url: '/mailly-api/threads' })
    assert.equal(status, 401)
    assert.equal(body.error, 'missing_key')
  } finally {
    process.env.MAILLY_API_KEY = saved
  }
})

test('shapes the conversation list and forwards the key', async () => {
  const { status, body } = await send(harness.handler, { url: '/mailly-api/threads?limit=5' })
  assert.equal(status, 200)
  assert.equal(body.threads.length, 1)
  assert.deepEqual(body.threads[0], {
    threadId: 't1',
    unreadCount: 2,
    messageCount: 3,
    lastReceivedAt: 1_760_000_000,
    latest: {
      id: 'm2',
      subject: '预算确认',
      snippet: '麻烦确认一下',
      fromName: '林薇',
      fromAddress: 'lin@example.com',
      direction: 'inbound',
    },
  })

  const call = upstream.at(-1)
  assert.equal(call.url, 'https://api.test/inbox/threads?limit=5')
  assert.equal(call.options.headers.authorization, 'Bearer test-api-key')
})

test('shapes a conversation with plain-text bodies and drafts', async () => {
  process.env.MAILLY_API_KEY = 'test-api-key'
  const { status, body } = await send(harness.handler, { url: '/mailly-api/thread?id=t1' })
  assert.equal(status, 200)
  assert.equal(body.threadId, 't1')
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].body, '第一封正文')
  // html_body is flattened, never handed to the browser as markup.
  assert.equal(body.messages[1].body, '第二封正文')
  assert.deepEqual(body.drafts, [])
})

test('rejects unknown paths instead of proxying them', async () => {
  const before = upstream.length
  const { status } = await send(harness.handler, { url: '/mailly-api/anything-else' })
  assert.equal(status, 404)
  assert.equal(upstream.length, before)
})

test('saves a draft with a stable idempotency key', async () => {
  const save = () =>
    send(harness.handler, {
      method: 'POST',
      url: '/mailly-api/drafts',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchor_email_id: 'm2', text: '好的，我确认。' }),
    })

  const first = await save()
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.draft.id, 'd1')

  const sent = JSON.parse(upstream.at(-1).options.body)
  assert.equal(sent.anchor_email_id, 'm2')
  assert.match(sent.idempotency_key, /^dsh-/)

  // A retry of the same reply must reuse the same key.
  const second = await save()
  assert.equal(second.status, 200)
  assert.equal(JSON.parse(upstream.at(-1).options.body).idempotency_key, sent.idempotency_key)
})

test('the read-thread tool returns readable text and labels drafts', async () => {
  const tool = harness.tools.find((entry) => entry.name === 'mailly_inbox_read_thread')
  const value = await tool.execute({ thread_id: 't1' }, { signal: new AbortController().signal })
  assert.match(value, /--- message m1 ---/)
  assert.match(value, /第一封正文/)
  assert.match(value, /第二封正文/)
  assert.match(value, /--- message m2 ---/)
})

test('the save-draft tool reports the review link and never claims a send', async () => {
  const tool = harness.tools.find((entry) => entry.name === 'mailly_inbox_save_draft')
  const value = await tool.execute({ anchor_email_id: 'm2', text: '好的' }, { signal: new AbortController().signal })
  assert.match(value, /Saved reply draft d1/)
  assert.match(value, /has not been sent/)
  assert.match(value, /review_url: https:\/\/mailly\.site\/review\/abc/)
})

test('a rejected key surfaces as a readable failure', async () => {
  const tool = harness.tools.find((entry) => entry.name === 'mailly_inbox_list_threads')
  globalThis.fetch = async () => reply({ success: false, error: 'invalid token' }, 401)
  try {
    await assert.rejects(() => tool.execute({}, { signal: new AbortController().signal }), /invalid token/)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------------
// Inbound automation routes

test('automation is off by default and unavailable without a session service', async () => {
  const plain = createHarness()
  const status = await send(plain.handler, { url: '/mailly-api/automation' })
  assert.equal(status.status, 200)
  assert.equal(status.body.enabled, false)
  assert.equal(status.body.available, false)
  assert.equal(status.body.running, false)

  const refused = await send(plain.handler, {
    method: 'PUT',
    url: '/mailly-api/automation',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'automation_unavailable')
})

test('automation requires a boolean and reports the stored state once enabled', async () => {
  const sessions = { created: 0, prompts: [] }
  const wired = createHarness({
    services: {
      sessionController: {
        async create() {
          sessions.created += 1
          return { sessionId: `s-${sessions.created}` }
        },
        async prompt(request) {
          sessions.prompts.push(request)
          return { accepted: true }
        },
      },
    },
  })
  try {
    const bad = await send(wired.handler, {
      method: 'PUT',
      url: '/mailly-api/automation',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    })
    assert.equal(bad.status, 400)

    const status = await send(wired.handler, { url: '/mailly-api/automation' })
    assert.equal(status.body.available, true)
    assert.equal(status.body.enabled, false)

    const enabled = await send(wired.handler, {
      method: 'PUT',
      url: '/mailly-api/automation',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.enabled, true)

    const off = await send(wired.handler, {
      method: 'PUT',
      url: '/mailly-api/automation',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(off.status, 200)
    assert.equal(off.body.enabled, false)
  } finally {
    wired.dispose()
  }
})
