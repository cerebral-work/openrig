# Cerebral 0.6.10-cw.3 — fresh launcher readiness

CER-2889: a newly created detached session starts at 160 columns by 48 rows.
Before its first staged runtime launch, OpenRig waits for positive idle-shell
process evidence and a computed `printf` marker from that shell. Echoed input
does not count. While waiting, it can resubmit only the readiness probe's Enter,
and only while the pane is still a proven idle shell. It never resubmits the
runtime launch. A missing marker stops launch with `shell_not_ready` after 40
polls at 250 ms plus probe time.

Claude and Codex startup readiness distinguish an unconsumed staged script
(`launch_not_executed`), an unproven shell wrapper (`awaiting_runtime`), and a
proven idle shell after consumption (`returned_to_shell`). The script observation
belongs to the current adapter's launch attempt; it is not recovery of launch
metadata after a daemon restart. The handshake is restricted to new sessions
created by this adapter; existing/adopted seats and in-place resumes retain
their existing input behavior. Attached terminal views may subsequently resize
the new window normally.

The idle-shell helper and readiness checks are narrow backports of upstream
`c336df24` (#1364), `3053354c` (#1373), and the readiness portion of `a2a37b16`
(#1395). Whole cherry-picks would also change legacy restore, reconciliation,
and interaction recovery; those are outside this release. Upstream #1357 and
#1236 were inspected but address resume and recovery paths rather than this
fresh-shell input race. The fork remains on the 0.6.10 version line.

Regression coverage is in `fresh-shell-launch.test.ts`, using fake tmux argv,
fixture process listings, real temporary launch files, and the repository's
hermetic test setup. It covers lost early Enter, echoed input, timeout,
transport failure, unknown process state, unconsumed/consumed launches, and
busy wrappers. Existing adapter, startup, process, and delivery-guard suites
cover the adjacent paths. The stub-agent scenario launcher does not use the
staged Claude/Codex launch path, so it cannot reproduce this race; this release
uses the deterministic transport fixture instead. Native provider interaction
and production deployment are not established by these tests.

The operator installs the packed CLI artifact and performs the separately
approved daemon-only restart. Seat launches must remain paused during that
operation. Retain the previous cw.2 package for `npm i -g <cw.2-package.tgz>`
rollback. Building this release does not authorize deployment or seat startup.
