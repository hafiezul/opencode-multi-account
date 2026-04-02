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

Historical usage is currently persisted by provider, model, cost, and tokens. It is not persisted by provider profile or account, so accurate per-profile history is not possible today.

That gap matters most for multi-account providers. If two profiles share one provider and model, any historical estimate will be blended.

Some providers can expose live quota or rate-limit signals, but others cannot. The UX therefore needs explicit state labels: `live`, `estimated`, and `unknown`.

---

## Shape experience

Show a compact badge near the inline tuple in the prompt area. It should read as a quick health signal for the active `provider/profile/model/variant` scope.

Recommended v1 badge states:

- `live` — provider returned current limit data
- `estimated` — derived from local history or coarse heuristics
- `unknown` — no reliable signal yet

The badge should stay small and low-noise. Prefer short text plus color, such as `live`, `est`, or `unknown`, over dense numbers in the footer line.

Use `/status` as the detailed limits surface. Add a monitor section that can show last refresh time, state label, scope, summary numbers, and any provider-specific notes.

Include a manual refresh action in `/status` for v1. That gives users a recovery path without requiring a full background sync system first.

Defer a dedicated `/monitor` route or screen. We should only add that after the inline badge and `/status` view prove too cramped.

---

## Normalize snapshot

Future implementation should normalize provider-specific responses into one monitor snapshot shape. The UI should only read this normalized form.

Suggested snapshot fields:

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

Support manual refresh from `/status` even when cached data exists. That gives users a way to force a new read after switching profile, hitting a limit, or waiting for reset.

Prefer stale-while-revalidate behavior for the inline badge. Show the last snapshot immediately, then refresh in the background when it is expired.

For v1, avoid user config and avoid aggressive polling. A fixed 5 minute interval is simple, cheap, and good enough to validate the feature.

---

## Roll out in phases

### Phase 1

Add a minimal monitor service and normalized snapshot model. Show an inline badge near the tuple, add a `/status` section, support manual refresh, and use a hardcoded 5 minute refresh TTL.

This phase should be useful even if many providers only return `unknown`. The value is shared plumbing, clear labeling, and a visible place for future provider support.

Status: shipped and verified, with one backend refresh mismatch fixed during phase 2 work.

What shipped:

- normalized monitor model and service in `src/monitor/index.ts`
- `GET /provider/monitor` in `src/server/routes/provider.ts` with regenerated JS SDK v2 client and types
- scope keyed by `provider + profile + model + variant`
- `estimated` and `unknown` states from local assistant-message history only, with no live provider adapters yet
- 5 minute TTL via `fetched_at` and `expires_at`
- stale-while-revalidate owned by the TUI sync cache for the prompt badge, plus manual refresh support
- backend manual refresh now correctly bypasses backend cache instead of only accepting the `refresh` query
- compact state badge in the prompt tuple
- `/status` Monitor section with scope, state, source, refresh time, window, summary numbers, message or notes, and manual refresh via mouse or `r`
- estimate window set to `Last 24h`
- no dedicated `/monitor` screen

Known limits and continuation notes:

- history is not persisted by profile or account, so estimates are blended across profiles for shared provider and model pairs
- phase 1 originally accepted `refresh` on `/provider/monitor` but did not pass it into `Monitor.get`, so backend manual refresh did not fully bypass backend state until phase 2 fixed it
- normalized snapshot contract remains stable for provider adapters
- phase 2 should keep `/status` copy and notes clear when provider data is partial or unavailable
- phase 3 should add profile or account attribution to persisted history before treating estimates as trustworthy for multi-account setups

### Phase 2

Add provider-specific live adapters where practical. Start with providers that already expose quota, credit, or rate-limit metadata with low implementation risk.

Improve `/status` copy for mixed states and provider-specific caveats. Keep the normalized UI contract stable.

Status: shipped with a verified live adapter for OpenRouter.

What shipped:

- normalized snapshot contract stayed stable
- backend monitor cache still uses a 5 minute TTL
- `refresh` on `/provider/monitor` now bypasses backend cache
- OpenRouter live data uses official `GET /api/v1/key`
- OpenRouter can now return `live` data when that response is available and well formed
- live OpenRouter data is key-wide, not model-specific, so it may include other models or variants on the same profile or key
- if OpenRouter live data is unavailable or malformed, the service falls back to local history as `estimated` or to `unknown`
- `/status` copy and notes are clearer about provider caveats and live to fallback behavior

Known limits and continuation notes:

- only OpenRouter has a live adapter so far
- history is still not attributed by profile or account, so estimates remain blended for shared provider and model pairs
- OpenRouter live data is still broader than tuple-specific model or variant usage

### Phase 3

Persist usage with provider profile or account context if we want correct multi-account historical estimates. Without this, any history-backed estimate stays approximate for shared provider/model pairs.

Once that attribution exists, add better estimated windows such as daily spend or token burn by active profile. This is the first phase where multi-account history can be considered trustworthy.

### Phase 4

Evaluate whether `/status` is still enough. Only then consider a dedicated `/monitor` view, richer timelines, or alerting.

This phase should be demand-driven. We should not prebuild it now.

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

## Touch future files

Likely touchpoints for a later implementation:

- `src/cli/cmd/tui/component/prompt/index.tsx` for the inline badge near the tuple
- `src/cli/cmd/tui/component/dialog-status.tsx` for the detailed `/status` section and manual refresh action
- `src/cli/cmd/tui/context/sync.tsx` for bootstrap, caching, and monitor state distribution
- `src/server/routes/provider.ts` or a new adjacent route for monitor/status API exposure
- `src/provider/auth.ts` and related profile helpers for active profile/account resolution
- a new service such as `src/monitor/index.ts` or `src/provider/monitor.ts` for normalization and refresh logic
- session usage persistence code, likely around `src/session/index.ts` and related schemas, if phase 3 adds profile/account attribution
- SDK generated types after any new API route or schema is added

Implementation should keep the monitor key tied to `provider/profile/model/variant`. That keeps the UI aligned with the tuple users already see.
