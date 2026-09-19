# Shared Observer native helpers

Build on a native macOS arm64, Linux x64 or Linux arm64 host:

```sh
python3 src/native/observer/build.py --output /absolute/new/helper-dir
```

The directory must not exist, and its parent must exist. The build installs
nothing and starts no helper or service. It emits `darwin-guardian` or
`linux-guardian`, `marked-exec`, `pty-marked-exec`, and `manifest.json`.
The manifest records the target, compiler, commands, flags, source hashes,
binary hashes and build-script hash. The command prints the manifest SHA-256.
The executable header must match the native target; cross builds are not native
validation. Failed builds retain partial output for diagnosis and have no final
manifest. A successful build is explicitly `built-not-validated` and does not
enable any platform in the product catalog or replace bundled binaries.

`marked-exec.c` and `pty-marked-exec.c` are shared implementations. The old probe
paths are include wrappers for existing harnesses. PTY headers are `<util.h>` on
macOS and `<pty.h>` on Linux; only Linux links `-lutil`.

The PTY helper uses the existing Linux diagnostic-write implementation on both
platforms. Compared with the former macOS copy, failure-output writes now consume
the return value and retry short writes or EINTR at most 16 times. This bounds
retry count, not individual blocking writes, and leaves SIGPIPE behavior intact.
The marker descriptor, offset, inherited environment, PTY setup and exit-status
contracts remain shared. Existing PTY retention-test environment controls remain
available to the probe harnesses.

`probes/observer-linux/build.py` delegates to this entry point for compatibility.
Historical probe evidence refers to the source and binary hashes of that run;
it is not evidence for newly built shared helpers.

## Shared lifecycle and platform differences

`src/lib/observer-containment-posix.js` owns start, stop, cleanup deadlines and
persisted-generation reconciliation. Darwin and Linux modules retain their
public adapter names and select native helper names/architecture manifests.
Linux x64 and arm64 adapter availability is experimental; it does not add either
platform to the product artifact catalog.

Both adapters remove inherited XDG/Zellij roots and session overrides, then set
private HOME, config, cache, data, state, socket and temporary directories.
Darwin keeps its native Library cache/data locations. This changes Darwin's
previous inherited-environment behavior. Empty runtime directories now reconcile
without loading helpers on both platforms.

`guardian.c` shares CLI parsing, census closure, tracked identities, cleanup and
logging. Linux reads procfs and signals identity-pinned pidfds. Darwin uses
libproc and rechecks birth identity before signaling; it retains its marker birth
prefilter to avoid inspecting older unrelated processes. Linux birth identity is
boot-relative start ticks; Darwin uses seconds/microseconds. These fields remain
platform-specific and do not provide a cross-boot reconciliation contract.

Compared with the former Darwin implementation, the shared guardian checks
identity before and after marker inspection, requires child birth not to precede
its parent, logs EACCES/EPERM marker-inspection skips, and retains uncertainty on
tracking overflow or failed signal passes. Deadline checks now cover the shared
loops, but cannot interrupt an individual blocked kernel call. Numeric arguments
are parsed strictly, process names are JSON-safe, and Darwin identity diagnostics
include state `?`. Unreadable untracked processes can be missed; this remains
cooperative containment, not protection against hostile same-UID workloads.

Guardian fault injection and known-bad controls require a separate build with
`-DZYLOS_GUARDIAN_TESTING=1`. The standard build does not enable them. Existing
PTY retention-test controls remain in the PTY helper; the adapter strips their
environment variables before launching children.
