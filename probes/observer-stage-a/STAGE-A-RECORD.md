# Observer Stage A mechanism record

Status: isolated feasibility gate passed on `darwin-arm64`; intermediate acceptance is still required before Stage B. This record makes no product-lifecycle, Fleet, release, or deployment claim.

## Pinned inputs and ownership

- Zellij: official `v0.45.1` Darwin arm64 release archive, acquired only in the isolated runtime workspace from `https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-aarch64-apple-darwin.tar.gz`.
- Archive SHA256: `c029ba4fe1927b79ad9f0cdd59155c4dff80777863c85857d4d09b88b56f9891`.
- Extracted `zellij` SHA256: `ca5f9333735bdbc59a621f1d8ed8e24798845302a28ff175d253d4793d5a4a2c`, matching the official `.sha256sum`; version output is `zellij 0.45.1`.
- The archive contains only `zellij`. Product packaging must retain the upstream Zellij MIT notice separately.
- Renderer: the `@xterm/xterm` 5.5.0 JavaScript and CSS already vendored in pinned Zellij source. Their embedded MIT headers must remain intact. Probe SHA256 values are `dcad74eddc249c9be1ff62ba66b58584418ce1a10727d1879461adc1311c9780` and `a396d0aa1f91733337c046445e1a610e93a5ca6b2ce37353dca07bcf48091691`.
- Production ownership decision: Dashboard owns the verified executable, license notices, renderer assets, private runtime roots, broker, guardian, and all teardown. No system Zellij, global Caddy route, PM2 service, package-manager install, or user token database is used.

## Browser and protocol mechanism

The browser-facing parent is Dashboard-owned code. It authenticates normally to Dashboard and receives display bytes from a narrow broker. Only the broker logs into the loopback Zellij listener, creates the watcher for the already-existing allowlisted session, and opens upstream `/ws/control` and `/ws/terminal/<session>` with its private cookie.

The terminal parser/renderer runs in `sandbox="allow-scripts"` without `allow-same-origin`. Its CSP is `default-src 'none'; connect-src 'none'`; the frame receives no URL, method, headers, command, lease credential, upstream token, or cookie. The parent validates the exact `contentWindow` during one-time setup and then transfers a dedicated `MessagePort`. The accepted parent-to-frame schema is limited to:

- `{type: "render", bytes: ArrayBuffer}`: at most 256 KiB per message and 100 messages/second in the probe; the parent keeps at most 1 MiB of bounded replay data.
- `{type: "preset", preset: "80x21" | "110x30" | "140x40"}`.
- `{type: "shutdown"}`.

The frame-to-parent schema is limited to `ready` and the isolated probe result. The parent processes at most 20 frame messages/second and rejects messages over 4 KiB using an explicit structured-clone size walk. It counts an `ArrayBuffer` at its full `byteLength` and an `ArrayBufferView` at the full size of its backing buffer, rather than the view slice or JSON text length. Unknown window or port messages are ignored and counted. Terminal bytes enter only `xterm.write(Uint8Array)` inside the opaque frame; the parent never inserts terminal content as HTML. This is a post-structured-clone processing and retention gate, not a hard resource bound: the browser has already allocated the clone before the handler runs, and `Object.entries` can materialize and scan an arbitrarily wide object (for example, 100,000 keys) before the accumulated size crosses 4 KiB. The probe therefore establishes neither a clone-time memory bound nor a post-clone CPU or temporary-allocation bound. Stage B must not claim that this gate alone prevents iframe-originated denial of service.

The initial upstream 403 was not a cookie or Origin failure. Starting the pinned upstream page at `/` made a read-only principal select a new, nonexistent generated session. Zellij correctly rejected session creation, removed that `web_client_id`, and the following control upgrade returned 403. Targeting the already-existing allowlisted session produced 101 for both terminal and control sockets. The product broker must always pass the resolved existing `claude-main` or `codex-main` session and must never use upstream's root/welcome-session path.

For Stage B, freeze the browser streaming resource allowlist to exactly `GET /observer/frame` and `WS /observer/stream`, under the four local/Fleet and root/base-path prefixes in the accepted plan. No arbitrary asset or proxy suffix exists: the frame response contains the pinned renderer assets. Lease creation/release/preset/status/install lifecycle endpoints remain the explicit `/api/observer/...` routes from Issue #297 and the plan. The WebSocket supplies its lease identifier in a fixed `Sec-WebSocket-Protocol` grammar (`zylos-observer-v1`, `lease.<base64url>`) so authorization occurs before upgrade without putting the identifier in a query string. Reject all other upgrade paths and subprotocol forms.

The Stage B active-stream policy is a 10-second canonical-principal and lease revalidation interval, in addition to protocol ping/pong and the 30-second default lease TTL. Cookie sessions and API/Fleet keys must be revalidated at the producer on that interval; same-key token refresh retains the stable `api_key_id`, while expiry, revocation, principal change, target change, generation change, or consumer disconnect closes both stream halves. This is a product contract selected by A, not behavior implemented by the probe.

## Darwin containment mechanism

Each generation owns a unique mode-0600 marker file. Every owned launcher inherits an open descriptor for that same device/inode across exec. The launcher primes that descriptor to a deterministic inode-derived offset, and the Darwin guardian requires the device, inode, and offset together. This excludes unrelated readers that happen to open the marker path. The guardian uses dynamically sized `proc_listpids(PROC_UID_ONLY, geteuid())`, `proc_pidinfo(PROC_PIDTBSDINFO)`, and `proc_pidfdinfo(PROC_PIDLISTFDS/PROC_PIDFDVNODEPATHINFO)` censuses; saturated or unstable enumeration fails closed rather than silently truncating the owned set. Restricting the initial PID list to the effective UID avoids turning an expected `EPERM` for an unrelated system account into a generation failure while retaining strict errors for every same-UID candidate.

All process-identity consumers use one three-state contract: exact PID/start match, definitely gone or start-changed, or query error. Query error is emitted with the originating errno and PID, never advances stable-zero, never becomes `parent-gone`, and never authorizes a signal. Census, tracked-owner scans, signal-time rechecks, timeout reporting, restart reconciliation, parent watching, the `identity` CLI (exit 5), and the JavaScript whole-topology oracle all preserve that contract. Cleanup closes over observed descendants and requires three successful stable-zero censuses. It starts the 1.5-second TERM grace only after the first complete successful TERM pass over all currently tracked exact identities; discovering a new exact owner resets that pass. Persistent unknown state ends nonzero at the global deadline. A liveness-pipe HUP remains a separate definitive reason to enter cleanup even while parent identity is unknown. Restart reconciliation uses the same exact marker and identities. The guardian never searches by process name or kills an unresolved PID.

The identity recheck and the subsequent `kill(2)` call cannot be atomic, so PID reuse between those two operations remains a Darwin probe limitation. The microsecond start check narrows that window but does not eliminate the TOCTOU.

Every generation supplies private mode-0700 process `HOME`, config, plugin data, cache/data, `TMPDIR` log, and `ZELLIJ_SOCKET_DIR` roots. The socket root is a short `/tmp/zo297-<pid>` directory because macOS Unix socket path length rejects the longer workspace path. Token metadata, cache metadata, sockets, and logs were observed only under these controlled roots. The generation marker, token material, and sensitive metadata are mode 0600. No terminal content or credential appeared in the inspected Zellij log.

The final harness starts both an unrelated Zellij session and an unrelated tmux sentinel. It records the unrelated Zellij expect/client PID, PPID, process group, session, microsecond start identity, and session line, then requires those Zellij wrapper/client identities to survive unchanged. The tmux negative control is narrower: it proves survival only with exact private-socket `has-session -t agent-sentinel`; it does not claim a locked tmux process identity. Before teardown the harness opens real upstream control and terminal WebSockets and waits until a unique tmux pane marker appears in the terminal stream. The 10-second deadline covers child close, census/reconcile, watcher/control closure, whole recorded Observer topology disappearance, listener closure, Observer tmux cleanup, and both unrelated-survivor checks.

Fresh six-case rerun after the P2 repairs:

| Case | Result | End-to-end cleanup | Active watcher | Unrelated Zellij + tmux |
| --- | --- | ---: | --- | --- |
| abrupt parent SIGKILL | pass | 1020 ms | marker received; both sockets closed | survived unchanged |
| graceful stop | pass | 1172 ms | marker received; both sockets closed | survived unchanged |
| guardian restart, then parent SIGKILL | pass | 731 ms | marker received; both sockets closed | survived unchanged |
| guardian disabled (known-bad), then exact reconcile | escaped set detected; reconcile pass | 1192 ms | marker received; both sockets closed | survived unchanged |
| wrapper retains marker after child exit | pass | 2240 ms, wrapper required SIGKILL | marker received; both sockets closed | survived unchanged |
| old wrapper behavior closes its own marker | mutant detected; exact cleanup pass | 1117 ms | marker received; both sockets closed | survived unchanged |

All timings are below 10 seconds and ended with zero marker-owned survivors, no recorded Observer topology, and a closed listener. The guardian self-test exercises permanent and transient bottom-level identity failures, direct CLI and shared JavaScript exit-5 propagation, signal-time recheck recovery, reconcile and watch-parent behavior, independent liveness HUP, timeout reporting, three stable-zero suppression, and the 1.5-second post-TERM grace. Known-bad collapse controls reproduce false reconcile/parent-gone/stable-zero outcomes while leaving the owner alive. The permanent census-error control also proves a previously observed, SIGTERM-ignoring owner is SIGKILLed while subsequent enumerations fail, while an unrelated process survives. A forced child-startup census failure separately proves the standalone browser harness removes fault injection, reruns exact reconciliation successfully, and cleans its marker set, unrelated Zellij session, private tmux server, sockets, and listener before returning the expected failure. Only tested `darwin-arm64` is supported by this A record; Linux, Darwin x64, and Windows remain unsupported until they have their own artifact, root, containment, known-bad, and real-browser evidence.

## Browser controls and retained evidence

### Self-review finding and correction

The first implementation of the 4 KiB frame-to-parent audit bound used `JSON.stringify(message).length`. Self-review rejected that mechanism because JSON serialization collapses an `ArrayBuffer` to an empty object, so the check can undercount the actual structured-clone payload. A second known-bad estimator counted only `view.byteLength`; a one-byte `Uint8Array` over a 1 MiB backing buffer bypassed it. The final source counts the full backing allocation, strings by encoded bytes, primitive widths, object keys, and nested values; cycles and unsupported prototypes fail closed. A 5,000-byte `ArrayBuffer`, the one-byte/1 MiB view, and a 25-message burst run from the opaque frame. The final CDP audit requires both oversize controls and the 20/s rate limiter to fire while valid traffic still succeeds.

In a fresh isolated Chrome profile, the final trust-domain audit recorded:

- opaque frame: true; sandbox is exactly `allow-scripts`;
- iframe direct `POST /admin/sentinel`: blocked by frame CSP;
- forged window message: rejected; forged MessagePort mutation: rejected;
- a 5,000-byte `ArrayBuffer` and a one-byte view over a 1 MiB backing buffer were both rejected by the 4 KiB bound; a 25-message burst exercised the 20/s limiter without blocking the valid `ready` or CSP probe result;
- browser requests to the upstream Zellij port: zero;
- browser `session_token` cookies: zero; only the probe's HttpOnly, SameSite=Strict admin cookie existed;
- unauthenticated direct mutation: HTTP 401;
- authenticated parent mutation changed the sentinel from 0 to 1, proving the mutation control can detect a breach;
- the exact read-only tmux client reported `client_readonly=1`; a unique harmless command sent with a real `0x0d` left the captured pane SHA256 byte-identical and appeared in neither the pane nor the actual terminal render stream;
- the paired writable upstream used the same browser/CDP/broker path with `client_readonly=0`; the same real-CR oracle changed the pane SHA256 and found the unique marker in both the pane and terminal render stream. This is a positive oracle only, not an allowed Observer policy;
- desktop 1280×900 and mobile 390×844 had no document-level horizontal overflow. The first repair run exposed that long unbroken SHA256 strings made Chrome widen its mobile layout viewport to 549px; `overflow-wrap:anywhere` plus border-box iframe sizing closed that false-green path, and the retained run asserts the exact 390×844 layout viewport.

Retained under the isolated runtime root:

- `containment-six-case-identity-final-20260916.json`: fresh identity-repair-source full process identities, roots, active-watcher content/closure, whole-topology checks, timings, unrelated Zellij identities, tmux session survival, and both containment known-bad controls.
- `browser-ro-final2-20260916.json` and `browser-rw-final2-20260916.json`: paired exact-source browser/frame/cookie/network and real-CR oracle results; they contain cookie metadata only, never values.
- `browser-ro-final2-20260916-{desktop,mobile}.png` and `browser-rw-final2-20260916-{desktop,mobile}.png`.
- `structured-clone-control-final2-20260916.json`: both rejected estimators and their corrected results.
- `guardian-selftest-identity-final-20260916.json`: direct identity CLI/JavaScript propagation, permanent/transient bottom-level faults, signal/reconcile/watch/survivor controls, known-bad collapses, exact-owner/unrelated behavior, census-failure SIGKILL, TERM grace, and final clean state.
- `containment/browser-repro-continue/existing-session-live.png`: pinned upstream existing-session protocol confirmation.

The retained browser JSON/screenshots above were generated at parent commit `ac01e378...`. Browser/frame/broker sources are unchanged by this identity-only follow-up; `darwin-containment-probe.mjs` and the guardian did change, so those images are supporting trust-domain evidence rather than a claim that the whole current tree was rerun through Chrome. The fresh current-source containment and guardian evidence is identified separately above.

Probe sources are deliberately outside production modules. Stage B must translate these mechanisms into the lifecycle coordinator and repeat the full ownership-set oracle against real last-lease, disable, component pre-uninstall, and Dashboard restart paths before claiming product coverage.
