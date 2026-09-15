# Development plan: optional read-only terminal Observer

Status: implementation authorized; plan pending independent review.
Baseline: v0.5.5. Feature authority: [Issue #297](https://github.com/zylos-ai/zylos-dashboard/issues/297), with Howard's subsequent installation decision below.

## Goal and accepted scope

An administrator can watch the selected Agent's terminal from Agent detail without controlling it. Both local and Fleet detail are in scope. Dashboard keeps working if Observer installation or operation fails.

Howard approved shipping the small Observer integration with Dashboard while downloading Zellij only after an explicit administrator action. He then authorized starting this next phase after v0.5.5 was released and deployed. This is not a general plugin system or a separately managed PM2 service. Production enablement, merge, and release remain separate from development and isolated acceptance.

Issue #297 owns the detailed lease, proxy, authorization, resource, and test requirements. This plan adds the installation lifecycle and organizes implementation; it does not weaken the issue's acceptance criteria. The issue's POC measurements and compatibility statements are reported evidence, not yet independently reproduced by this implementation.

## Experience and component boundaries

Default installation shows a lightweight Settings entry for terminal observation. It downloads no Zellij, starts no Observer child, and opens no Observer listener. The Observer app tab appears only when the selected producer has a verified installation and is enabled.

An administrator opens the selected Agent's Settings, sees the installation target, and selects **Install and enable**. The producer downloads and validates the pinned binary, records successful installation, and enables the feature. Installation alone does not start a terminal: entering Observer acquires the first viewer lease. Leaving the app tab releases it; the last lease triggers bounded teardown after grace.

- **Dependency installer:** platform/artifact allowlist, fixed version and trusted checksums, progress, atomic installation, retry, removal, and filesystem ownership.
- **Observer manager:** one process generation per producer, leases, tmux wrapper, resource limits, and complete teardown.
- **Observer HTTP/WS adapter:** admin identity, browser-origin checks, lease binding, narrow routes, private upstream credentials, and bounded streams.
- **Fleet adapter:** selected-producer installation/status/lifecycle forwarding and Observer-only WebSocket forwarding with producer-side reauthorization.
- **UI:** installation controls and status in Settings; Observer tab activation/exit integrated with existing app history and local/remote selection.

Use focused modules following current ESM/vanilla-JS conventions. Add a narrowly scoped WebSocket dependency only if needed after assessing Node's available primitives; do not build a general plugin loader or arbitrary tunnel.

## Installation contract (supplements #297)

Installation state and runtime state are separate:

| Installation state | Available action | Runtime implication |
| --- | --- | --- |
| not installed | Install and enable | No process or listener |
| installing | View bounded progress | No terminal process |
| installed, disabled | Enable or uninstall | No process or listener |
| installed, enabled | Open Observer, disable, uninstall | Processes only with leases |
| failed / unsupported / incompatible | Retry where supported | Dashboard stays available |

1. Status and installation-management endpoints are admin-only and remain reachable while disabled. This is an intentional refinement of #297's blanket disabled-route 404 rule: streaming and lease endpoints remain unavailable until installed and enabled. Status must distinguish unavailable permissions from not installed.
2. Use the existing Settings/config persistence pattern for `observer.enabled`. Installation completion must be proved by verified artifact/version, not solely by a boolean in config. Default install/upgrade hooks never download or enable Observer, including when an existing installation needs a newer supported artifact.
3. Pin Zellij 0.45.1 candidate artifacts from official zellij-org/zellij Releases. Before shipping, verify exact artifacts/checksums, licensing, and the Web client/read-only protocol for each supported platform. Do not resolve `latest` during installation. No arbitrary download URL, version, executable path, shell command, or platform string from the browser.
4. Download to bounded temporary files beneath the producer's managed Dashboard data subtree. Check the expected digest from the shipped manifest before extraction/execution. Reject unsafe archive entries and symlink escapes; stage and atomically publish only the expected binary. Preserve an existing working binary if a replacement fails. Bound download size/time and coalesce concurrent installation attempts.
5. Use private runtime/config directories (0700), sensitive metadata (0600), and executable (0755). Use direct argv invocation, never remote shell scripts or `shell:true`. Run without sudo or system package-manager changes. Installation failures must not change unrelated files/config.
6. **Disable** persists disabled, invalidates leases, and stops the owned generation while retaining downloaded artifacts. **Uninstall** first disables/stops, then removes only managed Observer artifacts. It must not delete a user/system Zellij or the Agent's tmux session. Serialize install/disable/uninstall so a late download cannot re-enable an uninstalled feature. A failed removal is visible and leaves the feature disabled.
7. Fleet installation runs on the selected producer. The consumer never reports its own binary as the remote Agent's installation. Old producers return a stable unsupported state. Reuse admin Fleet identity; read-scoped keys cannot install, enable, lease, or proxy Observer.
8. Do not expose internal binary paths, tokens, or download command lines in product controls. Display target Agent, supported version, progress/state, and actionable safe failure reasons.

## Runtime and security contract

Retain the full #297 contract, particularly:

- One shared generation; start coalescing and generation guards; defaults maxViewers=4, leaseTtlMs=30000, idleGraceMs=5000.
- A lease is not a credential: normal admin identity on every HTTP/WS hop; bind lease to principal, target, and generation. Browser-cookie mutations and WS require exact expected Origin; trusted bearer Fleet hops follow an explicit separate path.
- Only loopback internal listeners; dedicated observer Zellij runtime/config; no access to unrelated Zellij sessions. Never forward internal auth cookies/tokens to the browser.
- Double read-only enforcement: Zellij read-only watcher plus allowlisted `tmux attach-session -r`. Never create/replace the Agent's `claude-main` or `codex-main` session.
- Presets only (80x21 / 110x30 / 140x40); newest accepted preset shared and broadcast. Tampered clients cannot send input or alter Agent session dimensions outside the intended read-only policy.
- WebSocket ping/pong and server expiry are authoritative; background browser visibility alone is not an app-tab exit. Pagehide is best effort, never sole cleanup.
- Process-group shutdown, bounded graceful/force termination, late callbacks fenced by generation. Explicitly test Dashboard abrupt termination: document and implement the mechanism preventing detached descendants surviving parent death; a normal shutdown handler alone is insufficient.
- Exact local/Fleet route allowlists; authenticate before allocation/upgrade; preserve root and `/dashboard` deployment prefixes. No generic proxy, raw terminal logging, recording, or scrollback persistence.
- Bounded bodies, handshakes, startup, shutdown, buffers, viewers, and retries. Child failure closes its leases and streams; explicit retry starts a new generation.

## Work sequence and checks

### A. Verify the external integration before building around it

- [ ] Download only into an isolated test workspace; record official artifact URL, SHA256, license, OS/architecture, and version output.
- [ ] Reproduce watcher + tmux read-only embedding through an authenticated Dashboard-style prefix, including required assets and WebSocket paths.
- [ ] Demonstrate private upstream token handling with a real browser, no token/cookie escape, and sentinel input rejection with a positive control proving the sentinel can change through an intentionally interactive test client.
- [ ] Verify process ownership/teardown and supported-platform strategy. Mark untested platforms unsupported instead of claiming parity. Escalate any scope change rather than silently dropping local/Fleet or either runtime.

### B. Implement installation and local lifecycle

- [ ] Installer/status/config validation, permissions, atomic staging, retry and disable/uninstall serialization; no automatic downloads in lifecycle hooks.
- [ ] Manager, allowlisted wrapper, lease/generation state machine, capacity and teardown.
- [ ] Admin/origin/principal boundary and exact HTTP/WS proxy routes.
- [ ] Tests for successful install, checksum/archive failure, unsupported platform, concurrent first install, install-uninstall races, restart during partial installation, and preservation of existing artifacts.
- [ ] All local lifecycle/race/fault/rejection cases from #297.

### C. Integrate Fleet and UI

- [ ] Producer-owned remote status/install/enable/disable/uninstall and lease operations; admin-only narrow WS path.
- [ ] Settings target/state/progress/retry controls; bilingual strings; Observer tab and shared preset controls.
- [ ] App tabs, history/popstate, fleet wall, Agent switch, pagehide and reconnect all close the old viewer and cannot revive old leases.
- [ ] Mobile/desktop layout; CSS and JS cache-busting consistent with repo conventions.
- [ ] Real consumer→producer HTTP/WS round trips, admin/read keys, expired token refresh, disconnect/restart and old-producer behavior.

### D. Independent review and delivery

- [ ] `npm run check`, `npm test`, isolated startup and API smoke pass. Clear inherited CLAUDE_SESSION_ID/CODEX_SESSION_ID for tests requiring a clean service environment; report this explicitly.
- [ ] Run the complete #297 positive/reject/fault matrix against isolated services and sentinel tmux sessions on an isolated tmux socket. Never point mutation tests at an actual Agent main session or production DB.
- [ ] Capture desktop/mobile local/remote screens, installation/permission failures, before/active/after process trees/listeners, disk, RSS/PSS, teardown durations and rejected-input evidence.
- [ ] Add operator-facing installation/disable/uninstall documentation and Unreleased changelog. No feature-PR version bump.
- [ ] Jinglever implements under his own GitHub identity; Luna and an independent reviewer review final code/evidence. Plan review precedes implementation; Luna handles intermediate gates already delegated by Howard.
- [ ] Remove this temporary dev plan before final merge; retain the durable module/operator contract. Deliver PR and evidence to Howard for final acceptance. Do not merge/release/deploy/enable on production as part of development.

## Assumptions to prove

- Zellij Web 0.45.1 assets, authentication and watcher protocol work behind a private same-origin adapter without browser exposure of internal credentials.
- A dedicated Zellij runtime actually excludes other local sessions; read-only tokens alone are not assumed to be per-session capabilities.
- The chosen subprocess topology can reap descendants on abrupt Dashboard death on each claimed platform.
- Existing Fleet token-refresh and path normalization can be reused without broadening proxy targets or leaking tokens.
- The OS/architecture has a tested upstream artifact. Fixed/active memory numbers in #297 are acceptance targets to measure, not guarantees already established.
