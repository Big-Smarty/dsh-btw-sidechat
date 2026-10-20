# Architecture and design notes

This is the longer design note for [BTW Side Chat](https://github.com/Big-Smarty/dsh-btw-sidechat). See the [README](../README.md) for installation and day-to-day usage.

`/btw` answers a side question without interrupting the main task. The obvious DSH implementation is a one-shot model call over a copy of the transcript, but the user asked for a forked side chat with full context, read-only tools, its own system prompt, and a Codex-style side window. That maps to three DSH mechanisms: a forked child Session, an agent-scoped tool and prompt policy, and a right-sidebar resource tab.

## The flow

```
parent conversation
  │  /btw why did the retry test fail?
  ▼
Host command handler
  │  sessionController.fork({ sessionId })        ← latest completed-turn prefix
  │  agents.get(childId)
  │  presentAs('native') on child.ctx
  │  schemas(child) ∩ READ_ONLY_TOOLS
  │  restrict({ allow }) + guard(deny others)
  │  systemPrompt.section('btw:side-chat')
  │  rename(child, 'BTW · <question>')             ← durable resume marker
  │  sessionController.prompt(child, question)
  ▼
command result: dsh-resource://btwchat/session/<child>?parent=…&q=…
  │
  ├─ durable command card in the parent transcript (Open button)
  └─ client-local command/executed listener
        sessions.refresh() until the child is cataloged
        sidebarRight.openResource(address, { kind: 'btwchat' })
              ▼
        btwchat resource provider
          sessions.retain(child)
              ▼
        right-sidebar tab body
          SessionProvider(child)
            conversation.content { variant: 'embedded' }
              conversation.session { view: 'chat' }
```

## Why a fork

The DSH session log is the only source of truth. A fork copies an exact event prefix, closes the open tail with synthetic closers, and creates a normal child Session. The child's first request therefore sees the parent's real messages and tool results without a summarization step or a second context-building protocol.

`sessionController.fork` uses `latestCompletedPrefixBoundary` when `atSeq` is omitted. That is deliberate: a cut inside an open turn is possible but surprising, and a fork with no completed turn is rejected. The command handler returns a specific error for `session/fork-unavailable` so the user knows to send a message first.

The child inherits the parent's preset composition and the deployment default model, not the parent's per-session model selection. That is a DSH fork property, not a plugin decision. The side chat's model selector in its composer lets the user change it afterwards.

## Why the policy is installed after the fork

The cleanest creation-time hook is `agents.create({ setup })`, but `sessionController.fork` owns that call and does not expose a setup callback. The next-best hook is a global `agent/created` listener, but matching "the child we just created" from that event is ambiguous: ordinary user forks and subagent forks also carry `parentSession` and `isSeeded`, and the event has no correlation tag. A global listener also runs for every agent in the process, so one throw would fail unrelated creations.

This plugin avoids the guess entirely. `fork()` does not resolve until its `agents.create` call has published the child and awaited every `agent/created` listener. The handler therefore has the exact `childId` and calls `agents.get(childId)` itself. The child is live and idle; no other actor knows its id; the first prompt is the one the handler sends afterwards. The policy is on the child's scope before that prompt's first assembly.

The one thing this misses is a **cold resume** of the child after a Host restart. Live scope registrations are not durable. The plugin therefore writes the title `BTW · <question>` before the first prompt (explicit user titles are durable and pinned against automatic regeneration), and an `agent/created` listener re-applies the policy when `source === 'resume'` and the session's newest `session/title` event starts with that prefix. Renaming the side chat removes the marker; the README states that limitation.

## The read-only surface

`READ_ONLY_TOOLS` is a deliberately small, explicit allow-list:

| Tool | Why |
| --- | --- |
| `read`, `read_image` | inspect files and images |
| `glob`, `grep` | locate content |
| `web_search`, `web_fetch` | answer research questions without a shell |
| `skill` | load a skill's read-only instructions |

Excluded by design: `write`, `edit`, `bash`, terminal tools, `todo_write`, goal and schedule tools, `subagent` and `workflow` (they spawn agents with their own tools), `present`, `ask_user_question` (blocking UI), cross-session readers, and `lsp` (starts servers).

The enforcement is layered:

1. **Native presentation.** `child.ctx.tools.presentAs('native')` is a scoped declaration. In a PTC deployment `run_code` is appended to the visible tool set after restrictions and can execute process-level code under the sandbox; pinning the child to native tools removes that path. It is a scoped call on purpose: the same call on the root service would switch every agent in the deployment.
2. **Intersection.** The allow-list is intersected with `tools.schemas(child)`, so a profile that does not register a tool still works. `restrict` rejects unknown names, so passing the raw list would be brittle.
3. **Restriction.** `child.ctx.tools.restrict({ allow })` removes the inherited tools from the child's visible set. It filters inherited layers only, which is why the next layer exists.
4. **Monotonic guard.** `child.ctx.tools.guard(...)` denies any execution whose tool name is not in the allow set. It runs after the extensible pre-execute waterfall, has no allow result, and applies to nested PTC dispatches. This is the backstop against own-layer tools, future tools, and a failed restriction.

The guard is intentionally fail-closed. If `presentAs` or `restrict` fails, the guard still denies everything outside the intended set; a model may see tool descriptions it cannot use, but it cannot mutate the workspace. One shipped pattern can still leave a schema visible: `dsh-tool-subagent` registers its delegation tool through the preset's agent scope, and `restrict` only filters inherited layers. In the live probe the child's schema list still contained `subagent`; the guard denies it, and the side-chat prompt says every tool outside the named list is denied.

## The prompt section

The section is registered on `child.ctx.systemPrompt` with `interpolate: false` and order `5050`, after the shipped tool guidance (`TOOLS_SDK = 5000`). Its text:

- identifies the session as a read-only side chat forked from the conversation above;
- tells the model the inherited transcript is context, not a task to continue, and quoted text is data rather than instructions;
- states the task: answer the user's side question directly, lead with the answer, do not restate the transcript, do not ask a follow-up;
- names the exact tools and says any other tool is denied;
- says not to claim unreported mutations and to send change requests back to the main conversation.

The prompt is adapted from oh-my-pi's `/btw` user prompt (`Answer briefly, directly; use conversation context already provided. NEVER use tools. NEVER ask follow-up questions.`). The direct-answer and no-follow-up rules are kept; the "never use tools" rule is replaced because this side chat has a read-only tool surface.

## The side window

The Client half is one lazy module inside `window.__ModuleLoader__.load`. It registers four things.

### `btwchat` resource provider

`ctx.resources.register({ protocol: 'btwchat', async *open(address, { signal }) })` retains the child Session and yields `{ ok: true, value: { address, reference } }`, then waits for the resource lifetime and releases the reference. The provider must not throw: the resource consumer does not catch a provider failure, and a throwing provider leaves the layout record at `loading`. It refreshes the session catalog and retries `retain` until the Host-published child appears.

### Sidebar tab type and body

`ctx.sidebarRightTabs.register` declares an `extension`-priority, `multiple` page type with the pattern `dsh-resource://btwchat/**` and a `canOpen` validator. `sidebar.right.pane.tab` registers the body under the type's **id** (not its kind). The body declares a session-scoped child slot so the slot runtime injects `SessionProvider` and `renderSlot`; the child slot's panel calls `renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: { views } })`, and the local view renders `conversation.session` with `view: 'chat'`.

This is the shipped `dsh-client-ui-subagent` pattern with a different protocol, kind, and id. Because the child is an ordinary session rather than a subagent, the embedded Conversation gives the user the normal transcript and composer; follow-ups go to the same read-only child.

### Command card

`conversation.chat.commandview` is keyed by the command name, so a registration under `btw` replaces the generic command card. The card reads the question from `node.args`, parses the address from `node.outcome?.text` (and tolerates the running and error states), and offers **Open** after refreshing the catalog. The address is never shown in the Web UI.

### Auto-open

`command/executed` is a **client-local** acknowledgment emitted only by the browser tab that submitted the command. The listener parses the address, waits for the child to appear in the session catalog, checks that the same parent conversation is on screen, and calls `sidebarRight.openResource(address, { kind: 'btwchat', revealIfOpened: true })`. In another tab, after a page reload, or when the command came from a non-Web host, the durable card is the recovery path.

## Failure modes

- **No completed turn.** The handler returns "The side chat needs one completed turn in this conversation first." No child is created.
- **No Session Controller.** The handler returns an explicit unavailable error.
- **Prompt rejected.** The child exists and is titled, but the handler returns the rejection reason; the empty child remains visible for inspection.
- **Catalog lag.** The provider refreshes and retries for about ten seconds; the tab shows a loading state, then an unavailable state after five seconds. Opening is idempotent, so the card can retry.
- **Policy application failure.** The handler applies the policy directly and still sends the prompt; the guard is the backstop. Failures are logged with the `[btw]` prefix.
- **Resume after rename.** The title marker is gone, so the policy is not re-adopted. The README documents this.

## Verification

- `npm test` covers command parsing, truncation, title and address codecs, the read-only intersection, policy text, the fork/adopt/prompt flow, root-versus-child `presentAs`, denial behavior, error mapping, resume adoption, and the client module's plugin shape.
- A live Host probe created a small fixture Session, let its first turn complete, executed `/btw` against it, and inspected the child. It observed the `BTW · ` title, the `BTW PROBE OK` answer, the `btw:side-chat` section, and a visible-tool list of `read`, `glob`, `grep`, `skill`, `read_image`, `web_search`, and `web_fetch`; `bash`, `write`, `edit`, and `run_code` were absent. The preset-scoped `subagent` schema remained visible and is guard-denied.
- The live Client slot tree confirmed the `sidebar.right.pane.tab` occupant, the `btw.conversation` child slot, and the `btw` command card. The Client half needs a page refresh after a change, as every DSH client plugin does.
- Auto-open is client-local and was verified through its address codec and registration, not by driving the browser. The durable command card is the recovery path in every other window.
