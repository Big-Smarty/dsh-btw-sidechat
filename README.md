<img src="icon.svg" width="64" alt="BTW Side Chat logo">

# BTW Side Chat

**Ask a side question in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) without interrupting the main task.** `/btw` forks the current conversation with its full context, answers in a read-only side chat, and opens the answer in a Codex-style right-sidebar window.

[![test](https://github.com/Big-Smarty/dsh-btw-sidechat/actions/workflows/test.yml/badge.svg)](https://github.com/Big-Smarty/dsh-btw-sidechat/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- **Full inherited context.** DSH's session log is the source of truth, so `/btw` forks the latest completed-turn prefix of the current conversation. The child sees the parent's user messages, assistant answers, and tool results — no re-summarization step.
- **Read-only by policy.** The child is pinned to native tools, then restricted to `read`, `read_image`, `glob`, `grep`, `web_search`, `web_fetch`, and `skill`. A monotonic per-agent guard denies every other tool, including `run_code` and any tool registered later. Deployments that register a tool on the agent scope (some delegation tools do) may still show that tool's schema; the guard denies its execution.
- **A side-chat system prompt.** The child is told that it is a read-only side chat, that the inherited transcript is context rather than a task to continue, that these are its tools, and that it must answer the question directly without asking a follow-up.
- **A real side window.** A `dsh-resource://btwchat/...` tab opens in the right sidebar with the normal Conversation: the inherited transcript, streaming answer, Markdown, and a composer for follow-ups.
- **A compact command card.** The raw resource address is hidden behind a side-chat card with the question and an **Open** button, so the tab can be reopened later from the transcript.
- **No build step, no dependencies.** Plain ESM Host code and a browser module, host theme tokens, English and Chinese UI copy.

## Install

Requires DeepSeek Harness 0.2.1-rc.2 or a nearby version with the right sidebar, the Session Controller, and `/btw` command support.

### From GitHub

1. Open **Plugins** in the DSH sidebar.
2. Choose **Add plugin** → **Install third-party plugin**.
3. Enter the repository URL:

   ```text
   https://github.com/Big-Smarty/dsh-btw-sidechat.git
   ```

   A local clone path works too and keeps the checkout linked for edits.
4. Install and enable the bundle, then refresh the page once so the client half loads.

Or ask a DSH agent to install the bundle from the same URL.

### Local clone

```bash
git clone https://github.com/Big-Smarty/dsh-btw-sidechat.git
cd dsh-btw-sidechat
npm test
```

Install the cloned directory through **Plugins → Add plugin** as above.

> Only one plugin may provide the global `/btw` command. Disable any other `/btw` plugin (for example `@michengai/dsh-btw`) before enabling this one; two global commands with the same name are a load error, not a shadow.

## Usage

| Action | How |
| --- | --- |
| Ask a side question | `/btw why does the retry test fail?` |
| Read the answer | The side chat opens automatically in the right sidebar |
| Follow up | Type in the side chat's composer; the same read-only child answers |
| Reopen | Click **Open** on the `/btw` card in the parent transcript |
| Close | Close the tab; the child session stays in the session list |

The side chat is a normal forked session, so it also appears in the workspace's session list and survives a restart. Its read-only policy is re-installed when it is resumed.

### What the side chat sees

The fork is cut at the latest **completed** turn. A `/btw` sent while the parent is mid-turn does not include the in-flight turn; a conversation with no completed turn returns a helpful error instead of creating an empty child.

### What "read-only" means

The side chat cannot write files, run shell commands, edit code, change configuration, create goals or schedules, spawn subagents or workflows, ask blocking questions, or read other sessions. It can read workspace content and the web. Its own conversation is a separate fork, so follow-up prompts and answers never enter the parent context.

## How it works

1. The Host command calls `sessionController.fork({ sessionId })`, which creates a forked child with the parent's event prefix and preset.
2. Before the first prompt, it pins the child to native tool presentation, computes the read-only intersection from `tools.schemas(child)`, installs `tools.restrict` and a `tools.guard`, and adds a `btw:side-chat` system-prompt section.
3. It titles the child `BTW · <question>`, which is also the durable marker used to re-adopt the policy after a cold resume.
4. It admits the question with `sessionController.prompt`, then returns a `dsh-resource://btwchat/session/<child>?parent=…&q=…` address in the command result.
5. The Client registers a `btwchat` resource provider, a right-sidebar tab type and body, a command card keyed `btw`, and a local `command/executed` listener. The listener refreshes the session catalog, then opens the tab.
6. The tab renders the normal `conversation.content` factory in `embedded` mode inside the child's `SessionProvider`. The inherited transcript and composer are the shipped ones.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limits

- **Web/Desktop only.** The side window uses the right sidebar, so the Client half needs a DSH Web or Desktop profile. The Host half still creates the child on a TUI host, but no side window opens there.
- **`command/executed` is local.** Auto-open happens in the browser tab that submitted `/btw`. In another tab, after a reload, or after a Host-side invocation, use the command card's **Open** button.
- **The title is the resume marker.** Renaming a side chat removes the `BTW · ` prefix; the live process keeps the restriction, but a later cold resume of that renamed session will no longer recognize it as a side chat.
- **No auto-archive.** Closing the tab leaves the forked session in the conversation list, like an ordinary fork.
- **Scoped tool schemas can remain visible.** `tools.restrict` filters inherited tools; a tool registered directly on the child's agent scope (for example a delegation tool added by a preset) stays in the schema list. The guard denies its execution, and the side-chat prompt states that only the listed tools are available.
- **Web tools are allowed.** `web_search` and `web_fetch` can send text to search providers. If the inherited transcript is sensitive, remove them from `READ_ONLY_TOOLS` in `index.js`.

## Development

```bash
npm test
```

The tests use Node's built-in test runner and cover command parsing, title and address codecs, the read-only intersection, policy text, the fork/adopt/prompt flow, error mapping, root-versus-child tool presentation, resume adoption, and the client module shape. CI runs on every push and pull request.

A live Host probe on 2026-10-20 forked a small fixture session, prompted the child with `/btw Reply with exactly: BTW PROBE OK`, and observed:

- the child title `BTW · Reply with exactly: BTW PROBE OK`;
- the answer `BTW PROBE OK`;
- the `btw:side-chat` section in the child's assembled prompt;
- `read`, `glob`, `grep`, `skill`, `read_image`, `web_search`, and `web_fetch` visible;
- `bash`, `write`, `edit`, and `run_code` absent (a preset-scoped `subagent` schema remained visible but is guard-denied);
- the command result address the Client parses.

The live Client slot tree confirmed the right-sidebar tab body, the `btw.conversation` child slot, and the `btw` command card. The auto-open path is client-local; it was verified by registration and codec tests rather than by driving the browser.

```text
index.js            Host half: /btw command, fork, read-only policy, resume adoption
client.js           Client half: resource provider, sidebar tab, command card, auto-open
cordis.patch.yml    Loads the bundle row
locale/             Plugin-inventory metadata (en, zh)
test/               Node tests for the pure helpers and the Host flow
docs/               Architecture and design notes
```

## Design notes

The `btw` prompt is adapted from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `/btw` side question (`Ephemeral side question for current interactive session. Answer briefly, directly; use conversation context already provided. NEVER use tools. NEVER ask follow-up questions.`). This plugin keeps the direct-answer discipline but changes two premises: DSH has a durable, forkable session log, and the user asked for a read-only side chat with its own tools. The result is a read-only tool surface and a side window instead of a one-shot overlay.

## Cost and safety

A side chat makes one additional model request series over the inherited prefix, then one per follow-up. The plugin runs Host code in-process with your permissions; install it only if you trust the source. It cannot widen the parent's permissions and does not bypass approvals, sandbox policy, plan mode, or workspace restrictions.

## License

MIT. See [LICENSE](LICENSE).
