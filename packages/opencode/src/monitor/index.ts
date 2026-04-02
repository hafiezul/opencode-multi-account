import { MessageTable } from "@/session/session.sql"
import { Database, and, desc, gte, sql } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import z from "zod"

export namespace Monitor {
  export const TTL = 5 * 60 * 1000
  const DAY = 24 * 60 * 60 * 1000

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

  function notes(scope: Scope) {
    if (!scope.profile) return
    return [`History is not persisted by profile, so this estimate may include other ${scope.provider} profiles.`]
  }

  function total(tokens: z.infer<typeof History>["tokens"]) {
    return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  }

  export async function get(scope: Scope): Promise<Snapshot> {
    const now = Date.now()
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
        notes: notes(scope),
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
      notes: notes(scope),
    }
  }
}
