# Codex Runtime Observability MVP Implementation Plan

## Goal

Implement the first production-ready Codex Runtime observability path for Zylos Dashboard.

The MVP should make Codex observable through the same Dashboard model used for Claude where the semantics match: hook events drive runtime state and tool activity, while Codex rollout JSONL events drive token, context, rate limit, cache, cost, TTFT, and turn duration metrics.

This plan intentionally excludes OTLP. OTLP remains a later enhancement and must not block the MVP.

## Scope

In scope:

- Codex hook install and uninstall through the component lifecycle.
- Codex hook ingestion through the existing `hook-ingest.cjs` and `/api/ingest` path.
- Sanitized Codex hook metadata needed for state and rollout file mapping.
- A Codex rollout JSONL collector that reads only hook-provided `transcript_path` values.
- Metric mapping for Codex context, rate limits, token usage, cache hit rate, cost, TTFT, and turn duration.
- Resolver/config updates needed for Codex metrics to appear through existing API surfaces.
- Settings and Actions parity where Codex has matching runtime controls, including standard/priority price editing plus model and reasoning effort changes.
- Tests, fixtures, smoke checks, and self-acceptance notes.

Out of scope:

- Codex OTLP receiver or codec.
- Raw prompt, raw tool input, raw tool output, or raw assistant content persistence.
- Dashboard-side Codex session discovery through SQLite or filesystem scanning.

## Current Implementation Outcome

Status as of branch head `c3e5726` plus the in-progress source signal work:

| Area | Outcome |
|---|---|
| Product semantic model | Codex uses the same Dashboard surfaces as Claude where the semantics match: Runtime State, Current Activity, Capacity & Cost, Work Timeline, Trends, Communication, PM2/system/scheduler. |
| Privacy boundary | Landed. Hook, conversation, and rollout summaries use shared sanitizer behavior with redaction before truncation. Raw prompts, raw tool input/output, raw patch content, and raw assistant text are not persisted. |
| Token/cache/cost contract | Landed. Codex/OpenAI input includes cached tokens, so collector writes canonical dimensions and cost uses uncached input plus cache read/write plus output. Aggregates use canonical totals. |
| Rollout dedup | Landed. The rollout collector uses hook-provided `transcript_path` plus durable byte-offset cursors and deterministic rollout-position identities instead of random usage IDs. |
| Runtime switch boundary | Landed. StateEngine clears foreground runtime state and ignores foreign-runtime foreground events so Claude and Codex sessions do not appear active at the same time. |
| Sub-agent lifecycle | Landed for lifecycle/current-activity MVP. Codex `spawn_agent`, `send_input`, `wait_agent`, and `close_agent` rollout records reconstruct parent lifecycle rows; child-session events attach to the active sub-agent row when collectable. Diagnostics are being expanded with duration, wait latency, timeout reason, and recent activity history. |
| Source signals | Landed. `/api/health.source` now returns capability/reason/detail entries so Codex-specific missing data can be explained as unsupported, stale, unavailable, missing rollout path, runtime mismatch, or no signal. The Runtime card renders these as compact Source Signals. |

Remaining PR #131 work before merge:

- Extend Codex sub-agent diagnostics beyond the first landed set: stale explanation, richer recent tool/activity history, and historical statistics.
- Surface Codex TTFT and turn duration as first-class runtime metrics where the current UI can explain them clearly.
- Harden Codex work trace classification for command outcomes, permission flow, patch history, failures, and tool latency.
- Add mixed Claude/Codex runtime validation for daily/7d token, cache, cost, and project attribution semantics.
- Add rollout edge-case tests for rotation/truncation, partial lines, missing previous path, child-session path gaps, collector restart, and source-health explanations.
- Add browser-level validation for the key Codex UI states: capacity, reset times, source signals, timeline, current activity, and sub-agents.
- Keep OTLP out by default. Reconsider it only if hooks plus rollout JSONL cannot satisfy a required product semantic.

## Non-Negotiable Design Constraints

- Do not read Codex SQLite.
- Do not scan or guess the active Codex session as a normal collector strategy.
- Treat hook payload `transcript_path` as the authoritative rollout JSONL locator.
- If no new hook arrives, continue tailing the previous mapped `transcript_path`.
- If the previous rollout file has no new events, report stale or idle source health instead of searching for another file.
- On cold start with no hook-derived mapping, report Codex rollout metrics as unavailable.
- Keep Claude runtime behavior unchanged.
- Store only sanitized metadata. Do not persist raw prompts, raw tool arguments, raw command output, email addresses, account IDs, API keys, or tokens.
- Redact sensitive text before truncation.
- Cap `Stop.last_assistant_message` summaries at 200 characters.
- Cap rollout/conversation assistant message summaries at 500 characters.

## Implementation Gates

These gates must stay explicit in code and tests before the MVP is considered reviewable:

| Gate | Requirement |
|---|---|
| Shared sanitizer/privacy boundary | All hook, rollout, and conversation ingestion stores only safe structured metadata or redacted summaries; raw prompt, tool input, tool output, and assistant text are not persisted. Redaction happens before truncation. Summaries should preserve meaningful operation targets such as relative file paths and concise command/test labels while omitting raw payload content and noisy internal fields. |
| Canonical token/cache/cost contract | Codex `input_tokens` already includes cached input. Token rows must write canonical fields such as `total_input`, `uncached_input`, `cache_read`, `cache_creation`, `output`, and `runtime_semantics`; aggregate code must use canonical `metric_value` for total input rather than reinterpreting runtime-specific raw fields. Cache hit rate is `cached_input_tokens / input_tokens`; estimated cost charges only uncached input at input price plus cached input at cache-read price. |
| Deterministic rollout high-water dedup | Rollout ingestion advances a durable cursor by `transcript_path` and byte offset. Usage/event identities must be deterministic from rollout position (`transcript_path` plus byte offset / line), never from random UUID fallbacks. Re-collection must not duplicate metric or event rows. |
| Runtime-switch state reset | Runtime-specific state and source health must not make Claude and Codex sessions appear active at the same time after a runtime switch. The current runtime StateEngine must clear foreground state and ignore events from another runtime instead of replaying old open turns, running tools, pending permission, or active sub-agents. |
| Current-scope Codex sub-agent lifecycle | Codex sub-agent activity is reconstructed from rollout `spawn_agent`, `send_input`, `wait_agent`, and `close_agent` tool call/output events. This is part of the MVP, not deferred. |

## Current Code Baseline

Existing useful pieces:

- `src/lib/hook-installer.js` already has Codex hook install/uninstall primitives and flat-array migration support.
- `src/lib/hook-ingest.cjs` already posts hook payloads locally and spools when Dashboard is down.
- `src/lib/ingest-handler.js` already accepts the Codex hook event names used by the spike.
- `src/lib/store.js` already has runtime-aware `runtime_events`, `metric_points`, `source_health`, and aggregate helpers.
- `src/lib/metric-resolver.js` already resolves `context_pct` and `rate_limit` from `source='rollout'`.
- `hooks/pre-uninstall.js` already calls `HookInstaller.uninstall()`.

Known gaps:

- `hooks/post-install.js` still installs Claude hooks only and explicitly skips Codex.
- `HookInstaller.install()` has no test coverage for the Codex dispatch path.
- `Sanitizer` does not yet preserve safe Codex fields such as `turn_id`, `transcript_path`, `model`, and `permission_mode`.
- There is no persistent hook-derived `session_id -> transcript_path` mapping.
- There is no `CodexRolloutCollector`.
- `metric-resolver.js` does not include rollout as a source for `rate_limit_7d`.
- Codex price defaults and missing-price behavior need to be explicit.
- `src/index.js` skips Claude-only collectors on Codex but does not wire a Codex-specific collector.

## Implementation Phases

### Phase 1: Fixtures and Field Contracts

Add sanitized Codex fixtures before changing runtime behavior.

Files likely affected:

- `test/fixtures/codex/*.json`
- `test/fixtures/codex/*.jsonl`
- New or updated tests for sanitizer, hook ingestion, and rollout parsing.

Tasks:

- Create a minimal Codex hook fixture set for `SessionStart` if available, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, and `Stop`.
- Create a minimal Codex rollout JSONL fixture set for `token_count`, `task_complete`, and `response_item` function call envelopes.
- Ensure fixtures preserve `session_id`, `turn_id`, `transcript_path`, model name, permission mode, tool name, tool call IDs, token counts, context window, rate limits, TTFT, and turn duration.
- Remove or replace all raw prompts, tool arguments, tool output, emails, account IDs, file contents, and secrets.
- Document expected optional-field behavior in tests: missing optional fields should degrade, not reject the whole event.

Acceptance:

- Fixtures contain no sensitive raw content.
- Tests prove the minimum Codex field shapes expected by the MVP.
- Removing optional fields from fixture payloads still produces partial sanitized output.

### Phase 2: Hook Lifecycle and Ingestion Metadata

Finish the lifecycle path that installs Dashboard hooks when the active runtime is Codex.

Files likely affected:

- `hooks/post-install.js`
- `src/lib/hook-installer.js`
- `src/lib/sanitizer.js`
- `test/hook-installer.test.js`
- `test/post-install.test.js`
- New sanitizer or ingest tests.

Tasks:

- Change `post-install` to call `HookInstaller.install()` instead of manually installing Claude hooks only.
- Keep Claude statusline install behavior intact for Claude runtime.
- Add tests for `HookInstaller.install()` dispatching to Codex.
- Add post-install tests for Codex runtime that verify project-level `.codex/hooks.json` receives Dashboard hooks.
- Preserve safe Codex metadata in sanitized hook payloads:
  - `turn_id`
  - `transcript_path`
  - `model`
  - `permission_mode`
  - `tool_name`
  - `tool_use_id`
- Sanitize or omit filesystem paths outside the allowed locator use. `transcript_path` is allowed only as a rollout locator, not as display content.
- Use runtime-specific source health names so Codex hook health is distinguishable from generic hook health where useful.

Acceptance:

- Codex post-install creates Dashboard hook entries for the verified Codex events.
- Dashboard `post-upgrade` refreshes project-level Codex hook definitions.
- Claude post-install behavior remains covered and unchanged.
- Codex hook fixture ingestion writes `runtime_events` with `runtime='codex'` and safe metadata.
- Raw prompt and raw tool I/O are absent from stored event metadata.

### Phase 2B: Shared Privacy and Summary Contract

Apply the accepted summary boundaries consistently across hook and rollout ingestion.

Files likely affected:

- `src/lib/sanitizer.js`
- `src/lib/collectors/codex-rollout-collector.js`
- `src/lib/collectors/conversation-collector.js`
- Tests covering redaction and truncation.

Tasks:

- Keep hook `Stop.last_assistant_message` capped at 200 characters.
- Cap Codex rollout assistant message summaries at 500 characters.
- Ensure rollout assistant summaries redact API keys, bearer tokens, GitHub tokens, Slack tokens, and email addresses before truncation.
- Do not persist raw assistant text in metadata.

Acceptance:

- Tests prove redaction occurs before truncation.
- Assistant timeline summaries are useful but bounded.
- Raw assistant text is not stored in event metadata.

### Phase 3: Hook-Derived Rollout Path Registry

Persist the current rollout JSONL locator from hook metadata.

Files likely affected:

- `src/lib/store.js`
- `src/lib/ingest-handler.js`
- New small registry/helper module if useful.
- Tests for registry behavior.

Tasks:

- Add a small durable mapping for Codex rollout paths. The preferred shape is a new migration-backed table keyed by runtime/session:
  - `runtime`
  - `session_id`
  - `transcript_path`
  - `last_event_at`
  - `updated_at`
- Update the mapping when a sanitized Codex hook event has both `session_id` and `transcript_path`.
- Keep the latest mapping available after Dashboard restart.
- Validate that the path is a string path to a rollout JSONL file before persisting. Do not open or scan anything at ingestion time.

Acceptance:

- Hook ingestion updates `session_id -> transcript_path`.
- The latest mapping survives Dashboard restart because it is stored in SQLite.
- Missing `transcript_path` does not break hook ingestion.
- No Codex SQLite access is introduced.

### Phase 4: Codex Rollout Collector

Add a collector that tails only the hook-derived rollout JSONL path.

Files likely affected:

- `src/lib/collectors/codex-rollout-collector.js`
- `src/index.js`
- `src/lib/store.js`
- `src/lib/metric-resolver.js`
- Tests for collector parsing, cursors, and source health.

Tasks:

- Wire `CodexRolloutCollector` only when `config.runtime === 'codex'`.
- Read the latest stored Codex rollout mapping from the store.
- If no mapping exists, set `codex_rollout` source health to unavailable and return.
- If a mapping exists, tail that file from a stored cursor.
- Continue using the previous path until a later hook updates the mapping.
- Handle missing, truncated, rotated, or unreadable files as stale/unavailable source health without guessing another file.
- Parse only whitelisted rollout events:
  - `token_count`
  - `task_complete`
  - `response_item` function call envelopes
- Ignore message content events and unknown events by default.
- Store collector cursor durably enough to avoid duplicate metric insertion after restart. This can be a small table or a persisted fact keyed by path/session.

Metric mapping:

- `context_pct`: `last_token_usage.input_tokens / model_context_window * 100`, source `rollout`, confidence `actual`.
- `rate_limit`: primary rate limit percent, source `rollout`, confidence `actual`, dimensions include window and reset time.
- `rate_limit_7d`: secondary rate limit percent, source `rollout`, confidence `actual`, dimensions include window and reset time.
- `api_request_tokens`: token usage, source `jsonl_usage`, confidence `actual`, dimensions include input/output/cache/reasoning/model.
- `cache_hit_rate`: derived cache ratio or represented through existing token aggregate dimensions.
- `api_request_cost`: token usage multiplied by configured model prices when available.
- `ttft`: `task_complete.time_to_first_token_ms`, source `rollout`, confidence `actual`.
- `turn_duration`: `task_complete.duration_ms`, source `rollout`, confidence `actual`.
- `tool_calls` / `tool_duration`: use rollout function-call envelopes only for safe metadata and timing support; hooks remain the primary live source.

Acceptance:

- With a hook-derived mapping and fixture JSONL, collector writes the expected metric points.
- With no mapping, collector reports unavailable and does not scan `~/.codex/sessions`.
- With no new events, collector keeps the same path and reports stale/idle based on freshness.
- With truncated or missing files, collector does not crash and does not choose another path.
- `rate_limit_7d` resolves from rollout data.

### Phase 4B: Codex Sub-agent Lifecycle MVP

Reconstruct Codex sub-agent state from rollout tool events because Codex 0.130 hooks do not expose `SubagentStart` / `SubagentStop`.

Files likely affected:

- `src/lib/collectors/codex-rollout-collector.js`
- `src/lib/state-engine.js` only if the existing canonical events are insufficient.
- Tests for spawn, wait, send-input, and close behavior.

Tasks:

- Track `spawn_agent` function call arguments by `call_id` only long enough to summarize the request.
- On successful `spawn_agent` output, emit canonical `subagent_start` with `agent_id`, `agent_type`, and a redacted bounded description.
- Preserve spawn output nickname/name metadata when available so the existing active sub-agent row can show a recognizable label.
- On `send_input`, emit a bounded canonical `subagent_update` that marks the target agent active without storing the raw message.
- On `wait_agent` call/output, emit canonical `subagent_update` for waiting or timed-out status; do not treat timed-out waits as completion.
- On `wait_agent` output with completed status, emit canonical `subagent_stop` with a redacted bounded completion summary when available.
- On `close_agent` call or output, emit canonical `subagent_stop`.
- Preserve `send_input` target metadata so timeline/tool feed can attribute parent-to-subagent communication without storing raw message content.
- Keep the UI within existing Current Activity / Timeline components: show meaningful labels such as nickname, agent type, status, last activity, and concrete tool/file targets; avoid new Codex-only panels or raw internal JSON.
- Use deterministic ingest IDs so re-reading the same rollout events does not duplicate lifecycle events.

Acceptance:

- Active sub-agents appear through the existing StateEngine `active_subagents` output.
- Active sub-agent rows include useful status/last-activity fields without exposing raw sub-agent prompts.
- Completed or closed sub-agents are removed through canonical `subagent_stop`.
- Timed-out `wait_agent` events keep the sub-agent active and mark it waiting.
- `send_input` does not persist raw sub-agent prompt/message content.
- Duplicate collection does not create duplicate sub-agent lifecycle events.

### Phase 5: Cost and Resolver Behavior

Make Codex cost behavior clear and avoid invented values.

Files likely affected:

- `src/lib/config.js`
- `src/lib/collectors/codex-rollout-collector.js`
- `src/lib/collectors/conversation-collector.js` if price helper extraction is useful.
- `src/lib/metric-resolver.js`
- Tests for missing and present price entries.

Tasks:

- Reuse or extract the existing Claude price calculation pattern instead of duplicating incompatible logic.
- Add initial Codex/OpenAI model price defaults only if the repository already owns default price tables in config; otherwise document and implement missing-price behavior.
- When a model price is missing, write token metrics normally and skip cost metrics or mark cost unavailable through dimensions/source health.
- Ensure cost confidence is `estimated` or otherwise clearly labeled, because Codex rollout provides tokens but not billed cost.

Acceptance:

- Known-price fixture creates `api_request_cost`.
- Unknown-price fixture does not invent dollars.
- Token and cache metrics still appear when cost is missing.

### Phase 6: Wiring, API, and Runtime Presentation

Make the Codex data visible through existing Dashboard APIs without a broad frontend rewrite.

Files likely affected:

- `src/index.js`
- `src/lib/metric-resolver.js`
- Potentially `src/lib/http.js` if an API response needs Codex capability metadata.
- Minimal frontend changes only if existing Codex degraded behavior hides newly supported data.

Tasks:

- Add the Codex collector to the collector registry.
- Ensure startup runs the initial Codex rollout collection after state engine initialization or after hook replay, whichever makes the mapping available.
- Ensure existing metric endpoints return Codex context/rate/token/cache/cost/TTFT/turn duration values.
- Adjust Codex degraded/capability display only where existing UI suppresses metrics that are now supported.
- Keep Claude-only panels hidden on Codex.

Acceptance:

- Dashboard in Codex runtime shows PM2/system/C4/scheduler as before.
- After hook ingestion, agent/tool state becomes available.
- After rollout JSONL collection, context/rate/token/cache/cost/TTFT metrics become available or explicitly degraded.
- Claude runtime tests and behavior do not regress.

## Test Plan

Run during development:

- `npm run check`
- `npm test`

Targeted tests to add or update:

- Hook installer Codex dispatch and post-install behavior.
- Sanitizer Codex metadata preservation and raw content stripping.
- Ingest handler updates rollout path mapping from safe hook metadata.
- Codex rollout collector no-mapping behavior.
- Codex rollout collector fixture parsing.
- Cursor behavior for repeated collection.
- Missing/truncated rollout file behavior.
- Metric resolver `rate_limit_7d` rollout source.
- Cost behavior for known and unknown models.

Final self-acceptance:

- Run `npm run check`.
- Run `npm test`.
- Run `npm run smoke`.
- Run `npm run smoke:api` if the local environment can start the server without conflicting with the active component.
- Inspect `git diff --check`.
- Manually review the diff for raw prompt/tool output leakage.
- Confirm no code path reads Codex SQLite or scans `~/.codex/sessions` for active-session discovery.

## Review Checklist

Before asking Howard for review:

- The implementation plan is committed or included in the PR.
- Every phase completed in code has matching tests.
- The branch is based on latest `origin/main`.
- The working tree has no accidental changes outside the planned files.
- `spike/` remains untracked historical evidence and is not included unless explicitly needed as sanitized fixtures.
- Any production hook install is only through lifecycle code, not manual modification of live `.codex/hooks.json`.
- The final PR description calls out:
  - no OTLP dependency,
  - no Codex SQLite access,
  - hook `transcript_path` as the rollout source,
  - sensitive data handling,
  - test results.
