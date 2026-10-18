import { findQueueRecovery, recoveryId, recoveryTag } from "./queue-recovery.js";
import { queueWaitNotice } from "./queue-wait-backoff.js";
import { lastMeaningfulTransition, pendingSince } from "./queue-waiting.js";
import { resolvePickupThresholdMinutes } from "./queue-pickup.js";
// S02 (OPR.0.5.5.2) — STANDING STUCK SWEEP. `queue overdue` and `queue undelivered` are the
// two halves of "is anything silently stuck" — and they were verbs someone had to remember to
// run. This module makes the sweep a standing daemon loop's body: both halves swept on a
// config-keyed cadence, findings routed as durable rows to the owning seats, quiet sweeps
// cheap (one observable heartbeat, never a row), failures loud (named on the status surface).
//
// The verbs themselves are UNCHANGED — findOverdue/findUndelivered become this loop's
// library. Selection is by DESTINATION + obligation shape across ALL states, never by tag
// (the 0.5.3 custody-sweep lesson: tag sweeps miss founding rows; terminal states are read,
// not skipped). Sweep-finding rows self-exclude by their own stamp tag — exclusion, not
// selection.
//
// S01 seam (spec Amendment A1, cross-cited in both specs): the undelivered half SKIPS rows
// carrying a LIVE S01 wake-retry ladder — S01 records its ladder on the row's transitions
// exactly so this filter is derivable — and remains the net for what S01 excludes: the
// laddered-then-exhausted handback (exactly one finding, never double-reported) and
// created-with-destination obligations (S01's baton filter excludes them; the unclaimed
// net below sweeps them). S01 imports the marker vocabulary from HERE so the two slices
// share one contract instead of two guesses. S03 owns park/wake honesty: state=blocked rows
// legitimately wait and are never findings.

import { defaultResolveOrchestrator } from "./queue-owner.js";
import type Database from "better-sqlite3";
import { deriveCrossHostSuccessorId, hasLinkedSuccessor, matchesRecordedHandoffTarget, type QueueItem, type QueueRepository } from "./queue-repository.js";
import { stalledPickupFinding } from "./queue-pickup.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import { loadHostRegistry } from "./hosts/hosts-registry-reader.js";

export const STUCK_SWEEP_INTERVAL_KEY = "queue.stuck_sweep_interval_seconds";
export const DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS = 300;
export const STUCK_SWEEP_UNCLAIMED_AGE_KEY = "queue.stuck_sweep_unclaimed_age_minutes";
export const DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES = 60;
export const STUCK_SWEEP_CUSTODY_WINDOW_HOURS = 24;
// Queue churn A (cerebral-work fork): an undelivered-wake finding waits while the destination is refused at an
// interactive prompt or wrote a queue transition within the activity window, but only until the failed wake is
// older than the grace. Defaults are the 2026-10-18 measurement (vilicus churn baseline).
export const STUCK_SWEEP_UNDELIVERED_GRACE_KEY = "queue.stuck_sweep_undelivered_grace_minutes";
export const DEFAULT_STUCK_SWEEP_UNDELIVERED_GRACE_MINUTES = 10;
export const STUCK_SWEEP_OWNER_ACTIVE_KEY = "queue.stuck_sweep_owner_active_minutes";
export const DEFAULT_STUCK_SWEEP_OWNER_ACTIVE_MINUTES = 5;
// Queue churn B, ruling B2: finding rows stay, but the kinds that resolve themselves are created without a wake.
export const STUCK_SWEEP_QUIET_KINDS_KEY = "queue.stuck_sweep_quiet_kinds";
// A retry marker leases suppression; it is not proof that the ladder still runs.
// Thirty minutes allows several default five-minute ladder ticks. Expiry only
// restores reporting: it never retries delivery or acts on an interactive prompt.
export const STUCK_SWEEP_LADDER_MAX_AGE_MINUTES = 30;
const SWEEP_ACTOR = "stuck-sweep@system";

/** Stamp tag on every routed finding row: the sweep's self-exclusion mark. */
export const STUCK_SWEEP_FINDING_TAG = "stuck-sweep-finding";

// S01 ladder marker vocabulary (the seam contract). S01 writes these transition-note
// prefixes; the sweep derives "live ladder" from the latest marker. An attempt/rung is
// LIVE, an exhausted marker hands the row back, and a later attempt starts a live cycle
// again.
export const LADDER_ATTEMPT_PREFIX = "wake-attempt:";
export const LADDER_RUNG_PREFIX = "escalation-rung:";
export const LADDER_EXHAUSTED_PREFIX = "ladder-exhausted:";

export type StuckFindingKind =
  | "unconsumed-wait"
  | "overdue-claim"
  | "stalled-after-claim"
  | "undelivered-wake"
  | "unclaimed-obligation"
  | "dangling-closure";

export const DEFAULT_STUCK_SWEEP_QUIET_KINDS: readonly StuckFindingKind[] = ["dangling-closure", "undelivered-wake"];

/** Idempotency key: one open finding row per (stuck row, finding kind). */
export function findingDedupTag(kind: StuckFindingKind, qitemId: string): string {
  return `stuck-sweep:${kind}:${qitemId}`;
}

export interface StuckSweepStatusSnapshot {
  lastSweepAt: string | null;
  lastOutcome: "clean" | "findings" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  findingsRouted: number;
}

export interface StuckSweepStatus {
  record(outcome: "clean" | "findings" | "failed", detail?: { error?: string; findings?: number }): void;
  snapshot(): StuckSweepStatusSnapshot;
}

/** The loop's observable heartbeat — surfaced on /healthz so a quiet sweep is cheap but
 *  never invisible, and a failing sweep is loud without needing a row. */
export function createStuckSweepStatus(): StuckSweepStatus {
  const state: StuckSweepStatusSnapshot = {
    lastSweepAt: null,
    lastOutcome: null,
    lastError: null,
    consecutiveFailures: 0,
    findingsRouted: 0,
  };
  return {
    record(outcome, detail) {
      state.lastSweepAt = new Date().toISOString();
      state.lastOutcome = outcome;
      state.lastError = outcome === "failed" ? (detail?.error ?? "unknown error") : null;
      state.consecutiveFailures = outcome === "failed" ? state.consecutiveFailures + 1 : 0;
      if (detail?.findings) state.findingsRouted += detail.findings;
    },
    snapshot() {
      return { ...state };
    },
  };
}

/** Cadence, fresh-read with fail-open defaults (the queue-pickup precedent: a config flip
 *  applies to the next tick, and a settings error never silences the sweep). */
export function resolveStuckSweepIntervalSeconds(): number {
  try {
    const v = new SettingsStore().resolveOne(STUCK_SWEEP_INTERVAL_KEY as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS;
  } catch {
    return DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS;
  }
}

/** Queue churn R1 (cerebral-work fork): a churn window in minutes, where 0 means that fix is off. Shared by the
 *  sweep and the startup wiring of C and D. An unreadable setting falls back to the given default. */
export function resolveQueueMinutesSetting(key: string, fallback: number): number {
  try {
    const v = new SettingsStore().resolveOne(key as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function resolveStuckSweepUndeliveredGraceMinutes(): number {
  return resolveQueueMinutesSetting(STUCK_SWEEP_UNDELIVERED_GRACE_KEY, DEFAULT_STUCK_SWEEP_UNDELIVERED_GRACE_MINUTES);
}

export function resolveStuckSweepOwnerActiveMinutes(): number {
  return resolveQueueMinutesSetting(STUCK_SWEEP_OWNER_ACTIVE_KEY, DEFAULT_STUCK_SWEEP_OWNER_ACTIVE_MINUTES);
}

/** The finding kinds created without a wake. An unreadable setting falls back to the default list. */
export function resolveStuckSweepQuietKinds(): StuckFindingKind[] {
  try {
    const v = new SettingsStore().resolveOne(STUCK_SWEEP_QUIET_KINDS_KEY as never).value;
    return String(v ?? "").split(",").map((kind) => kind.trim()).filter(Boolean) as StuckFindingKind[];
  } catch {
    return [...DEFAULT_STUCK_SWEEP_QUIET_KINDS];
  }
}

export function resolveStuckSweepUnclaimedAgeMinutes(): number {
  try {
    const v = new SettingsStore().resolveOne(STUCK_SWEEP_UNCLAIMED_AGE_KEY as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES;
  } catch {
    return DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES;
  }
}

export interface StuckSweepDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  status?: StuckSweepStatus;
  /** Route resolution for obligations nobody holds: the destination seat's orchestrator
   *  (delegates_to parentage). null = no orchestrator known → the finding stays with the
   *  destination (the row is durable there even if the seat is dead — S01 is the wake
   *  layer). Injectable for tests; default derives from topology. */
  resolveOrchestrator?: (session: string) => string | null;
  unclaimedAgeMinutes?: number;
  /** Churn A: how long an undelivered-wake finding may wait for a refused or recently active destination. */
  undeliveredGraceMinutes?: number;
  /** Churn A: a destination queue transition within this window counts as activity. */
  ownerActiveMinutes?: number;
  /** Churn B2: finding kinds created without a wake. */
  quietKinds?: readonly StuckFindingKind[];
  custodyWindowHours?: number;
  now?: Date;
  log?: (line: string) => void;
  /** Is this host id (or observed self-id) present in the operator's hosts registry?
   *  One of TWO conjunct conditions for the proof-at-write disposition — the other is
   *  that the successor id recomputes through `deriveCrossHostSuccessorId` from the
   *  row's own fields, because the cross-host close (routes/queue.ts) creates the
   *  successor on that host FIRST and records the derived `<id>@<host>` only after that
   *  create succeeded, while the generic update path can store any string. Registry
   *  membership alone never suppresses. Injectable for tests; default reads the local
   *  hosts.yaml once per sweep pass, and an unavailable registry degrades honestly to
   *  verification-required (more indeterminate findings, never a false verdict). */
  isRegisteredHost?: (hostId: string) => boolean;
}

export interface StuckSweepFindingAction {
  kind: StuckFindingKind;
  qitemId: string;
  findingQitemId: string;
  action: "created" | "refreshed" | "closed";
}

export interface StuckSweepResult {
  outcome: "clean" | "findings" | "failed";
  findings: StuckSweepFindingAction[];
  error?: string;
}

export { resolveSessionNodeId, defaultResolveOrchestrator } from "./queue-owner.js";

interface TransitionNoteRow {
  transition_note: string | null;
}

/** The latest ladder marker is authoritative: a retry after exhaustion makes the
 *  ladder live again. Unrelated transitions do not change the latest marker. */
/** Durable custody-verification disposition: a transition note on the CLOSED source row,
 *  written by whoever performed the registered-host read (never by this detector),
 *  `custody-verified: <exact-target> <free-form how/where>`. Prefix-anchored parse; the
 *  target is the first whitespace-delimited token after the prefix, matched exactly.
 *  Read from the ACTIVE table AND the retention archive: the daily archiver MOVES every
 *  transition of an aged terminal qitem into `queue_transitions_archive` (the exact class
 *  custody rows belong to) while the row itself keeps participating in this sweep, so an
 *  active-only read would forget the disposition after the retention window and re-mint
 *  the very finding the verifier already answered. The archive is never deleted, so the
 *  union is the complete audit history. */
export const CUSTODY_VERIFIED_PREFIX = "custody-verified:";

function custodyVerifiedTargets(db: Database.Database, qitemId: string): Set<string> {
  const notes = db
    .prepare(
      `SELECT transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_note LIKE ?
       UNION ALL
       SELECT transition_note FROM queue_transitions_archive WHERE qitem_id = ? AND transition_note LIKE ?`,
    )
    .all(qitemId, `${CUSTODY_VERIFIED_PREFIX}%`, qitemId, `${CUSTODY_VERIFIED_PREFIX}%`) as TransitionNoteRow[];
  const verified = new Set<string>();
  for (const { transition_note: note } of notes) {
    if (!note) continue;
    const token = note.slice(CUSTODY_VERIFIED_PREFIX.length).trim().split(/\s+/)[0];
    if (token) {
      verified.add(token);
      for (const t of token.split(",")) {
        if (t.trim()) verified.add(t.trim());
      }
    }
  }
  return verified;
}

/** Default registry view for the proof-at-write arm: the operator's hosts.yaml, read
 *  lazily once per sweep pass. Registry unavailable → NO host is registered → every
 *  host-qualified target stays verification-required (honest degradation, logged once). */
function defaultIsRegisteredHost(log: (line: string) => void): (hostId: string) => boolean {
  let known: Set<string> | null | undefined;
  return (hostId: string) => {
    if (known === undefined) {
      const loaded = loadHostRegistry();
      if (loaded.ok) {
        known = new Set<string>();
        for (const host of loaded.registry.hosts) {
          known.add(host.id);
          if (host.hostId) known.add(host.hostId);
        }
      } else {
        known = null;
        log(`[stuck-sweep] host registry unavailable — host-qualified custody targets stay verification-required (${loaded.error})`);
      }
    }
    return known !== null && known.has(hostId);
  };
}

function hasLiveLadder(db: Database.Database, qitemId: string, now: Date): boolean {
  const notes = db
    .prepare("SELECT transition_note, ts FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC")
    .all(qitemId) as Array<TransitionNoteRow & { ts: string }>;
  for (const { transition_note: note, ts } of notes) {
    if (!note) continue;
    if (note.startsWith(LADDER_EXHAUSTED_PREFIX)) return false;
    if (note.startsWith(LADDER_ATTEMPT_PREFIX) || note.startsWith(LADDER_RUNG_PREFIX)) {
      const age = now.getTime() - Date.parse(ts);
      return age >= 0 && age < STUCK_SWEEP_LADDER_MAX_AGE_MINUTES * 60_000;
    }
  }
  return false;
}

/** Whether the time is less than `windowMs` before now. An absent or unreadable time is never recent. */
function withinMs(iso: string | null | undefined, now: Date, windowMs: number): boolean {
  if (!iso) return false;
  const then = Date.parse(iso);
  return !Number.isNaN(then) && now.getTime() - then < windowMs;
}

/** The transport's refusal of a seat at a permission or selection prompt (session-transport.ts). */
function refusedAtInteractivePrompt(nudgeResult: string | null | undefined): boolean {
  return !!nudgeResult && /Refused:.*interactive prompt/.test(nudgeResult);
}

function lastTransitionBy(db: Database.Database, session: string): string | null {
  const row = db.prepare("SELECT MAX(ts) AS ts FROM queue_transitions WHERE actor_session = ?").get(session) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

function minutesSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.round((now.getTime() - then) / 60_000));
}

function lastTransitionLine(db: Database.Database, qitemId: string): string {
  const row = db
    .prepare(
      `SELECT ts, transition_note FROM queue_transitions
        WHERE qitem_id = ? AND actor_session NOT IN ('watchdog@system', 'wake-ladder@system', 'daemon@kernel', 'daemon@system')
        ORDER BY transition_id DESC LIMIT 1`,
    )
    .get(qitemId) as { ts: string; transition_note: string | null } | undefined;
  if (row) return `${row.transition_note ?? "(no note)"} at ${row.ts}`;
  const anyRow = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1")
    .get(qitemId) as { ts: string; transition_note: string | null } | undefined;
  return anyRow ? `${anyRow.transition_note ?? "(no note)"} at ${anyRow.ts}` : "(no transitions)";
}

interface Candidate {
  kind: StuckFindingKind;
  row: QueueItem;
  route: string;
  ageMinutes: number;
  /** Per-kind evidence watermark. A closed finding suppresses only evidence at
   *  or below this timestamp; newer evidence earns one new finding. */
  evidenceAt: string;
  why: string;
  verificationTargets?: string[];
}

function isFindingRow(item: QueueItem): boolean {
  return (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG);
}

function latestIso(...values: Array<string | null | undefined>): string {
  let latest: { iso: string; time: number } | undefined;
  for (const iso of values) {
    if (!iso) continue;
    const time = Date.parse(iso);
    if (!Number.isNaN(time) && (!latest || time > latest.time)) latest = { iso, time };
  }
  return latest?.iso ?? new Date(0).toISOString();
}

function evidenceIsNewer(evidenceAt: string, closedAt: string): boolean {
  const evidence = Date.parse(evidenceAt);
  const closed = Date.parse(closedAt);
  return !Number.isNaN(evidence) && !Number.isNaN(closed) && evidence > closed;
}

export function verificationCommand(target: string, isRow = false): string {
  if (isRow || target.startsWith("qitem-")) {
    const successorId = target.split("@", 1)[0] ?? target;
    return `OPENRIG_URL=<registered-host> rig queue show ${successorId}`;
  }
  if (target === "(unspecified)") {
    return "OPENRIG_URL=<registered-host> rig queue list";
  }
  return `OPENRIG_URL=<registered-host> rig queue list --destination ${target}`;
}

function evidenceBody(db: Database.Database, c: Candidate): string {
  if (c.verificationTargets?.length) {
    const checks = c.verificationTargets
      .map((target) => `- ${target}\n  ${verificationCommand(target, Boolean(db.prepare("SELECT 1 FROM queue_items WHERE qitem_id = ?").get(target)))}`)
      .join("\n");
    return (
      `STUCK SWEEP FINDING (successor-verification-required)\n` +
      `row: ${c.row.qitemId}\n` +
      `destination: ${c.row.destinationSession} (source ${c.row.sourceSession}, state ${c.row.state})\n` +
      `age: ${c.ageMinutes} min\n` +
      `last transition: ${lastTransitionLine(db, c.row.qitemId)}\n` +
      `why: ${c.why}\n` +
      `verification targets (indeterminate until checked on the registered host):\n${checks}\n` +
      `After a registered-host read confirms a target, record it durably on the closed row so the sweep stops asking:\n` +
      `  rig queue update ${c.row.qitemId} --note "custody-verified: <target> <how verified>"\n` +
      `Do not rewrite historical custody from this local observation; record the verification result separately.`
    );
  }
  return (
    `STUCK SWEEP FINDING (${c.kind})\n` +
    `row: ${c.row.qitemId}\n` +
    `destination: ${c.row.destinationSession} (source ${c.row.sourceSession}, state ${c.row.state})\n` +
    `age: ${c.ageMinutes} min\n` +
    `last transition: ${lastTransitionLine(db, c.row.qitemId)}\n` +
    `why: ${c.why}\n` +
    `Resolve the underlying row; the sweep closes this finding itself once the row is no longer stuck.`
  );
}

/**
 * One sweep pass. Instance-wide (no rig scope — the loop is the net for every rig the
 * daemon carries). Never throws: a sweep that cannot run reports outcome=failed loudly
 * on the status surface and the log, because a silent skip is exactly the class this
 * slice exists to kill.
 */
export async function runStuckSweep(deps: StuckSweepDeps): Promise<StuckSweepResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const status = deps.status;
  try {
    const now = deps.now ?? new Date();
    const ageMinutes = deps.unclaimedAgeMinutes ?? resolveStuckSweepUnclaimedAgeMinutes();
    const undeliveredGraceMs = (deps.undeliveredGraceMinutes ?? resolveStuckSweepUndeliveredGraceMinutes()) * 60_000;
    const ownerActiveMs = (deps.ownerActiveMinutes ?? resolveStuckSweepOwnerActiveMinutes()) * 60_000;
    const quietKinds = new Set(deps.quietKinds ?? resolveStuckSweepQuietKinds());
    const resolveOrch =
      deps.resolveOrchestrator ?? ((session: string) => defaultResolveOrchestrator(deps.db, session));
    const isRegisteredHost = deps.isRegisteredHost ?? defaultIsRegisteredHost(log);
    const candidates: Candidate[] = [];

    // Half 1 — claimed-never-closed. The claimant holds the obligation; the finding
    // routes to them.
    for (const row of deps.queueRepo.findOverdue({ now: now.toISOString() })) {
      if (isFindingRow(row)) continue;
      candidates.push({
        kind: "overdue-claim",
        row,
        route: row.destinationSession,
        ageMinutes: minutesSince(row.closureRequiredAt ?? row.claimedAt, now),
        evidenceAt: latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.closureRequiredAt, row.claimedAt),
        why: "claimed and past closure_required_at with no closure",
      });
      try {
        deps.queueRepo.recordClosureOverdue(row.qitemId, { now: now.toISOString() });
      } catch (err) {
        log(`[stuck-sweep] failed to record closure-overdue for ${row.qitemId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // S04 seam — a claimed row with no later motion past the pickup threshold. The
    // pickup module remains the ONE derivation rule; this loop only enumerates and routes.
    const claimedRows = deps.db
      .prepare("SELECT qitem_id FROM queue_items WHERE state = 'in-progress' AND claimed_at IS NOT NULL")
      .all() as Array<{ qitem_id: string }>;
    for (const { qitem_id } of claimedRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const stalled = stalledPickupFinding(row);
      if (!stalled) continue;
      candidates.push({
        kind: stalled.kind,
        row,
        route: resolveOrch(stalled.target) ?? stalled.target,
        ageMinutes: minutesSince(row.claimedAt, now),
        // Keep this null arm for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row;
        // it is the first honest row-scoped writer, and wiring reopens only in that slice.
        evidenceAt: latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.lastHeartbeat, row.claimedAt),
        why: stalled.evidence,
      });
    }

    // The timer delivered one transition-specific notice (or recorded a failed
    // attempt). This existing sweep owns its bounded recovery, not another full
    // packet or a parked-owner replay. A real owner response ends the occurrence.
    const waitJobs = deps.db.prepare("SELECT job_id, spec_yaml FROM watchdog_jobs WHERE state = 'active' AND policy = 'periodic-reminder'").all() as Array<{ job_id: string; spec_yaml: string }>;
    for (const job of waitJobs) {
      const notice = queueWaitNotice(job.spec_yaml);
      if (!notice || now.getTime() - Date.parse(notice.at) <= resolvePickupThresholdMinutes() * 60_000) continue;
      const binding = deps.db.prepare("SELECT qitem_id FROM queue_transition_wakes WHERE wake_ref = ? AND phase = 'armed' ORDER BY transition_id DESC LIMIT 1").get(job.job_id) as { qitem_id: string } | undefined;
      const row = binding ? deps.queueRepo.getById(binding.qitem_id) : null;
      if (!row || row.state !== "blocked" || deps.queueRepo.getParkWakeStatus(row.qitemId)?.ref !== job.job_id) continue;
      const response = lastMeaningfulTransition(deps.db, row.qitemId);
      if (response && Date.parse(response.at) > Date.parse(notice.at)) continue;
      const ownerActivity = deps.queueRepo.ownerActivity(row.destinationSession);
      if (ownerActivity?.activity === "working" && !ownerActivity.needsInput.count && notice.deliveryStatus === "ok") continue;
      candidates.push({ kind: "unconsumed-wait", row, route: resolveOrch(row.destinationSession) ?? row.sourceSession,
        ageMinutes: minutesSince(notice.at, now), evidenceAt: notice.at,
        why: `wait notice delivery=${notice.deliveryStatus}; no later owner response; activity=${ownerActivity?.activity ?? "unknown"}; inspect exact blocker ${row.blockedOn}` });
    }

    // Half 2 — sender-believed-delivered-never-woken. Nobody holds it (the wake failed),
    // so it routes to the destination's orchestrator when one is derivable. Rows with a
    // live S01 ladder are S01's territory; an exhausted ladder is the handback and lands
    // here exactly once (the dedup tag keeps it to one finding).
    const undeliveredRows = deps.queueRepo.findUndelivered();
    const undeliveredIds = new Set(undeliveredRows.map((row) => row.qitemId));
    for (const row of undeliveredRows) {
      if (isFindingRow(row)) continue;
      if (hasLiveLadder(deps.db, row.qitemId, now)) continue;
      // Churn A: a destination refused at an interactive prompt, or one that wrote a queue transition within the
      // activity window, is not stuck yet. The wait lasts only until the failed wake is older than the grace.
      // A window of 0 is off, unconditionally (a time ahead of a stepped-back clock must not hold anything).
      if (undeliveredGraceMs > 0 && withinMs(row.lastNudgeAttempt ?? row.tsUpdated, now, undeliveredGraceMs)
        && (refusedAtInteractivePrompt(row.lastNudgeResult)
          || (ownerActiveMs > 0 && withinMs(lastTransitionBy(deps.db, row.destinationSession), now, ownerActiveMs)))) continue;
      candidates.push({
        kind: "undelivered-wake",
        row,
        route: resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(row.tsCreated, now),
        evidenceAt: latestIso(row.tsUpdated, row.lastNudgeAttempt),
        why: `wake failed (${row.lastNudgeResult ?? "failed"}) and nothing retried it`,
      });
    }

    // The A1 net — created-with-destination rows carrying real obligations, unclaimed past
    // the config-keyed age. Parks (state=blocked) legitimately wait and never appear here;
    // failed-nudge rows already surfaced in half 2; laddered rows are S01's.
    const cutoff = new Date(now.getTime() - ageMinutes * 60_000).toISOString();
    const unclaimedRows = deps.db
      .prepare(
        `SELECT qitem_id FROM queue_items
          WHERE state = 'pending'
            AND claimed_at IS NULL
            AND destination_session IS NOT NULL AND destination_session != ''
            AND ts_created <= ?
            AND (last_nudge_result IS NULL OR last_nudge_result NOT LIKE 'failed:%')`,
      )
      .all(cutoff) as Array<{ qitem_id: string }>;
    for (const { qitem_id } of unclaimedRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const actionableAt = pendingSince(deps.db, row.qitemId) ?? row.tsCreated;
      if (actionableAt > cutoff) continue;
      if (hasLiveLadder(deps.db, row.qitemId, now)) continue;
      // #514 — an ask already posted to its registered human in the current delivery episode waits on
      // that human; it is not stuck, and a finding would post the human again. Unposted, failed,
      // legacy and non-human rows keep this net.
      if (deps.queueRepo.humanNotificationPostedThisEpisode(row.qitemId)) continue;
      candidates.push({
        kind: "unclaimed-obligation",
        row,
        route: resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(actionableAt, now),
        evidenceAt: actionableAt,
        why: `actionable with a destination and unclaimed for ${minutesSince(actionableAt, now)} min (threshold ${ageMinutes})`,
      });
    }

    // The custody class — a terminal row whose closure names one or more successor
    // qitems or seat-address targets (closure_reason = 'handed_off_to'). A local miss is
    // never proof of absence: the successor may live in another registered host's database.
    // Comma fan-out is checked member-by-member and only unresolved members are reported.
    // Three dispositions satisfy a member without a local hit / check:
    // (1) proof-at-write — a REGISTERED host qualifier whose successor id RECOMPUTES
    // from this row's own (qitem_id, handed_off_to, host) through the same deterministic
    // derivation the cross-host close uses. The close path records that key only AFTER
    // its forwarded successor-create succeeded, and the generic update path (which
    // accepts arbitrary closure targets) cannot accidentally synthesize the sha256-derived
    // id — registered-host SYNTAX alone is never trusted;
    // (2) linked local successor for seat targets — a row in the local store whose
    // destination matches the target seat and carries this source row's lineage (either
    // handed_off_from or chain_of_record); and
    // (3) a durable `custody-verified:` transition note written on the source row by
    // whoever performed the registered-host read (read from active + archived transitions).
    // Historical source rows are never mutated by this detector — the disposition note is the
    // verifier's act, not ours.
    // Internal handoffs record handed_off_to. A generic reclose can retain an old
    // owner, so skip only recorded handoffs whose current target still matches (#341).
    // Closures outside the recent 24-hour window without open findings are skipped so upgrading
    // a real queue history does not raise a flood of historical findings.
    const custodyHours = deps.custodyWindowHours ?? STUCK_SWEEP_CUSTODY_WINDOW_HOURS;
    const custodyCutoff = new Date(now.getTime() - custodyHours * 3_600_000).toISOString();
    const openDanglingIds: string[] = [];
    const danglingPrefix = "stuck-sweep:dangling-closure:";
    for (const { tags } of deps.db
      .prepare(`SELECT tags FROM queue_items WHERE state IN ('pending', 'in-progress', 'blocked') AND tags LIKE ?`)
      .all(`%"${danglingPrefix}%`) as Array<{ tags: string }>) {
      try {
        for (const tag of JSON.parse(tags) as string[]) {
          if (tag.startsWith(danglingPrefix)) {
            openDanglingIds.push(tag.slice(danglingPrefix.length));
          }
        }
      } catch {
        // Skip malformed tags
      }
    }
    const custodyRows = deps.db
      .prepare(
        // Bound candidates before checking state: including handed-off in the
        // state index scan would otherwise revisit all historical atomic handoffs.
        `WITH custody_candidates AS MATERIALIZED (
           SELECT qitem_id, state, handed_off_to, closure_target, closure_reason
             FROM queue_items WHERE ts_updated >= ?
           UNION
           SELECT qitem_id, state, handed_off_to, closure_target, closure_reason
             FROM queue_items WHERE qitem_id IN (SELECT value FROM json_each(?))
         )
         SELECT q.qitem_id FROM custody_candidates q
          WHERE (q.state IN ('done', 'canceled') OR (q.state = 'handed-off'
            AND (q.handed_off_to IS NULL OR q.closure_target IS NOT q.handed_off_to)))
            AND (q.closure_target LIKE 'qitem-%' OR q.closure_reason = 'handed_off_to')`,
      )
      .all(custodyCutoff, JSON.stringify(openDanglingIds)) as Array<{ qitem_id: string }>;
    for (const { qitem_id } of custodyRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      // Local recorded targets were filtered in SQL; remote keys use the same
      // derivation as the cross-host close, without reading successor history.
      if (row.state === "handed-off" && matchesRecordedHandoffTarget(row.qitemId, row.handedOffTo, row.closureTarget)) continue;
      const targets = (row.closureTarget ?? row.handedOffTo ?? "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean);
      if (targets.length === 0 && row.closureReason === "handed_off_to") {
        targets.push("(unspecified)");
      }
      const verified = custodyVerifiedTargets(deps.db, row.qitemId);
      const verificationTargets = targets.filter((target) => {
        if (verified.has(target)) return false;
        if (target.startsWith("qitem-")) {
          const at = target.indexOf("@");
          if (at !== -1) {
            const hostId = target.slice(at + 1);
            const successorId = target.slice(0, at);
            return !(
              isRegisteredHost(hostId) &&
              row.handedOffTo !== null &&
              successorId === deriveCrossHostSuccessorId(row.qitemId, row.handedOffTo, hostId)
            );
          }
          if (target === row.qitemId) return true;
          return !deps.queueRepo.getById(target);
        }
        // Spec 0011: a custom-id successor row is a row, not a seat.
        if (deps.queueRepo.getById(target)) return false;
        try {
          return !hasLinkedSuccessor(deps.db, row.qitemId, target);
        } catch {
          return true;
        }
      });
      if (verificationTargets.length === 0) continue;
      candidates.push({
        kind: "dangling-closure",
        row,
        route: row.destinationSession,
        ageMinutes: minutesSince(row.tsUpdated, now),
        evidenceAt: latestIso(row.tsUpdated),
        why: `closed (${row.closureReason ?? "?"}) with successor custody that this local store cannot fully verify`,
        verificationTargets,
      });
    }

    // Route: idempotent per (row, kind). An existing open finding refreshes its age; a
    // new one is created durable + waking (the create path's default nudge).
    const findings: StuckSweepFindingAction[] = [];
    const liveDedupTags = new Set<string>();
    for (const c of [...new Map(candidates.map(c => [c.row.qitemId, c])).values()]) {
      const dedupTag = findingDedupTag(c.kind, c.row.qitemId);
      const shared = findQueueRecovery(deps.db, c.row.qitemId);
      if (shared) {
        const existingTags = deps.queueRepo.getById(shared.qitemId)?.tags ?? [];
        for (const tag of existingTags) if (tag.startsWith("stuck-sweep:")) liveDedupTags.add(tag);
        if (["pending", "in-progress", "blocked"].includes(shared.state)) findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: shared.qitemId, action: "refreshed" });
        continue;
      }
      liveDedupTags.add(dedupTag);
      const existing = deps.db
        .prepare(
          // The first term is implied by the second (its pattern starts with that literal); it lets
          // the planner use idx_queue_items_recovery_tags (migration 099) instead of a full scan.
          `SELECT qitem_id, source_session, state, ts_updated FROM queue_items
            WHERE (tags LIKE '%"stuck-sweep:%') AND tags LIKE ?
            ORDER BY CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END,
                     ts_updated DESC, ts_created DESC, qitem_id DESC
            LIMIT 1`,
        )
        .get(`%"${dedupTag}"%`) as
        | { qitem_id: string; source_session: string; state: string; ts_updated: string }
        | undefined;
      const existingIsOpen = existing && ["pending", "in-progress", "blocked"].includes(existing.state);
      if (existing && existingIsOpen) {
        // Age is derived at read time; an unchanged scan is not a transition.
        findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: existing.qitem_id, action: "refreshed" });
      } else if (!existing || evidenceIsNewer(c.evidenceAt, existing.ts_updated)) {
        const created = await deps.queueRepo.create({
          qitemId: recoveryId(deps.db, c.row.qitemId),
          // The detector is machinery, not a seat: the obligation's own creator is the
          // finding's source (the workflow-exception precedent).
          sourceSession: c.row.sourceSession,
          destinationSession: c.route,
          body: evidenceBody(deps.db, c),
          summary: `Stuck sweep: ${c.verificationTargets ? "successor-verification-required" : c.kind} on ${c.row.qitemId} (${c.ageMinutes} min)`,
          evidenceRef: `rig queue show ${c.row.qitemId}`,
          tags: [STUCK_SWEEP_FINDING_TAG, dedupTag, recoveryTag(c.row.qitemId)],
          // Churn B2: the kinds that resolve themselves are recorded without a wake.
          ...(quietKinds.has(c.kind) ? { nudge: false } : {}),
        });
        findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: created.qitemId, action: "created" });
      }
    }

    // Suppression decides whether to route a new finding, never whether the source
    // has resolved. In particular a live ladder or a changed age threshold can
    // remove a pending row from candidates without delivery or pickup occurring.
    const openFindings = deps.db
      .prepare(
        `SELECT qitem_id, tags FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND tags LIKE ?`,
      )
      .all(`%"${STUCK_SWEEP_FINDING_TAG}"%`) as Array<{ qitem_id: string; tags: string }>;
    for (const f of openFindings) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(f.tags) as string[];
      } catch {
        continue;
      }
      const dedupTag = tags.find((t) => t.startsWith("stuck-sweep:"));
      if (!dedupTag || liveDedupTags.has(dedupTag)) continue;
      const [, kind, stuckId] = dedupTag.match(/^stuck-sweep:([a-z-]+):(.+)$/) ?? [];
      if (!kind || !stuckId) continue;
      const source = deps.queueRepo.getById(stuckId);
      if (!source) continue; // a missing row is not resolution evidence
      const humanPosted = deps.queueRepo.humanNotificationPostedThisEpisode(stuckId);
      if (kind === "undelivered-wake" && ["pending", "in-progress", "blocked"].includes(source.state)) {
        if (undeliveredIds.has(stuckId)) continue;
        const claimed = source.state === "in-progress" && source.claimedAt !== null;
        // A human notification is scoped to its current episode. A terminal ACK
        // pending/indeterminate result is deliberately not delivery proof.
        if (!claimed && source.lastNudgeResult !== "verified" && !humanPosted) continue;
      }
      if (kind === "unclaimed-obligation" && source.state === "pending" && !source.claimedAt && !humanPosted) continue;
      await deps.queueRepo.update({
        qitemId: f.qitem_id,
        actorSession: SWEEP_ACTOR,
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: `stuck-sweep resolved: ${kind} on ${stuckId}; source state=${source.state}, claimed=${source.claimedAt !== null}, wake=${source.lastNudgeResult ?? "unknown"}, human-posted=${humanPosted}`,
      });
      if (kind && stuckId) {
        findings.push({
          kind: kind as StuckFindingKind,
          qitemId: stuckId,
          findingQitemId: f.qitem_id,
          action: "closed",
        });
      }
    }

    const outcome = findings.length > 0 ? "findings" : "clean";
    status?.record(outcome, { findings: findings.filter((f) => f.action !== "closed").length });
    return { outcome, findings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Loud, never silent: the failure lands on the log AND the status surface (healthz).
    log(`[stuck-sweep] SWEEP FAILED (skipping this tick loudly): ${message}`);
    status?.record("failed", { error: message });
    return { outcome: "failed", findings: [], error: message };
  }
}
