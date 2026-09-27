# Observer history implementation validation

Validated against base `a3f3858` (Dashboard PR #304), using synthetic credentials
and sanitized runtime-format fixtures. This is S2 implementation evidence;
independent review and post-release installation acceptance remain separate.

## Automated checks

- Full suite: **859/859 passed** with
  `env -u CLAUDE_SESSION_ID -u CODEX_SESSION_ID npm test`.
  The two session-ID variables are removed because the pre-existing state-engine
  fallback test otherwise reads the surrounding agent's active session.
- `npm run check` and `git diff --check` passed.
- Production parser → history service → redactor tests recover full C4 messages,
  Claude persisted tool output and Codex aggregated command output. Segments
  reconstruct the complete redacted source, including Unicode and credentials
  crossing the 256 KiB boundary.
- Read-only fixture files/directories retain their hashes and modification times.
  Path tests reject traversal, foreign paths, symlinks and transcript replacement
  with a symlink. Index tests cover incomplete tails, growth during reads,
  replacement, 17 MiB records, deferred PDF expansion and LRU retention.
- API tests cover no-auth/read/admin admission, enabled gating, every text output,
  content headers, stable paging, internal records, search, and late tool updates.
  An injected terminal/lease operation throws if history touches it.
- Fleet tests exercise all four allowlisted GET routes, admin scope and the
  retained response leak guard.
- Negative controls remove queued-command handling, remove L2 detection and
  bypass service redaction. Each is rejected by its corresponding acceptance
  predicate; the unchanged implementations pass.
- Pinned rule generation is byte-reproducible. The dedicated 1,016,000-byte
  adversarial regex fixture took **13.468 ms**, below the 200 ms threshold.
  Large-worker output equivalence, zero-deadline fail-closed behavior and known
  value reload/failure are tested.

## Browser checks

Actual shipped HTML/JS/CSS ran in isolated Chromium with synthetic HTTP APIs.
Eight cases cover 1440 px and 390 px, English and Chinese, and light/dark OS
preferences. Dashboard currently ships only the light theme; dark preference
therefore validates that supported theme, not an invented dark theme.

All cases had no document overflow or page errors. The terminal iframe, its
window and its source remained identical across view toggles; lease acquisition
counts did not increase. Interactions checked 300 KB exact full-text loading,
search-to-entry, older pagination, session switching, internal visibility, late
updates, and stopping polling when leaving Observer. Hidden-document handling
was exercised with a simulated visibility event in headless Chromium.

![Desktop history with synthetic data](images/observer-history-desktop.png)

![Chinese mobile history with synthetic data](images/observer-history-mobile.png)

## Scope and remaining acceptance

The bundled selection uses all 221 Gitleaks text rules (222 definitions including
the inapplicable path-only rule) and six additional high-confidence Betterleaks
vendor rules. Mistral and Lark lack the selected confidence/prefix properties;
known-value and structural credential detection still cover their secret fields.
Exact provenance and selected filter semantics are documented beside the rules.

Oversized JSONL lines are deferred until explicit expansion, including when
searching. Binary content, encoded credentials and live terminal redaction remain
outside textual history redaction. No show-original endpoint exists.

No release, deployment or live runtime modification was performed. S4 still
requires the agreed installed-instance checks: real Claude/Codex record matching,
C4 and full-output comparison, polling and redaction, remote Fleet, read-token
rejection, and unchanged agent/tmux state during use.
