# Observer Stage A evidence handoff

> **Historical record — frozen sources.** The native helper implementation and its
> build/probe commands below were removed from the current tree. For the complete
> pre-cleanup sources and assets, use the [frozen tree at `a5be86088efa8da63f98a73a182bd0ee57a4f004`](https://github.com/zylos-ai/zylos-dashboard/tree/a5be86088efa8da63f98a73a182bd0ee57a4f004).
> Commands referencing removed files are historical replay instructions, not
> commands to run from the current checkout. Preserve the original evidence and
> revision qualifications below; the frozen tree does not change their scope.

This package is an isolated feasibility probe for Issue #297. It does not implement Dashboard Observer lifecycle wiring and does not claim Stage B/C, production, Fleet, release, or deployment coverage.

## Environment used

- macOS 26.6.2 (build 25G83), arm64.
- Node.js 25.9.0.
- Apple clang 21.0.0.
- tmux 3.6a and `/usr/bin/expect`.
- Google Chrome 152.0.7977.83 with a fresh isolated profile.
- Zellij official 0.45.1 Darwin arm64 binary. The archive and extracted-binary hashes are in `STAGE-A-RECORD.md`.
- Pinned Zellij source checkout `efd8fd5a89a20c07a111d248ad7fce53848d2c18`; renderer inputs are `zellij-client/assets/xterm.js` and `zellij-client/assets/xterm.css`.

The commands below assume the dashboard probe checkout is the current directory and these sibling paths exist:

```sh
runtime_root=/Users/howard/zylos/workspace/observer-stage-a-runtime-af8ac477
zellij_source=/Users/howard/zylos/workspace/zellij-v0.45.1-source
```

## Build and static verification

```sh
cc -std=c11 -Wall -Wextra -Werror -O2 probes/observer-stage-a/darwin-guardian.c -o "$runtime_root/bin/darwin-guardian"
cc -std=c11 -Wall -Wextra -Werror -O2 probes/observer-stage-a/marked-exec.c -o "$runtime_root/bin/marked-exec"
cc -std=c11 -Wall -Wextra -Werror -O2 probes/observer-stage-a/pty-marked-exec.c -o "$runtime_root/bin/pty-marked-exec" -lutil
node --check probes/observer-stage-a/darwin-containment-probe.mjs
node --check probes/observer-stage-a/observer-broker-probe.mjs
node --check probes/observer-stage-a/cdp-trust-domain-audit.mjs
node probes/observer-stage-a/structured-clone-bound-control.mjs "$runtime_root/structured-clone-control-rerun.json"
node probes/observer-stage-a/guardian-selftest.mjs \
  "$runtime_root/bin/darwin-guardian" "$runtime_root/bin/marked-exec" "$runtime_root" \
  "$runtime_root/guardian-selftest-rerun.json"
```

The clone command recreates both rejected estimators and their replacements: JSON text vs a 5,000-byte `ArrayBuffer`, and view length vs a one-byte view over a 1 MiB backing buffer. The guardian self-test directly simulates Apple's byte-returning, zero-on-failure `proc_listpids` API for permanent and transient fill faults, normal nonempty results, saturation/growth, the resource ceiling, and malformed byte counts; it also exercises the old zero-as-empty mutant through the real cleanup loop. Existing coverage remains: exact-owner selection, unrelated-reader exclusion, match/gone-or-changed/query-error propagation through every C identity consumer and the shared JavaScript oracle, permanent and transient bottom-level identity faults, signal-time recovery, parent reconcile/watch, independent liveness HUP, timeout reporting, post-TERM grace, permanent census failure, fail-closed SIGKILL of a previously observed owner, and final clean recovery.

## Containment rerun

Use a new evidence filename because the probe intentionally refuses to overwrite evidence:

```sh
node probes/observer-stage-a/darwin-containment-probe.mjs \
  --runtime-root "$runtime_root" \
  --zellij "$runtime_root/extracted/zellij" \
  --guardian "$runtime_root/bin/darwin-guardian" \
  --marked-exec "$runtime_root/bin/marked-exec" \
  --pty-marked-exec "$runtime_root/bin/pty-marked-exec" \
  --pty-spawn "$PWD/probes/observer-stage-a/pty-spawn.exp" \
  --config-file "$PWD/probes/observer-stage-a/zellij-probe-config.kdl" \
  --tmux /opt/homebrew/bin/tmux \
  --evidence-file "$runtime_root/containment-rerun.json"
```

This executes six real Zellij cases: abrupt parent SIGKILL, graceful stop, guardian restart followed by parent SIGKILL, guardian-disabled known-bad escape followed by exact reconciliation, wrapper-marker retention, and the old wrapper-marker behavior mutant. Every case proves active terminal content before cleanup, both upstream sockets close, the whole recorded Observer topology disappears, the listener closes, exact unrelated Zellij wrapper/client identities survive, and the unrelated tmux sentinel still passes private-socket `has-session`. The tmux check is not an exact process-identity claim.

## Browser/protocol rerun contract

The retained paired browser runs used live isolated Zellij 0.45.1 listeners and already-existing Zellij sessions containing read-only and writable tmux clients. Neither was a stub. The broker is probe-owned JavaScript, not product lifecycle wiring.

Start the isolated Zellij session/listener once with `--session-mode read-only` and once with `--session-mode writable` (use a distinct case name each time). Retain each emitted `port`, `sessionName`, `tokenFile`, `tmuxSocket`, and `tmuxTarget`:

```sh
node probes/observer-stage-a/darwin-containment-probe.mjs --child \
  --case-name "$case_name" --session-mode "$session_mode" \
  --runtime-root "$runtime_root" \
  --zellij "$runtime_root/extracted/zellij" \
  --guardian "$runtime_root/bin/darwin-guardian" \
  --marked-exec "$runtime_root/bin/marked-exec" \
  --pty-marked-exec "$runtime_root/bin/pty-marked-exec" \
  --pty-spawn "$PWD/probes/observer-stage-a/pty-spawn.exp" \
  --config-file "$PWD/probes/observer-stage-a/zellij-probe-config.kdl" \
  --tmux /opt/homebrew/bin/tmux
```

Then start the broker with matching expectations:

```sh
node probes/observer-stage-a/observer-broker-probe.mjs \
  --upstream-port "$upstream_port" \
  --session "$session_name" \
  --token-file "$token_file" \
  --xterm-js "$zellij_source/zellij-client/assets/xterm.js" \
  --xterm-css "$zellij_source/zellij-client/assets/xterm.css" \
  --tmux /opt/homebrew/bin/tmux \
  --tmux-socket "$tmux_socket" \
  --tmux-target "$tmux_target" \
  --expected-upstream-readonly "$expected_readonly" \
  --public-port 0
```

Open the emitted `publicUrl` in a fresh Chrome profile with a dedicated remote-debugging port; the retained run used `--force-device-scale-factor=1 --window-size=1280,900`. Then run:

```sh
node probes/observer-stage-a/cdp-trust-domain-audit.mjs \
  "$cdp_port" "$broker_port" "$upstream_port" \
  "$runtime_root/trust-domain-rerun.json" "$runtime_root/trust-domain-rerun"
```

The audit exercises the positive/input controls itself and refuses success unless the opaque/CSP boundary, cookie/network absence, forged-message rejection, both backing-allocation oversize controls, burst limiter, authenticated mutation positive control, exact tmux client mode, real-CR oracle, and exact 1280x900 plus 390x844 viewport overflow checks all pass. Read-only must preserve the pane hash with no marker; writable must change the hash and show the marker in both the pane and render bytes. Writable is only the discriminating positive oracle. When given the optional prefix the audit captures both screenshots through the same CDP session.

## Evidence classification

- **Real upstream round trip:** official Zellij 0.45.1 archive/binary; `/command/login`; `/session?session=<existing>&welcome=false`; upstream control and terminal WebSockets; terminal display bytes rendered by xterm; exact read-only and writable tmux clients; a harmless command sent with a real CR and checked against the pane plus terminal bytes.
- **Isolated harness:** Darwin launcher/guardian, private roots, device+inode+offset ownership census, liveness pipe, exact unrelated Zellij and tmux controls, broker HTTP server, opaque iframe, browser cookie/mutation sentinel, CDP assertions, screenshots, and clone-size controls.
- **Stubbed:** no Zellij HTTP or WebSocket protocol was stubbed. Dashboard auth was represented by the probe's random HttpOnly `probe_admin` cookie and mutation sentinel; product principal/lease/lifecycle/Fleet code was not present.

## Explicitly unproved constraints

- No Stage B/C product code or real lifecycle wiring: last lease, disable, uninstall, component pre-uninstall, Dashboard restart, config transactions, generation fencing, install races, and failed-uninstall durability remain unproved.
- No canonical production principal, API-key/Fleet token refresh, lease expiry/revocation, or 10-second active-stream reauthorization implementation was tested.
- No public Dashboard root/base-path × local/Fleet routing implementation was tested.
- The 4 KiB frame gate limits retained payload size only. It cannot prevent the browser from allocating a structured clone before the handler runs, and its `Object.entries` walker can materialize and scan an arbitrarily wide object before rejecting it. Clone-time memory, post-clone CPU, and temporary allocation therefore have no hard bound in this probe and must not be described as solved.
- PID/start identity recheck followed by `kill(2)` retains a non-atomic PID-reuse TOCTOU; the recorded microsecond start identity narrows but does not eliminate it.
- No archive download/extraction bounds, MIT packaging, dual-hash install verification, online update, or active-generation artifact identity implementation was tested.
- No Linux, Darwin x64, Windows, multi-user load, sustained resource-bound, or production Agent-session evidence exists. The result applies only to the tested Darwin arm64 environment.
