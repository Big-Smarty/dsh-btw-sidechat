/**
 * BTW side chat — the browser half.
 *
 * One lazy module factory. It registers:
 *   - a `btwchat` resource provider that retains the forked child Session;
 *   - a right-sidebar tab type + body that renders the normal Conversation;
 *   - a `/btw` command card that hides the resource address and offers Open;
 *   - a local `command/executed` listener that opens the new tab immediately
 *     in the tab that submitted the command (the event is client-local).
 *
 * The side chat itself is a normal Session, so the embedded Conversation gives
 * the user the ordinary transcript and composer; follow-ups go to the same
 * child, whose tools remain the read-only set installed by the Host.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-btw-sidechat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'btwSideChat'
    const TAB_ID = '@local/dsh-btw-sidechat'
    const TAB_KIND = 'btwchat'
    const TAB_PATTERN = 'dsh-resource://btwchat/**'
    const CONVERSATION_SLOT = 'btw.conversation'
    const COMMAND = 'btw'
    const STYLE_ID = '@local/dsh-btw-sidechat/btw.css'

    const en = {
      'panel.title': 'Side chat',
      'tab.loading': 'Opening the side chat…',
      'tab.unavailable': 'The side chat did not load. Close this tab and try /btw again.',
      'card.title': 'Side chat',
      'card.running': 'Opening a read-only side chat…',
      'card.open': 'Open',
      'card.opening': 'Opening…',
      'card.unavailable': 'The side chat is not available in this window yet. Try again in a moment.',
      'card.failed': 'Could not open the side chat.',
      'card.noSurface': 'Switch to the conversation that asked the side question, then open it again.',
      'card.forked': 'The conversation was forked with its full context. Tools are read-only.',
    }

    const zh = {
      'panel.title': '旁问',
      'tab.loading': '正在打开旁问…',
      'tab.unavailable': '旁问未能加载。请关闭此标签页并重新执行 /btw。',
      'card.title': '旁问',
      'card.running': '正在打开只读旁问…',
      'card.open': '打开',
      'card.opening': '正在打开…',
      'card.unavailable': '当前窗口暂时无法打开旁问，请稍后重试。',
      'card.failed': '无法打开旁问。',
      'card.noSurface': '请切换到发起旁问的会话，然后再打开。',
      'card.forked': '该会话已连同完整上下文被派生；工具为只读。',
    }

    const CSS = `
      .btw-card {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        padding: 10px 12px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        line-height: 1.5;
        letter-spacing: 0;
      }
      .btw-card[data-tone="error"] {
        border-color: var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l2));
      }
      .btw-cardIcon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 28px;
        height: 28px;
        border-radius: 9px;
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
        color: var(--dsw-alias-brand-primary);
      }
      .btw-cardText {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .btw-cardTitle {
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
      }
      .btw-cardQuestion {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--dsw-alias-label-secondary);
      }
      .btw-cardNote {
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
      }
      .btw-cardError {
        flex: 1;
        min-width: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary));
      }
      .btw-cardAction {
        flex: none;
        appearance: none;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px;
        padding: 4px 12px;
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .btw-cardAction:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .btw-cardAction:disabled {
        cursor: wait;
        opacity: 0.55;
      }
      .btw-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        min-height: 120px;
        padding: 24px;
        box-sizing: border-box;
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
        text-align: center;
      }
    `

    /** Collapse whitespace and bound display text. */
    function truncate(value, max) {
      const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
      if (text.length <= max) return text
      let cut = text.slice(0, max)
      const last = cut.charCodeAt(cut.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
      return `${cut.trimEnd()}…`
    }

    /**
     * Parse one canonical side-chat address.
     * @param value - possible resource address.
     * @returns the child, parent, and tab question, or null.
     */
    function parseAddress(value) {
      if (typeof value !== 'string' || value === '') return null
      let url
      try {
        url = new URL(value)
      } catch {
        return null
      }
      if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'btwchat') return null
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return null
      let childId
      try {
        childId = decodeURIComponent(parts[1])
      } catch {
        return null
      }
      if (childId === '') return null
      return {
        childId,
        parentId: url.searchParams.get('parent') ?? '',
        question: url.searchParams.get('q') ?? '',
      }
    }

    /**
     * Pull the first side-chat address out of a command result.
     * @param text - command result text.
     * @returns the address, or undefined.
     */
    function addressFromText(text) {
      if (typeof text !== 'string') return undefined
      const match = text.match(/dsh-resource:\/\/btwchat\/[^\s]+/u)
      return match === null ? undefined : match[0]
    }

    /** Sleep without retaining a timer after abort. */
    function delay(ms, signal) {
      return new Promise((resolve) => {
        if (signal !== undefined && signal.aborted) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        function onAbort() {
          clearTimeout(timer)
          resolve()
        }
        if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
      })
    }

    /** Wait until a resource consumer releases the address. */
    function waitForAbort(signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const CSS_STYLE = CSS
      const t = () => ctx.locale.bind(NS)

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
        if (existing !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-btw-sidechat'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS_STYLE
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'btw: styles')

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'btw: dictionaries')

      /**
       * Wait until the Host-created child is in the client catalog. A Host-side
       * fork bypasses the client fork placeholder, so the session-list refresh
       * is what makes `retain(childId)` legal.
       * @param childId - forked session id.
       * @returns whether the row arrived.
       */
      async function ensureSessionKnown(childId) {
        const sessions = ctx.get('sessions')
        if (sessions === undefined) return false
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const state = sessions.list.getSnapshot()
          if (state !== undefined && state.byId !== undefined && state.byId[childId] !== undefined) {
            return true
          }
          try {
            await sessions.refresh()
          } catch {
            // A reconnect or a busy Host simply retries on the next pass.
          }
          await delay(100)
        }
        const finalState = sessions.list.getSnapshot()
        return Boolean(finalState !== undefined && finalState.byId !== undefined && finalState.byId[childId])
      }

      /**
       * Surface a failure on the composer of one Session.
       * @param sessionId - target session.
       * @param text - notice body.
       */
      function notify(sessionId, text) {
        try {
          const sessions = ctx.get('sessions')
          const conversation = ctx.get('conversation')
          if (sessions === undefined || conversation === undefined) return
          const actx = sessions.scope(sessionId)
          if (actx === undefined) return
          conversation.input.for(actx).notify('error', text)
        } catch {
          // Notices are best-effort; the command card still carries the state.
        }
      }

      /**
       * Retain a child with a bounded catalog wait. The provider must never
       * throw: the resource consumer does not catch a provider failure.
       * @param childId - forked session id.
       * @param signal - resource lifetime.
       * @returns a retained reference, or undefined.
       */
      async function retainEventually(childId, signal) {
        const sessions = ctx.get('sessions')
        if (sessions === undefined) return undefined
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (signal.aborted) return undefined
          try {
            return sessions.retain(childId, { source: 'btwChat', signal })
          } catch {
            // Unknown until the catalog refresh lands.
          }
          try {
            await sessions.refresh()
          } catch {
            // Retry below.
          }
          await delay(100, signal)
        }
        return undefined
      }

      /**
       * Open one side-chat tab, refreshing the client catalog first.
       * @param address - canonical resource address.
       * @param sourceSessionId - Session that submitted `/btw`.
       * @param report - whether to surface failures on the composer.
       */
      async function openSideChat(address, sourceSessionId, report) {
        const parsed = parseAddress(address)
        if (parsed === null) return
        const known = await ensureSessionKnown(parsed.childId)
        if (!known) {
          if (report) notify(sourceSessionId, t()('card.unavailable'))
          return
        }
        const sidebar = ctx.get('sidebarRight')
        if (sidebar === undefined) {
          if (report) notify(sourceSessionId, t()('card.unavailable'))
          return
        }
        let mounted
        try {
          mounted = typeof sidebar.mounted.getSnapshot === 'function' ? sidebar.mounted.getSnapshot() : undefined
        } catch {
          mounted = undefined
        }
        if (mounted !== undefined && mounted !== null && mounted !== sourceSessionId) {
          // The user moved to another conversation; the command card's Open
          // remains available instead of opening a tab in the wrong column.
          return
        }
        try {
          sidebar.openResource(address, { kind: TAB_KIND, revealIfOpened: true })
        } catch (error) {
          console.error('[btw] could not open the side chat tab:', error)
          if (report) notify(sourceSessionId, t()('card.failed'))
        }
      }

      // --- Resource provider -------------------------------------------------
      ctx.effect(() => {
        const resources = ctx.get('resources')
        if (resources === undefined) return () => {}
        try {
          return resources.register({
            protocol: 'btwchat',
            async *open(address, { signal }) {
              const parsed = parseAddress(address)
              if (parsed === null) return
              const reference = await retainEventually(parsed.childId, signal)
              if (reference === undefined) return
              try {
                yield { ok: true, value: { address: parsed, reference } }
                await waitForAbort(signal)
              } finally {
                reference.release()
              }
            },
          })
        } catch (error) {
          console.error('[btw] could not register the side-chat resource:', error)
          return () => {}
        }
      }, 'btw: chat resource provider')

      // --- Right-sidebar tab type and body ----------------------------------
      const titleOf = (address) => {
        const parsed = parseAddress(address)
        const question = parsed === null ? '' : truncate(parsed.question, 48)
        return question === '' ? t()('panel.title') : question
      }

      const BtwTab = function BtwTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
        const { tab } = useTabInfo()
        const resource = useResource(tab.contentId)
        const [slow, setSlow] = React.useState(false)
        React.useEffect(() => {
          if (resource.value !== undefined) {
            setSlow(false)
            return undefined
          }
          const timer = setTimeout(() => setSlow(true), 5000)
          return () => clearTimeout(timer)
        }, [resource.value])
        if (resource.value === undefined) {
          return h('div', { className: 'btw-state', role: 'status' }, t()(slow ? 'tab.unavailable' : 'tab.loading'))
        }
        return h(SessionProvider, { session: resource.value.reference }, renderSlot(CONVERSATION_SLOT, {}))
      }

      const BtwChatView = function BtwChatView({ renderSlot }) {
        return renderSlot('conversation.session', { view: 'chat' })
      }

      const BtwConversation = function BtwConversation({
        sessionId,
        useSession,
        useConversation,
        useSessions,
        renderFactorySlot,
      }) {
        const session = useSession((value) => value)
        if (session === undefined) return null
        const conversation = useConversation((value) => value)
        const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank)
        const activeTargets = conversation === undefined ? 0 : conversation.activeTargets.size
        const active =
          activeTargets > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running === true
        const settling =
          !active && session.openState === 'loading' && summaryBlank !== true
        const hero = !active && (session.openState === 'open' || summaryBlank === true)
        return renderFactorySlot(
          'conversation.content',
          {
            variant: 'embedded',
            phase: settling ? 'settling' : hero ? 'hero' : 'active',
            hero,
          },
          { slots: { views: BtwChatView } },
        )
      }

      let wired = false
      const wireSidebar = () => {
        if (wired) return
        const tabs = ctx.get('sidebarRightTabs')
        if (tabs === undefined) return
        wired = true

        // A client reload can briefly leave the previous generation's type in
        // the registry. Reuse it rather than failing setup on a duplicate id.
        if (tabs.get(TAB_KIND) === undefined) {
          try {
            ctx.effect(
              () =>
                tabs.register({
                  id: TAB_ID,
                  kind: TAB_KIND,
                  multiple: true,
                  patterns: [TAB_PATTERN],
                  priority: 'extension',
                  canOpen: (address) => parseAddress(address) !== null,
                  title: titleOf,
                }),
              'btw: sidebar tab type',
            )
          } catch (error) {
            console.error('[btw] sidebar tab type registration failed:', error)
          }
        }

        const register = (slot, options, component) => {
          try {
            ctx.slots.inject(slot, () => {
              try {
                return ctx.slots.register(options(), component)
              } catch (error) {
                console.error('[btw] sidebar slot registration failed:', slot, error)
                return () => {}
              }
            })
          } catch (error) {
            console.error('[btw] sidebar slot injection failed:', slot, error)
          }
        }

        register(
          'sidebar.right.pane.tab',
          () => ({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            children: { [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } },
          }),
          BtwTab,
        )

        register(CONVERSATION_SLOT, () => ({ name: CONVERSATION_SLOT, locale: NS }), BtwConversation)
      }

      if (ctx.get('sidebarRightTabs') !== undefined) wireSidebar()
      ctx.inject(['sidebarRightTabs'], () => wireSidebar())

      // --- Command card ------------------------------------------------------
      const BtwCommandCard = function BtwCommandCard({ node, t: translate, inputActions }) {
        const question = typeof node.args === 'string' ? node.args.trim() : ''
        const outcome = node.outcome
        const address = outcome !== null && outcome.kind === 'success' ? addressFromText(outcome.text) : undefined
        const [busy, setBusy] = React.useState(false)

        const open = React.useCallback(async () => {
          if (address === undefined || busy) return
          const parsed = parseAddress(address)
          if (parsed === null) return
          setBusy(true)
          try {
            const known = await ensureSessionKnown(parsed.childId)
            if (!known) {
              inputActions?.notify?.('error', translate('card.unavailable'))
              return
            }
            const sidebar = ctx.get('sidebarRight')
            if (sidebar === undefined) {
              inputActions?.notify?.('error', translate('card.unavailable'))
              return
            }
            sidebar.openResource(address, { kind: TAB_KIND, revealIfOpened: true })
          } catch (error) {
            console.error('[btw] could not open the side chat from its command card:', error)
            inputActions?.notify?.('error', translate('card.failed'))
          } finally {
            setBusy(false)
          }
        }, [address, busy, inputActions, translate])

        if (outcome === null) {
          return h(
            'div',
            { className: 'btw-card', 'data-tone': 'pending' },
            h('span', { className: 'btw-cardIcon', 'aria-hidden': true }, bubbleIcon()),
            h('div', { className: 'btw-cardText' },
              h('span', { className: 'btw-cardTitle' }, translate('card.title')),
              h('span', { className: 'btw-cardNote' }, translate('card.running')),
            ),
          )
        }

        if (outcome.kind === 'error') {
          return h(
            'div',
            { className: 'btw-card', 'data-tone': 'error', role: 'alert' },
            h('span', { className: 'btw-cardIcon', 'aria-hidden': true }, bubbleIcon()),
            h('div', { className: 'btw-cardText' },
              h('span', { className: 'btw-cardTitle' }, translate('card.title')),
              h('span', { className: 'btw-cardError' }, outcome.text ?? translate('card.failed')),
            ),
          )
        }

        return h(
          'div',
          { className: 'btw-card', 'data-tone': 'success' },
          h('span', { className: 'btw-cardIcon', 'aria-hidden': true }, bubbleIcon()),
          h('div', { className: 'btw-cardText' },
            h('span', { className: 'btw-cardTitle' }, translate('card.title')),
            h('span', { className: 'btw-cardQuestion', title: question }, question === '' ? translate('card.forked') : question),
            h('span', { className: 'btw-cardNote' }, translate('card.forked')),
          ),
          address === undefined
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'btw-cardAction',
                  disabled: busy,
                  onClick: () => {
                    void open()
                  },
                },
                busy ? translate('card.opening') : translate('card.open'),
              ),
        )
      }

      try {
        ctx.slots.inject('conversation.chat.commandview', () => {
          try {
            return ctx.slots.register(
              { name: 'conversation.chat.commandview', key: COMMAND, locale: NS },
              BtwCommandCard,
            )
          } catch (error) {
            console.error('[btw] command card registration failed:', error)
            return () => {}
          }
        })
      } catch (error) {
        console.error('[btw] command card injection failed:', error)
      }

      // --- Auto-open on the submitting client -------------------------------
      ctx.effect(
        () =>
          ctx.on('command/executed', (sessionId, name, result) => {
            if (name !== COMMAND || result === undefined || result.kind !== 'success') return
            const address = addressFromText(result.text)
            if (address === undefined) return
            void openSideChat(address, sessionId, true)
          }),
        'btw: auto-open side chat',
      )
    }

    /** Small inline glyph for the command card; original artwork. */
    function bubbleIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.5 3.25h8.25a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-1.25 1.25H6.5L3.75 13.5v-2.25H2.5A1.25 1.25 0 0 1 1.25 10V4.5A1.25 1.25 0 0 1 2.5 3.25Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M13.25 6.5h.25a1.25 1.25 0 0 1 1.25 1.25v5.5L13.5 14.5V12h-1.25', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', opacity: 0.55 }),
      )
    }

    return {
      inject,
      apply,
      __test: { addressFromText, parseAddress, truncate },
    }
  },
})
