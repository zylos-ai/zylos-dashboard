# Development plan: optional read-only terminal Observer

Status: implementation authorized; revised plan pending independent review. Stage A is an isolated feasibility gate; B/C cannot begin until its concrete mechanisms and evidence are accepted.
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
2. Persist desired `observer.enabled` in config.json separately from verified artifact truth. Replace the relevant independent whole-file read/modify/write paths with one shared config mutation helper used by Observer, Settings, Fleet, and configure. Each transaction rereads under a bounded cross-process lock, changes only its fields, writes a unique temporary file, and atomically renames; do not hold this lock over downloads or process teardown. Invalid existing JSON fails without replacing unrelated configuration. Prove stale-lock recovery and overlapping CLI/server writes. Installation completion must be proved by verified artifact/version, not solely by a boolean in config. Default install/upgrade hooks never download or enable Observer, including when an existing installation needs a newer supported artifact.
3. Pin Zellij 0.45.1 candidate artifacts from official zellij-org/zellij Releases. Before shipping, verify exact artifacts/checksums, licensing, and the Web client/read-only protocol for each supported platform. Do not resolve `latest` during installation. No arbitrary download URL, version, executable path, shell command, or platform string from the browser.
4. Download to bounded temporary files beneath the producer's managed Dashboard data subtree. The shipped manifest pins both archive SHA256 and extracted-binary SHA256: official `.sha256sum` files cover the binary, not its compressed archive. Check both before execution; bundle MIT license attribution because the upstream archive contains only the executable. Reject unsafe archive entries and symlink escapes; stage and atomically publish only the expected binary. Preserve an existing working binary if a replacement fails. Bound download size/time and coalesce concurrent installation attempts. Every lifecycle operation uses one producer-wide coordinator, an operation generation, and unique staging; late completion must check its generation before publishing an artifact or changing desired state. Status and every start revalidate the owned manifest, regular-file/no-symlink identity, version, and binary digest. Publish the verified artifact before setting enabled; if enabling fails it remains installed-but-disabled.
5. Use separate private config, cache, data, temporary-log, and session-socket roots (0700), sensitive metadata (0600), and executable (0755). Use direct argv invocation, never remote shell scripts or `shell:true`. Run without sudo or system package-manager changes. Installation failures must not change unrelated files/config.
6. **Disable** persists disabled, invalidates leases, and stops the owned generation while retaining downloaded artifacts. **Uninstall** first disables/stops, then removes only managed Observer artifacts. It must not delete a user/system Zellij or the Agent's tmux session. The producer coordinator covers install/update/enable/disable/UI uninstall/first-lease start. Disable/uninstall durably persist disabled first, fence starts/leases and obsolete operation generations, revoke access, prove all owned processes/listeners stopped, then remove only manifest-owned files for uninstall. A persistence failure stops removal and reports failure; it cannot claim durable disable. Failed removal remains durably visible after restart and the feature remains disabled. Component pre-uninstall must enter the same bounded teardown/revocation protocol while PM2 may still be running; a durable teardown fence prevents new leases until removal/reinstallation is resolved. The crash-containment mechanism remains the fallback; removing hooks alone is insufficient. No changes to Core uninstall ordering.
7. Fleet installation runs on the selected producer. The consumer never reports its own binary as the remote Agent's installation. Old producers return a stable unsupported state. Reuse admin Fleet identity; read-scoped keys cannot install, enable, lease, or proxy Observer.
8. Do not expose internal binary paths, tokens, or download command lines in product controls. Display target Agent, supported version, progress/state, and actionable safe failure reasons.

## Runtime and security contract

Retain the full #297 contract, particularly:

- One shared generation; start coalescing and generation guards; defaults maxViewers=4, leaseTtlMs=30000, idleGraceMs=5000.
- A lease is not a credential: normal admin identity on every HTTP/WS hop; bind lease to principal, target, and generation. Use one canonical auth context for HTTP and upgrade: `{kind, principalId, scope}` derived from live validated credentials. Cookie principal is its server-side session hash; API/Fleet principal is stable `api_key_id`, not a rotating bearer hash and never just scope. Store no plaintext credential in a lease. Revalidate expiry/revocation on requests and the active-stream policy defined in A; API token refresh under the same key retains identity, a different key cannot use the lease. Consumer leases additionally bind the local browser principal and selected producer before forwarding under its Fleet key. When auth is disabled, all Observer management/lease/stream routes fail closed with `auth_required`, and the UI explains authentication is required; no anonymous admin principal. Browser-cookie mutations and WS require exact expected Origin; trusted bearer Fleet hops follow an explicit separate path.
- Only loopback internal listeners; dedicated observer Zellij config/cache/data/socket roots; no access to unrelated Zellij sessions. Never forward internal auth cookies/tokens to the browser.
- Double read-only enforcement: Zellij read-only watcher plus allowlisted `tmux attach-session -r`. Never create/replace the Agent's `claude-main` or `codex-main` session.
- Presets only (80x21 / 110x30 / 140x40); newest accepted preset shared and broadcast. Tampered clients cannot send input or alter Agent session dimensions outside the intended read-only policy.
- WebSocket ping/pong and server expiry are authoritative; background browser visibility alone is not an app-tab exit. Pagehide is best effort, never sole cleanup.
- Bounded graceful/force termination under the stage-A containment mechanism; late callbacks fenced by generation. A process-group kill alone is insufficient: Unix Zellij session servers double-fork and daemonize, and shutdown commands do not acknowledge full exit. Stage A must select and prove containment of detached descendants and a crash guardian that also terminates itself after cleanup. No product Observer generation may start on an unproved platform; Windows remains unsupported. No global PM2/Caddy change or sudo is allowed.
- Exact local/Fleet route allowlists; authenticate before allocation/upgrade; preserve root and `/dashboard` deployment prefixes. No generic proxy, raw terminal logging, recording, or scrollback persistence.
- Bounded bodies, handshakes, startup, shutdown, buffers, viewers, and retries. Child failure closes its leases and streams; explicit retry starts a new generation.

## Work sequence and checks

### A. Verify the external integration before building around it

This stage produces isolated probes and a concrete mechanism record, not product implementation. Luna accepts that evidence after independent review before B. An unresolved trust-domain, containment, or protocol gate means stop and revise the design, not continue behind an optimistic assumption.

**Browser trust domain.** The privileged code is a small Dashboard-owned, audited broker. Do not execute the upstream Zellij Web bundle or terminal parser in the Dashboard administrator origin. The candidate is a self-contained renderer in an opaque sandboxed iframe (`allow-scripts`, no `allow-same-origin`, forms, popups, or top navigation) with a restrictive CSP denying network connections. The broker alone performs authenticated same-origin Observer HTTP/WS requests and transfers bounded display data over a dedicated MessageChannel. Validate the frame/window and channel during setup; do not trust `Origin: null` as identity. The bridge has an explicit message schema and size/rate limits, supports only rendering/lifecycle and the three presets, and accepts no URL, request method, headers, script, arbitrary command, or credential request. All terminal decoding/rendering of untrusted content stays inside the frame; the broker never inserts terminal text as HTML.

This preserves #297's normal-admin-per-network-hop requirement: the browser broker authenticates to the local/consumer Dashboard, and the consumer uses its normal admin Fleet identity to the producer. The iframe has no independent network capability or upstream token. A MessageChannel and lease ID do not substitute for Dashboard auth. Same-origin CSP/HttpOnly/Origin checks alone do not isolate an upstream bundle. Stage A must prove compatibility with the pinned watcher protocol without granting the frame administrator authority. If this cannot work without a large client fork or a changed auth/deployment contract, return the concrete tradeoff for review before B; no silent dedicated-origin or capability-only fallback.

**Crash containment.** Select a mechanism that contains daemonized descendants on each claimed OS/architecture, records exact ownership, and reacts to abrupt Dashboard death independently of its shutdown handler. Evaluate unprivileged containment/subreaper + parent-liveness guardian in the isolated probe; naming a technique is not proof. Capture PID/PPID/PGID/SID and process start identities, per-generation socket root/session/port, and independent config/cache/data roots. `ZELLIJ_SOCKET_DIR` isolates sockets only: token DB uses ProjectDirs data_dir and metadata uses cache directories. Prove the actual runtime uses all private roots, not the user's existing token database or session registry. Also isolate the system-temp-derived Zellij log root and verify no terminal content or credentials are written there. Safe cleanup must not rely on broad process-name searches or PID alone.

In an isolated harness with an active viewer, SIGKILL the harness parent standing in for Dashboard and prove within **10 seconds** that every owned web/session/PTY/wrapper/guardian process and listener is gone; unrelated Zellij and sentinel Agent tmux must survive. Repeat harness-level graceful stop and guardian restart/reconciliation, ending with a stopped harness and zero owned survivors. A proves the containment mechanism only; it does not implement or claim coverage of product lease, disable, hook, or restart wiring. Disable the containment/guardian in a known-bad probe and show the detector catches the escaped daemon; clean up only the exact captured test processes. Record measured timing and reconcile zero survivors across the whole ownership set. If the 10-second bound or zero inactive footprint cannot be met, report the failed gate. Untested platforms remain unsupported rather than inheriting a portability claim.

- [ ] Download only into an isolated test workspace; record official artifact URL, SHA256, license, OS/architecture, and version output.
- [ ] Reproduce watcher + tmux read-only rendering through the audited broker and opaque frame, including assets and WebSocket paths. Inject known-bad iframe code attempting a non-Observer admin mutation both directly and through forged bridge messages: both must fail without changing sentinel settings. A direct authenticated parent control must demonstrate the test mutation can otherwise succeed.
- [ ] Demonstrate private upstream token handling with a real browser, no token/cookie escape, and sentinel input rejection with a positive control proving the sentinel can change through an intentionally interactive test client.
- [ ] Verify process ownership/teardown, the 10-second abrupt-death bound, and supported-platform strategy. Mark untested platforms unsupported instead of claiming parity. Escalate any scope change rather than silently dropping local/Fleet or either runtime.

### B. Implement installation and local lifecycle

The accepted A record must name the mechanism, executable/dependency ownership, platform support, stream reauthorization interval, exact route allowlist, and measured failure bounds. Prototype success is not approval for production enablement. Lifecycle helper/hook calls must join the running producer coordinator through a private bounded control channel, or take exclusive offline ownership only after proving the producer absent; two coordinators may never publish concurrently.

- [ ] Installer/status/config validation, permissions, atomic staging, retry and disable/uninstall serialization; no automatic downloads in lifecycle hooks.
- [ ] Manager, allowlisted wrapper, lease/generation state machine, capacity and teardown.
- [ ] Canonical HTTP/upgrade auth context; session/key principal, same-key refresh and wrong-key rejection; auth-disabled fail closed; exact routes and broker/frame security boundary.
- [ ] Tests for successful install, checksum/archive failure, unsupported platform, concurrent first install, install-uninstall races, restart during partial installation, and preservation of existing artifacts. Include concurrent Settings/Fleet/configure writes, invalid config, manifest/digest tampering, symlink substitution, config-enable failure after artifact publish, durable failed-removal restart, and component pre-uninstall during active viewing; default install/upgrade hooks have explicit no-download/no-enable negative tests.
- [ ] After product wiring is implemented, apply the same whole-ownership-set survivor oracle from A to real last-lease teardown, disable, component pre-uninstall, and Dashboard restart, including abrupt death. Prove these entry points invoke the accepted containment mechanism; harness-only evidence does not satisfy B.
- [ ] All local lifecycle/race/fault/rejection cases from #297.

### C. Integrate Fleet and UI

The producer lease response is route-neutral: lease ID, expiry, presets, and a validated relative embed resource identifier, never a public origin or forwarded prefix. The local/consumer boundary constructs browser paths from its configured base and selected encoded Agent. Do not let forwarded-prefix headers construct producer resource paths. HTTP and upgrade share one canonical parser with decode-once and traversal/encoded-separator rejection; no independent normalization implementations.

| Browser deployment | Lease API | Embed/assets/WS namespace |
| --- | --- | --- |
| Root, local | `/api/observer/leases` | `/observer/<resource>` |
| `/dashboard`, local | `/dashboard/api/observer/leases` | `/dashboard/observer/<resource>` |
| Root, Fleet | `/fleet/<encoded-agent>/api/observer/leases` | `/fleet/<encoded-agent>/observer/<resource>` |
| `/dashboard`, Fleet | `/dashboard/fleet/<encoded-agent>/api/observer/leases` | `/dashboard/fleet/<encoded-agent>/observer/<resource>` |

`<resource>` is a closed, implementation-defined allowlist of embed/assets/WS paths, not arbitrary proxy suffixes. Freeze the exact entries in A's protocol record and test every entry in all four rows. The consumer forwards only normalized producer-relative paths; the producer never receives a consumer Fleet/base prefix as resource authority. Test remote 401 refresh, malicious forwarded prefixes, encoded Agent names and all HTTP/upgrade rejection cases through the real two-hop chain.

- [ ] Producer-owned remote status/install/enable/disable/uninstall and lease operations; admin-only narrow WS path.
- [ ] Settings target/state/progress/retry controls; bilingual strings; Observer tab and shared preset controls.
- [ ] App tabs, history/popstate, fleet wall, Agent switch, pagehide and reconnect all close the old viewer and cannot revive old leases.
- [ ] Mobile/desktop layout; CSS and JS cache-busting consistent with repo conventions.
- [ ] Real consumer→producer HTTP/WS round trips, admin/read keys, expired token refresh, disconnect/restart and old-producer behavior.

### D. Independent review and delivery

- [ ] `npm run check`, `npm test`, isolated startup and API smoke pass. Clear inherited CLAUDE_SESSION_ID/CODEX_SESSION_ID for tests requiring a clean service environment; report this explicitly.
- [ ] Run the complete #297 positive/reject/fault matrix against isolated services and sentinel tmux sessions on an isolated tmux socket. Never point mutation tests at an actual Agent main session or production DB.
- [ ] Re-run B's real last-lease/disable/component pre-uninstall/Dashboard restart survivor checks during final isolated acceptance; retain the same oracle and failure bounds used in A.
- [ ] Capture desktop/mobile local/remote screens, installation/permission failures, before/active/after process trees/listeners, disk, RSS/PSS, teardown durations and rejected-input evidence.
- [ ] Add operator-facing installation/disable/uninstall documentation and Unreleased changelog. No feature-PR version bump.
- [ ] Jinglever implements under his own GitHub identity; Luna and an independent reviewer review final code/evidence. Plan review precedes implementation; Luna handles intermediate gates already delegated by Howard.
- [ ] Remove this temporary dev plan before final merge; retain the durable module/operator contract. Deliver PR and evidence to Howard for final acceptance. Do not merge/release/deploy/enable on production as part of development.

## Assumptions to prove

- Zellij Web 0.45.1 watcher protocol works with the Dashboard-owned broker and opaque renderer while all upstream credentials stay server-side. This is a hard stage-A feasibility gate, not a claim already verified.
- Dedicated config/cache/data/socket roots actually exclude other local sessions and token metadata; read-only tokens alone are not assumed to be per-session capabilities.
- The chosen subprocess topology can reap descendants on abrupt Dashboard death on each claimed platform.
- Existing Fleet token-refresh and path normalization can be reused without broadening proxy targets or leaking tokens.
- The OS/architecture has a tested upstream artifact. Fixed/active memory numbers in #297 are acceptance targets to measure, not guarantees already established.


## Evidence anchors for the revised plan

Baseline code facts were checked against v0.5.5: `src/lib/auth.js` currently exposes boolean cookie validation and scope-only API validation, `src/index.js` and `hooks/configure.js` independently rewrite config, and `hooks/pre-uninstall.js` currently only removes runtime hooks. The changes above are target contracts, not existing behavior.

Pinned upstream source evidence (actual containment/browser probes remain outstanding):

- [Unix client double-fork](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-client/src/lib.rs#L459) and [server daemonization](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-server/src/lib.rs#L863).
- [Token database location](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/web_authentication_tokens.rs#L62) and [cache metadata](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/consts.rs#L92), with [socket and temporary-log roots](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/consts.rs#L333).
- [Release archive/checksum construction](https://github.com/zellij-org/zellij/blob/v0.45.1/.github/workflows/release.yml#L114) and [MIT license](https://github.com/zellij-org/zellij/blob/v0.45.1/LICENSE.md). Stage A still verifies the downloaded artifacts themselves.
