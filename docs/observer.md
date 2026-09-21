# Observer

Observer is an optional, authenticated display of the agent's tmux terminal.
Dashboard works without it. Open **Settings → Observer** to install its pinned
Zellij dependency and enable viewing. Installation downloads and verifies a
private copy; it does not replace a system Zellij installation.

## Platform availability

| Host | Dashboard Observer installation |
| --- | --- |
| macOS Apple Silicon (`darwin-arm64`) | Enabled |
| macOS Intel (`darwin-x64`) | Not enabled; native validation required |
| Linux x64 (`linux-x64`) | Enabled |
| Linux arm64 (`linux-arm64`) | Enabled |
| Windows x64 | Not enabled; lifecycle adapter required |

Dashboard automatically selects the pinned Zellij artifact for the server's
operating system and CPU architecture. No manual platform selection is needed.
In Fleet, selection happens on the target agent's server, not on the Fleet server
or the computer running your browser. Installation and enabling remain explicit
actions in Settings.

Observer requires an available tmux with support for `-N` (do not start a missing
server), the pinned private Zellij installation, and Dashboard's existing
SQLite dependency. Its coordinator and runtime data must be on a local filesystem
with working SQLite file locking. The private-tmux lifecycle does not use the
bundled native guardian helpers or their glibc/pidfd prerequisites.

The architecture entries describe managed-host support, not every Linux
distribution, container, filesystem or tmux build. The upstream artifact catalog
also includes targets that the product does not enable. A successful build or
isolated native probe does not establish product lifecycle support.

## Viewing and access

Use an authenticated administrator session. Observer is unavailable when
Dashboard authentication is disabled; read-only accounts and Fleet credentials
without administrator scope cannot acquire a viewing lease or change its state.
For a Fleet target, actions apply to the selected remote Dashboard and require
that target's administrator credentials and Observer support.

Once enabled, open the Observer tab. The first viewer starts a private Observer
generation attached read-only to the active runtime's tmux session. Keyboard,
paste and terminal input are not forwarded. The Standard, Wide and Large presets
change the shared display size; viewers of the same generation share that size.
Observer still displays terminal contents, so viewers must be trusted to see
anything shown by the agent.

Viewing uses short-lived leases tied to the authenticated session and target.
Closing the last viewer stops the private generation after the idle grace period
(five seconds by default). Expired authentication or leases close the stream.
Normal Dashboard shutdown closes streams and cleans the private generation.
An unexpected Dashboard crash may leave Observer processes running locally. The
Dashboard viewing connection ends; the private service remains loopback-only and
still requires its credential. Dashboard restart cleans the previous generation
before allowing fresh viewing, without reusing the old session. An enabled
setting alone does not start a viewer.

## Disable, uninstall and recovery

- **Disable** ends viewing and stops Observer processes, retaining the downloaded
  artifact for later use.
- **Enable** permits viewing again using a verified installed artifact.
- **Uninstall** ends viewing, proves cleanup and removes the private artifact.
  It does not remove the agent's tmux session or system tools.

Cleanup uncertainty leaves Observer disabled and fenced against new viewing.
Settings reports the failure and offers **Retry cleanup** to retain the artifact,
or **Uninstall** to remove it after cleanup succeeds. If an uninstall is already
pending or failed, Settings offers **Retry uninstall** to finish that removal.
If another live
Dashboard owns the Observer coordinator, resolve the duplicate producer before
retrying. A control startup failure leaves the ordinary Dashboard available but
blocks Observer admission.

Do not delete ownership markers or persisted runtime records to bypass a cleanup
failure. Preserve the error and runtime evidence for diagnosis. Interrupted
removal can be retried even if the owned socket directory or artifact leaf has
already been removed; existing parent paths and remaining ownership records must
still validate. Component uninstallation also performs Observer cleanup, both while Dashboard
is running and after it has crashed, and fails until that cleanup can be proved.

A startup worker continues independently if Dashboard crashes. If that worker,
the operating system, or Zellij itself fails before the private session's startup
is conclusively acknowledged, the remaining state may require operator
investigation. Retry can finish a startup still in
progress; restarting Dashboard or the host does not automatically discard an
unresolved record. Generations left by an older native-helper implementation
require its original cleanup path or explicit operator recovery before using the
replacement lifecycle.

## Cleanup scope and limits

Observer uses its own private tmux server, Zellij session, foreground web process
and private sockets. It first closes the exact private Zellij session, then the
private tmux server, and checks the recorded roles and private endpoints before
removing their records. It never closes the Agent's tmux server or signals an
unrelated service occupying a port. Cleanup uncertainty remains a failure.

This is cooperative process management on supported managed hosts, not a security
boundary against hostile processes running as the same user. Its evidence covers
known roles and the unique private namespace, not arbitrary descendant discovery.
Platform runs establish only their recorded source, binaries and host conditions;
historical probes do not validate a later implementation.
