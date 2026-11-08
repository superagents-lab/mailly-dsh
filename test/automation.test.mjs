/**
 * Inbound automation tests: the long-poll loop, one-session-per-thread
 * behaviour, dedupe, cursor persistence, backoff, the hourly cap and the state
 * file. No network: fetch is a fake Mailly long poll and the DSH session
 * services are recording fakes. `wait` is injected so backoff is instant.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_HOURLY_CAP,
  EVENT_LOG_CAP,
  POLL_YIELD_MS,
  RECENT_ID_CAP,
  STATE_VERSION,
  StateVersionError,
  backoffDelay,
  buildAutomationPrompt,
  buildPollRequest,
  classifyMessage,
  createPoller,
  createStateStore,
  defaultState,
  describeAutomation,
} from '../host/automation.js'

// ---------------------------------------------------------------------------
// Fakes

function reply(data, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(data),
  }
}

async function tempStateFile() {
  const directory = await mkdtemp(join(tmpdir(), 'mailly-automation-'))
  return join(directory, 'mailly', 'automation.json')
}

function inbound(id, threadId, extra = {}) {
  return {
    id,
    thread_id: threadId,
    direction: 'inbound',
    folder: 'inbox',
    from_name: '林薇',
    from_address: 'lin@example.com',
    subject: '预算确认',
    snippet: '麻烦确认一下',
    received_at: 1_760_000_000,
    ...extra,
  }
}

/**
 * A fake long poll: each entry is one response. When the script runs out the
 * poll answers `timed_out` with the same cursor, like Mailly does. `onEmpty`
 * is called instead when the caller wants the loop to end there.
 */
function fakeWait(script = [], { onEmpty } = {}) {
  const calls = []
  let index = 0
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const step = script[index]
    if (!step) {
      if (onEmpty) await onEmpty()
      return reply({ success: true, messages: [], cursor: null, timed_out: true })
    }
    index += 1
    if (typeof step === 'function') return step(url, init)
    if (step.status && step.status >= 400) return reply(step.body, step.status)
    return reply({ success: true, cursor: `c${index}`, timed_out: false, ...step })
  }
  return { fetchImpl, calls }
}

function fakeSessions() {
  const created = []
  const prompted = []
  return {
    created,
    prompted,
    createSession: async ({ threadId, message }) => {
      const sessionId = `s${created.length + 1}`
      created.push({ threadId, message, sessionId })
      return { sessionId }
    },
    promptSession: async (request) => {
      prompted.push(request)
      return { ok: true }
    },
  }
}

/**
 * Run the poller over a scripted batch, then stop it once the script is used
 * up. `waits` records only the backoff delays (the loop's inter-poll yield is
 * filtered out), so a test can assert the backoff schedule exactly.
 */
async function runPoller({ script, state, sessions, hourlyCap, filters, clock = { time: 1_000_000 } }) {
  const waits = []
  const events = []
  let poller
  const { fetchImpl, calls } = fakeWait(script, { onEmpty: () => poller.stop() })
  poller = createPoller({
    fetchImpl,
    store: state.store,
    key: async () => 'test-api-key',
    createSession: sessions.createSession,
    promptSession: sessions.promptSession,
    base: 'https://api.test',
    filters,
    hourlyCap,
    now: () => clock.time,
    onEvent: (event) => events.push(event),
    wait: async (ms) => {
      if (ms !== POLL_YIELD_MS) waits.push(ms)
      // A wait ends the run once the scripted responses are used up.
      if (calls.length >= script.length) await poller.stop()
    },
  })
  await poller.start()
  return { poller, calls, waits, events }
}

// ---------------------------------------------------------------------------
// Tests

test('the first message creates one session and prompts it once', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const { calls, events } = await runPoller({
    script: [{ messages: [inbound('m1', 't1')] }],
    state: { store },
    sessions,
  })

  assert.equal(sessions.created.length, 1)
  assert.deepEqual(
    { threadId: sessions.created[0].threadId, messageId: sessions.created[0].message.id },
    { threadId: 't1', messageId: 'm1' },
  )
  assert.equal(sessions.prompted.length, 1)
  assert.equal(sessions.prompted[0].sessionId, 's1')
  assert.equal(sessions.prompted[0].threadId, 't1')
  assert.equal(sessions.prompted[0].kind, 'new_thread')
  assert.match(sessions.prompted[0].text, /mailly_inbox_read_thread/)
  assert.match(sessions.prompted[0].text, /mailly_inbox_save_draft/)
  assert.match(sessions.prompted[0].text, /Do not send anything/)
  assert.match(sessions.prompted[0].text, /external data/)
  assert.ok(events.some((event) => event.type === 'session' && event.sessionId === 's1'))

  // The request is the documented long poll, authenticated with the bearer key.
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://api.test/inbox/messages/wait')
  assert.equal(url.searchParams.get('timeout'), '25')
  assert.equal(url.searchParams.get('limit'), '10')
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-api-key')

  const saved = await store.load()
  assert.deepEqual(saved.threads.t1.sessionId, 's1')
  assert.equal(saved.threads.t1.lastMessageId, 'm1')
  assert.equal(saved.hourly.count, 1)
})

test('a second message in the same thread reuses the session and creates nothing', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  await runPoller({ script: [{ messages: [inbound('m1', 't1')] }], state: { store }, sessions })
  assert.equal(sessions.created.length, 1)

  const second = await runPoller({
    script: [{ messages: [inbound('m2', 't1', { subject: 'Re: 预算确认' })] }],
    state: { store },
    sessions,
  })

  assert.equal(sessions.created.length, 1, 'a follow-up must not create a second session')
  assert.equal(sessions.prompted.length, 2)
  assert.deepEqual(
    { sessionId: sessions.prompted[1].sessionId, kind: sessions.prompted[1].kind, messageId: sessions.prompted[1].message.id },
    { sessionId: 's1', kind: 'follow_up', messageId: 'm2' },
  )
  assert.match(sessions.prompted[1].text, /conversation you are already handling/)
  // The follow-up costs no new session against the hourly cap.
  const saved = await store.load()
  assert.equal(saved.hourly.count, 1)
  assert.equal(saved.threads.t1.lastMessageId, 'm2')
  assert.ok(second.events.some((event) => event.type === 'session' && event.kind === 'follow_up'))
})

test('a repeated message id is a duplicate and produces no session', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  await runPoller({ script: [{ messages: [inbound('m1', 't1')] }], state: { store }, sessions })

  // Same id delivered again (Mailly redelivery, or a restart replaying a batch).
  const { events } = await runPoller({
    script: [{ messages: [inbound('m1', 't1')] }],
    state: { store },
    sessions,
  })
  assert.equal(sessions.created.length, 1)
  assert.equal(sessions.prompted.length, 1)
  assert.ok(events.some((event) => event.type === 'message' && event.kind === 'duplicate' && event.messageId === 'm1'))

  // The recent-id ring also catches a duplicate whose thread row moved on.
  const state = await store.load()
  state.threads.t1.lastMessageId = 'm2'
  assert.equal(classifyMessage(inbound('m1', 't1'), state), 'duplicate')

  // A different thread with the same id is still a duplicate: ids are global.
  assert.equal(classifyMessage(inbound('m1', 't9'), state), 'duplicate')
})

test('the cursor advances with every poll and is persisted for a restart', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const { calls } = await runPoller({
    script: [{ messages: [] }, { messages: [inbound('m1', 't1')] }],
    state: { store },
    sessions,
  })

  assert.equal(new URL(calls[0].url).searchParams.get('cursor'), null)
  assert.equal(new URL(calls[1].url).searchParams.get('cursor'), 'c1')
  const saved = await store.load()
  assert.equal(saved.cursor, 'c2')

  // A fresh poller (a Host restart) resumes from the stored cursor.
  const restarted = fakeWait([])
  const poller = createPoller({
    fetchImpl: restarted.fetchImpl,
    store,
    key: async () => 'test-api-key',
    createSession: sessions.createSession,
    promptSession: sessions.promptSession,
    base: 'https://api.test',
    wait: async () => poller.stop(),
  })
  // The empty script answers `timed_out` forever, so stop after the first poll.
  const running = poller.start()
  while (restarted.calls.length === 0) await new Promise((resolve) => setImmediate(resolve))
  await poller.stop()
  await running
  assert.equal(new URL(restarted.calls[0].url).searchParams.get('cursor'), 'c2')
})

test('filter options are forwarded to the long poll', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const { calls } = await runPoller({
    script: [{ messages: [] }],
    state: { store },
    sessions,
    filters: { address: 'me@example.com', subject: 'invoice', folder: 'inbox', sender: '', bogus: 'x' },
  })
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('address'), 'me@example.com')
  assert.equal(url.searchParams.get('subject'), 'invoice')
  assert.equal(url.searchParams.get('folder'), 'inbox')
  assert.equal(url.searchParams.get('sender'), null)
  assert.equal(url.searchParams.get('bogus'), null)
})

test('stop() aborts the in-flight poll and resolves within a second', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  let sawAbort = false
  // A poll that hangs until its signal aborts, like a real 25 s long poll.
  const fetchImpl = (url, init = {}) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        sawAbort = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })
  const poller = createPoller({
    fetchImpl,
    store,
    key: async () => 'test-api-key',
    createSession: sessions.createSession,
    promptSession: sessions.promptSession,
    base: 'https://api.test',
  })
  const running = poller.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const started = Date.now()
  await poller.stop()
  await running
  assert.ok(Date.now() - started < 1_000, 'stop() must not wait for the long poll to time out')
  assert.equal(sawAbort, true)
  assert.equal(sessions.created.length, 0)
})

test('a 500 backs off 1s then 2s and the loop keeps going', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const { waits, events } = await runPoller({
    script: [
      { status: 500, body: { success: false, error: 'upstream exploded' } },
      { status: 500, body: { success: false, error: 'upstream exploded' } },
      { messages: [inbound('m1', 't1')] },
    ],
    state: { store },
    sessions,
  })

  assert.deepEqual(waits, [1_000, 2_000])
  assert.equal(sessions.created.length, 1, 'the loop recovered after the failures')
  const errors = events.filter((event) => event.type === 'poll_error')
  assert.equal(errors.length, 2)
  assert.match(errors[0].error, /upstream exploded/)
  const saved = await store.load()
  assert.match(saved.lastError, /upstream exploded/)
})

test('a poll that succeeds after a failure keeps going and reports recovery', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const { poller, events } = await runPoller({
    script: [{ status: 500, body: { error: 'nope' } }, { messages: [] }],
    state: { store },
    sessions,
  })
  // The failure is recorded, and the next good poll is observed after it.
  assert.match(describeAutomation(await store.load()).lastError, /nope/)
  const types = events.map((event) => event.type)
  assert.ok(types.indexOf('poll_error') !== -1)
  assert.ok(types.lastIndexOf('poll') > types.indexOf('poll_error'), 'the loop recovered after the failure')
  assert.equal(poller.stats().failures, 0, 'a successful poll resets the backoff counter')
  assert.equal(poller.stats().sessionsStarted, 0)
})

test('the hourly cap blocks the sixth session in a window and lifts next hour', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const clock = { time: 1_000_000 }
  const messages = Array.from({ length: 6 }, (_, index) => inbound(`m${index + 1}`, `t${index + 1}`))
  const { events } = await runPoller({ script: [{ messages }], state: { store }, sessions, clock })

  assert.equal(DEFAULT_HOURLY_CAP, 5)
  assert.equal(sessions.created.length, 5, 'the sixth new thread in one hour is skipped')
  assert.ok(events.some((event) => event.type === 'message' && event.kind === 'skip' && event.messageId === 'm6'))
  assert.equal((await store.load()).hourly.count, 5)

  // An hour later the window rolls over and the skipped thread starts again.
  clock.time += 60 * 60 * 1000
  await runPoller({ script: [{ messages: [inbound('m6', 't6')] }], state: { store }, sessions, clock })
  assert.equal(sessions.created.length, 6)
  const saved = await store.load()
  assert.equal(saved.hourly.count, 1)
  assert.equal(saved.hourly.windowStart, clock.time)
})

test('the hourly cap can be configured', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const messages = [inbound('m1', 't1'), inbound('m2', 't2')]
  await runPoller({ script: [{ messages }], state: { store }, sessions, hourlyCap: 1 })
  assert.equal(sessions.created.length, 1)
})

test('outbound messages and quarantine mail are skipped', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  const { events } = await runPoller({
    script: [
      {
        messages: [
          inbound('m1', 't1', { direction: 'outbound' }),
          inbound('m2', 't2', { folder: 'quarantine' }),
          inbound('m3', 't3'),
        ],
      },
    ],
    state: { store },
    sessions,
  })
  assert.equal(sessions.created.length, 1)
  assert.equal(sessions.created[0].threadId, 't3')
  assert.equal(events.filter((event) => event.type === 'message' && event.kind === 'skip').length, 2)
  assert.equal(classifyMessage(inbound('m1', 't1', { direction: 'outbound' }), defaultState()), 'skip')
})

test('a failing session start is recorded and does not stop the batch', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  let attempts = 0
  const { events } = await runPoller({
    script: [{ messages: [inbound('m1', 't1'), inbound('m2', 't2')] }],
    state: { store },
    sessions: {
      ...sessions,
      createSession: async (request) => {
        attempts += 1
        if (attempts === 1) throw new Error('session service unavailable')
        return sessions.createSession(request)
      },
    },
  })
  assert.equal(attempts, 2)
  assert.equal(sessions.created.length, 1)
  assert.equal(sessions.created[0].threadId, 't2')
  const saved = await store.load()
  assert.match(saved.lastError, /session service unavailable/)
  assert.equal(saved.threads.t1, undefined)
  assert.ok(events.some((event) => event.type === 'poll_error'))
})

test('an unknown state version is refused instead of guessed', async () => {
  const file = await tempStateFile()
  const store = createStateStore({ file })
  await store.save({ ...defaultState(), version: STATE_VERSION, cursor: 'c1' })

  const written = JSON.parse(await readFile(file, 'utf8'))
  written.version = STATE_VERSION + 1
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, JSON.stringify(written))

  await assert.rejects(() => store.load(), (error) => {
    assert.ok(error instanceof StateVersionError)
    assert.equal(error.code, 'ERR_MAILLY_STATE_VERSION')
    assert.equal(error.found, STATE_VERSION + 1)
    return true
  })

  // A poller given that store refuses to start rather than running blind.
  const sessions = fakeSessions()
  const poller = createPoller({
    fetchImpl: fakeWait([]).fetchImpl,
    store,
    key: async () => 'test-api-key',
    createSession: sessions.createSession,
    promptSession: sessions.promptSession,
    base: 'https://api.test',
  })
  await assert.rejects(() => poller.start(), StateVersionError)
  assert.equal(sessions.created.length, 0)
})

test('a missing or corrupt state file loads defaults with automation off', async () => {
  const file = await tempStateFile()
  const store = createStateStore({ file })
  assert.deepEqual(await store.load(), defaultState())
  assert.equal((await store.load()).enabled, false)

  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '{"version": 1, "cursor": "c1"')
  assert.deepEqual(await store.load(), defaultState())
})

test('save is atomic: 0600 file, 0700 directory, valid JSON, no temp files left', async () => {
  const file = await tempStateFile()
  const store = createStateStore({ file })
  const state = defaultState()
  state.enabled = true
  state.cursor = 'c9'
  state.threads.t1 = { sessionId: 's1', lastMessageId: 'm1', lastSessionAt: 42 }
  await store.save(state)

  const info = await stat(file)
  assert.equal(info.mode & 0o777, 0o600)
  const directory = await stat(join(file, '..'))
  assert.equal(directory.mode & 0o777, 0o700)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), state)

  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(join(file, '..')), ['automation.json'])

  // A second save replaces the file in place and the result still parses.
  state.cursor = 'c10'
  await store.save(state)
  assert.equal((await store.load()).cursor, 'c10')
})

test('the recent-id ring is bounded', async () => {
  const state = defaultState()
  state.recentIds = Array.from({ length: RECENT_ID_CAP + 50 }, (_, index) => `old${index}`)
  const store = createStateStore({ file: await tempStateFile() })
  const saved = await store.save(state)
  assert.equal(saved.recentIds.length, RECENT_ID_CAP)
  assert.equal(saved.recentIds.at(-1), `old${RECENT_ID_CAP + 49}`)
})

test('describeAutomation reports the status shape a route returns', () => {
  const state = defaultState()
  state.enabled = true
  state.cursor = 'c3'
  state.threads.t1 = { sessionId: 's1', lastMessageId: 'm1', lastSessionAt: 1 }
  state.threads.t2 = { sessionId: 's2', lastMessageId: 'm2', lastSessionAt: 2 }
  state.hourly = { windowStart: 1, count: 2 }
  state.lastError = 'boom'
  assert.deepEqual(describeAutomation(state), {
    enabled: true,
    cursor: 'c3',
    threadCount: 2,
    hourlyCount: 2,
    lastError: 'boom',
  })
  assert.deepEqual(describeAutomation(defaultState()), {
    enabled: false,
    cursor: null,
    threadCount: 0,
    hourlyCount: 0,
    lastError: null,
  })
})

test('buildPollRequest surfaces a readable error on a non-2xx response', async () => {
  const fetchImpl = async () => reply({ success: false, error: 'invalid token' }, 401)
  await assert.rejects(
    () => buildPollRequest({ base: 'https://api.test', key: 'k', fetchImpl }),
    /Mailly long poll failed: invalid token/,
  )
  await assert.rejects(() => buildPollRequest({ base: 'https://api.test', key: '', fetchImpl }), /not connected/)
})

test('buildPollRequest passes the caller abort signal through', async () => {
  const controller = new AbortController()
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  const pending = buildPollRequest({ base: 'https://api.test', key: 'k', fetchImpl, signal: controller.signal })
  controller.abort(new Error('shutting down'))
  await assert.rejects(() => pending, /Mailly long poll stopped: shutting down/)
})

test('backoff doubles to a 60s cap and the prompt never asks the agent to send', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(backoffDelay), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
  const text = buildAutomationPrompt(inbound('m1', 't1'))
  assert.match(text, /thread_id: t1/)
  assert.match(text, /message_id: m1/)
  assert.match(text, /Never call a send, approve or reply endpoint/)
  assert.doesNotMatch(text, /mailly_inbox_send/)
})

test('the hourly window rolls over on its own clock, not on the stored count', () => {
  const state = defaultState()
  const message = inbound('m1', 't1')
  // A fresh state has no window yet, so the first message is a new thread.
  assert.equal(classifyMessage(message, state, { hourlyCap: 1, now: 1_000_000 }), 'new_thread')
  // A full window blocks new threads, but only while it is live.
  state.hourly = { windowStart: 1_000_000, count: 1 }
  assert.equal(classifyMessage(message, state, { hourlyCap: 1, now: 1_000_001 }), 'skip')
  assert.equal(classifyMessage(message, state, { hourlyCap: 1, now: 1_000_000 + 60 * 60 * 1000 }), 'new_thread')
  // A follow-up is never blocked by the cap: it reuses an existing session.
  state.threads.t1 = { sessionId: 's1', lastMessageId: 'm0', lastSessionAt: 1 }
  assert.equal(classifyMessage(message, state, { hourlyCap: 1, now: 1_000_001 }), 'follow_up')
})

test('an instantly-answering transport cannot spin the loop', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  let calls = 0
  // Every poll resolves immediately, forever — a proxy ignoring `timeout`.
  const fetchImpl = async () => {
    calls += 1
    return reply({ success: true, messages: [], cursor: `c${calls}`, timed_out: true })
  }
  const yields = []
  const poller = createPoller({
    fetchImpl,
    store,
    key: async () => 'test-api-key',
    createSession: sessions.createSession,
    promptSession: sessions.promptSession,
    base: 'https://api.test',
    wait: async (ms) => {
      yields.push(ms)
      if (calls >= 3) await poller.stop()
    },
  })
  await poller.start()
  // Each poll is followed by a real yield, so three polls cost three yields.
  assert.equal(calls, 3)
  assert.deepEqual(yields, [POLL_YIELD_MS, POLL_YIELD_MS, POLL_YIELD_MS])
  assert.equal(sessions.created.length, 0)
})

test('the in-memory event log is bounded', async () => {
  const store = createStateStore({ file: await tempStateFile() })
  const sessions = fakeSessions()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return reply({ success: true, messages: [], cursor: `c${calls}`, timed_out: true })
  }
  const poller = createPoller({
    fetchImpl,
    store,
    key: async () => 'test-api-key',
    createSession: sessions.createSession,
    promptSession: sessions.promptSession,
    base: 'https://api.test',
    wait: async () => {
      if (calls >= EVENT_LOG_CAP + 5) await poller.stop()
    },
  })
  await poller.start()
  const events = poller.recentEvents()
  assert.equal(events.length, EVENT_LOG_CAP)
  assert.equal(events.at(-1).type, 'poll')
})
