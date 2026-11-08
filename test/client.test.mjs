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
  assert.match(textOf(tree), /更换 key/)

  // --- open a conversation -------------------------------------------------
  byClass(tree, 'ml-row')[0].props.onClick()
  tree = await settle()
  assert.equal(byClass(tree, 'ml-message').length, 2)
  assert.match(textOf(tree), /第二封正文/)

  // --- hand to the agent ---------------------------------------------------
  byText(tree, '让 agent 处理').props.onClick()
  tree = await settle()
  assert.equal(uiCalls.length, 1)
  const [workspaceId, options] = uiCalls[0]
  assert.equal(workspaceId, undefined)
  assert.match(options.prompt, /thread_id: t1/)
  assert.match(options.prompt, /mailly_inbox_save_draft/)
  assert.match(textOf(tree), /按回车即可开始/)

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
