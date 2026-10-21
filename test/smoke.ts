/**
 * Smoke test for opencode-mnemosyne.
 *
 * Runs the plugin against a mock OpenCode setup context and a mock Mnemosyne
 * MCP server (streamable HTTP), asserting the compaction hook distills the
 * transcript about to be summarized into Mnemosyne before compaction proceeds,
 * that an interrupted turn (a user escape/stop, or a prompt superseded by a
 * newer one) is still captured while a shutdown interruption is not, and that
 * the hook stays fail-open when the server is unreachable.
 *
 * Run (Node >= 23.6 strips types natively):
 *   node test/smoke.ts
 * or:
 *   npm run smoke
 */

import assert from "node:assert/strict"
import http from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Loose = Record<string, any>

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Poll until `predicate` holds; the capture path has a jittered settle delay. */
async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  assert.ok(predicate(), message)
}

function startMockServer(): Promise<{ url: string; close: () => Promise<void>; calls: Loose[] }> {
  const calls: Loose[] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      let message: Loose
      try {
        message = JSON.parse(body) as Loose
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "smoke-session" })
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "mock-mnemosyne", version: "smoke" },
            },
          }),
        )
        return
      }
      if (message.id === undefined) {
        // Notifications (e.g. notifications/initialized) have no reply.
        res.writeHead(202)
        res.end()
        return
      }
      const name = String(message.params?.name ?? "")
      const args = (message.params?.arguments ?? {}) as Loose
      calls.push({ name, args })
      const payload =
        name === "mnemosyne_stats"
          ? { stats: { total_memories: 1 } }
          : name === "mnemosyne_recall"
            ? { results: [] }
            : name === "mnemosyne_sleep"
              ? { status: "no_op" }
              : { status: "stored" }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () =>
          new Promise((done) => {
            server.close(() => done(undefined))
          }),
      })
    })
  })
}

function makeCtx(messages: Loose[]) {
  const hooks: Record<string, Array<(event: Loose) => unknown>> = {}
  const storage = new Map<string, unknown>()
  const commands: Loose[] = []
  const prompts: Loose[] = []
  const compacts: Loose[] = []

  // Controllable server event stream. The test pushes events the way the real
  // broadcast would; the plugin's capture loop consumes them.
  const pending: Loose[] = []
  const waiters: Array<(value: Loose | undefined) => void> = []
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    for (const waiter of waiters.splice(0)) waiter(undefined)
  }
  const emit = (event: Loose) => {
    const waiter = waiters.shift()
    if (waiter) waiter(event)
    else pending.push(event)
  }

  const context = {
    app: { version: "smoke" },
    location: { directory: "/work/proj", project: { id: "p1" } },
    session: {
      hook: async (name: string, callback: (event: Loose) => unknown) => {
        ;(hooks[name] ||= []).push(callback)
        return { dispose: async () => {} }
      },
      get: async () => ({ projectID: "p1", model: { providerID: "mock", id: "mock-model" } }),
      context: async () => messages,
      prompt: async (input: Loose) => {
        prompts.push(input)
        return { id: "inbox-user" }
      },
      compact: async (input: Loose) => {
        compacts.push(input)
        return { id: "inbox-compaction" }
      },
    },
    command: {
      transform: async (callback: (editor: Loose) => void) => {
        callback({
          add: (definition: Loose) => {
            commands.push(definition)
          },
        })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe(options?: { signal?: AbortSignal }) {
        const signal = options?.signal
        signal?.addEventListener("abort", end)
        return (async function* () {
          while (true) {
            if (pending.length > 0) {
              yield pending.shift()!
              continue
            }
            if (ended) return
            const next = await new Promise<Loose | undefined>((resolve) => waiters.push(resolve))
            if (next === undefined) return
            yield next
          }
        })()
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
    mcp: { list: async () => [] },
    generate: {
      // Stand-in for the summarizer LLM: one durable-looking memory per exchange.
      text: async () => ({
        text: JSON.stringify([
          {
            content: "Compaction capture stores durable facts before the context window shrinks.",
            type: "insight",
            importance: 0.7,
            tags: ["smoke"],
          },
        ]),
      }),
    },
  }
  return { context, hooks, storage, commands, prompts, compacts, events: { emit, end } }
}

const MESSAGES: Loose[] = [
  { id: "m1", role: "user", content: [{ type: "text", text: "Where is the upload retry?" }] },
  { id: "m2", role: "assistant", content: [{ type: "text", text: "In src/uploader.ts, retryUpload()." }] },
]

const HANDOFF_MESSAGES: Loose[] = [
  { id: "h1", role: "user", content: [{ type: "text", text: "/handoff" }] },
  {
    id: "h2",
    role: "assistant",
    content: [{ type: "text", text: "Handoff: upload retry is done; next step is B; see src/uploader.ts." }],
  },
]

/** Five exchanges, used to prove the idle first-run window fallback. */
const BIG_MESSAGES: Loose[] = Array.from({ length: 5 }, (_, i) => [
  { id: `u${i + 1}`, role: "user", content: [{ type: "text", text: `question ${i + 1}` }] },
  { id: `a${i + 1}`, role: "assistant", content: [{ type: "text", text: `answer ${i + 1}` }] },
]).flat()

async function main(): Promise<void> {
  const mock = await startMockServer()

  // Hermetic config: a temp HOME/XDG plus an explicit config path, so the real
  // ~/.config/opencode state is never read. These must be set before the
  // dynamic import — the plugin captures HOME/XDG at module load.
  const tmp = mkdtempSync(join(tmpdir(), "mnemosyne-smoke-"))
  const configPath = join(tmp, "mnemosyne.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      url: mock.url,
      token: "smoke-token",
      log: { recall: false, capture: false, sleep: false },
      recall: { enabled: false },
      sleep: { enabled: false },
      capture: { idleMs: 400, idleExchanges: 4 },
      mcpHealth: { enabled: false },
    }),
  )
  process.env.HOME = tmp
  process.env.XDG_CONFIG_HOME = tmp
  process.env.MNEMOSYNE_CONFIG = configPath
  process.env.MNEMOSYNE_URL = mock.url
  process.env.MNEMOSYNE_API_KEY = "smoke-token"

  const plugin = (await import("../index.ts")).default

  /* ---------------- compaction capture ---------------- */

  const app = makeCtx(MESSAGES)
  const cleanup = await plugin.setup(app.context as any)
  const hook = app.hooks.compaction?.[0]
  assert.ok(hook, "compaction hook registered")

  await hook!({ sessionID: "s1", messages: MESSAGES })

  const remembers = mock.calls.filter((call) => call.name === "mnemosyne_remember")
  assert.equal(remembers.length, 1, "compaction distilled the exchange into Mnemosyne")
  assert.match(String(remembers[0].args.content), /durable facts/, "stored the summarizer's memory content")
  assert.ok(
    (remembers[0].args.metadata?.tags ?? []).includes("pre-compaction"),
    "compaction-captured memories are tagged pre-compaction",
  )
  assert.equal(
    app.storage.get("opencode-mnemosyne/cursor/s1"),
    "m2",
    "cursor advanced past the captured exchange",
  )

  // Re-running on the same transcript is a no-op: the cursor dedupes.
  await hook!({ sessionID: "s1", messages: MESSAGES })
  assert.equal(
    mock.calls.filter((call) => call.name === "mnemosyne_remember").length,
    1,
    "the same transcript is not captured twice",
  )

  /* ---------------- /handoff command ---------------- */

  const handoff = app.commands.find((entry) => entry.name === "handoff")
  assert.ok(handoff, "/handoff command is registered")
  await handoff!.execute({ sessionID: "s3", prompt: { text: "focus on the auth change" }, delivery: "steer" })

  assert.equal(app.prompts.length, 1, "/handoff submits one prompt turn")
  assert.equal(app.prompts[0].sessionID, "s3", "the handoff prompt targets the invoking session")
  assert.equal(app.prompts[0].delivery, "steer", "the handoff prompt is steered in")
  assert.match(
    String(app.prompts[0].text),
    /distill your learnings to mnemosyne/i,
    "the prompt carries the handoff instruction",
  )
  assert.match(String(app.prompts[0].text), /focus on the auth change/, "trailing arguments become focus text")

  assert.equal(app.compacts.length, 1, "/handoff requests exactly one compaction")
  assert.equal(app.compacts[0].sessionID, "s3", "the compaction targets the invoking session")
  assert.equal(app.compacts[0].delivery, "queue", "the compaction is queued so it follows the handoff turn")

  /* ---------------- /handoff breadcrumb (recall after compaction) -------- */

  const pending = app.storage.get("opencode-mnemosyne/handoff-pending/s3") as { at?: number } | undefined
  assert.ok(pending?.at, "/handoff marks the session handoff-pending")

  // Compaction runs: the breadcrumb hook lifts the handoff note out of the
  // transcript that is about to be replaced.
  for (const hook of app.hooks.compaction ?? []) {
    await hook({ sessionID: "s3", messages: HANDOFF_MESSAGES })
  }

  const stashed = app.storage.get("opencode-mnemosyne/handoff-note/s3") as { text?: string } | undefined
  assert.ok(stashed?.text, "the handoff note is stashed across the compaction")
  assert.match(String(stashed!.text), /next step is B/, "the stash holds the model's handoff note")
  const clearedPending = app.storage.get("opencode-mnemosyne/handoff-pending/s3") as { at?: number } | undefined
  assert.equal(clearedPending?.at, undefined, "the pending marker is consumed by the compaction")

  const handoffMemory = mock.calls.find((call) =>
    (call.args?.metadata?.tags ?? []).includes("handoff"),
  )
  assert.ok(handoffMemory, "the handoff note is also stored in Mnemosyne")
  assert.match(String(handoffMemory!.args.content), /next step is B/, "the stored memory carries the note")

  // The first model call after compaction gets the breadcrumb.
  const postEvent: Loose = { sessionID: "s3", messages: [{ id: "h3", role: "user", text: "continue" }], system: [] }
  for (const contextHook of app.hooks.context ?? []) await contextHook(postEvent)
  const injected = postEvent.system.map((part: Loose) => String(part.text ?? "")).join("\n")
  assert.match(injected, /Handoff \(recalled after compaction\)/, "the handoff note is recalled after compaction")
  assert.match(injected, /next step is B/, "the recalled breadcrumb carries the note")

  // Injected only once: the note is consumed on injection.
  const second: Loose = { sessionID: "s3", messages: [{ id: "h4", role: "user", text: "again" }], system: [] }
  for (const contextHook of app.hooks.context ?? []) await contextHook(second)
  assert.ok(
    !second.system.map((part: Loose) => String(part.text ?? "")).join("\n").includes("recalled after compaction"),
    "the breadcrumb is injected only once",
  )

  /* ---------------- interrupted turns are captured ---------------- */

  // A user interrupt (escape/stop) ends a turn with no `succeeded` event, so
  // the plugin must treat `session.execution.interrupted` as a capture trigger.
  const remembersBeforeInterrupt = mock.calls.filter((call) => call.name === "mnemosyne_remember").length
  app.events.emit({ type: "session.execution.interrupted", data: { sessionID: "s4", reason: "user" } })
  await waitFor(
    () => app.storage.get("opencode-mnemosyne/cursor/s4") === "m2",
    8_000,
    "a user-interrupted turn is captured",
  )
  assert.ok(
    mock.calls.filter((call) => call.name === "mnemosyne_remember").length > remembersBeforeInterrupt,
    "the interrupted turn is distilled into Mnemosyne",
  )
  assert.equal(
    app.storage.get("opencode-mnemosyne/cursor/s4"),
    "m2",
    "the interrupted capture advances the cursor past the captured exchange",
  )

  // A steer-superseded turn ends the same way and must be captured too.
  app.events.emit({ type: "session.execution.interrupted", data: { sessionID: "s6", reason: "superseded" } })
  await waitFor(
    () => app.storage.get("opencode-mnemosyne/cursor/s6") === "m2",
    8_000,
    "a superseded turn is captured",
  )

  // A shutdown interruption must never trigger a capture: the server (or this
  // location) is going away, so the summarizer + store round trip cannot finish.
  app.events.emit({ type: "session.execution.interrupted", data: { sessionID: "s5", reason: "shutdown" } })
  await sleep(2_800) // longer than the maximum settle delay (2500 ms)
  assert.equal(
    app.storage.get("opencode-mnemosyne/cursor/s5"),
    undefined,
    "a shutdown interruption does not trigger a capture",
  )

  /* ---------------- idle safety net ---------------- */

  // A session can stop producing usable turn events (a missed event, a failed
  // turn). Once it has been quiet for `capture.idleMs` the safety-net pass must
  // capture the uncaptured tail without another turn.
  const beforeIdle = mock.calls.filter((call) => call.name === "mnemosyne_remember").length
  app.events.emit({ type: "session.step.ended", data: { sessionID: "s7" } })
  await waitFor(
    () => app.storage.get("opencode-mnemosyne/cursor/s7") === "m2",
    10_000,
    "an idle session is captured by the safety net",
  )
  assert.ok(
    mock.calls.filter((call) => call.name === "mnemosyne_remember").length > beforeIdle,
    "the idle safety net distils the stranded exchange into Mnemosyne",
  )

  // A turn that is still running is not flushed mid-stream.
  app.events.emit({ type: "session.execution.started", data: { sessionID: "s8" } })
  await sleep(2_500) // longer than idleMs plus the capture settle delay
  assert.equal(
    app.storage.get("opencode-mnemosyne/cursor/s8"),
    undefined,
    "the idle safety net skips a session with a running turn",
  )
  app.events.emit({ type: "session.execution.succeeded", data: { sessionID: "s8" } })
  await waitFor(
    () => app.storage.get("opencode-mnemosyne/cursor/s8") === "m2",
    8_000,
    "a completed turn is still captured normally",
  )

  // An idle pass over an already-captured session must not call the summarizer
  // or store a duplicate: the cursor check returns first.
  app.storage.set("opencode-mnemosyne/cursor/s9", "m2")
  const beforeNoop = mock.calls.filter((call) => call.name === "mnemosyne_remember").length
  app.events.emit({ type: "session.step.ended", data: { sessionID: "s9" } })
  await sleep(3_500) // idleMs + maximum settle delay + slack
  assert.equal(
    mock.calls.filter((call) => call.name === "mnemosyne_remember").length,
    beforeNoop,
    "the idle safety net does not re-capture an already-captured session",
  )

  if (!cleanup) throw new Error("plugin setup did not activate (missing URL/token?)")
  await cleanup()

  /* ---------------- idle first-run window is bounded ---------------- */

  // When the cursor message is gone (as after a compaction), the idle pass must
  // fall back to the normal `capture.exchanges` window rather than look back
  // `idleExchanges`, so it does not re-capture the tail compaction just stored.
  process.env.MNEMOSYNE_CAPTURE_IDLE_MS = "300"
  const big = makeCtx(BIG_MESSAGES)
  const bigCleanup = await plugin.setup(big.context as any)
  if (!bigCleanup) throw new Error("plugin setup did not activate for the bounded-window instance")
  big.storage.set("opencode-mnemosyne/cursor/s10", "a-message-that-is-no-longer-in-context")
  const beforeBounded = mock.calls.filter((call) => call.name === "mnemosyne_remember").length
  big.events.emit({ type: "session.step.ended", data: { sessionID: "s10" } })
  await waitFor(
    () => big.storage.get("opencode-mnemosyne/cursor/s10") === "a5",
    10_000,
    "the idle pass captures from a stale cursor",
  )
  assert.equal(
    mock.calls.filter((call) => call.name === "mnemosyne_remember").length - beforeBounded,
    2,
    "a stale cursor limits the idle pass to the normal capture.exchanges window",
  )
  await bigCleanup()
  delete process.env.MNEMOSYNE_CAPTURE_IDLE_MS

  /* ---------------- fail-open when the server is unreachable ---------------- */

  process.env.MNEMOSYNE_URL = "http://127.0.0.1:1/mcp"
  const dead = makeCtx(MESSAGES)
  const deadCleanup = await plugin.setup(dead.context as any)
  if (!deadCleanup) throw new Error("plugin setup did not activate for the dead-endpoint instance")
  const deadHook = dead.hooks.compaction?.[0]
  assert.ok(deadHook, "compaction hook registered for the unreachable-endpoint instance")
  // Must resolve (never throw): a memory failure cannot block compaction.
  await deadHook!({ sessionID: "s2", messages: MESSAGES })
  await deadCleanup()

  /* ---------------- /handoff disabled by config ---------------- */

  process.env.MNEMOSYNE_HANDOFF = "0"
  const off = makeCtx(MESSAGES)
  const offCleanup = await plugin.setup(off.context as any)
  assert.equal(
    off.commands.find((entry) => entry.name === "handoff"),
    undefined,
    "MNEMOSYNE_HANDOFF=0 leaves the command unregistered",
  )
  if (offCleanup) await offCleanup()
  delete process.env.MNEMOSYNE_HANDOFF

  await mock.close()
  console.log("smoke: OK")
}

await main()
