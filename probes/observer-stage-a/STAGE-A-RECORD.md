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

The frame-to-parent schema is limited to `ready` and the isolated probe result. The parent processes at most 20 frame messages/second and rejects messages over 4 KiB using an explicit bounded structured-clone size walk (including `ArrayBuffer` and typed-view `byteLength`), rather than JSON text length. Unknown window or port messages are ignored and counted. Terminal bytes enter only `xterm.write(Uint8Array)` inside the opaque frame; the parent never inserts terminal content as HTML.

The initial upstream 403 was not a cookie or Origin failure. Starting the pinned upstream page at `/` made a read-only principal select a new, nonexistent generated session. Zellij correctly rejected session creation, removed that `web_client_id`, and the following control upgrade returned 403. Targeting the already-existing allowlisted session produced 101 for both terminal and control sockets. The product broker must always pass the resolved existing `claude-main` or `codex-main` session and must never use upstream's root/welcome-session path.

For Stage B, freeze the browser streaming resource allowlist to exactly `GET /observer/frame` and `WS /observer/stream`, under the four local/Fleet and root/base-path prefixes in the accepted plan. No arbitrary asset or proxy suffix exists: the frame response contains the pinned renderer assets. Lease creation/release/preset/status/install lifecycle endpoints remain the explicit `/api/observer/...` routes from Issue #297 and the plan. The WebSocket supplies its lease identifier in a fixed `Sec-WebSocket-Protocol` grammar (`zylos-observer-v1`, `lease.<base64url>`) so authorization occurs before upgrade without putting the identifier in a query string. Reject all other upgrade paths and subprotocol forms.

The Stage B active-stream policy is a 10-second canonical-principal and lease revalidation interval, in addition to protocol ping/pong and the 30-second default lease TTL. Cookie sessions and API/Fleet keys must be revalidated at the producer on that interval; same-key token refresh retains the stable `api_key_id`, while expiry, revocation, principal change, target change, generation change, or consumer disconnect closes both stream halves. This is a product contract selected by A, not behavior implemented by the probe.

## Darwin containment mechanism

Each generation owns a unique mode-0600 marker file. Every owned launcher inherits an open descriptor for that same device/inode across exec. The Darwin guardian uses `proc_listallpids`, `proc_pidinfo(PROC_PIDTBSDINFO)`, and `proc_pidfdinfo(PROC_PIDFDVNODEPATHINFO)` to census that marker, records PID plus microsecond start identity, closes over observed descendants, and revalidates identities before every signal. It watches both a dedicated parent-liveness pipe and the parent's PID/start identity. Cleanup sends TERM, then KILL if required, and requires three stable-zero censuses. Restart reconciliation uses the same exact marker and identities. It never searches by process name or kills an unresolved PID.

Every generation supplies private mode-0700 process `HOME`, config, plugin data, cache/data, `TMPDIR` log, and `ZELLIJ_SOCKET_DIR` roots. The socket root is a short `/tmp/zo297-<pid>` directory because macOS Unix socket path length rejects the longer workspace path. Token metadata, cache metadata, sockets, and logs were observed only under these controlled roots. The generation marker, token material, and sensitive metadata are mode 0600. No terminal content or credential appeared in the inspected Zellij log.

Final four-case rerun after the child-`close` logging fix:

| Case | Result | Full owned-set cleanup | Listener | Unrelated exact-socket tmux |
| --- | --- | ---: | --- | --- |
| abrupt parent SIGKILL | pass | 1093 ms | closed | survived |
| graceful stop | pass | 1109 ms | closed | survived |
| guardian restart, then parent SIGKILL | pass | 1108 ms | closed | survived |
| guardian disabled (known-bad), then exact reconcile | escaped set detected; reconcile pass | 1124 ms | closed | survived |

All timings are below 10 seconds and ended with zero marker-owned survivors. Only tested `darwin-arm64` is supported by this A record; Linux, Darwin x64, and Windows remain unsupported until they have their own artifact, root, containment, known-bad, and real-browser evidence.

## Browser controls and retained evidence

### Self-review finding and correction

The first implementation of the 4 KiB frame-to-parent audit bound used `JSON.stringify(message).length`. Self-review rejected that mechanism because JSON serialization collapses an `ArrayBuffer` to an empty object, so the check can undercount the actual structured-clone payload. The final source uses a bounded structured-clone size walk that counts `ArrayBuffer` and typed-view `byteLength`, strings by encoded bytes, primitive widths, object keys, and nested values; cycles and unsupported prototypes fail closed. A 5,000-byte `ArrayBuffer` negative control and a 25-message burst now run from the opaque frame, and the final CDP audit requires both the oversize rejection and the 20/s rate limiter to fire while valid traffic still succeeds.

In a fresh isolated Chrome profile, the final trust-domain audit recorded:

- opaque frame: true; sandbox is exactly `allow-scripts`;
- iframe direct `POST /admin/sentinel`: blocked by frame CSP;
- forged window message: rejected; forged MessagePort mutation: rejected;
- a 5,000-byte `ArrayBuffer` MessagePort payload was rejected by the 4 KiB bound, and a 25-message burst exercised the 20/s limiter without blocking the valid `ready` or CSP probe result;
- browser requests to the upstream Zellij port: zero;
- browser `session_token` cookies: zero; only the probe's HttpOnly, SameSite=Strict admin cookie existed;
- unauthenticated direct mutation: HTTP 401;
- authenticated parent mutation changed the sentinel from 0 to 1, proving the mutation control can detect a breach;
- raw input sent to the real upstream terminal socket through the read-only watcher did not add `__OBSERVER_INPUT_LEAK__` to the sentinel pane;
- the exact tmux client reported `read-only=1`; an intentional direct `tmux send-keys` positive control did add `__INTERACTIVE_POSITIVE_FINAL__` and appeared in the rendered terminal;
- desktop 1280×900 and mobile 390×844 had no document-level horizontal overflow.

Retained under the isolated runtime root:

- `final-containment-exact-20260916.json`: final-source full process identities, roots, events, timings, listener checks, and known-bad control.
- `final-trust-domain-arraybuffer-exact-20260916.json`: final exact-source redacted browser/frame/cookie/network results, including the discriminating `ArrayBuffer` oversize control, rate-limit control, and exact desktop/mobile viewport checks; it contains cookie metadata only, never values.
- `structured-clone-bound-control-20260916.json`: standalone before/after result for the rejected JSON-text estimator and corrected structured-clone estimator.
- `containment/browser-final-arraybuffer-20260916/final-arraybuffer-desktop.png` and `final-arraybuffer-mobile.png`.
- `containment/browser-repro-continue/existing-session-live.png`: pinned upstream existing-session protocol confirmation.

Probe sources are deliberately outside production modules. Stage B must translate these mechanisms into the lifecycle coordinator and repeat the full ownership-set oracle against real last-lease, disable, component pre-uninstall, and Dashboard restart paths before claiming product coverage.
