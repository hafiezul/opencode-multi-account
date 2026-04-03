# Monitor limits

Phased plan for provider limit visibility.

---

## Set scope

Goal: show useful limit state for the active provider context without adding a new screen in v1. The first useful slice is an inline signal near the prompt tuple plus richer detail in `/status`.

Monitor scope should follow the real provider context: `provider + profile + model + variant`. Agent is useful UI context, but it should not be treated as the billing or quota boundary.

Non-goals for this plan:

- copy `opencode-bar` directly
- build a dedicated `/monitor` screen in v1
- solve perfect historical attribution before the first release
- add user config for refresh cadence in v1

`opencode-bar` can inform terminology and rough UX, but not architecture. opencode should stay aligned with its own TUI model and data flow.

---

## Note constraints

The current TUI prompt/footer already exposes the active tuple inline as `<agent><model><provider><variant><profile>`. Any monitor signal should attach to that existing surface instead of inventing a parallel identity model.

`/status` already exists as a summary dialog and is the cheapest detailed surface to extend. That makes it the right place for the first detailed limits view.

Historical usage is persisted by provider, model, cost, tokens, and assistant auth attribution in message JSON. Assistant history now stores `auth.profile` and optional `auth.accountID`, with no DB migration required.

That closes the main phase 3 attribution gap for newly written assistant messages. Legacy unattributed rows still exist and are only used for intentionally unscoped fallback.

Some providers can expose live quota or rate-limit signals, but others cannot. The UX therefore needs explicit state labels: `live`, `estimated`, and `unknown`.

---

## Shape experience

Show a compact badge near the inline tuple in the prompt area. It should read as a quick health signal for the active `provider/profile/model/variant` scope.

Recommended v1 badge states:

- `live` — provider returned current limit data
- `estimated` — derived from local history or coarse heuristics
- `unknown` — no reliable signal yet

The badge should stay small and low-noise. Prefer a compact numeric hint when a real limit exists, such as `20%`, and fall back to short text plus color such as `live`, `est`, or `unknown` when it does not.

Use `/status` as the detailed limits surface. Add a monitor section that can show last refresh time, state label, scope, summary numbers, and any provider-specific notes.

Include a manual refresh action in `/status` for v1. That gives users a recovery path without requiring a full background sync system first.

Defer a dedicated `/monitor` route or screen. We should only add that after the inline badge and `/status` view prove too cramped.

---

## Normalize snapshot

The monitor service now normalizes provider-specific responses into one monitor snapshot shape. The UI should keep reading this normalized form.

Snapshot fields:

```ts
type MonitorSnapshot = {
  scope: {
    provider: string
    profile?: string
    model: string
    variant?: string
  }
  state: "live" | "estimated" | "unknown"
  fetched_at: number
  expires_at: number
  source: "provider" | "history" | "none"
  window?: {
    label: string
    start?: number
    end?: number
  }
  usage?: {
    requests?: { used?: number; limit?: number }
    tokens?: { used?: number; limit?: number }
    cost?: { used?: number; limit?: number; currency?: string }
  }
  reset_at?: number
  message?: string
  notes?: string[]
}
```

`scope` should match the active tuple fields except for `agent`. `agent` can still be shown in the UI nearby, but it should not key the snapshot cache.

`state` should drive both label text and confidence. `source` should explain whether the snapshot came from provider data, local estimation, or no backing signal.

---

## Refresh carefully

Use a hardcoded 5 minute TTL in v1. This should apply both to inline display reuse and `/status` reads.

Support manual refresh from `/status` even when cached data exists. That gives users a way to bypass the stored snapshot after switching profile, hitting a limit, or waiting for reset.

If a matching read is already in flight, refresh can still share that work. It should not imply cancellation or a guaranteed duplicate fetch.

Prefer stale-while-revalidate behavior for the inline badge. Show the last snapshot immediately, then refresh in the background when it is expired.

For v1, avoid user config and avoid aggressive polling. A fixed 5 minute interval is simple, cheap, and good enough to validate the feature.

---

## Roll out in phases

### Phase 1

Add a minimal monitor service and normalized snapshot model. Show an inline badge near the tuple, add a `/status` section, support manual refresh, and use a hardcoded 5 minute refresh TTL.

This phase should be useful even if many providers only return `unknown`. The value is shared plumbing, clear labeling, and a visible place for future provider support.

Status: shipped and verified in code and backend tests, with one backend refresh mismatch fixed during phase 2 work.

What shipped:

- normalized monitor model and service in `src/monitor/index.ts`
- `GET /provider/monitor` in `src/server/routes/provider.ts` with regenerated JS SDK v2 client and types
- scope keyed by `provider + profile + model + variant`
- `estimated` and `unknown` states from local assistant-message history only, with no live provider adapters yet
- 5 minute TTL via `fetched_at` and `expires_at`
- stale-while-revalidate owned by the TUI sync cache for the prompt badge, plus manual refresh support
- backend manual refresh now bypasses the stored backend snapshot instead of only accepting the `refresh` query
- compact prompt badge that prefers a percent hint when a usable limit exists, else falls back to the state label
- `/status` Monitor section with scope, state, source, refresh time, window, summary numbers, message or notes, and manual refresh via mouse or `r`
- estimate window set to `Last 24h`
- no dedicated `/monitor` screen

Known limits and continuation notes:

- history is not persisted by profile or account, so estimates are blended across profiles for shared provider and model pairs
- phase 1 originally accepted `refresh` on `/provider/monitor` but did not pass it into `Monitor.get`, so backend manual refresh did not bypass the stored backend snapshot until phase 2 fixed it
- normalized snapshot contract remains stable for provider adapters
- no direct TUI tests were found for the prompt badge or `/status` monitor UI
- phase 2 should keep `/status` copy and notes clear when provider data is partial or unavailable
- phase 3 later added profile and optional account attribution in message JSON, which made scoped fallback estimates trustworthy for newly attributed history

### Phase 2

Add provider-specific live adapters where practical. Start with providers that already expose quota, credit, or rate-limit metadata with low implementation risk.

Improve `/status` copy for mixed states and provider-specific caveats. Keep the normalized UI contract stable.

Status: shipped with verified live adapters for OpenRouter, OpenAI, Anthropic, Gemini, and GitHub Copilot plus backend coverage.

What shipped:

- normalized snapshot contract stayed stable
- backend monitor cache still uses a 5 minute TTL
- `refresh` on `/provider/monitor` now bypasses the stored backend snapshot
- OpenRouter live data uses official `GET /api/v1/key`
- OpenRouter can now return `live` data when that response is available and well formed
- OpenAI can now return `live` data from OAuth-backed Codex quota data or from org cost data when the profile has an admin-capable API key
- Anthropic can now return `live` data from OAuth-backed Claude quota data or from org cost data when the profile has organization access
- Gemini can now return `live` data from Google OAuth-backed Code Assist quota data when a Google Cloud project can be resolved from stored auth, local CLI creds, env, or config
- GitHub Copilot can now return `live` data from OAuth-backed Copilot tokens and can fall back to local Copilot token files such as `hosts.json` or `apps.json`
- live OpenRouter data is key-wide, not model-specific, so it may include other models or variants on the same profile or key
- live OpenAI and Anthropic data is also broader than tuple-specific model or variant usage for the same profile
- live Gemini data is broader than tuple-specific model or variant usage for the resolved project
- live GitHub Copilot data is broader than tuple-specific model or variant usage for the current Copilot account
- if OpenRouter live data is unavailable or malformed, the service falls back to local history as `estimated` or to `unknown`
- if OpenAI or Anthropic live data is unavailable, unsupported by the current auth, or lacks org access, the service falls back to local history as `estimated` or to `unknown`
- if Gemini live data cannot resolve a project or refresh OAuth, or if GitHub Copilot cannot resolve a token or quota response, the service falls back to local history as `estimated` or to `unknown`
- `/status` copy and notes are clearer about provider caveats and live to fallback behavior

Known limits and continuation notes:

- live adapters now exist for OpenRouter, OpenAI, Anthropic, Gemini, and GitHub Copilot
- OpenAI org cost data requires an admin-capable API key, and Anthropic org cost data requires organization access
- Gemini live quota depends on a resolvable Google Cloud project and currently uses Code Assist quota buckets rather than spend limits
- GitHub Copilot live quota depends on either stored OAuth auth or locally discoverable Copilot token files and currently does not use browser-cookie billing pages
- history attribution now exists for newly written assistant messages, but live provider data may still be broader than tuple-specific model or variant usage
- `/status` copy is verified in implementation, but not by direct UI tests

### Phase 3

Ship persisted auth attribution for assistant history so multi-account fallback estimates stop blending newly written usage.

Status: shipped and verified, with persistence and stamping paths confirmed in code.

What shipped:

- assistant messages now persist auth attribution in history as `auth.profile` and optional `auth.accountID`
- attribution is stamped when assistant messages are created for normal prompts, subtasks, compaction, and shell or command assistant messages
- monitor fallback history now filters by persisted profile, and by account when current auth exposes one
- unscoped requests intentionally use only legacy unattributed history and do not silently use active-profile live OpenRouter data
- no DB migration was required because persistence stayed in message JSON
- normalized snapshot contract stayed stable
- verified live OpenRouter cache and refresh behavior still passes
- verified profile separation test, account-id separation test, and legacy unattributed unscoped fallback test

Known limits and continuation notes:

- scoped fallback only benefits rows that include persisted auth attribution, so older history may remain invisible to scoped estimates
- unscoped fallback still exists for legacy unattributed rows by design
- backend separation and fallback tests seed message rows directly, so persistence and stamping were inspected rather than exercised end to end
- this phase improves estimate trust for local history, not live provider precision
- richer estimated windows such as daily spend or burn rate can build on the stable snapshot contract in a later phase

### Phase 4

Evaluate whether the current surfaces are still enough.

Status: complete as evaluation. The inline badge plus `/status` detail still covers the current need.

There is not enough evidence yet to justify a dedicated `/monitor` screen, richer timelines, or alerting. Phase 4 therefore closes by deferring those additions until concrete user demand or clear UI pressure appears.

This phase did not require product or architecture changes beyond documenting that decision.

---

## Call out risks

The biggest risk is false precision. A confident-looking badge backed by blended or stale data will erode trust quickly.

Provider semantics will vary. Some limits are spend-based, some are request-based, some are token-based, and some are opaque.

Open questions:

- should the inline badge prefer text only, color only, or both?
- should refresh happen only on demand plus TTL, or also on profile/model switch?
- where should provider-specific caveats live in the normalized model?
- do we need separate handling for short-term rate limits vs billing-period limits?

---

## Note touchpoints

Current touchpoints and likely extension points:

- `src/cli/cmd/tui/component/prompt/index.tsx` for the inline badge near the tuple
- `src/cli/cmd/tui/component/dialog-status.tsx` for the detailed `/status` section and manual refresh action
- `src/cli/cmd/tui/context/sync.tsx` for bootstrap, caching, and monitor state distribution
- `src/server/routes/provider.ts` for monitor API exposure, or an adjacent route if the surface later expands
- `src/provider/auth.ts` and related profile helpers for active profile/account resolution
- `src/monitor/index.ts` for normalization, caching, provider adapters, and refresh logic
- `src/session` plus `src/monitor/index.ts` for any later attribution or history changes
- SDK generated types after any new API route or schema is added

Implementation should keep the monitor key tied to `provider/profile/model/variant`. That keeps the UI aligned with the tuple users already see.
