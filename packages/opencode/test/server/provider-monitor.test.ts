import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { Database } from "../../src/storage/db"
import { Project } from "../../src/project/project"
import { MessageTable, SessionTable } from "../../src/session/session.sql"
import { MessageID, SessionID } from "../../src/session/schema"

Log.init({ print: false })

beforeEach(async () => {
  await Auth.remove("openrouter")
})

afterEach(async () => {
  await Auth.remove("openrouter")
})

function query(input: Record<string, string | boolean | undefined>) {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    out.set(key, String(value))
  }
  return out.toString()
}

async function seed(dir: string, model = "openai/gpt-4o") {
  const now = Date.now()
  const sessionID = SessionID.make(`session-${crypto.randomUUID()}`)
  const messageID = MessageID.make(`message-${crypto.randomUUID()}`)
  const { project } = await Project.fromDirectory(dir)

  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: project.id,
        slug: sessionID,
        directory: dir,
        title: "test",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )

  Database.use((db) =>
    db
      .insert(MessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        data: {
          role: "assistant",
          providerID: "openrouter",
          modelID: model,
          cost: 1.25,
          tokens: {
            total: 42,
            input: 20,
            output: 22,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
        } as unknown as typeof MessageTable.$inferInsert.data,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
}

describe("provider monitor endpoint", () => {
  test.serial("caches live OpenRouter snapshots and refresh bypasses cache", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openrouter", "work", { type: "api", key: "work-key" })
        await Auth.activate("openrouter", "work")

        const originalFetch = globalThis.fetch
        let calls = 0
        globalThis.fetch = mock(async (input: string | URL | Request) => {
          expect(String(input)).toBe("https://openrouter.ai/api/v1/key")
          calls += 1
          return new Response(
            JSON.stringify(
              calls === 1
                ? {
                    data: {
                      limit: 10,
                      limit_remaining: 8,
                      limit_reset: "monthly",
                      usage: 999,
                      usage_daily: 1,
                      usage_monthly: 2,
                    },
                  }
                : {
                    data: {
                      limit: 10,
                      limit_remaining: 7,
                      limit_reset: "monthly",
                      usage: 998,
                      usage_monthly: 3,
                    },
                  },
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const base = query({ provider: "openrouter", profile: "work", model: "openai/gpt-4o" })

          const first = (await (await app.request(`/provider/monitor?${base}`)).json()) as {
            state: string
            source: string
            window?: { label?: string }
            usage?: { cost?: { used?: number } }
            notes?: string[]
          }
          const second = (await (await app.request(`/provider/monitor?${base}`)).json()) as {
            usage?: { cost?: { used?: number } }
          }

          expect(first.state).toBe("live")
          expect(first.source).toBe("provider")
          expect(first.usage?.cost?.used).toBe(2)
          expect(first.window?.label).toBe("Monthly key limit")
          expect(first.notes).toContain(
            "OpenRouter live data is key-wide and may include other models or variants on this profile.",
          )
          expect(first.notes).toContain("Limit resets: monthly.")
          expect(second.usage?.cost?.used).toBe(2)
          expect(calls).toBe(1)

          const third = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", profile: "work", model: "openai/gpt-4o", refresh: true })}`,
            )
          ).json()) as {
            usage?: { cost?: { used?: number } }
          }

          expect(third.usage?.cost?.used).toBe(3)
          expect(calls).toBe(2)
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("falls back to local history when OpenRouter live data is unavailable", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openrouter", "work", { type: "api", key: "work-key" })
        await Auth.activate("openrouter", "work")
        await seed(tmp.path, "openai/gpt-4.1")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async () => new Response("busy", { status: 503 })) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", profile: "work", model: "openai/gpt-4.1", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            usage?: { requests?: { used?: number }; tokens?: { used?: number }; cost?: { used?: number } }
            notes?: string[]
          }

          expect(body.state).toBe("estimated")
          expect(body.source).toBe("history")
          expect(body.usage?.requests?.used).toBe(1)
          expect(body.usage?.tokens?.used).toBe(42)
          expect(body.usage?.cost?.used).toBe(1.25)
          expect(body.notes).toContain("Live OpenRouter monitor was unavailable (503), showing a local fallback.")
          expect(body.notes).toContain(
            "History is not persisted by profile, so this estimate may include other openrouter profiles.",
          )
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("falls back when OpenRouter returns an unexpected wrapped shape", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openrouter", "work", { type: "api", key: "work-key" })
        await Auth.activate("openrouter", "work")
        await seed(tmp.path, "openai/gpt-4.2")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(
          async () => new Response(JSON.stringify({ nope: {} }), { status: 200 }),
        ) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", profile: "work", model: "openai/gpt-4.2", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            usage?: { cost?: { used?: number } }
            notes?: string[]
          }

          expect(body.state).toBe("estimated")
          expect(body.source).toBe("history")
          expect(body.usage?.cost?.used).toBe(1.25)
          expect(body.notes).toContain(
            "Live OpenRouter monitor returned an unexpected response, showing a local fallback.",
          )
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("falls back when OpenRouter returns empty wrapped data", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openrouter", "work", { type: "api", key: "work-key" })
        await Auth.activate("openrouter", "work")
        await seed(tmp.path, "openai/gpt-4.3")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(
          async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
        ) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", profile: "work", model: "openai/gpt-4.3", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            usage?: { cost?: { used?: number } }
            notes?: string[]
          }

          expect(body.state).toBe("estimated")
          expect(body.source).toBe("history")
          expect(body.usage?.cost?.used).toBe(1.25)
          expect(body.notes).toContain(
            "Live OpenRouter monitor returned an unexpected response, showing a local fallback.",
          )
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })
})
