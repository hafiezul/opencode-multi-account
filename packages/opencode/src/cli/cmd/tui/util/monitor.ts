import type { MonitorSnapshot } from "@opencode-ai/sdk/v2"

type Item = {
  used?: number
  limit?: number
}

type Cost = Item & {
  currency?: string
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
  const value = pct(snap.usage?.cost) ?? pct(snap.usage?.tokens) ?? pct(snap.usage?.requests)
  if (value === undefined) return monitorLabel(snap)
  return `${value}%`
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

export function monitorSummary(name: string, item?: Item | Cost) {
  if (!item || item.used === undefined) return
  const used = fmt(name, item)
  if (item.limit === undefined) return `${name} ${used}`
  const left = item.limit - item.used
  return `${name} ${used} / ${full(name, item)} · ${full(name, { ...item, limit: Math.max(left, 0) })} remaining · ${pct(item)}% used`
}
