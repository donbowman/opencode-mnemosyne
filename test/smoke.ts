/**
 * Smoke test for opencode-mnemosyne.
 *
 * Runs the plugin against a mock OpenCode setup context and a mock Mnemosyne
 * MCP server (streamable HTTP), asserting the compaction hook distills the
 * transcript about to be summarized into Mnemosyne before compaction proceeds,
 * and that the hook stays fail-open when the server is unreachable.
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
    },
    event: {
      subscribe: async function* (options?: { signal?: AbortSignal }) {
        const signal = options?.signal
        if (signal?.aborted) return
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()))
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
  return { context, hooks, storage }
}

const MESSAGES: Loose[] = [
  { id: "m1", role: "user", content: [{ type: "text", text: "Where is the upload retry?" }] },
  { id: "m2", role: "assistant", content: [{ type: "text", text: "In src/uploader.ts, retryUpload()." }] },
]

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

  if (!cleanup) throw new Error("plugin setup did not activate (missing URL/token?)")
  await cleanup()

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

  await mock.close()
  console.log("smoke: OK")
}

await main()
