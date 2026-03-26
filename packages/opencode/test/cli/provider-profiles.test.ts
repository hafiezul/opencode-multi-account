import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import {
  all,
  formatProfileLine,
  formatProviderLabel,
  getActiveEnv,
  getProviderNames,
  getLogoutMode,
  hasProfile,
  resolveStoredProvider,
} from "../../src/cli/cmd/providers"

describe("provider profile helpers", () => {
  test("shows provider name and id clearly", () => {
    expect(stripAnsi(formatProviderLabel({ id: "openai", name: "OpenAI" }))).toBe("OpenAI openai")
  })

  test("shows the active marker in profile rows", () => {
    expect(stripAnsi(formatProfileLine({ name: "work", type: "oauth", active: true }))).toBe("  ● work oauth (active)")
  })

  test("shows inactive profiles clearly", () => {
    expect(stripAnsi(formatProfileLine({ name: "personal", type: "api", active: false }))).toBe("  ○ personal api")
  })

  test("defaults multi-profile logout to profile selection", () => {
    expect(getLogoutMode({ total: 2 })).toBe("prompt")
  })

  test("keeps single-profile logout backward compatible", () => {
    expect(getLogoutMode({ total: 1 })).toBe("provider")
  })

  test("respects explicit profile logout", () => {
    expect(getLogoutMode({ total: 2, profile: "work" })).toBe("profile")
  })

  test("respects explicit provider logout", () => {
    expect(getLogoutMode({ total: 2, all: true })).toBe("provider")
  })

  test("rejects combining profile logout with all", () => {
    expect(getLogoutMode({ total: 2, profile: "work", all: true })).toBe("invalid")
  })

  test("matches stored providers by display name", () => {
    expect(
      resolveStoredProvider({
        entries: [{ id: "openai" }, { id: "anthropic" }],
        names: { openai: "OpenAI", anthropic: "Anthropic" },
        value: "Anthropic",
      }),
    ).toBe("anthropic")
  })

  test("matches stored plugin providers by configured display name", () => {
    const names = getProviderNames({
      database: {},
      config: {
        provider: {
          portkey: { name: "Portkey AI" },
        },
      },
    })

    expect(
      resolveStoredProvider({
        entries: [{ id: "portkey" }],
        names,
        value: "Portkey AI",
      }),
    ).toBe("portkey")
  })

  test("prefers configured provider names", () => {
    expect(
      getProviderNames({
        database: { openai: { name: "OpenAI" } },
        config: { provider: { openai: { name: "OpenAI Team" } } },
      }),
    ).toEqual({ openai: "OpenAI Team" })
  })

  test("keeps built-in names when configured name is missing", () => {
    expect(
      getProviderNames({
        database: { openai: { name: "OpenAI" } },
        config: { provider: { openai: {} } },
      }),
    ).toEqual({ openai: "OpenAI" })
  })

  test("resolves built-in providers by configured display name", () => {
    const names = getProviderNames({
      database: { openai: { name: "OpenAI" } },
      config: { provider: { openai: { name: "OpenAI Team" } } },
    })

    expect(
      resolveStoredProvider({
        entries: [{ id: "openai" }],
        names,
        value: "OpenAI Team",
      }),
    ).toBe("openai")
    expect(stripAnsi(formatProviderLabel({ id: "openai", name: names.openai }))).toBe("OpenAI Team openai")
  })

  test("rejects ambiguous provider display names", () => {
    expect(() =>
      resolveStoredProvider({
        entries: [{ id: "openai" }, { id: "openai-team" }],
        names: { openai: "OpenAI", "openai-team": "OpenAI" },
        value: "OpenAI",
      }),
    ).toThrow('Provider name "OpenAI" is ambiguous. Use an exact provider id: openai, openai-team')
  })

  test("uses resolved provider names for active env vars", () => {
    expect(
      getActiveEnv({
        database: { openai: { env: ["OPENAI_API_KEY"] } },
        names: { openai: "OpenAI Team" },
        env: { OPENAI_API_KEY: "test" },
      }),
    ).toEqual([{ provider: "OpenAI Team", envVar: "OPENAI_API_KEY" }])
  })

  test("keeps exact id lookup when display names are ambiguous", () => {
    expect(
      resolveStoredProvider({
        entries: [{ id: "openai" }, { id: "openai-team" }],
        names: { openai: "OpenAI", "openai-team": "OpenAI" },
        value: "openai-team",
      }),
    ).toBe("openai-team")
  })

  test("uses a symbol for all-profiles selection", () => {
    expect(typeof all).toBe("symbol")
  })

  test("detects known profiles", () => {
    expect(hasProfile({ profiles: [{ name: "default" }, { name: "work" }], value: "work" })).toBe(true)
  })
})
