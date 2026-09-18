# Linux AMD64 experimental containment handoff

This is an implementation candidate on accepted F13 `ab2a59cc18df82d705eed6d514901b9e5db6097f`, not a platform acceptance or a release. The existing Darwin helpers and accepted R5/F13 commits remain frozen. The upstream Linux artifact remains excluded from the enabled product catalog.

## R3 execution scope

Piper may build the three native helper programs in a fresh private experiment directory using the existing GCC toolchain and run the supplied native-helper probe after reading its source. This stage needs only existing Node, GCC/libc headers, and filesystem/process facilities. It neither downloads Zellij nor installs npm/system dependencies. Preserve the directory and raw logs after success or failure.

Use only the explicitly supplied helper directory and a fresh experiment output directory. Never point the probe at a deployed Observer, an existing generation, real Agent session, shared tmux socket, or production data directory. The probe creates its own synthetic children and sentinel. Cleanup must be limited to those identities and the fresh marker's verified ownership set. Do not widen permissions or substitute broad process-name kills if a check fails.

## Evidence classification

- The reported Debian 13.5, Linux x86_64, Node 22.22.1, UID 1000, readable `/proc`, tmux/GCC/Make availability and isolated tmux trial are Piper-reported preflight facts. Raw preflight output remains a separate required artifact.
- Local JavaScript tests exercise contracts with injected process operations. They cannot prove Linux compilation, procfs access, pidfd availability, native lifecycle, or crash cleanup.
- A native helper probe result covers only synthetic helper topology. It cannot establish Zellij daemon ownership, read-only terminal operation, install integrity, or product lifecycle behavior.
- A zombie is terminated but can remain visible under `/proc` until reaped. Reports must distinguish absent identities, replaced identities, terminated zombies, and live survivors rather than labeling all of them as absent.

## Native report requirements

Return the exact source head/tree, source and package hashes, `uname -a`, architecture, Node/compiler version and target, build invocation/output/exit status, helper manifest and binary hashes, probe invocation/output/exit status, and complete per-case logs. Include PID namespace scope and all permission/visibility/compile errors. Do not discard a failed attempt after a successful retry.

R3 requires three consecutive successful native probes from the same frozen
source and helper build, each in a fresh output directory. Preserve every failed
attempt, then restart the consecutive-run count after any repair. Record all four
cases: identity mismatch, graceful shutdown, abrupt producer death, and omitted
cleanup control. The omitted mechanism control calibrates survivor detection;
it is not a mutation test of the guardian's clean-reporting implementation.

Retain the independent reviewer's PID-only identity and disabled-descendant-closure
mutation patches, commands, binary hashes, and raw failures. Each must fail the
corresponding new assertion while the unchanged candidate passes. Run mutants
only against private synthetic fixtures; never replace deployed helpers.

The fortified build control must compile the same source with the standard flags
plus `-D_FORTIFY_SOURCE=3` on a toolchain supporting that setting. Record compiler,
libc, flags, and exit status, and preserve a frozen-parent comparison showing
whether the original ignored-write warning is reproduced. Debian evidence does
not by itself close the reported Ubuntu 24.04 toolchain gate.

The lifecycle oracle must cover the full fresh-marker ownership set, originally recorded process identities, cleanup time measured from the trigger through stable zero, and sentinel survival. An error or inaccessible census must never count as zero. A deliberately omitted cleanup mechanism must produce detected live survivors before safe fixture recovery.

Use `events.jsonl` monotonic trigger/oracle timestamps for trigger-through-quiet
duration (at most 10 seconds including at least 1 second of stable zero). Report
helper event timing separately from harness timing. Direct-child exit events and
final identity classifications establish harness-observed reaping only; any
post-harness `/proc` absence needs a separate timestamped observation by the
executor. Retained zombies are terminated, not absent.

General-host ownership is still unresolved (S1-1). Unreadable enumerated processes
block census; processes hidden by dumpability, credentials, or namespace changes
can fall outside enumeration. Keep the restricted cooperative envelope in README
explicit. Piper reported read-only cgroup v2 with no writable delegation; this
handoff does not authorize cgroup creation, migration, killing, or permission
changes. A synthetic pass cannot enable the product or establish crash-stable
ownership on a general host.

## R3 fixture regression control

Keep `0749c0b` frozen as the R2 comparison. In a private synthetic control, retain
an owned killed child unreaped (for example `waitid(WEXITED | WNOWAIT)`), record
its directory UID, stat-file UID, and start ticks, then invoke the compiled R2
fixture and R3 fixture against that same identity before reaping it. On the
reported failure mechanism, R2 must return 5 and R3 0. Record unsupported or
different metadata behavior explicitly instead of claiming reproduction. Also
verify a live child's wrong start ticks yield 4 without harming it, and correct
ticks allow cleanup. Do not deduplicate the main probe's final identity sweep to
hide this race. Preserve the control source, commands, hashes, and raw results.

The original build script admits only native AMD64 and validates ELF machine 62.
Any reviewer-derived architecture patch must label its manifest as derived and
record the actual architecture. R3 derives the manifest platform from the build
machine and records `buildMachine`; a manifest alone cannot establish native
AMD64 provenance without matching sources, unmodified gates, and binary headers.

## Remaining product gates after the helper experiment

1. Pinned Linux Zellij archive and extracted executable hashes, executable provenance and helper packaging compatibility.
2. Real isolated Zellij client/session/web topology, full private HOME/XDG/config/cache/data/socket/temp/log roots, and loopback-only listener.
3. Positive interactive control plus watcher/tmux read-only negative controls; ensure the controls discriminate a broken boundary.
4. Actual last lease, disable, pre-uninstall, restart/reconciliation, startup rollback, guardian failure, and abrupt producer death, including repeated generations and sentinel noninterference. The total cleanup bound is 10 seconds including the oracle, not a fresh timeout for each substep.
5. Installation/retry/corruption/permission checks on the same native environment and exact integration head.
6. luna.coco's independent exact-head technical review, then Howard's separate product/final acceptance. Merge, release, deployment and real Agent use remain outside this experiment.

## Linux interface references

The implementation uses procfs process starttime as an opaque identity value and pidfds for signaling a specific process. Linux documents process starttime in [proc_pid_stat(5)](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html), fd inspection permissions in [proc_pid_fd(5)](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html), and pidfd lifecycle/zombie semantics in [pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html). Availability and access still require native execution evidence.

## Native build and first probe commands

After verifying the package hash and reading the sources, run from the reconstructed candidate repository root on Piper's native Linux AMD64 host. Each command below is a separate step; stop and return logs at the first nonzero exit. Do not execute the final probe if the build or selftest fails.

```sh
experiment_root=$(mktemp -d /tmp/zobs-linux-stage1.XXXXXX)
python3 probes/observer-linux/build.py --output "$experiment_root/helpers" > "$experiment_root/build.log" 2>&1
"$experiment_root/helpers/linux-guardian" listpids-selftest > "$experiment_root/selftest.log" 2>&1
node probes/observer-linux/native-helper-probe.mjs --helper-dir "$experiment_root/helpers" --output-dir "$experiment_root/probe" > "$experiment_root/probe.log" 2>&1
```

Save each exit code immediately along with the exact invocation. Preserve the entire experiment directory and return it as an attachment. Do not remove the fixture evidence directories. The script can produce ordinary process termination and retained zombie classifications separately; a pass means resource-live cleanup within this synthetic fixture only. The PTY helper is compiled in this stage but its runtime behavior is not exercised.

After a successful first probe, repeat the last command with fresh `probe-2` and
`probe-3` output directories and distinct log files. Stop on any failure and return
all logs. A new handoff must supply the frozen R3 head/tree and package manifest;
do not treat this working document or either previous Stage 1/R2 package as that
freeze record.

Known next-stage gap: persisted Linux process identities need explicit boot and PID-namespace metadata before reboot reconciliation can be accepted. The first-stage script has no persisted generation replay across boots. See README for other visibility/cooperative-ownership assumptions; none is silently waived by a synthetic pass.
