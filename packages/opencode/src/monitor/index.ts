import { MessageTable } from "@/session/session.sql"
import { Database, and, desc, gte, sql } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import { Auth } from "@/auth"
import z from "zod"

export namespace Monitor {
  export const TTL = 5 * 60 * 1000
  const DAY = 24 * 60 * 60 * 1000
  const cache = new Map<string, Snapshot>()
  const pending = new Map<string, Promise<Snapshot>>()

  export const Scope = z
    .object({
      provider: ProviderID.zod,
      profile: z.string().optional(),
      model: ModelID.zod,
      variant: z.string().optional(),
    })
    .meta({ ref: "MonitorScope" })
  export type Scope = z.infer<typeof Scope>

  const Count = z
    .object({
      used: z.number().optional(),
      limit: z.number().optional(),
    })
    .meta({ ref: "MonitorUsageCount" })

  const Cost = Count.extend({
    currency: z.string().optional(),
  }).meta({ ref: "MonitorUsageCost" })

  const Usage = z
    .object({
      requests: Count.optional(),
      tokens: Count.optional(),
      cost: Cost.optional(),
    })
    .meta({ ref: "MonitorUsage" })

  const Window = z
    .object({
      label: z.string(),
      start: z.number().optional(),
      end: z.number().optional(),
    })
    .meta({ ref: "MonitorWindow" })

  export const Snapshot = z
    .object({
      scope: Scope,
      state: z.enum(["live", "estimated", "unknown"]),
      fetched_at: z.number(),
      expires_at: z.number(),
      source: z.enum(["provider", "history", "none"]),
      window: Window.optional(),
      usage: Usage.optional(),
      reset_at: z.number().optional(),
      message: z.string().optional(),
      notes: z.array(z.string()).optional(),
    })
    .meta({ ref: "MonitorSnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>

  const History = z.object({
    role: z.literal("assistant"),
    providerID: ProviderID.zod,
    modelID: ModelID.zod,
    variant: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  })

  const OpenRouter = z.object({
    data: z.object({
      limit: z.number().nullable().optional(),
      limit_reset: z.string().nullable().optional(),
      limit_remaining: z.number().nullable().optional(),
      usage_daily: z.number().nullable().optional(),
      usage_weekly: z.number().nullable().optional(),
      usage_monthly: z.number().nullable().optional(),
      usage: z.number().nullable().optional(),
      include_byok_in_limit: z.boolean().optional(),
      is_free_tier: z.boolean().optional(),
    }),
  })

  function key(scope: Scope) {
    return [Auth.revision(), scope.provider, scope.profile ?? "", scope.model, scope.variant ?? ""].join("\x1f")
  }

  function historyNotes(scope: Scope) {
    if (!scope.profile) return
    return [`History is not persisted by profile, so this estimate may include other ${scope.provider} profiles.`]
  }

  function usd(value: number) {
    return `$${value.toFixed(4)}`
  }

  function merge(...list: Array<string[] | undefined>) {
    const next = list.flatMap((item) => item ?? [])
    if (next.length === 0) return
    return next
  }

  function total(tokens: z.infer<typeof History>["tokens"]) {
    return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  }

  function current(data: z.infer<typeof OpenRouter>["data"]) {
    if (
      data.limit !== null &&
      data.limit !== undefined &&
      data.limit_remaining !== null &&
      data.limit_remaining !== undefined
    ) {
      return Math.max(0, data.limit - data.limit_remaining)
    }
    if (data.limit_reset === "daily") return data.usage_daily ?? undefined
    if (data.limit_reset === "weekly") return data.usage_weekly ?? undefined
    if (data.limit_reset === "monthly") return data.usage_monthly ?? undefined
    return undefined
  }

  function usable(data: z.infer<typeof OpenRouter>["data"]) {
    return [data.limit, data.limit_remaining, data.usage_daily, data.usage_weekly, data.usage_monthly].some(
      (item) => item !== null && item !== undefined,
    )
  }

  async function fallback(scope: Scope, now: number, note?: string): Promise<Snapshot> {
    const start = now - DAY
    const variant = scope.variant
      ? sql`json_extract(${MessageTable.data}, '$.variant') = ${scope.variant}`
      : sql`json_extract(${MessageTable.data}, '$.variant') is null`
    const rows = Database.use((db) =>
      db
        .select({ data: MessageTable.data })
        .from(MessageTable)
        .where(
          and(
            gte(MessageTable.time_created, start),
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            sql`json_extract(${MessageTable.data}, '$.providerID') = ${scope.provider}`,
            sql`json_extract(${MessageTable.data}, '$.modelID') = ${scope.model}`,
            variant,
          ),
        )
        .orderBy(desc(MessageTable.time_created))
        .all(),
    )

    const list = rows.flatMap((row) => {
      const parsed = History.safeParse(row.data)
      if (!parsed.success) return []
      return [parsed.data]
    })

    if (list.length === 0) {
      return {
        scope,
        state: "unknown",
        fetched_at: now,
        expires_at: now + TTL,
        source: "none",
        window: {
          label: "Last 24h",
          start,
          end: now,
        },
        message: "No local history estimate yet.",
        notes: merge(note ? [note] : undefined, historyNotes(scope)),
      }
    }

    const usage = list.reduce(
      (acc, item) => {
        acc.requests += 1
        acc.tokens += total(item.tokens)
        acc.cost += item.cost
        return acc
      },
      { requests: 0, tokens: 0, cost: 0 },
    )

    return {
      scope,
      state: "estimated",
      fetched_at: now,
      expires_at: now + TTL,
      source: "history",
      window: {
        label: "Last 24h",
        start,
        end: now,
      },
      usage: {
        requests: { used: usage.requests },
        tokens: { used: usage.tokens },
        cost: { used: Number(usage.cost.toFixed(4)), currency: "USD" },
      },
      message: "Estimated from local assistant history.",
      notes: merge(note ? [note] : undefined, historyNotes(scope)),
    }
  }

  async function live(scope: Scope, now: number) {
    if (scope.provider !== ProviderID.openrouter) return {}

    const auth = scope.profile
      ? (await Auth.entry(scope.provider))?.profiles[scope.profile]
      : await Auth.get(scope.provider)
    if (auth?.type !== "api") {
      return { note: "Live OpenRouter monitor requires an API key on the active profile." }
    }

    let res: Response
    try {
      res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: {
          Authorization: `Bearer ${auth.key}`,
        },
      })
    } catch {
      return { note: "Live OpenRouter monitor was unavailable, showing a local fallback." }
    }

    if (!res.ok) {
      return { note: `Live OpenRouter monitor was unavailable (${res.status}), showing a local fallback.` }
    }

    const parsed = OpenRouter.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) {
      return { note: "Live OpenRouter monitor returned an unexpected response, showing a local fallback." }
    }

    const data = parsed.data.data
    if (!usable(data)) {
      return { note: "Live OpenRouter monitor returned an unexpected response, showing a local fallback." }
    }
    const used = current(data)
    const note = [
      `OpenRouter live data is key-wide and may include other models or variants${scope.profile ? " on this profile" : ""}.`,
      data.usage_daily !== null && data.usage_daily !== undefined
        ? `Daily usage: ${usd(data.usage_daily)}.`
        : undefined,
      data.usage_weekly !== null && data.usage_weekly !== undefined
        ? `Weekly usage: ${usd(data.usage_weekly)}.`
        : undefined,
      data.usage_monthly !== null && data.usage_monthly !== undefined
        ? `Monthly usage: ${usd(data.usage_monthly)}.`
        : undefined,
      data.include_byok_in_limit === false ? "BYOK usage is excluded from this OpenRouter key limit." : undefined,
      data.is_free_tier ? "This OpenRouter key is on the free tier." : undefined,
      data.limit_reset ? `Limit resets: ${data.limit_reset}.` : undefined,
    ].filter((item): item is string => !!item)

    return {
      snap: {
        scope,
        state: "live" as const,
        fetched_at: now,
        expires_at: now + TTL,
        source: "provider" as const,
        window: {
          label: data.limit_reset
            ? `${data.limit_reset[0].toUpperCase()}${data.limit_reset.slice(1)} key limit`
            : "Current key limit",
        },
        usage:
          used !== undefined || data.limit !== null
            ? {
                cost: {
                  used,
                  limit: data.limit ?? undefined,
                  currency: "USD",
                },
              }
            : undefined,
        message:
          data.limit_remaining !== null && data.limit_remaining !== undefined
            ? `Live OpenRouter key data. ${usd(data.limit_remaining)} remaining.`
            : "Live OpenRouter key data.",
        notes: note.length > 0 ? note : undefined,
      },
    }
  }

  async function load(scope: Scope): Promise<Snapshot> {
    const now = Date.now()
    const result = await live(scope, now)
    if (result.snap) return result.snap
    return fallback(scope, now, result.note)
  }

  export async function get(scope: Scope, opts?: { refresh?: boolean }): Promise<Snapshot> {
    const id = key(scope)
    const hit = cache.get(id)
    if (!opts?.refresh && hit && hit.expires_at > Date.now()) return hit

    const run = pending.get(id)
    if (run) return run

    const next = load(scope).then((snap) => {
      cache.set(id, snap)
      return snap
    })

    pending.set(id, next)
    return next.finally(() => {
      if (pending.get(id) === next) pending.delete(id)
    })
  }
}
