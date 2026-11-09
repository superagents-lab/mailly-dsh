/**
 * Client half test: renders the workbench with a minimal React stand-in and a
 * stubbed fetch, then drives the UI through the flow a user performs —
 * load conversations, open one, hand it to the agent, draft and save a reply.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = new URL('../client/index.js', import.meta.url)
const read = () => readFileSync(SOURCE, 'utf8')

// ---------------------------------------------------------------------------
// Minimal React stand-in: hooks keep state across re-renders so the component's
// own effects and handlers can be exercised without a browser.

let hookIndex = 0
let dirty = false
const states = []
const effects = []
const intervals = []

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: (init) => {
    const index = hookIndex++
    if (!(index in states)) states[index] = typeof init === 'function' ? init() : init
    return [
      states[index],
      (value) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
        dirty = true
      },
    ]
  },
  useEffect: (fn, deps) => {
    const index = hookIndex++
    const previous = effects[index]
    const changed =
      !previous ||
      !deps ||
      !previous.deps ||
      deps.length !== previous.deps.length ||
      deps.some((dep, position) => dep !== previous.deps[position])
    effects[index] = { fn, deps, run: Boolean(changed) }
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  // The page polls a live agent transcript; record the interval so the harness
  // can clear it when a test finishes, or the process would never exit.
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    intervals.push(handle)
    return handle
  },
  clearInterval: (handle) => clearInterval(handle),
  useRef: (init) => {
    const index = hookIndex++
    if (!(index in states)) states[index] = { current: init }
    return states[index]
  },
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  },
}

// ---------------------------------------------------------------------------
// Load the module the way the Harness client loader does.

const loaded = []
globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } }
new Function('window', read())(globalThis.window)
assert.equal(loaded.length, 1)

const plugin = loaded[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

const uiCalls = []
const registrations = []
plugin.apply({
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
    getLocale: () => ({ active: 'zh' }),
  },
  slots: {
    inject: (_key, callback) => {
      callback()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  get: (name) => (name === 'uiWorkspace' ? { startSession: (...args) => uiCalls.push(args) } : undefined),
  on: () => () => {},
})

test('registers the sidebar entry and the main panel', () => {
  const panel = registrations.find((entry) => entry.options.name === 'main')
  assert.deepEqual(panel.options, { name: 'main', key: 'mailly', locale: 'mailly' })
  const nav = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(nav.options.id, 'mailly')
  assert.equal(typeof nav.options.label, 'function')
})

// ---------------------------------------------------------------------------
// Shared render harness for the flow tests below.

const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return out
  }
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}
const byClass = (tree, className) =>
  walk(tree).filter(
    (node) => node.props && typeof node.props.className === 'string' && node.props.className.split(' ').includes(className),
  )
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}
const byText = (tree, label) => walk(tree).find((node) => node.type === 'button' && textOf(node).includes(label))
const byTagText = (tree, tag, label) =>
  walk(tree).find((node) => node.type === tag && textOf(node).includes(label))

/** Fresh hook state so each test starts from a clean mount. */
globalThis.__MAILLY_STOP_TIMERS = () => {
  for (const handle of intervals.splice(0)) clearInterval(handle)
}

process.on('beforeExit', () => {
  for (const handle of intervals.splice(0)) clearInterval(handle)
})

function resetHooks() {
  // A previous mount may still hold a transcript poller; stop it first.
  for (const handle of intervals.splice(0)) clearInterval(handle)
  states.length = 0
  effects.length = 0
  hookIndex = 0
  dirty = false
}

/** Render the workbench once, running any effects whose deps changed. */
function mountWorkbench({ keepCache = false } = {}) {
  // The page keeps a module-level cache so returning to it paints instantly;
  // each mount starts from an empty one unless a test simulates a return visit.
  if (!keepCache && plugin.testHelpers && typeof plugin.testHelpers.resetPageCache === 'function') {
    plugin.testHelpers.resetPageCache()
  }
  const main = registrations.find((entry) => entry.options.name === 'main')
  const outer = main.component({})
  const workbench = outer.children[0].type
  const workbenchProps = outer.children[0].props
  resetHooks()
  const renderOnce = () => {
    hookIndex = 0
    dirty = false
    const tree = workbench(workbenchProps)
    for (const effect of effects) {
      if (effect && effect.run) {
        effect.run = false
        effect.fn()
      }
    }
    return tree
  }
  const settle = async (passes = 12) => {
    let tree
    for (let pass = 0; pass < passes; pass += 1) {
      tree = renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    return tree
  }
  /** Keep re-rendering for `ms` of real time (for flows with real timers). */
  const pump = async (ms = 2600) => {
    const until = Date.now() + ms
    let tree
    while (Date.now() < until) {
      tree = renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    return tree
  }
  return { renderOnce, settle, pump }
}

const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
const fail = (status, error) => ({ ok: false, status, text: async () => JSON.stringify({ error }) })

function threadPayload(overrides = {}) {
  return {
    threadId: 't1',
    olderMessagesOmitted: 0,
    drafts: [],
    messages: [
      {
        id: 'm1',
        direction: 'inbound',
        fromName: '林薇',
        fromAddress: 'lin@example.com',
        toAddress: 'me@example.com',
        subject: '预算确认',
        receivedAt: 1_759_990_000,
        body: '第一封正文',
        attachments: [],
      },
      {
        id: 'm2',
        direction: 'inbound',
        fromName: '林薇',
        fromAddress: 'lin@example.com',
        toAddress: 'me@example.com',
        subject: '预算确认',
        receivedAt: 1_760_000_000,
        body: '第二封正文',
        attachments: [],
      },
    ],
    ...overrides,
  }
}

const THREADS_PAYLOAD = {
  threads: [
    {
      threadId: 't1',
      unreadCount: 2,
      messageCount: 2,
      lastReceivedAt: 1_760_000_000,
      latest: {
        id: 'm2',
        subject: '预算确认',
        snippet: '麻烦确认一下',
        fromName: '林薇',
        fromAddress: 'lin@example.com',
        direction: 'inbound',
      },
    },
  ],
  cursor: null,
}

const STATUS_FILE = {
  configured: true,
  source: 'file',
  apiBaseUrl: 'https://api.mailly.site',
  keyEnv: 'MAILLY_API_KEY',
  keyFile: '/tmp/key',
}

test('drives list, reader, agent handoff and draft saving', async () => {
  const main = registrations.find((entry) => entry.options.name === 'main')
  const outer = main.component({})
  const workbench = outer.children[0].type
  const workbenchProps = outer.children[0].props

  // --- stubbed Mailly API --------------------------------------------------
  const threadDetail = {
    threadId: 't1',
    olderMessagesOmitted: 0,
    drafts: [],
    messages: [
      {
        id: 'm1',
        direction: 'inbound',
        fromName: '林薇',
        fromAddress: 'lin@example.com',
        toAddress: 'me@example.com',
        subject: '预算确认',
        receivedAt: 1_759_990_000,
        body: '第一封正文',
        attachments: [],
      },
      {
        id: 'm2',
        direction: 'inbound',
        fromName: '林薇',
        fromAddress: 'lin@example.com',
        toAddress: 'me@example.com',
        subject: '预算确认',
        receivedAt: 1_760_000_000,
        body: '第二封正文',
        attachments: [],
      },
    ],
  }
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    calls.push({ path, options })
    const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
    if (path.endsWith('/status')) {
      return ok({
        configured: true,
        source: 'file',
        apiBaseUrl: 'https://api.mailly.site',
        keyEnv: 'MAILLY_API_KEY',
        keyFile: '/tmp/key',
      })
    }
    if (path.includes('/threads?')) {
      return ok({
        threads: [
          {
            threadId: 't1',
            unreadCount: 2,
            messageCount: 2,
            lastReceivedAt: 1_760_000_000,
            latest: {
              id: 'm2',
              subject: '预算确认',
              snippet: '麻烦确认一下',
              fromName: '林薇',
              fromAddress: 'lin@example.com',
              direction: 'inbound',
            },
          },
        ],
        cursor: null,
      })
    }
    if (path.includes('/thread?id=')) return ok(threadDetail)
    if (path.endsWith('/agent/session') && options.method === 'POST') {
      return ok({ sessionId: 's1', threadId: 't1' })
    }
    if (path.includes('/agent?session=')) {
      return ok({
        sessionId: 's1',
        messages: [
          { id: 'a1', role: 'user', text: '请处理这封 Mailly 邮件。' },
          { id: 'a2', role: 'assistant', text: '读完了，草稿已保存：好的，我确认。' },
        ],
      })
    }
    if (path.endsWith('/agent/prompt') && options.method === 'POST') {
      return ok({ accepted: true })
    }
    if (path.endsWith('/drafts') && options.method === 'POST') {
      threadDetail.drafts = [
        { id: 'd1', revision: 1, status: 'pending', text: '好的，我确认。', reviewUrl: 'https://mailly.site/review/abc' },
      ]
      return ok({ ok: true, draft: { id: 'd1', revision: 1 } })
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: `unexpected ${path}` }) }
  }

  // --- render loop ---------------------------------------------------------
  function renderOnce() {
    hookIndex = 0
    dirty = false
    const tree = workbench(workbenchProps)
    for (const effect of effects) {
      if (effect && effect.run) {
        effect.run = false
        effect.fn()
      }
    }
    return tree
  }

  async function settle(passes = 12) {
    let tree
    for (let pass = 0; pass < passes; pass += 1) {
      tree = renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    return tree
  }

  const walk = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out)
      return out
    }
    out.push(node)
    for (const child of node.children || []) walk(child, out)
    return out
  }
  const byClass = (tree, className) =>
    walk(tree).filter(
      (node) => node.props && typeof node.props.className === 'string' && node.props.className.split(' ').includes(className),
    )
  const textOf = (node) => {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return (node.children || []).map(textOf).join('')
  }
  const byText = (tree, label) => walk(tree).find((node) => node.type === 'button' && textOf(node).includes(label))

  // --- load ---------------------------------------------------------------
  let tree = await settle()
  assert.equal(byClass(tree, 'ml-row').length, 1)
  assert.match(textOf(tree), /预算确认/)
  assert.match(textOf(tree), /更换凭据/)

  // --- open a conversation -------------------------------------------------
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()
  assert.equal(byClass(tree, 'ml-message').length, 2)
  assert.match(textOf(tree), /第二封正文/)

  // --- hand to the agent ---------------------------------------------------
  // The agent opens beside the conversation: the Host starts this thread's
  // session, the page shows its transcript and never navigates away.
  byText(tree, '让 agent 处理').props.onClick()
  tree = await settle()
  const created = calls.filter((call) => /\/agent\/session$/.test(call.path) && call.options.method === 'POST')
  assert.equal(created.length, 1)
  const createdBody = JSON.parse(created[0].options.body)
  assert.equal(createdBody.thread_id, 't1')
  assert.match(createdBody.prompt, /thread_id: t1/)
  assert.match(createdBody.prompt, /mailly_inbox_save_draft/)
  assert.equal(uiCalls.length, 0, 'no navigation to a new session')
  assert.equal(byClass(tree, 'ml-message').length, 2, 'the conversation stays on screen')
  assert.equal(byClass(tree, 'ml-agent').length, 1, 'the agent panel is open')

  // --- draft and save ------------------------------------------------------
  byText(tree, '起草回复').props.onClick()
  tree = await settle()
  const textarea = walk(tree).find((node) => node.type === 'textarea')
  assert.ok(textarea, 'composer textarea should render')
  textarea.props.onChange({ target: { value: '好的，我确认。' } })
  tree = await settle()
  const save = byText(tree, '保存草稿')
  assert.ok(save, 'save button should render')
  assert.equal(save.props.disabled, false)
  save.props.onClick()
  tree = await settle(20)

  const posted = calls.filter((call) => call.path.endsWith('/drafts') && call.options.method === 'POST')
  assert.equal(posted.length, 1)
  assert.deepEqual(JSON.parse(posted[0].options.body), { anchor_email_id: 'm2', text: '好的，我确认。' })

  assert.equal(byClass(tree, 'ml-draft').length, 1)
  assert.match(textOf(tree), /好的，我确认。/)
  assert.match(textOf(tree), /在 Mailly 中审核并发送/)
  assert.match(textOf(tree), /草稿已保存/)
})

// ---------------------------------------------------------------------------
// Pure helpers

test('draftMatches refuses anything but the exact reviewed version', () => {
  const { draftMatches } = plugin.testHelpers
  const shown = { revision: 3, text: 'Hello\n\nBest' }
  assert.equal(draftMatches(shown, { revision: 3, text: 'Hello\n\nBest', status: 'pending' }), true)
  assert.equal(draftMatches(shown, { revision: 3, text: 'Hello\n\nBest' }), true, 'missing status reads as pending')
  assert.equal(draftMatches(shown, { revision: 4, text: 'Hello\n\nBest', status: 'pending' }), false, 'revision moved')
  assert.equal(draftMatches(shown, { revision: 3, text: 'Hello\n\nBest!', status: 'pending' }), false, 'text moved')
  assert.equal(draftMatches(shown, { revision: 3, text: 'Hello\n\nBest ', status: 'pending' }), false, 'whitespace matters')
  assert.equal(draftMatches(shown, { revision: 3, text: 'Hello\n\nBest', status: 'sent' }), false, 'no longer pending')
  assert.equal(draftMatches(shown, null), false, 'draft gone')
  assert.equal(draftMatches({ revision: null, text: 'x' }, { revision: null, text: 'x' }), false, 'no revision')
  assert.equal(draftMatches(null, { revision: 1, text: 'x' }), false)
})

test('findDraft, replyRecipient and canSend read the Host shapes', () => {
  const { findDraft, replyRecipient, canSend, showsChangeCredential, connectedEmail } = plugin.testHelpers
  const thread = threadPayload({
    drafts: [
      { id: 'd1', revision: 1, status: 'pending', text: 'a' },
      { id: 'd2', revision: 2, status: 'pending', text: 'b' },
    ],
  })
  assert.equal(findDraft(thread, 'd2').text, 'b')
  assert.equal(findDraft(thread, 'nope'), null)
  assert.equal(findDraft(null, 'd1'), null)
  assert.equal(replyRecipient(thread), 'lin@example.com')
  assert.equal(replyRecipient({ messages: [] }), '')

  assert.equal(canSend({ configured: true, source: 'device' }), true, 'unknown scopes allow send')
  assert.equal(canSend({ configured: true, account: { scopes: ['mail:read', 'mail:draft'] } }), false)
  assert.equal(canSend({ configured: true, account: { scopes: ['mail:read', 'mail:send'] } }), true)
  assert.equal(canSend({ configured: false }), false)

  assert.equal(showsChangeCredential({ configured: true, source: 'device' }), true)
  assert.equal(showsChangeCredential({ configured: true, source: 'file' }), true)
  assert.equal(showsChangeCredential({ configured: true, source: 'env' }), false)
  assert.equal(showsChangeCredential({ configured: false, source: 'none' }), false)

  assert.equal(connectedEmail({ source: 'device', email: 'wang@example.com' }), 'wang@example.com')
  assert.equal(connectedEmail({ source: 'device', account: { email: 'a@b.c' } }), 'a@b.c')
  assert.equal(connectedEmail({ source: 'file' }), '')
})

test('nextPollState walks pending -> approved / expired and retries failures', () => {
  const { nextPollState, pollIntervalMs, formatCountdown } = plugin.testHelpers
  const waiting = { phase: 'waiting', pollFailures: 0, interval: 2 }

  const pending = nextPollState(waiting, { ok: true, data: { status: 'pending' } })
  assert.equal(pending.action, 'wait')
  assert.equal(pending.delayMs, 2000)
  assert.equal(pending.state.phase, 'waiting')

  const approved = nextPollState(waiting, { ok: true, data: { status: 'approved', email: 'a@b.c' } })
  assert.equal(approved.action, 'refresh')
  assert.equal(approved.state.phase, 'approved')
  assert.equal(approved.state.email, 'a@b.c')

  const expired = nextPollState(waiting, { ok: true, data: { status: 'expired' } })
  assert.equal(expired.action, 'expired')
  assert.equal(expired.state.phase, 'expired')

  // Transport failures retry with backoff, then give up as expired.
  let state = waiting
  for (let attempt = 1; attempt < 5; attempt += 1) {
    const step = nextPollState(state, { ok: false })
    assert.equal(step.action, 'wait')
    assert.equal(step.state.pollFailures, attempt)
    state = step.state
  }
  const gaveUp = nextPollState(state, { ok: false })
  assert.equal(gaveUp.action, 'expired')

  // A cancelled / idle flow never keeps polling.
  assert.equal(nextPollState({ phase: 'idle' }, { ok: true, data: { status: 'pending' } }).action, 'stop')

  assert.equal(pollIntervalMs(0), 2000, 'missing interval falls back to 2s')
  assert.equal(pollIntervalMs(0.1), 1000, 'clamped up')
  assert.equal(pollIntervalMs(9999), 60000, 'clamped down')
  assert.equal(formatCountdown(0), '0:00')
  assert.equal(formatCountdown(65), '1:05')
})

test('sendErrorKey maps the Host status contract', () => {
  const { sendErrorKey } = plugin.testHelpers
  assert.equal(sendErrorKey({ status: 409 }), 'sendChanged')
  assert.equal(sendErrorKey({ status: 403 }), 'sendForbidden')
  assert.equal(sendErrorKey({ status: 402 }), 'sendNoBalance')
  assert.equal(sendErrorKey({ status: 429 }), 'sendRateLimited')
  assert.equal(sendErrorKey({ status: 503 }), 'sendUnconfirmed')
  assert.equal(sendErrorKey({ status: 404 }), 'sendUnavailable')
  assert.equal(sendErrorKey({ status: 500 }), '')
  assert.equal(sendErrorKey(null), '')
})

// ---------------------------------------------------------------------------
// Device sign-in flow

function signInFetch({ startStatus = 200, polls = [], statusAfter } = {}) {
  const calls = []
  let pollIndex = 0
  let approved = false
  const queue = [...polls]
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    calls.push({ path, options })
    if (path.endsWith('/status')) {
      const configured = approved && statusAfter ? statusAfter.configured : false
      return ok({
        configured,
        source: configured ? 'device' : 'none',
        email: configured ? 'wang@example.com' : null,
        apiBaseUrl: 'https://api.mailly.site',
        keyEnv: 'MAILLY_API_KEY',
        keyFile: '/tmp/key',
      })
    }
    if (path.endsWith('/auth/device/start')) {
      if (startStatus !== 200) return fail(startStatus, startStatus === 404 ? 'not_found' : 'mailly_unreachable')
      return ok({
        deviceToken: 'abc',
        verificationUrl: 'https://mailly.site/cli-auth?token=abc',
        expiresIn: 300,
        interval: 1,
      })
    }
    if (path.endsWith('/auth/device/poll')) {
      const next = queue.length ? queue[Math.min(pollIndex, queue.length - 1)] : { status: 'pending' }
      pollIndex += 1
      if (next.status === 'approved') approved = true
      return ok(next)
    }
    if (path.endsWith('/auth/device/cancel')) return ok({ ok: true })
    if (path.includes('/threads?')) return ok(THREADS_PAYLOAD)
    if (path.includes('/thread?id=')) return ok(threadPayload())
    return fail(404, `unexpected ${path}`)
  }
  return calls
}

test('sign-in shows the verification link and connects after approval', async () => {
  const calls = signInFetch({
    polls: [{ status: 'pending' }, { status: 'approved', email: 'wang@example.com' }],
    statusAfter: { configured: true },
  })
  const { settle, pump } = mountWorkbench()
  let tree = await settle()

  // Connect card, sign-in is primary and the key form is behind a secondary control.
  assert.match(textOf(tree), /连接 Mailly/)
  const signIn = byText(tree, '使用 Mailly 账号登录')
  assert.ok(signIn, 'sign-in button should render')
  assert.equal(byText(tree, '改用 API key') !== undefined, true)
  assert.equal(walk(tree).some((node) => node.type === 'input' && node.props.type === 'password'), false)

  signIn.props.onClick()
  // The flow polls on a 1 s interval, so give the real timers time to run.
  tree = await pump(3000)

  const started = calls.filter((call) => call.path.endsWith('/auth/device/start'))
  assert.equal(started.length, 1)
  assert.equal(started[0].options.method, 'POST')
  const polls = calls.filter((call) => call.path.endsWith('/auth/device/poll'))
  assert.ok(polls.length >= 2, 'should poll until approved')

  // Approved: the inbox loads and the connected email is shown.
  assert.equal(byClass(tree, 'ml-row').length, 1)
  assert.match(textOf(tree), /wang@example\.com/)
  assert.match(textOf(tree), /已登录/)
  assert.equal(byText(tree, '更换凭据') !== undefined, true)
})

test('the sign-in card shows the verification link while waiting', async () => {
  const calls = signInFetch({ polls: [{ status: 'pending' }] })
  const { settle, pump } = mountWorkbench()
  let tree = await settle()
  byText(tree, '使用 Mailly 账号登录').props.onClick()
  tree = await pump(400)

  const link = walk(tree).find((node) => node.type === 'a' && String(node.props.href || '').includes('/cli-auth?token='))
  assert.ok(link, 'verification URL should be shown as a link')
  assert.equal(link.props.target, '_blank')
  assert.ok(byText(tree, '复制链接'), 'copy button should render')
  assert.ok(byText(tree, '取消登录'), 'cancel control should render')
  assert.match(textOf(tree), /等待你在 Mailly 里确认/)

  // Cancelling stops the loop and calls the Host's cancel route.
  byText(tree, '取消登录').props.onClick()
  tree = await settle()
  assert.equal(calls.filter((call) => call.path.endsWith('/auth/device/cancel')).length, 1)
  assert.ok(byText(tree, '使用 Mailly 账号登录'), 'back to the idle card')
})

test('sign-in offers a retry when the request expires', async () => {
  signInFetch({ polls: [{ status: 'expired' }] })
  const { settle } = mountWorkbench()
  let tree = await settle()
  byText(tree, '使用 Mailly 账号登录').props.onClick()
  tree = await settle(20)
  assert.match(textOf(tree), /登录请求已过期/)
  assert.ok(byText(tree, '重新登录'), 'retry button should render')
  assert.match(textOf(tree), /连接 Mailly/)
})

test('a Host without the device routes falls back to the key card', async () => {
  signInFetch({ startStatus: 404 })
  const { settle } = mountWorkbench()
  let tree = await settle()
  byText(tree, '使用 Mailly 账号登录').props.onClick()
  tree = await settle(20)
  assert.match(textOf(tree), /不支持账号登录/)
  // The key form is open and usable; the page did not break.
  const input = walk(tree).find((node) => node.type === 'input' && node.props.type === 'password')
  assert.ok(input, 'API key input should be shown')
  assert.match(textOf(tree), /连接 Mailly/)
})

// ---------------------------------------------------------------------------
// Two-step human-only send

function sendFetch({ approveStatus = 200, approveError = 'unexpected', draftAfterOpen, threadAfterApprove, noPrefetch = false } = {}) {
  // The page's background warm-up only makes the first thread read happen
  // earlier; the changed-draft test therefore answers by call count, not by
  // which read was "first".
  if (noPrefetch) globalThis.__MAILLY_NO_PREFETCH = true
  else delete globalThis.__MAILLY_NO_PREFETCH
  const calls = []
  // The list prefetches the visible conversation, so the panel's "shown"
  // version is the first answer that carries a draft — not simply the first
  // thread fetch. Count only those.
  let draftFetches = 0
  const draft = { id: 'd1', revision: 3, status: 'pending', text: '好的，我确认。\n\n谢谢', reviewUrl: 'https://x/review' }
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    calls.push({ path, options })
    if (path.endsWith('/status')) return ok({ ...STATUS_FILE, source: 'device', email: 'wang@example.com' })
    if (path.includes('/threads?')) return ok(THREADS_PAYLOAD)
    if (path.includes('/thread?id=')) {
      draftFetches += 1
      if (draftAfterOpen) {
        // The first read is the one the panel shows; every later read (the
        // confirm re-read, a background refresh) sees the changed draft.
        return ok(threadPayload({ drafts: [draftFetches === 1 ? draft : draftAfterOpen] }))
      }
      return ok(threadPayload({ drafts: [draft] }))
    }
    if (/\/drafts\/d1\/approve$/.test(path)) {
      if (approveStatus !== 200) return fail(approveStatus, approveError)
      return ok({ ok: true, draft: { ...draft, status: 'sent' } })
    }
    if (/\/drafts\/d1\/discard$/.test(path)) return ok({ ok: true })
    return fail(404, `unexpected ${path}`)
  }
  return { calls, draft, threadAfterApprove }
}

test('send needs the review toggle and posts the exact revision and text', async () => {
  const { calls, draft } = sendFetch()
  const { settle } = mountWorkbench()
  let tree = await settle()
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()

  const open = byText(tree, '审核后发送')
  assert.ok(open, 'send control should render on a pending draft')
  open.props.onClick()
  tree = await settle()

  // The panel shows the exact text and the recipient, and Send starts disabled.
  assert.ok(byClass(tree, 'ml-send-text').length, 'exact text panel should render')
  assert.equal(textOf(byClass(tree, 'ml-send-text')[0]), draft.text)
  assert.match(textOf(tree), /lin@example\.com/)
  const send = byText(tree, '立即发送')
  assert.ok(send, 'confirm button should render')
  assert.equal(send.props.disabled, true, 'send must be disabled before review')

  // Ticking the toggle enables it; nothing has been sent yet.
  const checkbox = walk(tree).find((node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.ok(checkbox, 'review checkbox should render')
  checkbox.props.onChange({ target: { checked: true } })
  tree = await settle()
  assert.equal(byText(tree, '立即发送').props.disabled, false)
  assert.equal(calls.filter((call) => /\/approve$/.test(call.path)).length, 0, 'no send before the click')

  byText(tree, '立即发送').props.onClick()
  tree = await settle(20)

  const approved = calls.filter((call) => /\/drafts\/d1\/approve$/.test(call.path))
  assert.equal(approved.length, 1)
  assert.deepEqual(JSON.parse(approved[0].options.body), { revision: 3, text: draft.text })
  assert.match(textOf(tree), /已发送/)
  // The panel is gone after a successful send.
  assert.equal(byClass(tree, 'ml-send-text').length, 0)
})

test('a draft that changed after review is refused and re-shown', async () => {
  // This test controls which draft version the page sees, so it never warms
  // the list in the background (a second thread fetch would change it).
  const { calls } = sendFetch({
    draftAfterOpen: { id: 'd1', revision: 4, status: 'pending', text: '改过的正文' },
    noPrefetch: true,
  })
  assert.equal(globalThis.__MAILLY_NO_PREFETCH, true, 'the warm-up must be off for this test')
  const { settle } = mountWorkbench()
  const stopTimers = () => {
    for (const handle of intervals.splice(0)) clearInterval(handle)
  }
  let tree = await settle()
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()
  byText(tree, '审核后发送').props.onClick()
  tree = await settle()
  walk(tree).find((node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  tree = await settle()
  const sendButton = byText(tree, '立即发送')
  sendButton.props.onClick()
  // The confirm path re-reads the thread; on CI the harness renders more
  // often, so wait for the page to settle on the refusal rather than a fixed
  // number of passes.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    tree = await settle(1)
    if (calls.some((call) => /\/approve$/.test(call.path))) break
    if (textOf(tree).includes('草稿在你审核后发生了变化')) break
  }

  const approveCalls = calls.filter((call) => /\/approve$/.test(call.path))
  assert.equal(
    approveCalls.length,
    0,
    `must not call approve; thread reads: ${calls.filter((call) => call.path.includes('/thread?id=')).length}, approve bodies: ${JSON.stringify(
      approveCalls.map((call) => call.options.body),
    )}`,
  )
  assert.match(textOf(tree), /草稿在你审核后发生了变化/)
  assert.match(textOf(tree), /改过的正文/)
  stopTimers()
})

test('a 409 from the Host is shown as "the draft changed"', async () => {
  const { calls } = sendFetch({ approveStatus: 409, approveError: 'draft_changed' })
  const { settle } = mountWorkbench()
  let tree = await settle()
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()
  byText(tree, '审核后发送').props.onClick()
  tree = await settle()
  walk(tree).find((node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  tree = await settle()
  byText(tree, '立即发送').props.onClick()
  tree = await settle(20)
  assert.equal(calls.filter((call) => /\/approve$/.test(call.path)).length, 1)
  assert.match(textOf(tree), /草稿在你审核后发生了变化/)
})

test('send failures map to readable messages', async () => {
  const cases = [
    [403, /没有发送权限/],
    [402, /额度不足/],
    [429, /限制发送频率/],
    [503, /没有确认这次发送/],
  ]
  for (const [status, pattern] of cases) {
    const { calls } = sendFetch({ approveStatus: status })
    const { settle } = mountWorkbench()
    let tree = await settle()
    byClass(tree, 'ml-row')[0].props.onClick()
    tree = await settle()
    byText(tree, '审核后发送').props.onClick()
    tree = await settle()
    walk(tree).find((node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
    tree = await settle()
    byText(tree, '立即发送').props.onClick()
    tree = await settle(20)
    assert.equal(calls.filter((call) => /\/approve$/.test(call.path)).length, 1, `status ${status}`)
    assert.match(textOf(tree), pattern, `status ${status}`)
  }
})

test('a Host without the send routes degrades to a readable message', async () => {
  const { calls } = sendFetch({ approveStatus: 404, approveError: 'not_found' })
  const { settle } = mountWorkbench()
  let tree = await settle()
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()
  byText(tree, '审核后发送').props.onClick()
  tree = await settle()
  walk(tree).find((node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  tree = await settle()
  byText(tree, '立即发送').props.onClick()
  tree = await settle(20)
  assert.equal(calls.filter((call) => /\/approve$/.test(call.path)).length, 1)
  assert.match(textOf(tree), /不支持在工作台发送/)
  assert.match(textOf(tree), /在 Mailly 中审核并发送/)
})

test('discard asks first and posts the current revision', async () => {
  const { calls } = sendFetch()
  const { settle } = mountWorkbench()
  let tree = await settle()
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()

  byText(tree, '丢弃草稿').props.onClick()
  tree = await settle()
  assert.match(textOf(tree), /确定丢弃这封草稿/)
  assert.equal(calls.filter((call) => /\/discard$/.test(call.path)).length, 0, 'nothing discarded before confirming')

  byText(tree, '丢弃').props.onClick()
  tree = await settle(20)
  const discarded = calls.filter((call) => /\/drafts\/d1\/discard$/.test(call.path))
  assert.equal(discarded.length, 1)
  assert.deepEqual(JSON.parse(discarded[0].options.body), { revision: 3 })
  assert.match(textOf(tree), /草稿已丢弃/)
})

test('no send control without send scope, and never in the agent prompt', async () => {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    calls.push({ path, options })
    if (path.endsWith('/status')) {
      return ok({ ...STATUS_FILE, source: 'device', account: { scopes: ['mail:read', 'mail:draft'] } })
    }
    if (path.includes('/threads?')) return ok(THREADS_PAYLOAD)
    if (path.includes('/thread?id=')) {
      return ok(
        threadPayload({
          drafts: [{ id: 'd1', revision: 3, status: 'pending', text: '正文', reviewUrl: 'https://mailly.site/review#abc' }],
        }),
      )
    }
    if (path.endsWith('/agent/session') && options.method === 'POST') return ok({ sessionId: 's1', threadId: 't1' })
    if (path.includes('/agent?session=')) return ok({ sessionId: 's1', messages: [] })
    return fail(404, `unexpected ${path}`)
  }
  const { settle } = mountWorkbench()
  let tree = await settle()
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()
  assert.equal(byText(tree, '审核后发送'), undefined, 'no send control without mail:send')
  assert.ok(byTagText(tree, 'a', '在 Mailly 中审核并发送'), 'review link stays')

  // The hand-off prompt never offers sending.
  // Start from a clean slate: a previous test in this file may have opened
  // this conversation's panel, and the page remembers the thread's session.
  plugin.testHelpers.resetPageCache()
  plugin.testHelpers.resetSessions()
  const before = calls.length
  const handOff = byText(tree, '让 agent 处理')
  assert.ok(handOff, 'hand-off button should render')
  handOff.props.onClick()
  tree = await settle(20)
  assert.equal(uiCalls.length, 0, 'no navigation to a new session')
  // The hand-off now starts the thread's DSH session through the Host; the
  // prompt it carries is the same "read, draft, never send" instruction.
  const created = calls
    .slice(before)
    .filter((call) => /\/agent\/session$/.test(call.path) && call.options.method === 'POST')
  const prompt = created.length ? JSON.parse(created[0].options.body).prompt : ''
  assert.equal(
    created.length,
    1,
    `the hand-off starts the thread session through the Host; calls: ${calls
      .slice(before)
      .slice(0, 5)
      .map((call) => `${call.options.method || 'GET'} ${call.path}`)
      .join(' | ')}`,
  )
  assert.match(prompt, /不要发送/)
  assert.match(prompt, /永远不要发送/)
  assert.doesNotMatch(prompt, /approve|发送这封|send/i)
})

// ---------------------------------------------------------------------------
// Instant return and the embedded agent panel

test('returning to the page paints the cached list before Mailly answers', async () => {
  // No agent routes here: the page must paint from its cache without opening
  // the panel, so no transcript poller can outlive the test.
  let releaseThreads
  let gated = false
  const gate = new Promise((resolve) => {
    releaseThreads = resolve
  })
  globalThis.fetch = async (url) => {
    const path = String(url)
    if (path.endsWith('/status')) return ok({ ...STATUS_FILE, source: 'device', email: 'wang@example.com' })
    if (path.includes('/threads?')) {
      if (gated) await gate
      return ok(THREADS_PAYLOAD)
    }
    if (path.includes('/thread?id=')) return ok(threadPayload())
    return fail(404, `unexpected ${path}`)
  }
  const first = mountWorkbench()
  let tree = await first.settle()
  assert.equal(byClass(tree, 'ml-row').length, 1, 'first visit loads the list')
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await first.settle()

  // Leave the panel and come back: the list must already be there while the
  // refresh is still in flight. The first mount stays mounted so the shared
  // cache is not reset by the second one.
  gated = true
  const second = mountWorkbench({ keepCache: true })
  tree = second.renderOnce()
  assert.equal(byClass(tree, 'ml-row').length, 1, 'cached list paints on the first render')
  assert.match(textOf(tree), /预算确认/)
  releaseThreads()
  tree = await second.settle()
  assert.equal(byClass(tree, 'ml-row').length, 1)

  // Both mounts may still hold timers; clear them so the process can exit.
  resetHooks()
  for (const handle of intervals.splice(0)) clearInterval(handle)
})


test('the list warms the first conversations so opening one is instant', async () => {
  const threads = []
  globalThis.fetch = async (url) => {
    const path = String(url)
    threads.push(path)
    if (path.endsWith('/status')) return ok({ ...STATUS_FILE, source: 'device', email: 'wang@example.com' })
    if (path.includes('/threads?')) return ok(THREADS_PAYLOAD)
    if (path.includes('/thread?id=')) return ok(threadPayload())
    return fail(404, `unexpected ${path}`)
  }
  const { settle } = mountWorkbench()
  await settle()
  // The prefetch is scheduled off the first paint; give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle(4)
  const prefetched = threads.filter((path) => path.includes('/thread?id=t1'))
  assert.ok(prefetched.length >= 1, 'the visible conversation is fetched ahead of the click')
})
