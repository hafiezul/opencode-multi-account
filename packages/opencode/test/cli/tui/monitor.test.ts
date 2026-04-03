import { describe, expect, test } from "bun:test"
import { monitorHint, monitorLabel, monitorName, monitorSummary } from "../../../src/cli/cmd/tui/util/monitor"

describe("monitor tui formatting", () => {
  test("prefers a percent hint when a limit exists", () => {
    expect(
      monitorHint({
        state: "live",
        source: "provider",
        scope: { provider: "openrouter", model: "openai/gpt-4o" },
        fetched_at: 1,
        expires_at: 2,
        usage: {
          cost: { used: 2, limit: 10, currency: "USD" },
        },
      }),
    ).toBe("20%")
  })

  test("falls back to the state label when no limit exists", () => {
    expect(
      monitorHint({
        state: "estimated",
        source: "history",
        scope: { provider: "openrouter", model: "openai/gpt-4o" },
        fetched_at: 1,
        expires_at: 2,
        usage: {
          cost: { used: 2, currency: "USD" },
        },
      }),
    ).toBe("est")
    expect(
      monitorLabel({
        state: "estimated",
        source: "history",
        scope: { provider: "openrouter", model: "openai/gpt-4o" },
        fetched_at: 1,
        expires_at: 2,
      }),
    ).toBe("est")
  })

  test("formats full status summaries when a limit exists", () => {
    expect(monitorSummary("cost", { used: 2, limit: 10, currency: "USD" })).toBe(
      "cost $2.0000 / $10.0000 · $8.0000 remaining · 20% used",
    )
    expect(monitorSummary("requests", { used: 25, limit: 100 })).toBe("requests 25 / 100 · 75 remaining · 25% used")
  })

  test("labels provider quota windows as quota instead of requests", () => {
    expect(
      monitorName(
        {
          state: "live",
          source: "provider",
          scope: { provider: "anthropic", model: "claude-sonnet-4-5" },
          fetched_at: 1,
          expires_at: 2,
          window: { label: "7d quota" },
        },
        "requests",
      ),
    ).toBe("quota")
    expect(monitorSummary("quota", { used: 35, limit: 100 })).toBe("quota 35 / 100 · 65 remaining · 35% used")
  })

  test("labels GitHub Copilot premium requests as quota", () => {
    expect(
      monitorName(
        {
          state: "live",
          source: "provider",
          scope: { provider: "github-copilot", model: "gpt-4.1" },
          fetched_at: 1,
          expires_at: 2,
          window: { label: "Monthly premium requests" },
        },
        "requests",
      ),
    ).toBe("quota")
  })

  test("treats zero limits as exhausted caps", () => {
    expect(
      monitorHint({
        state: "live",
        source: "provider",
        scope: { provider: "openrouter", model: "openai/gpt-4o" },
        fetched_at: 1,
        expires_at: 2,
        usage: {
          cost: { used: 0, limit: 0, currency: "USD" },
        },
      }),
    ).toBe("0%")
    expect(
      monitorHint({
        state: "live",
        source: "provider",
        scope: { provider: "openrouter", model: "openai/gpt-4o" },
        fetched_at: 1,
        expires_at: 2,
        usage: {
          cost: { used: 1, limit: 0, currency: "USD" },
        },
      }),
    ).toBe("100%")
    expect(monitorSummary("requests", { used: 0, limit: 0 })).toBe("requests 0 / 0 · 0 remaining · 0% used")
    expect(monitorSummary("cost", { used: 1, limit: 0, currency: "USD" })).toBe(
      "cost $1.0000 / $0.0000 · $0.0000 remaining · 100% used",
    )
  })

  test("keeps used-only summaries when no limit exists", () => {
    expect(monitorSummary("tokens", { used: 1_234 })).toBe("tokens 1,234")
  })
})
