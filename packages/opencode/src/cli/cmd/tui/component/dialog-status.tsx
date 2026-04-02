import { TextAttributes } from "@opentui/core"
import { fileURLToPath } from "bun"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useKeyboard } from "@opentui/solid"
import { For, Match, Switch, Show, createMemo } from "solid-js"
import { Locale } from "@/util/locale"

export type DialogStatusProps = {}

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

function money(value?: number) {
  if (value === undefined) return "—"
  return `$${value.toFixed(4)}`
}

export function DialogStatus() {
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const dialog = useDialog()

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

  const refresh = async () => {
    const next = scope()
    if (!next) return
    await sync.monitor.refresh(next)
  }

  useKeyboard((evt) => {
    if (evt.name === "r" && !evt.ctrl && !evt.meta) {
      void refresh()
    }
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
            <text
              fg={sync.monitor.pending(scope()!) ? theme.warning : theme.textMuted}
              onMouseUp={() => void refresh()}
            >
              {sync.monitor.pending(scope()!) ? "refreshing..." : "r refresh"}
            </text>
          </box>
          <Show when={monitor()} fallback={<text fg={theme.textMuted}>Loading monitor snapshot...</text>}>
            {(snap) => (
              <box flexDirection="column">
                <text fg={theme.text}>
                  state <span style={{ fg: monitorColor(), bold: true }}>{snap().state}</span>
                  <span style={{ fg: theme.textMuted }}> · {snap().source}</span>
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  {snap().scope.provider}/{snap().scope.model}
                  {snap().scope.variant ? ` · ${snap().scope.variant}` : ""}
                  {snap().scope.profile ? ` · ${snap().scope.profile}` : ""}
                </text>
                <text fg={theme.textMuted}>last refresh {ago(snap().fetched_at)}</text>
                <Show when={snap().window}>
                  <text fg={theme.textMuted}>window {snap().window!.label}</text>
                </Show>
                <Show when={snap().usage?.requests?.used !== undefined}>
                  <text fg={theme.text}>requests {snap().usage?.requests?.used?.toLocaleString()}</text>
                </Show>
                <Show when={snap().usage?.tokens?.used !== undefined}>
                  <text fg={theme.text}>tokens {snap().usage?.tokens?.used?.toLocaleString()}</text>
                </Show>
                <Show when={snap().usage?.cost?.used !== undefined}>
                  <text fg={theme.text}>cost {money(snap().usage?.cost?.used)}</text>
                </Show>
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
