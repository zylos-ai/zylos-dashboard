# Native Observer size-follow probe

Run this opt-in probe from the repository root with an already available binary
matching the platform's pinned Observer artifact:

```sh
OBSERVER_ZELLIJ_BINARY=/absolute/path/to/zellij node probes/observer-follow/real-chain.mjs
```

It verifies the binary digest before launching anything. It requires tmux and
Python 3 (standard-library PTY helper for the ordinary-client fixture only).
Python is not required by Observer installation, upgrade or runtime.

The probe creates fresh isolated tmux sockets and data directories. It checks
detached 140x40 windows across startup and stop, status off and three status
lines, and actual inner-client size changes through the private tmux + Zellij
chain. It records the effective `window-size` option, verifies that cleanup
removes the test Observer client, and retains temporary data for diagnosis.

Output is a JSON report. A failing assertion sets a nonzero exit status. The
two-second monitor interval is not a strict end-to-end deadline: native resize
propagation and scheduling add latency.

`OBSERVER_PROBE_SOURCE` can select an isolated source copy for mutation tests;
`OBSERVER_PROBE_CASE` selects one named scenario. The `guard` case expects a
source copy with faulty startup sizing: startup must fail with
`target_size_changed`, disconnect, and leave the changed Agent window alone.
It must fail against unmodified source, where startup succeeds. Never inject
faults into a running Dashboard or an existing Agent session.

This probe exercises production containment, size monitor and upstream modules.
Service wiring is covered by unit tests. Browser rendering and target-host
deployment validation remain separate checks.
