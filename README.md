# opencode-mnemosyne

An [OpenCode](https://opencode.ai) v2 plugin that makes a
[Mnemosyne](https://github.com/mnemosyne-oss/mnemosyne) memory server work
**automatically** inside OpenCode.

A Mnemosyne **MCP** server only exposes tools — nothing calls
`mnemosyne_recall` or `mnemosyne_remember` for you. Mnemosyne's "automatic"
mode (inject working memory before an LLM call, capture after a tool call) only
exists in hosts that implement its plugin lifecycle. This plugin gives OpenCode
v2 the same behaviour using OpenCode's own plugin API.

| Mechanism | OpenCode v2 API | What it does |
|---|---|---|
| **Auto-recall** | `ctx.session.hook("context", …)` | Before a model call with a **new** user message, runs `mnemosyne_recall` and appends the best hits as a system part. Uses a short timeout so a slow server never blocks the turn. |
| **Auto-capture** | `ctx.event.subscribe` → `session.execution.succeeded` | When a user turn finishes, summarises the exchange with an LLM and stores the extracted durable facts via `mnemosyne_remember` (`scope=global`). |
| **Compaction capture** | `ctx.session.hook("compaction", …)` | Before every checkpoint summary (automatic or `/compact`), forces one bounded capture pass over the transcript that is about to be replaced, so durable facts reach Mnemosyne before those messages leave the context window. Fail-open and time-boxed. |
| **Auto-sleep** | periodic check (startup + every 15 min) | When unconsolidated working memory reaches `sleep.threshold`, runs `mnemosyne_sleep` so working memory can compress into the episodic/vector tier. |
| **Guidance** | `ctx.session.hook("context")` | Injects a built-in Mnemosyne tool-usage guide as a system part, so the plugin carries its own instructions and no manual `AGENTS.md` section is needed. |
| **MCP health** | `ctx.mcp.list` + local service API | Watches the MCP server's status and asks the host to reconnect it if it enters `failed` (OpenCode v2 does not retry a failed MCP connect on its own). |

It talks to the **same Mnemosyne endpoint** you already configure as an MCP
server, over streamable HTTP MCP. It does **not** need its own API key for the
summarizer: capture reuses the OpenCode provider already authenticated for the
session (falling back to the catalog default model).

## Requirements

- OpenCode v2 (`opencode2`).
- A reachable Mnemosyne MCP-over-HTTP endpoint.
- A bearer token for that endpoint.
- Node 20.16+ or Bun (the plugin loads `node:fs` through
  `process.getBuiltinModule` or `require`).

## Install

Copy this directory to `~/.config/opencode/plugins/mnemosyne/`:

```sh
mkdir -p ~/.config/opencode/plugins/mnemosyne
cp index.ts README.md ~/.config/opencode/plugins/mnemosyne/
```

OpenCode v2 auto-discovers plugin directories under `~/.config/opencode/plugins/`,
so **no `opencode.jsonc` change is required** to load it. The file watcher picks
it up automatically; if it does not, restart the service:

```sh
opencode2 service restart
```

The plugin has **no runtime dependencies** — `index.ts` is dependency-free and
the host executes it as-is. `package.json` and `tsconfig.json` exist only for
editor/type-checking and the smoke test (`npm install && npm test`).

Alternatively, reference the directory explicitly from `opencode.jsonc`:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mnemosyne"]
}
```

### Verify it loaded

```sh
opencode2 plugin list          # ID column should read opencode.mnemosyne
opencode2 api get /api/plugin  # look for state.status: "active"
```

(Plugin `console.log` output is not surfaced in the service log file. Look for
`failed to load plugin` + `mnemosyne` in
`~/.local/share/opencode/log/opencode.log` if it does not appear.)

## Configure the connection

The plugin needs an **endpoint URL** and a **bearer token**. Both are resolved
with the same precedence — the first source that is set wins:

1. **Environment**: `MNEMOSYNE_URL`, `MNEMOSYNE_API_KEY`.
2. **Config file** `~/.config/opencode/mnemosyne.json`: `url`, `token`.
3. **Your existing MCP entry**: the `url` and `Authorization` header of the MCP
   server named by `mcpHealth.server` (default `mnemosyne`) in
   `opencode.jsonc`. This is the zero-config path — if you already use
   Mnemosyne as an MCP server, the plugin reuses it.

Values may contain `{env:NAME}` placeholders, expanded inline (for example
`"Authorization": "Bearer {env:MNEMOSYNE_API_KEY}"`).

If neither endpoint nor token can be resolved, the plugin logs a warning and
disables itself.

## Configuration file

Defaults `< ~/.config/opencode/mnemosyne.json < environment variables`.

```json
{
  "url": "https://your-mnemosyne-host.example/mcp",
  "token": "{env:MNEMOSYNE_API_KEY}",
  "debug": false,
  "recall": {
    "enabled": true,
    "limit": 6,
    "minScore": 0.12,
    "perMemoryChars": 400,
    "totalChars": 2200,
    "timeoutMs": 4000,
    "projectContext": true
  },
  "capture": {
    "enabled": true,
    "exchanges": 2,
    "maxMemories": 5,
    "minGapMs": 10000,
    "model": null,
    "contextChars": 7000,
    "extraPrompt": "",
    "onCompaction": true,
    "compactionExchanges": 12,
    "compactionTimeoutMs": 20000
  },
  "sleep": {
    "enabled": true,
    "threshold": 30,
    "minIntervalMs": 3600000,
    "allSessions": true,
    "force": false
  },
  "guidance": { "enabled": true, "file": "", "text": "" },
  "mcpHealth": {
    "enabled": true,
    "server": "mnemosyne",
    "intervalMs": 90000,
    "initialDelayMs": 60000,
    "maxBackoffMs": 900000
  },
  "log": { "recall": false, "capture": true, "sleep": true }
}
```

Set `MNEMOSYNE_CONFIG` to use a different config file path.

### `recall`

| Key | Meaning |
|---|---|
| `enabled` | Turn auto-recall on/off. |
| `limit` | Max memories fetched per user message. |
| `minScore` | Hybrid-score cutoff for injection. |
| `perMemoryChars` | Per-memory character cap. |
| `totalChars` | Total character budget for the injected block. |
| `timeoutMs` | Abort a recall query after this long. Recall runs on the critical path, so it never retries; a slow server simply means no memory this turn. |
| `projectContext` | Prefix the query with the workspace directory name so memories from other projects (the store is global) rank lower. Default `true`. |

### `capture`

| Key | Meaning |
|---|---|
| `enabled` | Turn auto-capture on/off. |
| `exchanges` | Exchanges summarised per idle event (and looked back on first run). |
| `maxMemories` | Max memories stored per exchange. |
| `minGapMs` | Minimum time between capture runs for the same session. |
| `model` | Optional summarizer model `provider/model-id`; defaults to the session's own model. |
| `contextChars` | Character budget handed to the summarizer for one exchange. |
| `extraPrompt` | Extra system guidance appended to the summarizer prompt. |
| `onCompaction` | Force a capture pass when the session is compacted (automatic or `/compact`), before older messages are replaced by the summary. Default `true`. |
| `compactionExchanges` | Max exchanges looked back on one compaction capture. Default `12`. |
| `compactionTimeoutMs` | Total budget for one compaction capture; bounds how long compaction can be delayed. Default `20000`. |

> **Compaction capture is the safety net for the context window.** OpenCode's
> per-turn capture normally keeps up, but anything not captured before older
> messages are dropped by compaction can no longer be read from the transcript.
> The `compaction` hook runs before the summary is generated, bypasses the
> per-session capture gap, and processes the uncaptured tail (oldest first, up
> to `compactionExchanges`, within `compactionTimeoutMs`). Memories stored from
> this path carry the extra tag `pre-compaction`. The hook never throws: if
> Mnemosyne is unreachable or the budget is exceeded, the normal compaction
> cycle still runs. Note that compaction waits for this pass, so keep
> `compactionTimeoutMs` modest on slow connections.

### `sleep`

| Key | Meaning |
|---|---|
| `enabled` | Turn auto-sleep on/off. |
| `threshold` | Run `mnemosyne_sleep` when unconsolidated working memory reaches this. |
| `minIntervalMs` | Never run the sleep cycle more often than this. |
| `allSessions` | Pass `all_sessions=true` so aged rows across inactive sessions consolidate. |
| `force` | Pass `force` to skip the server's age gate. Off by default. |

> **Auto-sleep is a no-op until working memories age out.** With the default
> `force: false`, the server only consolidates rows past its own age threshold.
> Run `mnemosyne_sleep` with `dry_run: true` to see what would be eligible. If
> nothing is, and you want to consolidate anyway, set `sleep.force: true` — but
> note that force can make the server invoke its own LLM for summaries, so test
> with a dry run first.

### `guidance`

The plugin carries its own Mnemosyne tool-usage instructions and injects them as
a system part on each new user message, so you do **not** need to keep a
Mnemosyne section in `AGENTS.md`. The text lives in the plugin (override it with
`guidance.file` or `guidance.text` if you prefer).

| Key | Meaning |
|---|---|
| `enabled` | Inject the guidance block. Set `false` if you supply your own instructions elsewhere. |
| `file` | Optional path to a Markdown file whose contents replace the built-in text. |
| `text` | Inline guidance text; overrides both `file` and the built-in text. |

### `mcpHealth`

| Key | Meaning |
|---|---|
| `enabled` | Watch the MCP server and reconnect it if it fails. |
| `server` | Name of the MCP server entry in `opencode.jsonc` to watch. Also used to resolve `url`/`token`. |
| `intervalMs` | Poll interval used once the server is healthy. |
| `initialDelayMs` | Delay before the first check, so startup connects can settle. |
| `maxBackoffMs` | Cap for the exponential backoff applied after repeated failures. |

### `log`

Set `recall`, `capture`, `sleep` to `true` to emit activity logs. (Note that
plugin `console.log` is not currently surfaced in the service log file.)

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MNEMOSYNE_URL` | – | MCP endpoint (required unless set elsewhere) |
| `MNEMOSYNE_API_KEY` | – | Bearer token (a leading `Bearer ` is stripped) |
| `MNEMOSYNE_CONFIG` | `~/.config/opencode/mnemosyne.json` | Config file path |
| `MNEMOSYNE_RECALL` | `true` | `0`/`false` disables auto-recall |
| `MNEMOSYNE_RECALL_LIMIT` | `6` | Max memories per user message |
| `MNEMOSYNE_RECALL_MIN_SCORE` | `0.12` | Hybrid-score cutoff for injection |
| `MNEMOSYNE_RECALL_TIMEOUT_MS` | `4000` | Recall query timeout |
| `MNEMOSYNE_RECALL_PROJECT_CONTEXT` | `true` | Prefix recall queries with the workspace directory name |
| `MNEMOSYNE_CAPTURE` | `true` | `0`/`false` disables auto-capture |
| `MNEMOSYNE_CAPTURE_MAX` | `5` | Max memories stored per exchange |
| `MNEMOSYNE_CAPTURE_MODEL` | – | Summarizer `provider/model-id` |
| `MNEMOSYNE_CAPTURE_ON_COMPACTION` | `true` | `0`/`false` disables the pre-compaction capture pass |
| `MNEMOSYNE_CAPTURE_COMPACTION_MAX` | `12` | Max exchanges looked back on one compaction capture |
| `MNEMOSYNE_CAPTURE_COMPACTION_TIMEOUT_MS` | `20000` | Budget for one compaction capture |
| `MNEMOSYNE_SLEEP` | `true` | `0`/`false` disables auto-sleep |
| `MNEMOSYNE_SLEEP_THRESHOLD` | `30` | Unconsolidated working-memory threshold |
| `MNEMOSYNE_SLEEP_ALL_SESSIONS` | `true` | Pass `all_sessions` to `mnemosyne_sleep` |
| `MNEMOSYNE_GUIDANCE` | `true` | `0`/`false` disables the injected tool-usage guidance |
| `MNEMOSYNE_GUIDANCE_FILE` | – | File whose contents replace the built-in guidance text |
| `MNEMOSYNE_MCP_HEALTH` | `true` | `0`/`false` disables MCP health checks |
| `MNEMOSYNE_MCP_SERVER` | `mnemosyne` | MCP server entry name |
| `MNEMOSYNE_MCP_HEALTH_INTERVAL_MS` | `90000` | Healthy poll interval |
| `MNEMOSYNE_MCP_HEALTH_INITIAL_MS` | `60000` | First-check delay |
| `MNEMOSYNE_MCP_HEALTH_MAX_BACKOFF_MS` | `900000` | Backoff cap |
| `MNEMOSYNE_DEBUG` | `false` | Verbose client logging + scratchpad traces |

## Behaviour notes

- **Recall** injects once per new user message (not per tool continuation). A
  `# Mnemosyne memory` system block is added only when at least one result
  clears `minScore`. The block is labelled as background context, not user
  instructions.
- **Capture** runs shortly after a turn completes, looks at exchanges not yet
  processed (a per-session cursor is kept in plugin storage), asks the chosen
  LLM for a JSON array of durable memories, and stores each with
  `scope=global`, a `source` category, importance, `veracity: "inferred"`
  (it is an extraction, not a direct quote), and
  `metadata.tags: ["opencode", "auto-capture", "project:<dir>"]`.
- Nothing is stored when the exchange contains nothing durable — the
  summarizer is instructed to return `[]` for chit-chat, transient commands,
  and rejected drafts.
- **Compaction capture** runs inside OpenCode's `compaction` hook for every
  checkpoint summary (automatic or `/compact`) and forces one capture pass over
  the transcript that is about to be replaced. It bypasses the normal capture
  gap, is bounded by `capture.compactionExchanges` and
  `capture.compactionTimeoutMs`, and tags its memories `pre-compaction`. The
  hook never throws and never sets a compaction result: OpenCode's own summary
  is generated as usual afterwards.
- The plugin is loaded once **per project location**, and every instance sees
  the same broadcast events. Capture checks the session's `projectID` against
  the instance's own project and uses a jittered settle delay plus a stored
  cursor to avoid duplicates. This is **best-effort** — if the same project is
  open at several locations at once, a session can theoretically be processed
  more than once. Set `capture.minGapMs` higher if you see duplicates.
- If a session's cursor message falls out of the context window, capture
  re-examines only the most recent window rather than rewinding to the start of
  the transcript (which would re-capture old turns). Compaction capture is what
  makes the pre-compaction tail the last chance to capture those exchanges, so
  leave `capture.onCompaction` enabled if durable memory matters more than a
  few seconds of compaction delay.
- **Guidance** is injected once per new user message (not per tool
  continuation), alongside recall. It is a fixed system part, so it costs a
  small, constant amount of context per turn; disable it with
  `guidance.enabled: false` if you keep the instructions in `AGENTS.md` instead.
- Recall runs on its own client and never queues behind capture, sleep, or
  health checks. Sleep runs on its own client and uses a longer timeout.

## How to verify it works

1. Confirm the plugin is **active** (`opencode2 plugin list`, or
   `opencode2 api get /api/plugin` → `opencode.mnemosyne` → `active`).
2. **Capture**: work on something real for a turn, wait a few seconds, then
   check the store grew: `mnemosyne_stats` shows new rows with a `source` of
   `decision`/`fact`/`insight`/… and tags containing `opencode` +
   `auto-capture`.
3. **Recall**: in a brand-new session, ask a question whose answer lives in an
   earlier captured memory. If the model answers using it without you
   prompting, injection is working. You can also watch a memory's
   `recall_count` increase on the server.
4. **Compaction**: run `/compact` (or wait for automatic compaction) and check
   that the store grew by memories tagged `pre-compaction`. If nothing was
   uncaptured, the pass is a no-op.
5. **Sleep**: `mnemosyne_stats` should show `beam.episodic_memory.total > 0`
   once consolidation has run. If it never grows while
   `working_memory.unconsolidated` is high, see the auto-sleep note above.
6. Tuning: edit `~/.config/opencode/mnemosyne.json` and touch `index.ts` — the
   watcher reloads the plugin.

## Troubleshooting

- **Plugin not listed / not active** — confirm the directory is
  `~/.config/opencode/plugins/mnemosyne/` with an `index.ts`, then
  `opencode2 service restart`. Look for `failed to load plugin` + `mnemosyne`
  in `~/.local/share/opencode/log/opencode.log`.
- **"no Mnemosyne MCP endpoint configured"** — set `url` in
  `mnemosyne.json` or `MNEMOSYNE_URL`, or add a `url` to the MCP entry named in
  `mcpHealth.server` in `opencode.jsonc`.
- **"no bearer token found"** — set `MNEMOSYNE_API_KEY`, add `token` to
  `mnemosyne.json`, or add an `Authorization` header to the MCP entry.
- **Capture makes no calls** — the summarizer reuses the model the session runs
  on (`ctx.generate.text`). Check the session model is reachable, or pin one
  with `capture.model` / `MNEMOSYNE_CAPTURE_MODEL`.
- **Recall feels weak** — lower `recall.minScore`, raise `recall.limit`, or run
  `mnemosyne_sleep` on the server so the episodic tier is populated (hybrid
  recall works best once older memories are consolidated).
- **Recall adds latency** — lower `recall.timeoutMs`; the hooks already skip
  injection on timeout rather than retrying.

## Development

`package.json` and `tsconfig.json` are dev-only; the plugin itself has no
runtime dependencies.

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run smoke       # node --experimental-transform-types test/smoke.ts
npm test            # typecheck + smoke
```

`test/smoke.ts` runs the plugin against a mock OpenCode setup context and a
mock Mnemosyne MCP server. It covers the pre-compaction capture path (memories
stored, tagged `pre-compaction`, cursor advanced, repeat runs are no-ops) and
keeps the hook fail-open when the endpoint is unreachable. The
`--experimental-transform-types` flag is needed because the plugin uses
TypeScript parameter properties, which Node's default type stripping does not
transform.

## Security notes

- Memory text is injected into future sessions as system context. Treat stored
  memories as a **persistent prompt-injection surface**: the plugin labels them
  as background context, but a poisoned or mistaken memory can still influence
  later behaviour. Review what gets stored.
- Auto-capture sends the exchange to the configured LLM and stores extracted
  facts on the Mnemosyne server. Do not enable it in sessions where the
  transcript is sensitive unless that is acceptable.
- Auto-recall sends the current user message to the Mnemosyne server as the
  query.
- Prefer `MNEMOSYNE_API_KEY` (or a `{env:…}` placeholder) over a literal token
  in `opencode.jsonc`, and keep that file readable only by you.

## License

MIT — see [LICENSE](LICENSE).
