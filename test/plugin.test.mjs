import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  COMMAND,
  READ_ONLY_TOOLS,
  SECTION_NAME,
  TITLE_PREFIX,
  adoptOnResume,
  buildAddress,
  buildPolicy,
  buildTitle,
  isSideChatSession,
  latestTitle,
  questionOf,
  runBtw,
  selectReadOnlyTools,
  truncate,
} from '../index.js'

const here = fileURLToPath(new URL('.', import.meta.url))

test('questionOf trims the command separator and rejects whitespace', () => {
  assert.equal(questionOf('  why does this test fail?  '), 'why does this test fail?')
  assert.equal(questionOf('   '), '')
  assert.equal(questionOf(undefined), '')
})

test('truncate collapses whitespace, bounds text, and keeps surrogate pairs', () => {
  assert.equal(truncate(' a\n b\tc ', 20), 'a b c')
  assert.equal(truncate('abcdefghij', 5), 'abcde…')
  assert.equal(truncate('😀😀😀', 3), '😀…')
  assert.equal(truncate('', 5), '')
})

test('buildTitle carries the durable marker and stays short', () => {
  const title = buildTitle('why is the sky blue?')
  assert.equal(title, `${TITLE_PREFIX}why is the sky blue?`)
  assert.ok(buildTitle('x'.repeat(200)).length <= TITLE_PREFIX.length + 61)
})

test('buildAddress round-trips through the browser parser', async () => {
  const address = buildAddress('session-child', 'session-parent', 'what changed?')
  assert.match(address, /^dsh-resource:\/\/btwchat\/session\/session-child\?/)
  const url = new URL(address)
  assert.equal(url.searchParams.get('parent'), 'session-parent')
  assert.equal(url.searchParams.get('q'), 'what changed?')

  const client = await loadClient()
  assert.deepEqual(client.parseAddress(address), {
    childId: 'session-child',
    parentId: 'session-parent',
    question: 'what changed?',
  })
})

test('buildPolicy names the tools and never interpolates user text', () => {
  const policy = buildPolicy(['read', 'grep'])
  assert.match(policy, /read, grep/)
  assert.match(policy, /read-only/i)
  assert.match(policy, /do not ask the user a follow-up question/i)
  assert.ok(!policy.includes('{{'))
  assert.match(buildPolicy([]), /Your tools: none/)
})

test('selectReadOnlyTools intersects the deployment and ignores mutations', () => {
  assert.deepEqual(selectReadOnlyTools(['bash', 'read', 'write', 'grep', 'web_search']), [
    'read',
    'grep',
    'web_search',
  ])
  assert.deepEqual(selectReadOnlyTools(undefined), [])
  assert.ok(READ_ONLY_TOOLS.includes('read'))
  assert.ok(!READ_ONLY_TOOLS.includes('bash'))
  assert.ok(!READ_ONLY_TOOLS.includes('write'))
  assert.ok(!READ_ONLY_TOOLS.includes('edit'))
})

test('latestTitle and isSideChatSession read the newest title event', () => {
  const session = {
    snapshotEvents() {
      return [
        { type: 'turn/start', data: {} },
        { type: 'session/title', data: { title: 'Main conversation' } },
        { type: 'turn/end', data: {} },
        { type: 'session/title', data: { title: `${TITLE_PREFIX}why?` } },
      ]
    },
  }
  assert.equal(latestTitle(session), `${TITLE_PREFIX}why?`)
  assert.equal(isSideChatSession(session), true)
  assert.equal(isSideChatSession({ snapshotEvents: () => [{ type: 'session/title', data: { title: 'Other' } }] }), false)
  assert.equal(isSideChatSession({ snapshotEvents: () => { throw new Error('no head') } }), false)
})

test('runBtw forks, installs the read-only policy, titles, and prompts the child', async () => {
  const calls = { fork: [], rename: [], prompt: [] }
  const sections = []
  const restrictions = []
  const guards = []
  const presentations = []
  let child

  const controller = {
    async fork(request) {
      calls.fork.push(request)
      return { sessionId: 'session-child' }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: 1 }
    },
    async prompt(request, signal) {
      calls.prompt.push({ request, signal })
      return { accepted: true }
    },
  }

  const childAgent = {
    id: 'session-child',
    session: { header: { id: 'session-child', parentSession: 'session-parent', isSeeded: true } },
    ctx: {
      tools: {
        presentAs(mode) {
          presentations.push(mode)
        },
        restrict(filter) {
          restrictions.push(filter)
        },
        guard(guard) {
          guards.push(guard)
          return () => {}
        },
      },
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
    },
  }
  child = childAgent

  const parentAgent = {
    id: 'session-parent',
    session: { header: { id: 'session-parent' } },
  }

  const agents = {
    get(id) {
      assert.equal(id, child.id)
      return child
    },
  }

  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          presentAs() {
            throw new Error('the root tool presentation must not be changed')
          },
          schemas(agent) {
            assert.equal(agent, childAgent)
            return [{ name: 'read' }, { name: 'bash' }, { name: 'web_search' }, { name: 'write' }]
          },
        }
      }
      if (name === 'sessionController') return controller
      if (name === 'agents') return agents
      return undefined
    },
  }

  const signal = new AbortController().signal
  const result = await runBtw(ctx, {
    agent: parentAgent,
    rawInput: ' why did the build fail? ',
    signal,
  })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Side chat opened/)
  assert.match(result.text, /dsh-resource:\/\/btwchat\/session\/session-child/)

  assert.deepEqual(calls.fork, [{ sessionId: 'session-parent' }])
  assert.deepEqual(presentations, ['native'])
  assert.equal(restrictions.length, 1)
  assert.deepEqual(restrictions[0], { allow: ['read', 'web_search'] })
  assert.equal(guards.length, 1)
  assert.equal(guards[0]({ name: 'read' }), undefined)
  assert.match(guards[0]({ name: 'bash' }), /read-only/i)
  assert.match(guards[0]({ name: 'write' }), /read-only/i)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, SECTION_NAME)
  assert.equal(sections[0].interpolate, false)
  assert.match(sections[0].text, /read, web_search/)
  assert.doesNotMatch(sections[0].text, /bash/)

  assert.equal(calls.rename.length, 1)
  assert.equal(calls.rename[0].sessionId, 'session-child')
  assert.ok(calls.rename[0].title.startsWith(TITLE_PREFIX))

  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].request.sessionId, 'session-child')
  assert.equal(calls.prompt[0].request.mode, 'queue')
  assert.deepEqual(calls.prompt[0].request.content, [{ type: 'text', text: 'why did the build fail?' }])
  assert.equal(calls.prompt[0].signal, signal)
  assert.equal(typeof calls.prompt[0].request.requestId, 'string')
  assert.ok(calls.prompt[0].request.requestId.length > 0)
})

test('runBtw refuses a bare command and a fork with no completed turn', async () => {
  const bare = await runBtw(
    {
      get(name) {
        if (name === 'sessionController') return { fork: async () => ({ sessionId: 'x' }) }
        return undefined
      },
    },
    { agent: { session: { header: { id: 'parent' } } }, rawInput: '   ', signal: new AbortController().signal },
  )
  assert.equal(bare.kind, 'error')
  assert.match(bare.text, /Usage: \/btw/)

  const noTurn = await runBtw(
    {
      get(name) {
        if (name === 'sessionController') {
          return {
            fork: async () => {
              const error = new Error('no completed turn')
              error.code = 'session/fork-unavailable'
              throw error
            },
          }
        }
        return undefined
      },
    },
    { agent: { session: { header: { id: 'parent' } } }, rawInput: 'hello', signal: new AbortController().signal },
  )
  assert.equal(noTurn.kind, 'error')
  assert.match(noTurn.text, /completed turn/)
})

test('adoptOnResume re-applies the policy only to a titled fork', () => {
  const applied = []
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          schemas: () => [{ name: 'read' }, { name: 'bash' }],
        }
      }
      return undefined
    },
  }
  const makeAgent = (title) => ({
    id: 'child',
    session: {
      header: { id: 'child', parentSession: 'parent', isSeeded: true },
      snapshotEvents: () => [{ type: 'session/title', data: { title } }],
    },
    ctx: {
      tools: {
        presentAs(mode) {
          applied.push(`present:${mode}`)
        },
        restrict(filter) {
          applied.push(`restrict:${filter.allow.join(',')}`)
        },
        guard() {
          applied.push('guard')
          return () => {}
        },
      },
      systemPrompt: {
        section(section) {
          applied.push(`section:${section.name}`)
          return () => {}
        },
      },
    },
  })

  adoptOnResume(ctx, makeAgent(`${TITLE_PREFIX}why?`))
  assert.deepEqual(applied, [
    'present:native',
    'restrict:read',
    'guard',
    `section:${SECTION_NAME}`,
  ])

  applied.length = 0
  adoptOnResume(ctx, makeAgent('Ordinary fork'))
  assert.deepEqual(applied, [])
})

test('the client module declares the expected plugin shape', async () => {
  const client = await loadClient()
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(typeof client.apply, 'function')
})

test('the command name is the /btw the command card is keyed to', () => {
  assert.equal(COMMAND, 'btw')
})

async function loadClient() {
  const source = await readFile(`${here}/../client.js`, 'utf8')
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  const url = new URL('../client.js', import.meta.url)
  url.searchParams.set('t', String(Math.random()))
  await import(url.href)
  assert.equal(definition.id, '@local/dsh-btw-sidechat')
  assert.equal(typeof definition.factory, 'function')

  const fakeReact = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const module = definition.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected client module: ${id}`)
  })
  return { ...module, ...module.__test, source }
}
