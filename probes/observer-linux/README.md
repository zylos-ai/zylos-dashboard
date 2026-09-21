# Experimental Linux native helpers

> **Historical record — frozen sources.** The native helper implementation and its
> build/probe commands below were removed from the current tree. For the complete
> pre-cleanup sources and assets, use the [frozen tree at `a5be86088efa8da63f98a73a182bd0ee57a4f004`](https://github.com/zylos-ai/zylos-dashboard/tree/a5be86088efa8da63f98a73a182bd0ee57a4f004).
> Commands referencing removed files are historical replay instructions, not
> commands to run from the current checkout. Preserve the original evidence and
> revision qualifications below; the frozen tree does not change their scope.

These sources preserve the accepted Darwin watch/reconcile event and exit-status
contract while replacing process inspection and signaling with Linux mechanisms.
They are **experimental sources**, not product assets or a supported Observer
platform. Frozen Stage 1 `0cdcf003` has reported native Debian AMD64 synthetic
evidence; this R3 revision still requires its own native validation. That prior
result does not validate R3 or general Linux deployment. Historical sections
below describe frozen revisions. Current sources are shared with Darwin under
`src/native/observer`; bundled binaries remain unchanged.

Build on an authorized native Linux x64 or arm64 host, using an existing compiler
and Python (the same entry point also supports native macOS arm64):

```sh
python3 probes/observer-linux/build.py --output /absolute/new/isolated/helper-dir
```

The output directory must not already exist. The script installs nothing, starts
no service and runs no helper. It compiles three native executables and emits
`manifest.json` with source/binary/build-script SHA-256 values and compiler flags.
`pty-marked-exec` shares its implementation with macOS; Linux uses `<pty.h>` and
`-lutil`. The shared build uses
`-std=c11 -O2 -Wall -Wextra -Werror -D_FILE_OFFSET_BITS=64`. Failed builds leave their
isolated directory intact for diagnosis; they do not write a final manifest.

## Contracts

- `linux-guardian identity PID`: exit 0 plus `identity` JSON; absent PID exit 2;
  incomplete query exit 5. `startSec` is `/proc/PID/stat` field 22 (boot-relative
  ticks), `startUsec` is 0. These are opaque identity fields, not epoch time.
  `state` explicitly reports Linux process state including zombies `Z`/dead `X`.
- `linux-guardian census MARKER`: one `owned` JSON per resource-live member, then
  `count`; empty exit 0, nonempty exit 2, incomplete query exit 5.
- `linux-guardian watch FD PARENT STARTSEC STARTUSEC MARKER DEADLINE_MS`: wait for
  the liveness pipe to close or the parent identity to terminate, then clean up.
- `linux-guardian reconcile PARENT STARTSEC STARTUSEC MARKER DEADLINE_MS`: refuse
  a live matching parent with exit 4; otherwise clean up. Successful clean exit 0,
  deadline/uncertain census exit 3, setup or parent-query error exit 5, misuse 64.
- `linux-guardian listpids-selftest`: exercises allocation/full-buffer/error
  classification with fake enumeration; it is not an OS-enumeration test.
- Production-style marker input is `fdpath:/absolute/marker-file`. Inherited FDs
  must match the marker's device/inode and position
  `0x5a170000 + (inode & 0xfffff)`. `marked-exec` and `pty-marked-exec` prime it.
  Environment matching is retained only for diagnostic compatibility.

## Mechanics and limits

The census enumerates visible same-effective-UID processes through `/proc`,
checks starttime before/after FD inspection, and computes descendant closure.
The guardian itself and PID 1 are excluded. FD inspection checks device/inode
before and after reading position. Disappearing/inaccessible FDs cause a retry
(up to four) and then a query error, never a false empty census. Names are reduced
to printable JSON-safe ASCII. Processes in `Z`/`X` state are resource-dead: they
cannot retain FDs or execute/fork. Identity still reports them, so harnesses must
separately report retained zombie entries rather than claim `/proc` absence.

Signaling requires `pidfd_open` and `pidfd_send_signal`: open the handle, recheck
the expected starttime, then signal the pinned handle. There is no PID-only kill
fallback. Missing syscalls, seccomp rejection or permissions cannot silently
produce a clean result. Three complete empty passes are required. TERM grace is
1500 ms; polling interval is 100 ms. New discoveries restart TERM grace within
the overall supplied cleanup deadline. Enumeration has a 65,536-PID bound;
tracking overflow remains sticky uncertainty and forces nonzero completion.
Cleanup also checks the deadline during PID/FD enumeration, descendant closure,
tracking and signaling. Individual kernel reads/stat calls cannot be preempted by
these userspace checks; hard wall-clock guarantees under a stalled kernel or
extreme process churn remain unvalidated. The standalone census command has no
caller-supplied timeout; its process caller must impose one.

This is cooperative containment, not a security boundary against hostile code
with the same UID. A process that closes the marker and reparents before any
observation may evade discovery. Descendant and FD snapshots are not atomic.
No namespace, cgroup, privilege, ptrace attachment, systemd or host PID access is
used. No marker birth-time shortcut is used. If marker inspection of an
unrelated same-UID process is denied with `EACCES` or `EPERM`, the candidate is
reported as `skipped-unreadable` and treated as unmarked; all other query errors
still fail closed. Already-tracked owned identities remain tracked and signalled.
This behavior must be measured on the target container. It does not cover
processes excluded before FD inspection:
dumpability changes can change procfs ownership, and credential or namespace
transitions can invalidate the visibility assumptions while marker FDs remain
open. For example, privilege-changing setuid/setgid exec can leave an inherited
marker holder outside the procfs-owner filter. `/proc` must expose the entire
authorized experiment PID namespace without
hidden same-UID processes. The bounded synthetic envelope assumes inspectable
same-UID candidates and cooperative fixtures that do not change dumpability,
credentials, or namespaces. A successful probe does not enforce these assumptions
for future workloads. General-host ownership remains an unresolved product gate;
do not exclude permission errors or different-GID processes to obtain a pass.

R2's probe retries uncertain census results within a fixed deadline and resets
the quiet window on uncertainty. It adds wrong-starttime reconciliation against
an empty marker and a marked parent with a markerless child. Native repeated
runs and identity/descendant-closure mutants must establish their discrimination;
source changes alone are not evidence that those controls pass.

R3 corrects the fixture cleanup UID check to inspect the process directory,
not its `stat` file, whose owner can change during process exit before reaping.
The pidfd and exact start-tick check remain required. Duplicate identity records
are retained to exercise the exit window. `exact-fixture-cleanup` records a
successful cleanup command, including an already-gone target; it does not prove
that a signal was sent. Native frozen-R2 versus R3 fixture controls remain required.

Identity is only meaningful within the same boot and PID namespace. Persisted
adapter records require an explicit boot-ID/namespace contract before reboot
reconciliation can be accepted. The experimental native helper itself does not
add that metadata. A clean helper census proves only resource-live disappearance
in that visible namespace; it is not host-wide absence or product readiness.

Local checks on macOS can validate C syntax with syscall identifiers stubbed and
Python syntax, but cannot prove Linux headers, linking, syscalls, permission
behavior, PTY behavior or cleanup correctness. Native build, failure controls,
real fixture lifecycles and independent review are all still required.
