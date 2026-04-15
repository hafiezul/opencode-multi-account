import { describe, expect, test } from "bun:test"
import {
  monitorHint,
  monitorLabel,
  monitorName,
  monitorReset,
  monitorSummary,
} from "../../../src/cli/cmd/tui/util/monitor"

describe("monitor tui formatting", () => {
  test("shows billing amounts for api usage hints", () => {
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
    ).toBe("$2.0000")
  })

  test("shows current spend when no cost limit exists", () => {
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
    ).toBe("$2.0000")
  })

  test("falls back to the state label when no usage hint exists", () => {
    expect(
      monitorLabel({
        state: "estimated",
        source: "history",
        scope: { provider: "openrouter", model: "openai/gpt-4o" },
        fetched_at: 1,
        expires_at: 2,
      }),
    ).toBe("est")
    expect(
      monitorHint({
        state: "estimated",
        source: "history",
        scope: { provider: "openrouter", model: "openai/gpt-4o" },
        fetched_at: 1,
        expires_at: 2,
      }),
    ).toBe("est")
  })

  test("formats full status summaries when a limit exists", () => {
    expect(
      monitorSummary(
        {
          state: "live",
          source: "provider",
          scope: { provider: "openrouter", model: "openai/gpt-4o" },
          fetched_at: 1,
          expires_at: 2,
        },
        "cost",
        { used: 2, limit: 10, currency: "USD" },
      ),
    ).toBe("cost $2.0000 / $10.0000")
    expect(
      monitorSummary(
        {
          state: "live",
          source: "provider",
          scope: { provider: "openai", model: "gpt-5.3-codex" },
          fetched_at: 1,
          expires_at: 2,
          window: { label: "5h quota" },
        },
        "requests",
        { used: 25, limit: 100 },
      ),
    ).toBe("requests 25%")
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
    expect(
      monitorSummary(
        {
          state: "live",
          source: "provider",
          scope: { provider: "anthropic", model: "claude-sonnet-4-5" },
          fetched_at: 1,
          expires_at: 2,
          window: { label: "7d quota" },
        },
        "quota",
        { used: 35, limit: 100 },
      ),
    ).toBe("quota 35%")
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
    ).toBe("$0.0000")
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
    ).toBe("$1.0000")
    expect(
      monitorSummary(
        {
          state: "live",
          source: "provider",
          scope: { provider: "openrouter", model: "openai/gpt-4o" },
          fetched_at: 1,
          expires_at: 2,
        },
        "requests",
        { used: 0, limit: 0 },
      ),
    ).toBe("requests 0 / 0")
    expect(
      monitorSummary(
        {
          state: "live",
          source: "provider",
          scope: { provider: "openrouter", model: "openai/gpt-4o" },
          fetched_at: 1,
          expires_at: 2,
        },
        "cost",
        { used: 1, limit: 0, currency: "USD" },
      ),
    ).toBe("cost $1.0000 / $0.0000")
  })

  test("keeps used-only summaries when no limit exists", () => {
    expect(
      monitorSummary(
        {
          state: "estimated",
          source: "history",
          scope: { provider: "openrouter", model: "openai/gpt-4o" },
          fetched_at: 1,
          expires_at: 2,
        },
        "tokens",
        { used: 1_234 },
      ),
    ).toBe("tokens 1,234")
  })

  test("keeps copilot premium quotas as request counts", () => {
    expect(
      monitorHint({
        state: "live",
        source: "provider",
        scope: { provider: "github-copilot", model: "gpt-4.1" },
        fetched_at: 1,
        expires_at: 2,
        window: { label: "Monthly premium requests" },
        usage: {
          requests: { used: 11, limit: 100 },
        },
      }),
    ).toBe("11")
    expect(
      monitorSummary(
        {
          state: "live",
          source: "provider",
          scope: { provider: "github-copilot", model: "gpt-4.1" },
          fetched_at: 1,
          expires_at: 2,
          window: { label: "Monthly premium requests" },
        },
        "quota",
        { used: 11, limit: 100 },
      ),
    ).toBe("quota 11 / 100")
  })

  test("formats reset countdowns from reset timestamps", () => {
    expect(monitorReset(61_000, 0)).toBe("limit will reset in 1m 1s")
    expect(monitorReset(0, 0)).toBeUndefined()
    expect(monitorReset(500, 1_000)).toBe("resetting now")
  })

  test("allows additive account snapshots on monitor payloads", () => {
    expect(
      monitorHint({
        state: "live",
        source: "provider",
        scope: { provider: "openai", model: "gpt-5.3-codex" },
        fetched_at: 1,
        expires_at: 2,
        usage: {
          requests: { used: 75, limit: 100 },
        },
        accounts: [
          {
            key: "acct_1",
            label: "acct_1",
            state: "live",
            usage: {
              requests: { used: 20, limit: 100 },
            },
          },
          {
            key: "acct_2",
            label: "acct_2",
            state: "live",
            usage: {
              requests: { used: 75, limit: 100 },
            },
          },
        ],
      }),
    ).toBe("75%")
  })
})
