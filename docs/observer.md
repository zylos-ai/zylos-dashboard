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
| Linux x64 and arm64 | Not enabled; experimental adapters and validation tooling only |
| Windows x64 | Not enabled; lifecycle adapter required |

The upstream artifact catalog includes targets that the product does not enable.
A successful helper build or isolated native test does not change this table.
Native helper development and platform differences are documented in
[the shared-source guide](../src/native/observer/README.md).

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
Dashboard shutdown closes streams and attempts cleanup. A restart reconciles
persisted generations before allowing new viewing; an enabled setting alone
does not start a viewer.

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
still validate. Component uninstallation also performs Observer cleanup and may
fail until that cleanup can be proved.

## Containment limits

Observer manages its own marked processes and private sockets. Linux uses procfs
identity and pidfds; macOS uses libproc and birth-identity checks. Unreadable,
untracked processes are reported and skipped where marker inspection returns
permission errors. Cleanup uncertainty for tracked processes remains a failure.
This is cooperative process cleanup, not a security boundary against hostile
processes running as the same user.

Bounded synthetic lifecycle runs cover their exact platform, source and helper
hashes. They do not establish arbitrary descendant discovery, cross-boot recovery,
all host configurations, or isolation of real agent workloads. Historical probe
results apply only to their recorded revisions.
