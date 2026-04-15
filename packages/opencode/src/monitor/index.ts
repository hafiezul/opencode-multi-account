import { MessageTable } from "@/session/session.sql"
import { Database, and, desc, gte, sql } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import os from "node:os"
import path from "node:path"
import z from "zod"

export namespace Monitor {
  const log = Log.create({ service: "monitor" })
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

  const AccountSnapshot = z
    .object({
      key: z.string(),
      label: z.string(),
      state: z.enum(["live", "estimated", "unknown"]),
      window: Window.optional(),
      usage: Usage.optional(),
      reset_at: z.number().optional(),
      message: z.string().optional(),
      notes: z.array(z.string()).optional(),
    })
    .meta({ ref: "MonitorAccountSnapshot" })
  export type AccountSnapshot = z.infer<typeof AccountSnapshot>

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
      accounts: z.array(AccountSnapshot).optional(),
    })
    .meta({ ref: "MonitorSnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>

  const History = z.object({
    role: z.literal("assistant"),
    providerID: ProviderID.zod,
    modelID: ModelID.zod,
    variant: z.string().optional(),
    auth: z
      .object({
        profile: z.string(),
        accountID: z.string().optional(),
      })
      .optional(),
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

  const OpenAIWindow = z.object({
    used_percent: z.number(),
    limit_window_seconds: z.number().nullable().optional(),
    reset_after_seconds: z.number().nullable().optional(),
    reset_at: z.number().nullable().optional(),
  })

  const OpenAIRateLimitValue = z.union([OpenAIWindow, z.boolean(), z.null()])

  const OpenAIAdditionalRateLimit = z.object({
    limit_name: z.string().nullable().optional(),
    metered_feature: z.string().nullable().optional(),
    rate_limit: OpenAIWindow.nullable().optional(),
  })

  const OpenAICredits = z.object({
    balance: z.string().nullable().optional(),
  })

  const OpenAIOauth = z.object({
    plan_type: z.string().nullable().optional(),
    rate_limit: z.record(z.string(), OpenAIRateLimitValue),
    additional_rate_limits: z.array(OpenAIAdditionalRateLimit).nullable().optional(),
    credits: OpenAICredits.nullable().optional(),
  })

  const OpenAICost = z.object({
    data: z.array(
      z.object({
        start_time: z.number(),
        end_time: z.number(),
        results: z.array(
          z.object({
            amount: z.object({
              value: z.number(),
              currency: z.string(),
            }),
          }),
        ),
      }),
    ),
  })

  const AnthropicOauthWindow = z.object({
    utilization: z.number(),
    resets_at: z.string().nullable().optional(),
  })

  const AnthropicOauth = z.object({
    five_hour: AnthropicOauthWindow.nullable().optional(),
    seven_day: AnthropicOauthWindow.nullable().optional(),
    seven_day_sonnet: AnthropicOauthWindow.nullable().optional(),
    seven_day_opus: AnthropicOauthWindow.nullable().optional(),
    extra_usage: z
      .object({
        is_enabled: z.boolean().nullable().optional(),
        monthly_limit: z.number().nullable().optional(),
        used_credits: z.number().nullable().optional(),
        utilization: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
  })

  const AnthropicCost = z.object({
    data: z.array(
      z.object({
        starting_at: z.string(),
        ending_at: z.string(),
        results: z.array(
          z.object({
            amount: z.string(),
            currency: z.string(),
          }),
        ),
      }),
    ),
  })

  const GoogleCreds = z.object({
    expiry_date: z.union([z.number(), z.string()]).optional(),
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    id_token: z.string().optional(),
    project_id: z.string().optional(),
    quota_project_id: z.string().optional(),
  })

  const GoogleQuota = z.object({
    buckets: z
      .array(
        z.object({
          modelId: z.string().optional(),
          remainingFraction: z.number().optional(),
          resetTime: z.string().optional(),
          tokenType: z.string().optional(),
        }),
      )
      .optional(),
  })

  const Copilot = z.object({
    copilot_plan: z.string().optional(),
    plan: z.string().optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
    id: z.number().optional(),
    quota_reset_date_utc: z.string().optional(),
    quota_reset_date: z.string().optional(),
    limited_user_reset_date: z.string().optional(),
    limited_user_quotas: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    monthly_quotas: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    quota_snapshots: z
      .record(
        z.string(),
        z.object({
          unlimited: z.boolean().optional(),
          entitlement: z.union([z.number(), z.string()]).optional(),
          remaining: z.union([z.number(), z.string()]).optional(),
        }),
      )
      .optional(),
  })

  function key(scope: Scope) {
    return [Auth.revision(), scope.provider, scope.profile ?? "", scope.model, scope.variant ?? ""].join("\x1f")
  }

  function historyMessage(scope: Scope, accountID?: string, empty?: boolean) {
    if (scope.profile && accountID) {
      return empty
        ? "No local history estimate for this profile and account yet."
        : "Estimated from local assistant history for this profile and account."
    }
    if (scope.profile) {
      return empty
        ? "No local history estimate for this profile yet."
        : "Estimated from local assistant history for this profile."
    }
    return empty
      ? "No local history estimate yet."
      : "Estimated from local assistant history without profile attribution."
  }

  function usd(value: number) {
    return `$${value.toFixed(4)}`
  }

  function day(now: number) {
    const date = new Date(now)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  }

  function iso(value: number) {
    return new Date(value).toISOString()
  }

  function pct(value: number) {
    return Math.round(value)
  }

  function parseReset(value?: string | null) {
    if (!value) return
    const next = Date.parse(value)
    if (Number.isNaN(next)) return
    return next
  }

  function cents(value?: number | null) {
    if (value === null || value === undefined) return
    return Number((value / 100).toFixed(4))
  }

  function account(input?: string) {
    if (!input) return
    const parts = input.split(".")
    if (parts.length !== 3) return
    try {
      const value = JSON.parse(Buffer.from(parts[1], "base64url").toString())
      if (typeof value?.chatgpt_account_id === "string") return value.chatgpt_account_id
      if (typeof value?.["https://api.openai.com/auth"]?.chatgpt_account_id === "string") {
        return value["https://api.openai.com/auth"].chatgpt_account_id
      }
      if (typeof value?.organizations?.[0]?.id === "string") return value.organizations[0].id
    } catch {}
  }

  function label(seconds?: number | null) {
    if (!seconds || seconds <= 0) return "Codex quota"
    if (seconds % (24 * 60 * 60) === 0) return `${seconds / (24 * 60 * 60)}d quota`
    if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)}h quota`
    if (seconds % 60 === 0) return `${seconds / 60}m quota`
    return `${seconds}s quota`
  }

  function reset(now: number, data: z.infer<typeof OpenAIWindow>) {
    if (data.reset_after_seconds && data.reset_after_seconds > 0) return now + data.reset_after_seconds * 1000
    if (!data.reset_at) return
    return data.reset_at > 2_000_000_000_000 ? data.reset_at : data.reset_at * 1000
  }

  function home() {
    return process.env.HOME || os.homedir()
  }

  async function file<T>(file: string, schema: z.ZodType<T>) {
    const item = Bun.file(file)
    if (!(await item.exists())) return
    const parsed = schema.safeParse(await item.json().catch(() => undefined))
    if (!parsed.success) return
    return parsed.data
  }

  function scalar(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const next = Number(value)
      if (Number.isFinite(next)) return next
    }
  }

  function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  function string(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  function token(value: string) {
    const parts = value.split(".")
    if (parts.length !== 3) return
    try {
      const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString())
      if (!record(parsed)) return
      return parsed
    } catch {}
  }

  function project(value?: string) {
    if (!value) return {}
    const [refresh = "", pid = "", mid = ""] = value.split("|", 3)
    return {
      refresh: refresh.trim(),
      project: pid.trim() || undefined,
      managed: mid.trim() || undefined,
    }
  }

  async function googleProject(packed?: string, creds?: z.infer<typeof GoogleCreds>) {
    const parts = project(packed)
    if (parts.project) return parts.project
    if (parts.managed) return parts.managed
    if (creds?.project_id?.trim()) return creds.project_id.trim()
    if (creds?.quota_project_id?.trim()) return creds.quota_project_id.trim()
    if (process.env.OPENCODE_GEMINI_PROJECT_ID?.trim()) return process.env.OPENCODE_GEMINI_PROJECT_ID.trim()
    if (process.env.GOOGLE_CLOUD_PROJECT?.trim()) return process.env.GOOGLE_CLOUD_PROJECT.trim()
    if (process.env.GOOGLE_CLOUD_PROJECT_ID?.trim()) return process.env.GOOGLE_CLOUD_PROJECT_ID.trim()
    if (process.env.GEMINI_PROJECT_ID?.trim()) return process.env.GEMINI_PROJECT_ID.trim()
    const cfg = await Config.get().catch(() => undefined)
    const next = cfg?.provider?.google?.options?.projectId
    if (typeof next === "string" && next.trim()) return next.trim()
  }

  async function googleCreds() {
    return file(path.join(home(), ".gemini", "oauth_creds.json"), GoogleCreds)
  }

  function googleClient(creds?: z.infer<typeof GoogleCreds>, packed?: string) {
    const aud = string(token(creds?.id_token ?? "")?.aud)
    if (aud === "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com") {
      return {
        id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
        secret: "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",
      }
    }
    if (packed?.includes("|")) {
      return {
        id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
        secret: "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",
      }
    }
    return {
      id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      secret: "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",
    }
  }

  function copilotPaths() {
    const list = [] as string[]
    const xdg = process.env.XDG_CONFIG_HOME?.trim()
    if (xdg) {
      list.push(path.join(xdg, "github-copilot", "hosts.json"))
      list.push(path.join(xdg, "github-copilot", "apps.json"))
    }
    list.push(path.join(home(), ".config", "github-copilot", "hosts.json"))
    list.push(path.join(home(), ".config", "github-copilot", "apps.json"))
    list.push(path.join(home(), "Library", "Application Support", "github-copilot", "hosts.json"))
    list.push(path.join(home(), "Library", "Application Support", "github-copilot", "apps.json"))
    return [...new Set(list)]
  }

  function copilotDomain(value?: string) {
    if (!value?.trim()) return
    const next = value.trim()
    try {
      const url = new URL(next.includes("://") ? next : `https://${next}`)
      const host = url.host.replace(/^copilot-api\./, "").replace(/^api\./, "")
      if (!host) return
      return host === "github" ? "github.com" : host
    } catch {
      const host = next
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/^copilot-api\./, "")
        .replace(/^api\./, "")
      if (!host) return
      return host === "github" ? "github.com" : host
    }
  }

  function copilotHost(value?: string) {
    if (!value?.trim()) return
    const next = value.trim()
    if (next !== "github" && next !== "github.com" && !next.includes(".") && !next.includes("://")) return
    return copilotDomain(next)
  }

  function copilotPick(input: Record<string, unknown>, base?: string) {
    const keys = Object.fromEntries(Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]))
    const access = string(keys.oauthtoken) ?? string(keys.accesstoken) ?? string(keys.token)
    if (!access) return
    const account = string(keys.accountid) ?? string(keys.userid) ?? string(keys.id)
    const login = string(keys.login) ?? string(keys.user) ?? string(keys.username) ?? string(keys.email)
    const enterpriseUrl =
      copilotDomain(
        string(keys.enterpriseurl) ??
          string(keys.serverurl) ??
          string(keys.host) ??
          string(keys.hostname) ??
          string(keys.domain),
      ) ?? copilotHost(base)
    return { access, account, login, enterpriseUrl }
  }

  async function copilotLocal() {
    const list = [] as Array<{
      access: string
      account?: string
      login?: string
      source: string
      enterpriseUrl?: string
    }>
    for (const item of copilotPaths()) {
      const data = await file(item, z.record(z.string(), z.unknown()))
      if (!data) continue
      const first = copilotPick(data)
      if (first) list.push({ ...first, source: item })
      for (const [key, value] of Object.entries(data)) {
        if (!record(value)) continue
        const next = copilotPick(value, key)
        if (next) list.push({ ...next, source: item })
      }
    }
    return list
  }

  type LiveResult = {
    snap?: Snapshot
    note?: string
  }

  function window(data: Record<string, z.infer<typeof OpenAIRateLimitValue>>) {
    const named = Object.entries(data).flatMap(([key, value]) => {
      const parsed = OpenAIWindow.safeParse(value)
      if (!parsed.success) return []
      return [[key, parsed.data] as const]
    })
    if (named.length === 0) return
    const timed = named
      .filter(([, item]) => item.limit_window_seconds && item.limit_window_seconds > 0)
      .sort((a, b) => {
        const window = (a[1].limit_window_seconds ?? Infinity) - (b[1].limit_window_seconds ?? Infinity)
        if (window !== 0) return window
        return pct(b[1].used_percent) - pct(a[1].used_percent)
      })
    if (timed.length > 0) {
      return {
        key: timed[0][0],
        data: timed[0][1],
        alt: timed.length > 1 ? timed[timed.length - 1] : undefined,
      }
    }
    if ("primary_window" in data) {
      const primary = OpenAIWindow.safeParse(data.primary_window)
      const secondary = "secondary_window" in data ? OpenAIWindow.safeParse(data.secondary_window) : undefined
      if (!primary.success) return
      return {
        key: "primary_window",
        data: primary.data,
        alt: secondary?.success ? (["secondary_window", secondary.data] as const) : undefined,
      }
    }
    const sorted = named.toSorted((a, b) => a[0].localeCompare(b[0]))
    return { key: sorted[0][0], data: sorted[0][1], alt: sorted.length > 1 ? sorted[sorted.length - 1] : undefined }
  }

  function merge(...list: Array<string[] | undefined>) {
    const next = list.flatMap((item) => item ?? [])
    if (next.length === 0) return
    return next
  }

  function uniq(...list: Array<string[] | undefined>) {
    const next = [] as string[]
    for (const item of list.flatMap((item) => item ?? [])) {
      if (next.includes(item)) continue
      next.push(item)
    }
    if (next.length === 0) return
    return next
  }

  function pick(usage?: Snapshot["usage"]) {
    return usage?.requests ?? usage?.tokens ?? usage?.cost
  }

  function rate(usage?: Snapshot["usage"]) {
    const item = pick(usage)
    if (!item || item.used === undefined) return -1
    if (item.limit === undefined) return item.used
    if (item.limit === 0) return item.used === 0 ? 0 : Number.POSITIVE_INFINITY
    return item.used / item.limit
  }

  function left(usage?: Snapshot["usage"]) {
    const item = pick(usage)
    if (!item || item.used === undefined || item.limit === undefined) return Number.POSITIVE_INFINITY
    return item.limit - item.used
  }

  function worst<T extends { usage?: Snapshot["usage"]; reset_at?: number }>(list: T[]) {
    return list.toSorted((a, b) => {
      const ar = rate(a.usage)
      const br = rate(b.usage)
      if (ar !== br) return br > ar ? 1 : -1
      const rem = left(a.usage) - left(b.usage)
      if (rem !== 0) return rem
      return (a.reset_at ?? Infinity) - (b.reset_at ?? Infinity)
    })[0]
  }

  function snap(
    scope: Scope,
    now: number,
    row: AccountSnapshot,
    rows?: AccountSnapshot[],
    notes?: string[],
    all?: boolean,
  ): Snapshot {
    return {
      scope,
      state: row.state,
      fetched_at: now,
      expires_at: now + TTL,
      source: "provider",
      window: row.window,
      usage: row.usage,
      reset_at: row.reset_at,
      message: row.message,
      notes: uniq(row.notes, notes),
      accounts: rows && (all || rows.length > 1) ? rows : undefined,
    }
  }

  function total(tokens: z.infer<typeof History>["tokens"]) {
    return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  }

  function accountLabel(key?: string, current?: string) {
    if (!key) return "Current account"
    if (key === current) return `${key} (current)`
    return key
  }

  function quota(
    key: string,
    label: string,
    item?: z.infer<typeof AnthropicOauthWindow> | null,
  ): AccountSnapshot | undefined {
    if (!item) return
    return {
      key,
      label,
      state: "live",
      window: {
        label,
      },
      usage: {
        requests: {
          used: pct(item.utilization),
          limit: 100,
        },
      },
      reset_at: parseReset(item.resets_at),
      message: "Live Anthropic quota data via subscription usage.",
    }
  }

  function copilotURL(base?: string) {
    const host = copilotDomain(base)
    if (!host || host === "github.com") return "https://api.github.com/copilot_internal/user"
    return `https://copilot-api.${host}/copilot_internal/user`
  }

  function openaiURL(base?: string) {
    if (!base?.trim()) return "https://chatgpt.com/backend-api/wham/usage"
    try {
      const url = new URL(base)
      const path = url.pathname.replace(/\/+$/, "").replace(/\/v\d+$/, "")
      url.pathname = `${path}/api/codex/usage`.replace(/\/+/g, "/")
      url.search = ""
      url.hash = ""
      return url.toString()
    } catch {
      return "https://chatgpt.com/backend-api/wham/usage"
    }
  }

  function openaiAccounts(input?: string, current?: string) {
    const parsed = token(input ?? "")
    const auth = record(parsed?.["https://api.openai.com/auth"])
      ? (parsed["https://api.openai.com/auth"] as Record<string, unknown>)
      : undefined
    return [
      current,
      string(parsed?.chatgpt_account_id),
      string(auth?.chatgpt_account_id),
      ...(Array.isArray(parsed?.organizations)
        ? parsed.organizations
            .flatMap((item) => (record(item) ? [string(item.id)] : []))
            .filter((item): item is string => !!item)
        : []),
    ].filter((item, idx, list): item is string => !!item && list.indexOf(item) === idx)
  }

  function copilotKey(access: string, account?: string, login?: string, enterpriseUrl?: string) {
    const host = copilotDomain(enterpriseUrl)
    const prefix = host && host !== "github.com" ? `${host}:` : ""
    if (account) return `${prefix}${account}`
    const parsed = token(access)
    const sub = string(parsed?.sub)
    if (sub) return `${prefix}${sub}`
    const id = string(parsed?.login) ?? string(parsed?.email) ?? login
    const hash = Bun.hash(access).toString(36)
    if (id) return `${prefix}${id}:${hash}`
    return `${prefix}token-${hash}`
  }

  function copilotUsage(data: z.infer<typeof Copilot>) {
    const premium = data.quota_snapshots?.premium_interactions
    if (premium) {
      const limit = scalar(premium.entitlement) ?? 0
      const left = scalar(premium.remaining) ?? 0
      if (limit > 0) {
        return {
          limit,
          used: Math.max(0, limit - left),
          reset_at:
            parseReset(data.quota_reset_date_utc) ??
            parseReset(data.quota_reset_date) ??
            parseReset(data.limited_user_reset_date),
          plan: data.copilot_plan ?? data.plan,
          account: string(data.user_id) ?? (data.id !== undefined ? String(data.id) : undefined),
        }
      }
    }

    let limit = 0
    let left = 0
    if (data.quota_snapshots) {
      for (const item of Object.values(data.quota_snapshots)) {
        if (item.unlimited) continue
        limit += scalar(item.entitlement) ?? 0
        left += scalar(item.remaining) ?? 0
      }
    }
    if (limit === 0) {
      const month = Object.values(data.monthly_quotas ?? {}).reduce<number>((sum, item) => sum + (scalar(item) ?? 0), 0)
      const used = Object.values(data.limited_user_quotas ?? {}).reduce<number>(
        (sum, item) => sum + (scalar(item) ?? 0),
        0,
      )
      limit = month
      left = limit > 0 ? Math.max(0, limit - used) : 0
    }
    if (limit === 0) return
    return {
      limit,
      used: Math.max(0, limit - left),
      reset_at:
        parseReset(data.quota_reset_date_utc) ??
        parseReset(data.quota_reset_date) ??
        parseReset(data.limited_user_reset_date),
      plan: data.copilot_plan ?? data.plan,
      account: string(data.user_id) ?? (data.id !== undefined ? String(data.id) : undefined),
    }
  }

  async function openaiQuota(input: {
    now: number
    access: string
    url: string
    key?: string
    current?: string
  }): Promise<{ row?: AccountSnapshot; note?: string }> {
    let res: Response
    try {
      res = await fetch(input.url, {
        headers: {
          Authorization: `Bearer ${input.access}`,
          ...(input.key ? { "ChatGPT-Account-Id": input.key } : {}),
        },
      })
    } catch {
      return { note: "Live OpenAI monitor was unavailable, showing a local fallback." }
    }

    if (!res.ok) {
      return { note: `Live OpenAI monitor was unavailable (${res.status}), showing a local fallback.` }
    }

    const parsed = OpenAIOauth.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) {
      log.warn("openai oauth schema mismatch", { url: input.url, error: parsed.error.message })
      return { note: "Live OpenAI monitor returned an unexpected response, showing a local fallback." }
    }

    const picked = window(parsed.data.rate_limit)
    if (!picked) {
      return { note: "Live OpenAI monitor returned an unexpected response, showing a local fallback." }
    }

    const extras = (parsed.data.additional_rate_limits ?? [])
      .flatMap((item) => {
        if (!item.rate_limit) return []
        const name = item.limit_name ?? item.metered_feature ?? "additional quota"
        return [`${name}: ${pct(item.rate_limit.used_percent)}% used.`]
      })
      .filter((item, idx, list) => list.indexOf(item) === idx)

    return {
      row: {
        key: input.key ?? input.current ?? "default",
        label: accountLabel(input.key, input.current),
        state: "live",
        window: {
          label: label(picked.data.limit_window_seconds),
        },
        usage: {
          requests: {
            used: pct(picked.data.used_percent),
            limit: 100,
          },
        },
        reset_at: reset(input.now, picked.data),
        message: "Live OpenAI quota data via subscription-tier usage.",
        notes: uniq(
          [
            "Method: subscription quota.",
            "OpenAI live quota data is account-wide and may include other models or variants on this profile.",
          ],
          parsed.data.plan_type ? [`Plan: ${parsed.data.plan_type}.`] : undefined,
          picked.alt
            ? [`${label(picked.alt[1].limit_window_seconds)}: ${pct(picked.alt[1].used_percent)}% used.`]
            : undefined,
          extras,
          parsed.data.credits?.balance ? [`Credits balance: ${parsed.data.credits.balance}.`] : undefined,
        ),
      },
    }
  }

  async function copilotQuota(input: {
    access: string
    account?: string
    login?: string
    source?: string
    enterpriseUrl?: string
  }): Promise<{ row?: AccountSnapshot; note?: string }> {
    let res: Response
    try {
      res = await fetch(copilotURL(input.enterpriseUrl), {
        headers: {
          Authorization: `token ${input.access}`,
          Accept: "application/json",
          "Editor-Version": "vscode/1.96.2",
          "X-Github-Api-Version": "2025-04-01",
        },
      })
    } catch {
      return { note: "Live GitHub Copilot monitor was unavailable, showing a local fallback." }
    }
    if (!res.ok) {
      return { note: `Live GitHub Copilot monitor was unavailable (${res.status}), showing a local fallback.` }
    }
    const parsed = Copilot.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) {
      log.warn("copilot schema mismatch", { error: parsed.error.message })
      return { note: "Live GitHub Copilot monitor returned an unexpected response, showing a local fallback." }
    }

    const usage = copilotUsage(parsed.data)
    if (!usage) {
      return { note: "Live GitHub Copilot monitor returned no quota values, showing a local fallback." }
    }

    const key = copilotKey(input.access, usage.account ?? input.account, input.login, input.enterpriseUrl)
    return {
      row: {
        key,
        label: input.login ?? usage.account ?? input.account ?? key,
        state: "live",
        window: {
          label: "Monthly premium requests",
        },
        usage: {
          requests: {
            used: usage.used,
            limit: usage.limit,
          },
        },
        reset_at: usage.reset_at,
        message: "Live GitHub Copilot premium request quota data.",
        notes: uniq(
          ["Method: subscription premium request quota."],
          usage.plan ? [`Plan: ${usage.plan}.`] : undefined,
          input.source ? [`Using local Copilot token data from ${input.source}.`] : undefined,
        ),
      },
    }
  }

  function matches(item: z.infer<typeof History>, scope: Scope, accountID?: string) {
    if (!scope.profile) return !item.auth?.profile
    if (item.auth?.profile !== scope.profile) return false
    if (accountID) return item.auth?.accountID === accountID
    return true
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
    const ctx = await Auth.resolve(scope.provider, scope.profile)
    const variant = scope.variant
      ? sql`json_extract(${MessageTable.data}, '$.variant') = ${scope.variant}`
      : sql`json_extract(${MessageTable.data}, '$.variant') is null`
    const profile = scope.profile
      ? sql`json_extract(${MessageTable.data}, '$.auth.profile') = ${scope.profile}`
      : sql`json_extract(${MessageTable.data}, '$.auth.profile') is null`
    const account =
      scope.profile && ctx.accountID
        ? sql`json_extract(${MessageTable.data}, '$.auth.accountID') = ${ctx.accountID}`
        : undefined
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
            profile,
            account,
          ),
        )
        .orderBy(desc(MessageTable.time_created))
        .all(),
    )

    const list = rows.flatMap((row) => {
      const parsed = History.safeParse(row.data)
      if (!parsed.success) return []
      if (!matches(parsed.data, scope, ctx.accountID)) return []
      return [parsed.data]
    })

    if (list.length === 0) {
      log.info("monitor fallback has no history", { provider: scope.provider, profile: scope.profile, note })
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
        message: historyMessage(scope, ctx.accountID, true),
        notes: merge(note ? [note] : undefined),
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
      message: historyMessage(scope, ctx.accountID),
      notes: merge(note ? [note] : undefined),
    }
  }

  async function openrouter(scope: Scope, now: number): Promise<LiveResult> {
    if (scope.provider !== ProviderID.openrouter) return {}
    if (!scope.profile) {
      return { note: "Live OpenRouter monitor requires an explicit profile, showing a local fallback." }
    }

    const ctx = await Auth.resolve(scope.provider, scope.profile)
    if (ctx.auth?.type !== "api") {
      return { note: "Live OpenRouter monitor requires an API key on this profile." }
    }

    let res: Response
    try {
      res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: {
          Authorization: `Bearer ${ctx.auth.key}`,
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
      log.warn("openrouter schema mismatch", { error: parsed.error.message })
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

  async function openai(scope: Scope, now: number): Promise<LiveResult> {
    if (scope.provider !== ProviderID.openai) return {}
    if (!scope.profile) {
      return { note: "Live OpenAI monitor requires an explicit profile, showing a local fallback." }
    }

    const ctx = await Auth.resolve(scope.provider, scope.profile)
    if (!ctx.auth) {
      return { note: "Live OpenAI monitor requires configured auth on this profile." }
    }

    if (ctx.auth.type === "api") {
      let res: Response
      try {
        res = await fetch(
          `https://api.openai.com/v1/organization/costs?start_time=${Math.floor(day(now) / 1000)}&limit=1`,
          {
            headers: {
              Authorization: `Bearer ${ctx.auth.key}`,
              "Content-Type": "application/json",
            },
          },
        )
      } catch {
        return { note: "Live OpenAI monitor was unavailable, showing a local fallback." }
      }

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { note: "Live OpenAI organization costs require an admin-capable API key, showing a local fallback." }
        }
        return { note: `Live OpenAI monitor was unavailable (${res.status}), showing a local fallback.` }
      }

      const parsed = OpenAICost.safeParse(await res.json().catch(() => undefined))
      if (!parsed.success || parsed.data.data.length === 0) {
        if (!parsed.success) log.warn("openai cost schema mismatch", { error: parsed.error.message })
        return { note: "Live OpenAI monitor returned an unexpected response, showing a local fallback." }
      }

      const item = parsed.data.data[0]
      const used = Number(item.results.reduce((sum, row) => sum + row.amount.value, 0).toFixed(4))

      return {
        snap: {
          scope,
          state: "live",
          fetched_at: now,
          expires_at: now + TTL,
          source: "provider",
          window: {
            label: "Today org cost",
            start: item.start_time * 1000,
            end: item.end_time * 1000,
          },
          usage: {
            cost: {
              used,
              currency: item.results[0]?.amount.currency?.toUpperCase() ?? "USD",
            },
          },
          message: "Live OpenAI organization cost data via API billing. No budget limit was returned.",
          notes: [
            "Method: API billing.",
            "OpenAI organization cost data is org-wide and may include other models, projects, or API keys on this profile.",
          ],
        },
      }
    }

    if (ctx.auth.type !== "oauth") {
      return { note: "Live OpenAI monitor requires OAuth or API auth on this profile." }
    }

    const cfg = await Config.get().catch(() => undefined)
    const url = openaiURL(cfg?.provider?.openai?.options?.baseURL)
    const auth = ctx.auth as Auth.Oauth
    let aid = ctx.accountID
    let token = auth.access
    if (!token || auth.expires <= now) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refresh,
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      })
      let refresh: Response
      try {
        refresh = await fetch("https://auth.openai.com/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        })
      } catch (err) {
        log.warn("openai oauth refresh network error", { error: String(err) })
        return { note: "Live OpenAI monitor could not refresh the OAuth token, showing a local fallback." }
      }
      if (!refresh.ok) {
        log.warn("openai oauth refresh failed", { status: refresh.status })
        return { note: "Live OpenAI monitor could not refresh the OAuth token, showing a local fallback." }
      }
      const next = z
        .object({
          access_token: z.string(),
          refresh_token: z.string(),
          expires_in: z.number().optional(),
          id_token: z.string().optional(),
        })
        .safeParse(await refresh.json().catch(() => undefined))
      if (!next.success) {
        return { note: "Live OpenAI monitor returned an unexpected OAuth response, showing a local fallback." }
      }
      token = next.data.access_token
      aid = account(next.data.id_token) ?? account(next.data.access_token) ?? ctx.accountID
      await Auth.put(scope.provider, scope.profile, {
        type: "oauth",
        access: next.data.access_token,
        refresh: next.data.refresh_token,
        expires: Date.now() + (next.data.expires_in ?? 3600) * 1000,
        accountId: aid,
      })
    }

    const rows = [] as AccountSnapshot[]
    const notes = [] as string[]
    const keys = openaiAccounts(token, aid)
    const seen = new Set<string>()
    for (const key of keys.length > 0 ? keys : [undefined]) {
      const result = await openaiQuota({
        now,
        access: token,
        url,
        key,
        current: aid,
      })
      if (!result.row) {
        if (result.note) notes.push(result.note)
        continue
      }
      if (seen.has(result.row.key)) continue
      seen.add(result.row.key)
      rows.push(result.row)
    }

    const row = worst(rows)
    if (!row) {
      return {
        note:
          uniq(notes)?.join(" ") ?? "Live OpenAI monitor returned an unexpected response, showing a local fallback.",
      }
    }

    return {
      snap: snap(
        scope,
        now,
        row,
        rows,
        uniq(
          ...rows.map((item) => item.notes),
          notes,
          rows.length > 1 ? [`Aggregated across ${rows.length} OpenAI accounts on this profile.`] : undefined,
        ),
        notes.length > 0,
      ),
    }
  }

  async function anthropic(scope: Scope, now: number): Promise<LiveResult> {
    if (scope.provider !== ProviderID.anthropic) return {}
    if (!scope.profile) {
      return { note: "Live Anthropic monitor requires an explicit profile, showing a local fallback." }
    }

    const ctx = await Auth.resolve(scope.provider, scope.profile)
    if (!ctx.auth) {
      return { note: "Live Anthropic monitor requires configured auth on this profile." }
    }

    if (ctx.auth.type === "oauth") {
      const auth = ctx.auth as Auth.Oauth
      let token = auth.access
      if (!token || auth.expires <= now) {
        let refresh: Response
        try {
          refresh = await fetch("https://platform.claude.com/v1/oauth/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              grant_type: "refresh_token",
              client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
              refresh_token: auth.refresh,
            }),
          })
        } catch (err) {
          log.warn("anthropic oauth refresh network error", { error: String(err) })
          return { note: "Live Anthropic monitor could not refresh the OAuth token, showing a local fallback." }
        }
        if (!refresh.ok) {
          log.warn("anthropic oauth refresh failed", { status: refresh.status })
          return { note: "Live Anthropic monitor could not refresh the OAuth token, showing a local fallback." }
        }
        const next = z
          .object({
            access_token: z.string(),
            refresh_token: z.string(),
            expires_in: z.number(),
          })
          .safeParse(await refresh.json().catch(() => undefined))
        if (!next.success) {
          return { note: "Live Anthropic monitor returned an unexpected OAuth response, showing a local fallback." }
        }
        token = next.data.access_token
        await Auth.put(scope.provider, scope.profile, {
          type: "oauth",
          access: next.data.access_token,
          refresh: next.data.refresh_token,
          expires: Date.now() + next.data.expires_in * 1000 - 5 * 60 * 1000,
        })
      }

      let res: Response
      try {
        res = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "claude-code/2.1.80",
            "anthropic-beta": "oauth-2025-04-20",
          },
        })
      } catch {
        return { note: "Live Anthropic monitor was unavailable, showing a local fallback." }
      }
      if (!res.ok) {
        return { note: `Live Anthropic monitor was unavailable (${res.status}), showing a local fallback.` }
      }
      const parsed = AnthropicOauth.safeParse(await res.json().catch(() => undefined))
      if (!parsed.success) {
        log.warn("anthropic oauth schema mismatch", { error: parsed.error.message })
        return { note: "Live Anthropic monitor returned an unexpected response, showing a local fallback." }
      }

      const five = quota("five_hour", "5h quota", parsed.data.five_hour)
      const week = quota("seven_day", "7d quota", parsed.data.seven_day)
      const sonnet = quota("seven_day_sonnet", "7d Sonnet quota", parsed.data.seven_day_sonnet)
      const opus = quota("seven_day_opus", "7d Opus quota", parsed.data.seven_day_opus)
      const rows = [five, week, sonnet, opus].filter((item): item is AccountSnapshot => !!item)
      const row = five ?? week ?? sonnet ?? opus
      if (!row) {
        return { note: "Live Anthropic monitor returned an unexpected response, showing a local fallback." }
      }

      const notes = [
        "Method: subscription quota.",
        "Anthropic live quota data is account-wide and may include other models or variants on this profile.",
        parsed.data.five_hour ? `5h quota: ${pct(parsed.data.five_hour.utilization)}% used.` : undefined,
        parsed.data.seven_day ? `7d quota: ${pct(parsed.data.seven_day.utilization)}% used.` : undefined,
        parsed.data.seven_day_sonnet
          ? `7d Sonnet quota: ${pct(parsed.data.seven_day_sonnet.utilization)}% used.`
          : undefined,
        parsed.data.seven_day_opus ? `7d Opus quota: ${pct(parsed.data.seven_day_opus.utilization)}% used.` : undefined,
        parsed.data.extra_usage?.is_enabled
          ? `Extra usage: ${usd(cents(parsed.data.extra_usage.used_credits) ?? 0)} of ${usd(cents(parsed.data.extra_usage.monthly_limit) ?? 0)}.`
          : undefined,
      ].filter((note, idx, list): note is string => !!note && list.indexOf(note) === idx)

      return {
        snap: snap(scope, now, row, rows, notes.length > 0 ? notes : undefined),
      }
    }

    let res: Response
    try {
      const params = new URLSearchParams({
        starting_at: iso(day(now)),
        bucket_width: "1d",
        limit: "1",
      })
      res = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${params.toString()}`, {
        headers: {
          "x-api-key": ctx.auth.key,
          "anthropic-version": "2023-06-01",
          Accept: "application/json",
        },
      })
    } catch {
      return { note: "Live Anthropic monitor was unavailable, showing a local fallback." }
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { note: "Live Anthropic cost reports require organization access, showing a local fallback." }
      }
      return { note: `Live Anthropic monitor was unavailable (${res.status}), showing a local fallback.` }
    }

    const parsed = AnthropicCost.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success || parsed.data.data.length === 0) {
      if (!parsed.success) log.warn("anthropic cost schema mismatch", { error: parsed.error.message })
      return { note: "Live Anthropic monitor returned an unexpected response, showing a local fallback." }
    }

    const item = parsed.data.data[0]
    const used = Number(item.results.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(4))

    return {
      snap: {
        scope,
        state: "live",
        fetched_at: now,
        expires_at: now + TTL,
        source: "provider",
        window: {
          label: "Today org cost",
          start: parseReset(item.starting_at),
          end: parseReset(item.ending_at),
        },
        usage: {
          cost: {
            used,
            currency: item.results[0]?.currency?.toUpperCase() ?? "USD",
          },
        },
        message: "Live Anthropic organization cost data via API billing. No budget limit was returned.",
        notes: [
          "Method: API billing.",
          "Anthropic organization cost data is org-wide and may include other models, workspaces, or API keys on this profile.",
        ],
      },
    }
  }

  async function google(scope: Scope, now: number): Promise<LiveResult> {
    if (scope.provider !== ProviderID.google) return {}

    const ctx = await Auth.resolve(scope.provider, scope.profile)
    const saved = ctx.auth?.type === "oauth" ? (ctx.auth as Auth.Oauth) : undefined
    const creds = await googleCreds()
    const packed = saved?.refresh || creds?.refresh_token
    const fresh = project(packed)
    const gid = await googleProject(saved?.refresh, creds)
    if (!packed || !fresh.refresh || !gid) {
      return {
        note: "Live Gemini monitor requires OAuth credentials and a resolved Google Cloud project, showing a local fallback.",
      }
    }

    const client = googleClient(creds, saved?.refresh)
    let access = saved?.access || creds?.access_token
    const expiry = scalar(saved?.expires ?? creds?.expiry_date)
    if (!access || !expiry || expiry <= now + 60_000) {
      let refresh: Response
      try {
        refresh = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: fresh.refresh,
            client_id: client.id,
            client_secret: client.secret,
          }),
        })
      } catch {
        return { note: "Live Gemini monitor could not refresh the OAuth token, showing a local fallback." }
      }
      if (!refresh.ok) {
        return { note: "Live Gemini monitor could not refresh the OAuth token, showing a local fallback." }
      }
      const next = z
        .object({
          access_token: z.string(),
          expires_in: z.number(),
        })
        .safeParse(await refresh.json().catch(() => undefined))
      if (!next.success) {
        return { note: "Live Gemini monitor returned an unexpected OAuth response, showing a local fallback." }
      }
      access = next.data.access_token
      if (scope.profile) {
        await Auth.put(scope.provider, scope.profile, {
          type: "oauth",
          access,
          refresh: saved?.refresh ?? fresh.refresh,
          expires: Date.now() + next.data.expires_in * 1000,
        })
      }
    }

    let res: Response
    try {
      res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access}`,
        },
        body: JSON.stringify({ project: gid }),
      })
    } catch {
      return { note: "Live Gemini monitor was unavailable, showing a local fallback." }
    }
    if (!res.ok) {
      return { note: `Live Gemini monitor was unavailable (${res.status}), showing a local fallback.` }
    }
    const parsed = GoogleQuota.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success || !parsed.data.buckets?.length) {
      if (!parsed.success) log.warn("google quota schema mismatch", { error: parsed.error.message })
      return { note: "Live Gemini monitor returned an unexpected response, showing a local fallback." }
    }

    const list = parsed.data.buckets.filter((item) => item.remainingFraction !== undefined)
    const bucket =
      list.find((item) => item.modelId === scope.model) ??
      list.toSorted((a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1))[0]
    if (!bucket || bucket.remainingFraction === undefined) {
      return { note: "Live Gemini monitor returned an unexpected response, showing a local fallback." }
    }
    const used = pct((1 - Math.max(0, Math.min(bucket.remainingFraction, 1))) * 100)
    const notes = [
      "Gemini live quota data is account-wide for the resolved Google Cloud project and may include other models or variants.",
      `Project: ${gid}.`,
      ...parsed.data.buckets
        .filter((item) => item.modelId && item.remainingFraction !== undefined)
        .slice(0, 4)
        .map(
          (item) => `${item.modelId}: ${pct((1 - Math.max(0, Math.min(item.remainingFraction ?? 1, 1))) * 100)}% used.`,
        ),
    ]

    return {
      snap: {
        scope,
        state: "live",
        fetched_at: now,
        expires_at: now + TTL,
        source: "provider",
        window: {
          label: bucket.tokenType ? `Gemini ${bucket.tokenType.toLowerCase()} quota` : "Gemini quota",
        },
        usage: {
          requests: {
            used,
            limit: 100,
          },
        },
        reset_at: parseReset(bucket.resetTime),
        message: "Live Gemini quota data.",
        notes,
      },
    }
  }

  async function github(scope: Scope, now: number): Promise<LiveResult> {
    if (scope.provider !== ProviderID.githubCopilot) return {}

    const ctx = await Auth.resolve(scope.provider, scope.profile)
    const auth = ctx.auth?.type === "oauth" ? (ctx.auth as Auth.Oauth) : undefined
    const local = await copilotLocal()
    const list = [
      ...(auth
        ? [
            {
              access: auth.access || auth.refresh,
              account: ctx.accountID,
              enterpriseUrl: auth.enterpriseUrl,
              source: undefined,
            },
          ]
        : []),
      ...local,
    ].filter((item) => !!item.access)
    if (list.length === 0) {
      return {
        note: "Live GitHub Copilot monitor requires OAuth credentials or local Copilot token files, showing a local fallback.",
      }
    }

    const rows = [] as AccountSnapshot[]
    const notes = [] as string[]
    const seen = new Set<string>()
    for (const item of list) {
      const result = await copilotQuota(item)
      if (!result.row) {
        if (result.note) notes.push(result.note)
        continue
      }
      if (seen.has(result.row.key)) continue
      seen.add(result.row.key)
      rows.push(result.row)
    }

    const row = worst(rows)
    if (!row) {
      return {
        note:
          uniq(notes)?.join(" ") ?? "Live GitHub Copilot monitor returned no quota values, showing a local fallback.",
      }
    }

    return {
      snap: snap(
        scope,
        now,
        row,
        rows,
        uniq(
          ...rows.map((item) => item.notes),
          notes,
          rows.length > 1 ? [`Aggregated across ${rows.length} GitHub Copilot accounts.`] : undefined,
        ),
        notes.length > 0,
      ),
    }
  }

  const adapters: Array<(scope: Scope, now: number) => Promise<LiveResult>> = [
    openrouter,
    anthropic,
    openai,
    google,
    github,
  ]

  async function live(scope: Scope, now: number): Promise<LiveResult> {
    for (const item of adapters) {
      const result = await item(scope, now)
      if (result.snap) {
        log.info("monitor live adapter matched", {
          provider: scope.provider,
          profile: scope.profile,
          state: result.snap.state,
          adapter: item.name,
        })
        return result
      }
      if (result.note) {
        log.warn("monitor live adapter failed", {
          provider: scope.provider,
          profile: scope.profile,
          note: result.note,
          adapter: item.name,
        })
        return result
      }
    }
    log.info("no monitor adapter matched", { provider: scope.provider, profile: scope.profile })
    return {}
  }

  async function load(scope: Scope): Promise<Snapshot> {
    const now = Date.now()
    const result = await live(scope, now)
    if (result.snap) return result.snap
    log.info("monitor falling back to history", {
      provider: scope.provider,
      profile: scope.profile,
      note: result.note,
    })
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
