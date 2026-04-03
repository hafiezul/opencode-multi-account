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
  await Auth.remove("openai")
  await Auth.remove("anthropic")
  await Auth.remove("google")
  await Auth.remove("github-copilot")
})

afterEach(async () => {
  await Auth.remove("openrouter")
  await Auth.remove("openai")
  await Auth.remove("anthropic")
  await Auth.remove("google")
  await Auth.remove("github-copilot")
})

function query(input: Record<string, string | boolean | undefined>) {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    out.set(key, String(value))
  }
  return out.toString()
}

function jwt(payload: Record<string, unknown>) {
  const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${head}.${body}.sig`
}

async function seed(
  dir: string,
  input: {
    model?: string
    profile?: string
    accountID?: string
    cost?: number
    tokens?: number
  } = {},
) {
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
          modelID: input.model ?? "openai/gpt-4o",
          ...(input.profile
            ? {
                auth: {
                  profile: input.profile,
                  accountID: input.accountID,
                },
              }
            : {}),
          cost: input.cost ?? 1.25,
          tokens: {
            total: input.tokens ?? 42,
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
        await seed(tmp.path, { model: "openai/gpt-4.1", profile: "work" })

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
            message?: string
            usage?: { requests?: { used?: number }; tokens?: { used?: number }; cost?: { used?: number } }
            notes?: string[]
          }

          expect(body.state).toBe("estimated")
          expect(body.source).toBe("history")
          expect(body.usage?.requests?.used).toBe(1)
          expect(body.usage?.tokens?.used).toBe(42)
          expect(body.usage?.cost?.used).toBe(1.25)
          expect(body.message).toBe("Estimated from local assistant history for this profile.")
          expect(body.notes).toContain("Live OpenRouter monitor was unavailable (503), showing a local fallback.")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("returns live OpenAI quota data from OAuth auth", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openai", "chatgpt", {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct_1",
        })
        await Auth.activate("openai", "chatgpt")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request) => {
          expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage")
          return new Response(
            JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 37,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3_600,
                },
                secondary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 86_400,
                },
              },
              credits: {
                balance: "12.34",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openai", profile: "chatgpt", model: "gpt-5.3-codex", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            window?: { label?: string }
            reset_at?: number
            usage?: { requests?: { used?: number; limit?: number } }
            message?: string
            notes?: string[]
          }

          expect(body.state).toBe("live")
          expect(body.source).toBe("provider")
          expect(body.window?.label).toBe("5h quota")
          expect(body.usage?.requests?.used).toBe(37)
          expect(body.usage?.requests?.limit).toBe(100)
          expect(body.reset_at).toBeDefined()
          expect(body.message).toBe("Live OpenAI quota data.")
          expect(body.notes).toContain(
            "OpenAI live quota data is account-wide and may include other models or variants on this profile.",
          )
          expect(body.notes).toContain("Plan: plus.")
          expect(body.notes).toContain("7d quota: 10% used.")
          expect(body.notes).toContain("Credits balance: 12.34.")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("refreshes OpenAI OAuth tokens and uses the refreshed account header", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openai", "chatgpt", {
          type: "oauth",
          access: "stale-access",
          refresh: "refresh-token",
          expires: Date.now() - 1,
          accountId: "acct_old",
        })
        await Auth.activate("openai", "chatgpt")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url === "https://auth.openai.com/oauth/token") {
            return new Response(
              JSON.stringify({
                access_token: jwt({ chatgpt_account_id: "acct_new" }),
                refresh_token: "refresh-next",
                expires_in: 3600,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }

          expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
          expect((init?.headers as Record<string, string>)["ChatGPT-Account-Id"]).toBe("acct_new")
          return new Response(
            JSON.stringify({
              rate_limit: {
                primary_window: {
                  used_percent: 22,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 600,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openai", profile: "chatgpt", model: "gpt-5.3-codex", refresh: true })}`,
            )
          ).json()) as {
            state: string
            usage?: { requests?: { used?: number } }
          }

          expect(body.state).toBe("live")
          expect(body.usage?.requests?.used).toBe(22)

          const auth = await Auth.resolve("openai", "chatgpt")
          expect(auth.accountID).toBe("acct_new")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("returns live OpenAI organization costs from admin api auth", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openai", "admin", { type: "api", key: "sk-admin" })
        await Auth.activate("openai", "admin")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request) => {
          expect(String(input)).toContain("https://api.openai.com/v1/organization/costs?")
          return new Response(
            JSON.stringify({
              data: [
                {
                  start_time: 1,
                  end_time: 2,
                  results: [{ amount: { value: 1.5, currency: "usd" } }, { amount: { value: 0.25, currency: "usd" } }],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openai", profile: "admin", model: "gpt-4.1", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            window?: { label?: string; start?: number; end?: number }
            usage?: { cost?: { used?: number; currency?: string } }
            message?: string
            notes?: string[]
          }

          expect(body.state).toBe("live")
          expect(body.source).toBe("provider")
          expect(body.window?.label).toBe("Today org cost")
          expect(body.window?.start).toBe(1000)
          expect(body.window?.end).toBe(2000)
          expect(body.usage?.cost?.used).toBe(1.75)
          expect(body.usage?.cost?.currency).toBe("USD")
          expect(body.message).toBe("Live OpenAI organization cost data. No budget limit was returned.")
          expect(body.notes).toContain(
            "OpenAI organization cost data is org-wide and may include other models, projects, or API keys on this profile.",
          )
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("returns live Anthropic quota data from OAuth auth", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("anthropic", "claude", {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        })
        await Auth.activate("anthropic", "claude")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request) => {
          expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage")
          return new Response(
            JSON.stringify({
              five_hour: {
                utilization: 15,
                resets_at: "2026-04-02T05:00:00Z",
              },
              seven_day: {
                utilization: 35,
                resets_at: "2026-04-07T00:00:00Z",
              },
              seven_day_sonnet: {
                utilization: 40,
                resets_at: "2026-04-07T00:00:00Z",
              },
              extra_usage: {
                is_enabled: true,
                monthly_limit: 5000,
                used_credits: 1250,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "anthropic", profile: "claude", model: "claude-sonnet-4-5", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            window?: { label?: string }
            usage?: { requests?: { used?: number; limit?: number } }
            reset_at?: number
            message?: string
            notes?: string[]
          }

          expect(body.state).toBe("live")
          expect(body.source).toBe("provider")
          expect(body.window?.label).toBe("7d quota")
          expect(body.usage?.requests?.used).toBe(35)
          expect(body.usage?.requests?.limit).toBe(100)
          expect(body.reset_at).toBe(Date.parse("2026-04-07T00:00:00Z"))
          expect(body.message).toBe("Live Anthropic quota data.")
          expect(body.notes).toContain(
            "Anthropic live quota data is account-wide and may include other models or variants on this profile.",
          )
          expect(body.notes).toContain("5h quota: 15% used.")
          expect(body.notes).toContain("7d quota: 35% used.")
          expect(body.notes).toContain("7d Sonnet quota: 40% used.")
          expect(body.notes).toContain("Extra usage: $12.5000 of $50.0000.")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("refreshes Anthropic OAuth tokens before fetching usage", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("anthropic", "claude", {
          type: "oauth",
          access: "stale-access",
          refresh: "refresh-token",
          expires: Date.now() - 1,
        })
        await Auth.activate("anthropic", "claude")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url === "https://platform.claude.com/v1/oauth/token") {
            expect(init?.method).toBe("POST")
            expect(init?.body).toBe(
              JSON.stringify({
                grant_type: "refresh_token",
                client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
                refresh_token: "refresh-token",
              }),
            )
            return new Response(
              JSON.stringify({
                access_token: "fresh-access",
                refresh_token: "refresh-next",
                expires_in: 3600,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }

          expect(url).toBe("https://api.anthropic.com/api/oauth/usage")
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fresh-access")
          return new Response(
            JSON.stringify({
              seven_day: {
                utilization: 28,
                resets_at: "2026-04-07T00:00:00Z",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "anthropic", profile: "claude", model: "claude-sonnet-4-5", refresh: true })}`,
            )
          ).json()) as {
            state: string
            usage?: { requests?: { used?: number } }
          }

          expect(body.state).toBe("live")
          expect(body.usage?.requests?.used).toBe(28)

          const auth = await Auth.resolve("anthropic", "claude")
          expect(auth.auth?.type).toBe("oauth")
          if (auth.auth?.type === "oauth") {
            expect(auth.auth.access).toBe("fresh-access")
            expect(auth.auth.refresh).toBe("refresh-next")
          }
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("returns live Anthropic organization costs from api auth", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("anthropic", "org", { type: "api", key: "sk-ant" })
        await Auth.activate("anthropic", "org")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request) => {
          expect(String(input)).toContain("https://api.anthropic.com/v1/organizations/cost_report?")
          return new Response(
            JSON.stringify({
              data: [
                {
                  starting_at: "2026-04-02T00:00:00Z",
                  ending_at: "2026-04-03T00:00:00Z",
                  results: [
                    { amount: "1.25", currency: "usd" },
                    { amount: "0.75", currency: "usd" },
                  ],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "anthropic", profile: "org", model: "claude-sonnet-4-5", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            window?: { label?: string; start?: number; end?: number }
            usage?: { cost?: { used?: number; currency?: string } }
            message?: string
            notes?: string[]
          }

          expect(body.state).toBe("live")
          expect(body.source).toBe("provider")
          expect(body.window?.label).toBe("Today org cost")
          expect(body.window?.start).toBe(Date.parse("2026-04-02T00:00:00Z"))
          expect(body.window?.end).toBe(Date.parse("2026-04-03T00:00:00Z"))
          expect(body.usage?.cost?.used).toBe(2)
          expect(body.usage?.cost?.currency).toBe("USD")
          expect(body.message).toBe("Live Anthropic organization cost data. No budget limit was returned.")
          expect(body.notes).toContain(
            "Anthropic organization cost data is org-wide and may include other models, workspaces, or API keys on this profile.",
          )
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("returns live Gemini quota data from OAuth auth", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("google", "work", {
          type: "oauth",
          access: "google-access",
          refresh: "google-refresh|proj-123",
          expires: Date.now() + 120_000,
        })
        await Auth.activate("google", "work")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
          expect(String(input)).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer google-access")
          expect(init?.body).toBe(JSON.stringify({ project: "proj-123" }))
          return new Response(
            JSON.stringify({
              buckets: [
                {
                  modelId: "gemini-2.5-pro",
                  remainingFraction: 0.75,
                  resetTime: "2026-04-03T00:00:00Z",
                  tokenType: "REQUESTS",
                },
                {
                  modelId: "gemini-3-pro-preview",
                  remainingFraction: 0.4,
                  resetTime: "2026-04-02T12:00:00Z",
                  tokenType: "REQUESTS",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "google", profile: "work", model: "gemini-3-pro-preview", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            window?: { label?: string }
            reset_at?: number
            usage?: { requests?: { used?: number; limit?: number } }
            message?: string
            notes?: string[]
          }

          expect(body.state).toBe("live")
          expect(body.source).toBe("provider")
          expect(body.window?.label).toBe("Gemini requests quota")
          expect(body.usage?.requests?.used).toBe(60)
          expect(body.usage?.requests?.limit).toBe(100)
          expect(body.reset_at).toBe(Date.parse("2026-04-02T12:00:00Z"))
          expect(body.message).toBe("Live Gemini quota data.")
          expect(body.notes).toContain(
            "Gemini live quota data is account-wide for the resolved Google Cloud project and may include other models or variants.",
          )
          expect(body.notes).toContain("Project: proj-123.")
          expect(body.notes).toContain("gemini-2.5-pro: 25% used.")
          expect(body.notes).toContain("gemini-3-pro-preview: 60% used.")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("prefers the active Gemini model bucket when multiple buckets exist", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("google", "work", {
          type: "oauth",
          access: "google-access",
          refresh: "google-refresh|proj-123",
          expires: Date.now() + 120_000,
        })
        await Auth.activate("google", "work")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(
          async () =>
            new Response(
              JSON.stringify({
                buckets: [
                  {
                    modelId: "gemini-2.5-pro",
                    remainingFraction: 0.1,
                    resetTime: "2026-04-02T08:00:00Z",
                    tokenType: "REQUESTS",
                  },
                  {
                    modelId: "gemini-3-pro-preview",
                    remainingFraction: 0.6,
                    resetTime: "2026-04-02T12:00:00Z",
                    tokenType: "REQUESTS",
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        ) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "google", profile: "work", model: "gemini-3-pro-preview", refresh: true })}`,
            )
          ).json()) as {
            state: string
            reset_at?: number
            usage?: { requests?: { used?: number } }
          }

          expect(body.state).toBe("live")
          expect(body.usage?.requests?.used).toBe(40)
          expect(body.reset_at).toBe(Date.parse("2026-04-02T12:00:00Z"))
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("returns live Gemini quota data from local oauth creds fallback", async () => {
    await using tmp = await tmpdir()

    const prevHome = process.env.HOME
    const gemini = `${tmp.path}/.gemini`
    await Bun.$`mkdir -p ${gemini}`
    await Bun.write(
      `${gemini}/oauth_creds.json`,
      JSON.stringify({
        access_token: "stale-google-access",
        refresh_token: "google-refresh",
        expiry_date: Date.now() - 1,
        id_token: jwt({ aud: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com" }),
        project_id: "proj-local",
      }),
    )
    process.env.HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const originalFetch = globalThis.fetch
          globalThis.fetch = mock(async (input: string | URL | Request) => {
            const url = String(input)
            if (url === "https://oauth2.googleapis.com/token") {
              return new Response(
                JSON.stringify({
                  access_token: "fresh-google-access",
                  expires_in: 3600,
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              )
            }
            expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
            return new Response(
              JSON.stringify({
                buckets: [
                  {
                    modelId: "gemini-2.5-flash",
                    remainingFraction: 0.5,
                    resetTime: "2026-04-03T00:00:00Z",
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }) as unknown as typeof fetch

          try {
            const app = Server.Default()
            const body = (await (
              await app.request(
                `/provider/monitor?${query({ provider: "google", model: "gemini-2.5-flash", refresh: true })}`,
              )
            ).json()) as {
              state: string
              usage?: { requests?: { used?: number } }
            }

            expect(body.state).toBe("live")
            expect(body.usage?.requests?.used).toBe(50)
          } finally {
            globalThis.fetch = originalFetch
          }
        },
      })
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    }
  })

  test.serial("returns live GitHub Copilot quota data from OAuth auth", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("github-copilot", "work", {
          type: "oauth",
          access: "copilot-token",
          refresh: "copilot-token",
          expires: 0,
        })
        await Auth.activate("github-copilot", "work")

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
          expect(String(input)).toBe("https://api.github.com/copilot_internal/user")
          expect((init?.headers as Record<string, string>).Authorization).toBe("token copilot-token")
          return new Response(
            JSON.stringify({
              copilot_plan: "individual",
              quota_reset_date_utc: "2026-05-01T00:00:00.000Z",
              quota_snapshots: {
                chat: {
                  entitlement: 300,
                  remaining: 225,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "github-copilot", profile: "work", model: "gpt-4.1", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            window?: { label?: string }
            reset_at?: number
            usage?: { requests?: { used?: number; limit?: number } }
            message?: string
            notes?: string[]
          }

          expect(body.state).toBe("live")
          expect(body.source).toBe("provider")
          expect(body.window?.label).toBe("Monthly premium requests")
          expect(body.usage?.requests?.used).toBe(75)
          expect(body.usage?.requests?.limit).toBe(300)
          expect(body.reset_at).toBe(Date.parse("2026-05-01T00:00:00.000Z"))
          expect(body.message).toBe("Live GitHub Copilot quota data.")
          expect(body.notes).toContain("Plan: individual.")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("returns live GitHub Copilot quota data from local token files", async () => {
    await using tmp = await tmpdir()

    const prevXdg = process.env.XDG_CONFIG_HOME
    await Bun.$`mkdir -p ${tmp.path}/github-copilot`
    await Bun.write(
      `${tmp.path}/github-copilot/hosts.json`,
      JSON.stringify({
        github: {
          oauthToken: "copilot-file-token",
          user: "octocat",
        },
      }),
    )
    process.env.XDG_CONFIG_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const originalFetch = globalThis.fetch
          globalThis.fetch = mock(
            async () =>
              new Response(
                JSON.stringify({
                  plan: "team",
                  quota_reset_date: "2026-05-01",
                  monthly_quotas: { completions: 100 },
                  limited_user_quotas: { completions: 40 },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              ),
          ) as unknown as typeof fetch

          try {
            const app = Server.Default()
            const body = (await (
              await app.request(
                `/provider/monitor?${query({ provider: "github-copilot", model: "gpt-4.1", refresh: true })}`,
              )
            ).json()) as {
              state: string
              usage?: { requests?: { used?: number; limit?: number } }
              notes?: string[]
            }

            expect(body.state).toBe("live")
            expect(body.usage?.requests?.used).toBe(40)
            expect(body.usage?.requests?.limit).toBe(100)
            expect(body.notes).toContain(`Using local Copilot token data from ${tmp.path}/github-copilot/hosts.json.`)
          } finally {
            globalThis.fetch = originalFetch
          }
        },
      })
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prevXdg
    }
  })

  test.serial("fallback estimated history is separated by profile", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openrouter", "work", { type: "api", key: "work-key" })
        await Auth.put("openrouter", "personal", { type: "api", key: "personal-key" })
        await Auth.activate("openrouter", "work")
        await seed(tmp.path, { model: "openai/gpt-4.1-profile-split", profile: "work", cost: 1.25, tokens: 42 })
        await seed(tmp.path, { model: "openai/gpt-4.1-profile-split", profile: "personal", cost: 2.5, tokens: 84 })

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async () => new Response("busy", { status: 503 })) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const scoped = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", profile: "work", model: "openai/gpt-4.1-profile-split", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            message?: string
            usage?: { requests?: { used?: number }; tokens?: { used?: number }; cost?: { used?: number } }
          }
          const unscoped = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", model: "openai/gpt-4.1-profile-split", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            message?: string
            usage?: { requests?: { used?: number } }
          }

          expect(scoped.state).toBe("estimated")
          expect(scoped.source).toBe("history")
          expect(scoped.message).toBe("Estimated from local assistant history for this profile.")
          expect(scoped.usage?.requests?.used).toBe(1)
          expect(scoped.usage?.tokens?.used).toBe(42)
          expect(scoped.usage?.cost?.used).toBe(1.25)

          expect(unscoped.state).toBe("unknown")
          expect(unscoped.source).toBe("none")
          expect(unscoped.message).toBe("No local history estimate yet.")
          expect(unscoped.usage?.requests?.used).toBeUndefined()
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("unscoped fallback still uses legacy unattributed history", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openrouter", "work", { type: "api", key: "work-key" })
        await Auth.activate("openrouter", "work")
        await seed(tmp.path, { model: "openai/gpt-4.1-legacy" })

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async () => new Response("busy", { status: 503 })) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", model: "openai/gpt-4.1-legacy", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            message?: string
            usage?: { requests?: { used?: number }; tokens?: { used?: number }; cost?: { used?: number } }
            notes?: string[]
          }

          expect(body.state).toBe("estimated")
          expect(body.source).toBe("history")
          expect(body.message).toBe("Estimated from local assistant history without profile attribution.")
          expect(body.usage?.requests?.used).toBe(1)
          expect(body.usage?.tokens?.used).toBe(42)
          expect(body.usage?.cost?.used).toBe(1.25)
          expect(body.notes).toContain(
            "Live OpenRouter monitor requires an explicit profile, showing a local fallback.",
          )
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test.serial("fallback estimated history is separated by account id", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Auth.put("openrouter", "work", {
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
          accountId: "acct-2",
        })
        await Auth.activate("openrouter", "work")
        await seed(tmp.path, {
          model: "openai/gpt-4.1-account-split",
          profile: "work",
          accountID: "acct-1",
          cost: 1.25,
          tokens: 42,
        })
        await seed(tmp.path, {
          model: "openai/gpt-4.1-account-split",
          profile: "work",
          accountID: "acct-2",
          cost: 2.5,
          tokens: 84,
        })

        const originalFetch = globalThis.fetch
        globalThis.fetch = mock(async () => new Response("busy", { status: 503 })) as unknown as typeof fetch

        try {
          const app = Server.Default()
          const body = (await (
            await app.request(
              `/provider/monitor?${query({ provider: "openrouter", profile: "work", model: "openai/gpt-4.1-account-split", refresh: true })}`,
            )
          ).json()) as {
            state: string
            source: string
            message?: string
            usage?: { requests?: { used?: number }; tokens?: { used?: number }; cost?: { used?: number } }
          }

          expect(body.state).toBe("estimated")
          expect(body.source).toBe("history")
          expect(body.message).toBe("Estimated from local assistant history for this profile and account.")
          expect(body.usage?.requests?.used).toBe(1)
          expect(body.usage?.tokens?.used).toBe(84)
          expect(body.usage?.cost?.used).toBe(2.5)
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
        await seed(tmp.path, { model: "openai/gpt-4.2", profile: "work" })

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
        await seed(tmp.path, { model: "openai/gpt-4.3", profile: "work" })

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
