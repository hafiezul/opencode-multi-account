import { TextAttributes } from "@opentui/core"
import { fileURLToPath } from "bun"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useKeyboard } from "@opentui/solid"
import { For, Match, Switch, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Locale } from "@/util/locale"
import { monitorName, monitorReset, monitorSummary } from "../util/monitor"
import type { MonitorAccountSnapshot, MonitorSnapshot } from "@opencode-ai/sdk/v2"

export type DialogStatusProps = {}

function monitorLines(snap: MonitorSnapshot) {
  return [
    monitorSummary(monitorName(snap, "requests"), snap.usage?.requests),
    monitorSummary("tokens", snap.usage?.tokens),
    monitorSummary("cost", snap.usage?.cost),
  ].filter((item): item is string => !!item)
}

function monitorFacts(snap: Pick<MonitorSnapshot, "fetched_at" | "window" | "reset_at">, now: number) {
  return [
    `refresh ${ago(snap.fetched_at)}`,
    snap.window ? `window ${snap.window.label}` : undefined,
    monitorReset(snap.reset_at, now),
  ].filter((item): item is string => !!item)
}

function accountFacts(item: MonitorAccountSnapshot, now: number) {
  return [item.window ? `window ${item.window.label}` : undefined, monitorReset(item.reset_at, now)].filter(
    (note): note is string => !!note,
  )
}

function accountLines(item: MonitorAccountSnapshot) {
  return [
    monitorSummary("requests", item.usage?.requests),
    monitorSummary("tokens", item.usage?.tokens),
    monitorSummary("cost", item.usage?.cost),
  ].filter((line): line is string => !!line)
}

function ago(time?: number) {
  if (!time) return "—"
  const diff = Date.now() - time
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (seconds < 60) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return Locale.datetime(time)
}

export function DialogStatus() {
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const dialog = useDialog()
  const [details, setDetails] = createSignal(false)

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const path = fileURLToPath(value)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })
  const scope = createMemo(() => {
    const model = local.model.current()
    if (!model) return
    return {
      provider: model.providerID,
      profile: sync.data.provider_next.profile[model.providerID]?.active,
      model: model.modelID,
      variant: local.model.variant.current(),
    }
  })
  const monitor = createMemo(() => {
    const next = scope()
    if (!next) return
    return sync.monitor.ensure(next)
  })
  const monitorColor = createMemo(() => {
    const snap = monitor()
    if (!snap) return theme.textMuted
    if (snap.state === "live") return theme.success
    if (snap.state === "estimated") return theme.warning
    return theme.textMuted
  })
  const [now, setNow] = createSignal(Date.now())

  const refresh = async () => {
    const next = scope()
    if (!next) return
    await sync.monitor.refresh(next)
  }

  useKeyboard((evt) => {
    if (evt.name === "r" && !evt.ctrl && !evt.meta) {
      void refresh()
    }
    if (evt.name === "d" && !evt.ctrl && !evt.meta) {
      setDetails((item) => !item)
    }
  })

  onMount(() => {
    dialog.setSize("large")
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={sync.data.provider.length > 0} fallback={<text fg={theme.text}>No Providers</text>}>
        <box>
          <text fg={theme.text}>{sync.data.provider.length} Providers</text>
          <For each={sync.data.provider}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: theme.success }}>
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.name}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>
                    {sync.data.provider_next.profile[item.id]?.active
                      ? `${sync.data.provider_next.profile[item.id]!.active} profile`
                      : "Connected"}
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={scope()} fallback={<text fg={theme.text}>No Monitor Scope</text>}>
        <box>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text}>Monitor</text>
            <box flexDirection="row" gap={2}>
              <Show
                when={
                  monitor() &&
                  (monitor()!.message ? 1 : 0) + (monitor()!.notes?.length ?? 0) + (monitor()!.accounts?.length ?? 0) >
                    0
                }
              >
                <text fg={details() ? theme.text : theme.textMuted} onMouseUp={() => setDetails((item) => !item)}>
                  {details() ? "d less" : "d details"}
                </text>
              </Show>
              <text
                fg={sync.monitor.pending(scope()!) ? theme.warning : theme.textMuted}
                onMouseUp={() => void refresh()}
              >
                {sync.monitor.pending(scope()!) ? "refreshing..." : "r refresh"}
              </text>
            </box>
          </box>
          <Show when={monitor()} fallback={<text fg={theme.textMuted}>Loading monitor snapshot...</text>}>
            {(snap) => (
              <box flexDirection="column">
                <text fg={theme.text}>
                  <span style={{ fg: monitorColor(), bold: true }}>{snap().state}</span>
                  <span style={{ fg: theme.textMuted }}> · {snap().source}</span>
                </text>
                <Show when={monitorLines(snap())[0]}>{(item) => <text fg={theme.text}>{item()}</text>}</Show>
                <text fg={theme.textMuted} wrapMode="word">
                  {monitorFacts(snap(), now()).join(" · ")}
                </text>
                <Show when={details()}>
                  <box flexDirection="column" marginTop={1}>
                    <text fg={theme.textMuted} wrapMode="word">
                      {snap().scope.provider}/{snap().scope.model}
                      {snap().scope.variant ? ` · ${snap().scope.variant}` : ""}
                      {snap().scope.profile ? ` · ${snap().scope.profile}` : ""}
                    </text>
                    <For each={monitorLines(snap()).slice(1)}>{(item) => <text fg={theme.text}>{item}</text>}</For>
                    <Show when={snap().message}>
                      <text fg={theme.textMuted} wrapMode="word">
                        {snap().message}
                      </text>
                    </Show>
                    <For each={snap().notes ?? []}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="word">
                          • {item}
                        </text>
                      )}
                    </For>
                    <Show when={(snap().accounts?.length ?? 0) > 0}>
                      <box flexDirection="column" marginTop={1}>
                        <text fg={theme.text}>accounts {snap().accounts!.length}</text>
                        <For each={snap().accounts ?? []}>
                          {(item) => (
                            <box flexDirection="column" paddingLeft={2}>
                              <text fg={theme.text}>
                                {item.label}{" "}
                                <span
                                  style={{
                                    fg:
                                      item.state === "live"
                                        ? theme.success
                                        : item.state === "estimated"
                                          ? theme.warning
                                          : theme.textMuted,
                                    bold: true,
                                  }}
                                >
                                  {item.state}
                                </span>
                              </text>
                              <Show when={accountFacts(item, now()).length > 0}>
                                <text fg={theme.textMuted} wrapMode="word">
                                  {accountFacts(item, now()).join(" · ")}
                                </text>
                              </Show>
                              <For each={accountLines(item)}>{(line) => <text fg={theme.text}>{line}</text>}</For>
                              <Show when={item.message}>
                                <text fg={theme.textMuted} wrapMode="word">
                                  {item.message}
                                </text>
                              </Show>
                              <For each={item.notes ?? []}>
                                {(note) => (
                                  <text fg={theme.textMuted} wrapMode="word">
                                    • {note}
                                  </text>
                                )}
                              </For>
                            </box>
                          )}
                        </For>
                      </box>
                    </Show>
                  </box>
                </Show>
              </box>
            )}
          </Show>
        </box>
      </Show>
      <Show when={Object.keys(sync.data.mcp).length > 0} fallback={<text fg={theme.text}>No MCP Servers</text>}>
        <box>
          <text fg={theme.text}>{Object.keys(sync.data.mcp).length} MCP Servers</text>
          <For each={Object.entries(sync.data.mcp)}>
            {([key, item]) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: (
                      {
                        connected: theme.success,
                        failed: theme.error,
                        disabled: theme.textMuted,
                        needs_auth: theme.warning,
                        needs_client_registration: theme.error,
                      } as Record<string, typeof theme.success>
                    )[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{key}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>Connected</Match>
                      <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                      <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={(item.status as string) === "needs_auth"}>
                        Needs authentication (run: opencode mcp auth {key})
                      </Match>
                      <Match when={(item.status as string) === "needs_client_registration" && item}>
                        {(val) => (val() as { error: string }).error}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      {sync.data.lsp.length > 0 && (
        <box>
          <text fg={theme.text}>{sync.data.lsp.length} LSP Servers</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: theme.success,
                      error: theme.error,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.text}>No Formatters</text>}>
        <box>
          <text fg={theme.text}>{enabledFormatters().length} Formatters</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={plugins().length > 0} fallback={<text fg={theme.text}>No Plugins</text>}>
        <box>
          <text fg={theme.text}>{plugins().length} Plugins</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
