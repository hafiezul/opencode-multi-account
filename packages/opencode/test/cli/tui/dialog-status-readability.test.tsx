/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"

const now = Date.now()
const snap = {
  state: "live" as const,
  source: "provider" as const,
  scope: {
    provider: "github-copilot",
    model: "claude-opus-4.6",
    profile: "work",
    variant: "high",
  },
  fetched_at: now - 5_000,
  expires_at: now + 60_000,
  window: { label: "Monthly premium requests" },
  usage: {
    requests: { used: 75, limit: 100 },
    cost: { used: 2.75, currency: "USD" },
  },
  reset_at: now + 3_600_000,
  message: "Live GitHub Copilot premium request quota data.",
  notes: ["Provider data is refreshed on demand."],
  accounts: [
    {
      key: "acct_work",
      label: "work-acct",
      state: "live" as const,
      window: { label: "Monthly premium requests" },
      usage: {
        requests: { used: 20, limit: 100 },
      },
      reset_at: now + 3_600_000,
      notes: ["Shared org account"],
    },
  ],
}

mock.module("@tui/context/theme", () => ({
  useTheme: () => ({
    theme: {
      text: RGBA.fromInts(255, 255, 255),
      textMuted: RGBA.fromInts(160, 160, 160),
      success: RGBA.fromInts(0, 200, 120),
      warning: RGBA.fromInts(240, 180, 0),
      error: RGBA.fromInts(220, 80, 80),
      primary: RGBA.fromInts(80, 180, 255),
      secondary: RGBA.fromInts(220, 120, 255),
      accent: RGBA.fromInts(80, 180, 255),
      info: RGBA.fromInts(80, 180, 255),
      backgroundPanel: RGBA.fromInts(20, 20, 20),
      backgroundElement: RGBA.fromInts(30, 30, 30),
      border: RGBA.fromInts(90, 90, 90),
    },
  }),
}))

mock.module("@tui/context/sync", () => ({
  useSync: () => ({
    data: {
      formatter: [],
      config: { plugin: ["example-plugin@1.0.0"] },
      provider: [{ id: "github-copilot", name: "GitHub Copilot" }],
      provider_next: {
        all: [],
        default: {},
        connected: ["github-copilot"],
        profile: {
          [snap.scope.provider]: {
            active: "work",
            names: ["work"],
          },
        },
      },
      mcp: {
        github: { status: "connected" },
      },
      lsp: [],
    },
    monitor: {
      ensure: () => snap,
      pending: () => false,
      refresh: async () => snap,
    },
  }),
}))

mock.module("@tui/context/local", () => ({
  useLocal: () => ({
    model: {
      current: () => ({ providerID: snap.scope.provider, modelID: snap.scope.model }),
      variant: {
        current: () => snap.scope.variant,
      },
    },
  }),
}))

mock.module("@tui/ui/dialog", () => ({
  useDialog: () => ({
    clear() {},
    setSize() {},
    stack: [],
  }),
}))

const { DialogStatus } = await import("../../../src/cli/cmd/tui/component/dialog-status")

function frame(value: string) {
  return value.replace(/\0/g, " ")
}

test("status dialog defaults to summary-first monitor view and expands on demand", async () => {
  const ui = await testRender(() => <DialogStatus />, { width: 100, height: 30 })
  await ui.renderOnce()

  const compact = frame(ui.captureCharFrame())
  expect(compact).toContain("Status")
  expect(compact).toContain("live · provider")
  expect(compact).toContain("quota 75 / 100 · 25 remaining · 75% used")
  expect(compact).toContain("d details")
  expect(compact).not.toContain("work-acct")
  expect(compact).not.toContain("github-copilot/claude-opus-4.6")

  ui.mockInput.pressKey("d")
  await ui.renderOnce()

  const expanded = frame(ui.captureCharFrame())
  expect(expanded).toContain("d less")
  expect(expanded).toContain("github-copilot/claude-opus-4.6 · high · work")
  expect(expanded).toContain("work-acct live")
  expect(expanded).toContain("Provider data is refreshed on demand.")
})
