# Observer Stage A evidence handoff

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
node probes/observer-stage-a/structured-clone-bound-control.mjs
```

The last command is the requested bounded-clone-size before/after control. It recreates the rejected JSON-text estimator and the final structured-clone estimator against the same 5,000-byte `ArrayBuffer`. The JSON estimator stays below 4 KiB and fails to reject; the corrected estimator crosses the bound and rejects. The retained browser report independently records `frameOversizeRejected: 1` and `frameRateLimited: 9` for the final source.

## Containment rerun

Use a new evidence filename because the probe intentionally refuses to overwrite evidence:

```sh
node probes/observer-stage-a/darwin-containment-probe.mjs \
  --runtime-root "$runtime_root" \
  --zellij "$runtime_root/extracted/zellij" \
  --guardian "$runtime_root/bin/darwin-guardian" \
  --marked-exec "$runtime_root/bin/marked-exec" \
  --pty-marked-exec "$runtime_root/bin/pty-marked-exec" \
  --config-file "$PWD/probes/observer-stage-a/zellij-probe-config.kdl" \
  --tmux /opt/homebrew/bin/tmux \
  --evidence-file "$runtime_root/containment-rerun.json"
```

This executes the four real Zellij cases: abrupt parent SIGKILL, graceful stop, guardian restart followed by parent SIGKILL, and guardian-disabled known-bad escape followed by exact reconciliation. Each case also starts an unrelated exact-socket tmux sentinel and asserts that it survives.

## Browser/protocol rerun contract

The retained browser run used a live isolated Zellij 0.45.1 listener and an already-existing Zellij session containing a read-only tmux client. It was not a stub. The broker is probe-owned JavaScript, not product lifecycle wiring.

Start the isolated Zellij session/listener with the same private-root and marker-FD launch sequence used by `darwin-containment-probe.mjs` child mode, retain the emitted `port`, `sessionName`, and `tokenFile`, then start the broker:

```sh
node probes/observer-stage-a/observer-broker-probe.mjs \
  --upstream-port "$upstream_port" \
  --session "$session_name" \
  --token-file "$token_file" \
  --xterm-js "$zellij_source/zellij-client/assets/xterm.js" \
  --xterm-css "$zellij_source/zellij-client/assets/xterm.css" \
  --public-port 0
```

Open the emitted `publicUrl` in a fresh Chrome profile with a dedicated remote-debugging port. Exercise the authenticated positive-control, attempted upstream-input, and preset controls, then run:

```sh
node probes/observer-stage-a/cdp-trust-domain-audit.mjs \
  "$cdp_port" "$broker_port" "$upstream_port" \
  "$runtime_root/trust-domain-rerun.json" "$runtime_root/trust-domain-rerun"
```

The audit exercises the positive/input controls itself and refuses success unless the opaque/CSP boundary, cookie/network absence, forged-message rejection, `ArrayBuffer` oversize rejection, burst limiter, authenticated mutation positive control, real upstream read-only connection, and exact 1280x900 plus 390x844 viewport overflow checks all pass. When given the optional prefix it captures both screenshots through the same CDP session. The screenshot pixels are supporting visual evidence; the JSON is the machine-checked result.

## Evidence classification

- **Real upstream round trip:** official Zellij 0.45.1 archive/binary; `/command/login`; `/session?session=<existing>&welcome=false`; upstream control and terminal WebSockets; terminal display bytes rendered by xterm; read-only tmux client; positive `tmux send-keys` visibility; attempted terminal input through the upstream read-only watcher.
- **Isolated harness:** Darwin launcher/guardian, private roots, ownership-set census, liveness pipe, exact tmux sentinel, broker HTTP server, opaque iframe, browser cookie/mutation sentinel, CDP assertions, screenshots, and clone-size control.
- **Stubbed:** no Zellij HTTP or WebSocket protocol was stubbed. Dashboard auth was represented by the probe's random HttpOnly `probe_admin` cookie and mutation sentinel; product principal/lease/lifecycle/Fleet code was not present.

## Explicitly unproved constraints

- No Stage B/C product code or real lifecycle wiring: last lease, disable, uninstall, component pre-uninstall, Dashboard restart, config transactions, generation fencing, install races, and failed-uninstall durability remain unproved.
- No canonical production principal, API-key/Fleet token refresh, lease expiry/revocation, or 10-second active-stream reauthorization implementation was tested.
- No public Dashboard root/base-path × local/Fleet routing implementation was tested.
- No archive download/extraction bounds, MIT packaging, dual-hash install verification, online update, or active-generation artifact identity implementation was tested.
- No Linux, Darwin x64, Windows, multi-user load, sustained resource-bound, or production Agent-session evidence exists. The result applies only to the tested Darwin arm64 environment.
