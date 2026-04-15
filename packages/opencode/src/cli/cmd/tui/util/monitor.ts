import type { MonitorSnapshot } from "@opencode-ai/sdk/v2"
import { formatDuration } from "@/util/format"

type Item = {
  used?: number
  limit?: number
}

type Cost = Item & {
  currency?: string
}

type Source = {
  scope?: MonitorSnapshot["scope"]
  window?: MonitorSnapshot["window"]
  message?: string
  notes?: string[]
  state?: MonitorSnapshot["state"]
  source?: MonitorSnapshot["source"]
  fetched_at?: number
  expires_at?: number
  key?: string
  label?: string
  reset_at?: number
  usage?: MonitorSnapshot["usage"]
}

function pct(item?: Item) {
  if (item?.used === undefined || item.limit === undefined) return
  if (item.limit === 0) return item.used === 0 ? 0 : 100
  return Math.round((item.used / item.limit) * 100)
}

function money(value?: number, currency?: string) {
  if (value === undefined) return "—"
  if (currency && currency !== "USD") return `${value.toFixed(4)} ${currency}`
  return `$${value.toFixed(4)}`
}

function num(value?: number) {
  if (value === undefined) return "—"
  return value.toLocaleString()
}

function text(item: Source) {
  return [item.window?.label, item.message, ...(item.notes ?? [])]
    .filter((part): part is string => !!part)
    .join(" ")
    .toLowerCase()
}

function copilot(item: Source) {
  const id = item.scope?.provider
  if (id === "github-copilot") return true
  return text(item).includes("premium request")
}

function percent(item: Source, name: string, value?: Item | Cost) {
  if (!value || value.used === undefined || value.limit === undefined) return false
  if (name === "cost" || name === "tokens") return false
  if (copilot(item)) return false
  return value.limit === 100
}

function fmt(name: string, item?: Item | Cost) {
  if (!item || item.used === undefined) return
  if (name === "cost") return money(item.used, (item as Cost).currency)
  return num(item.used)
}

function full(name: string, item?: Item | Cost) {
  if (!item) return
  if (name === "cost") return money(item.limit, (item as Cost).currency)
  return num(item.limit)
}

export function monitorLabel(snap?: MonitorSnapshot) {
  if (!snap) return
  if (snap.state === "estimated") return "est"
  return snap.state
}

export function monitorHint(snap?: MonitorSnapshot) {
  if (!snap) return
  if (snap.usage?.cost?.used !== undefined) return money(snap.usage.cost.used, snap.usage.cost.currency)
  if (percent(snap, "requests", snap.usage?.requests)) return `${pct(snap.usage?.requests)}%`
  if (snap.usage?.requests?.used !== undefined) return num(snap.usage.requests.used)
  const value = pct(snap.usage?.tokens)
  if (value !== undefined) return `${value}%`
  if (snap.usage?.tokens?.used !== undefined) return num(snap.usage.tokens.used)
  return monitorLabel(snap)
}

export function monitorName(snap: MonitorSnapshot, name: keyof NonNullable<MonitorSnapshot["usage"]>) {
  const label = snap.window?.label.toLowerCase() ?? ""
  if (
    name === "requests" &&
    snap.source === "provider" &&
    (((snap.scope.provider === "anthropic" || snap.scope.provider === "openai" || snap.scope.provider === "google") &&
      label.includes("quota")) ||
      (snap.scope.provider === "github-copilot" && label.includes("premium requests")))
  ) {
    return "quota"
  }
  return name
}

export function monitorSummary(source: Source, name: string, item?: Item | Cost) {
  if (!item || item.used === undefined) return
  if (percent(source, name, item)) return `${name} ${pct(item)}%`
  const used = fmt(name, item)
  if (item.limit === undefined) return `${name} ${used}`
  return `${name} ${used} / ${full(name, item)}`
}

export function monitorReset(resetAt?: number, now = Date.now()) {
  if (!resetAt) return
  const secs = Math.max(0, Math.round((resetAt - now) / 1000))
  const text = formatDuration(secs)
  if (text) return `limit will reset in ${text}`
  return "resetting now"
}
