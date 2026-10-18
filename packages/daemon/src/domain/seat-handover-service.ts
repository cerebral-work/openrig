import type Database from "better-sqlite3";
import { readSeatEffort } from "./seat-effort.js";
import { NativePermissionStore } from "./native-permission-store.js";
import { ulid } from "ulid";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { SeatStatusService, type SeatStatus, type SeatStatusResult } from "./seat-status-service.js";
import { SeatHandoverPlanner, parseHandoverSource, SEAT_HANDOVER_SOURCE_CAPABILITIES, type SeatHandoverPlan, type SeatHandoverSource } from "./seat-handover-planner.js";
import { discoverResumeToken } from "./agent-images/resume-token-discovery.js";
import { resolveRebuildArtifacts } from "./session-source-rebuild-resolver.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { RigSpecCodec as PodRigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema as PodRigSpecSchema } from "./rigspec-schema.js";
import type { PodRigInstantiator } from "./rigspec-instantiator.js";
import type { RigSpec as PodRigSpec, RigSpecPod, RigSpecPodMember } from "./types.js";
import { mergeSeatEnv, parseSeatEnvAssignment, parseStoredSeatEnv, type SeatEnv } from "./seat-env.js";
import { isSecretSeatEnvName } from "./seat-launch-env-filter.js";
import type { NativePermissionSelection } from "./native-permission-selection.js";
import { NodeRuntimeChangeLedger, envFingerprint, type RevertBefore, type RuntimeSide } from "./node-runtime-changes.js";
import { partitionStartupFiles, persistStartupContext } from "./startup-orchestrator.js";
import type { ProjectionPlan } from "./projection-planner.js";
import type { NodeBinding, ResolvedStartupFile } from "./runtime-adapter.js";
import type { StartupAction } from "./types.js";
import { SuccessorSessionLauncher } from "./successor-session-launcher.js";
import { deriveResumeToken, type ResumeTokenCaptureDeps } from "./resume-token-capture.js";
import { validateResumeToken } from "./resume-token-validation.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import type { JsonlExchange } from "./session-jsonl.js";
import type { PersistedEvent } from "./types.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import { findOtherSessionOwner } from "./session-owner.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import { seatCorePluginDir, withCorePlugin } from "./claude-core-plugin-env.js";

/** A bounded labeled-from-record recap of the predecessor's last exchanges + the record path,
 *  resolved from the predecessor's provider transcript (claude transcript_path / codex rollout_path).
 *  The permanent claude-runtime leg of scrollback preservation (alternate-screen seats keep no
 *  native scrollback); renders on codex seats too, where native scrollback is the money proof. */
export interface PredecessorRecap {
  recap: JsonlExchange[];
  recordPath: string;
}
/** B16 — every no-recap outcome is NAMED: the resolver returns either the recap or the reason it
 *  is unavailable, and the packet prints that reason (honest-degraded means labeled, not silent). */
export type PredecessorRecapResolution = PredecessorRecap | { unavailableReason: string };

/** Resolve the predecessor's bounded recap for the successor boot packet, or a named unavailable
 *  verdict (never a silent null — the packet renders the reason). */
export type PredecessorRecapResolver = (args: {
  nodeId: string;
  runtime: string | null;
  sessionName: string;
}) => PredecessorRecapResolution;

/** Spec 0005 (cerebral-work fork): a runtime change requested on `rig seat handover`. */
export interface RuntimeChangeRequest {
  toRuntime: string;
  toModel?: string | null;
  /** A mode the target runtime takes, or "inherit". Required: an inherited default is confirmed, never implied. */
  toPermissions?: string | null;
  toEffort?: string | null;
  toCwd?: string | null;
  /** NAME=VALUE assignments; when given they replace the member env. Secret-named names are refused. */
  toEnv?: string[] | null;
  /** The rig spec of record: its member at the seat's logical id must declare the target (D2). */
  spec?: { path: string; yaml: string } | null;
  /** Christian's go, recorded verbatim as attribution, not proof. */
  approval?: string | null;
}

/** The transport identity that issued a request (X-OpenRig-Session) and its provenance. On a loopback daemon with no
 *  caller authentication this is attribution, not authentication. */
export interface HandoverCaller {
  session: string;
  provenance: string;
}

/** The member-startup steps of a launch, used to start a runtime change's target member the way a launch would. */
export type MemberStartupResolver = Pick<PodRigInstantiator,
  "resolveMemberConfig" | "reconcileMemberSkills" | "planMemberStartup" | "resolveMemberStarterFiles" | "memberStartupActions">;

type MemberConfig = Extract<ReturnType<MemberStartupResolver["resolveMemberConfig"]>, { ok: true }>;

/** A validated runtime change or revert, ready to execute. Nothing has been changed yet. */
interface PreparedRuntimeChange {
  kind: "change" | "revert";
  nodeId: string;
  seatRef: string;
  revertsChangeId: string | null;
  from: RuntimeSide;
  to: RuntimeSide;
  /** nodes.effort, nodes.effort_choice and nodes.codex_config_profile after the commit. */
  toAuthoredEffort: string | null;
  toEffortChoice: string | null;
  toCodexProfile: string | null;
  /** The permission selection after the commit, or null for inherit. */
  toPermissionRow: RevertBefore["permission"];
  launchOverride: ReturnType<NativePermissionStore["launchOverride"]>;
  adapter: RuntimeAdapter;
  startup:
    | { kind: "member"; member: RigSpecPodMember; config: MemberConfig; plan: ProjectionPlan; files: ResolvedStartupFile[];
        actions: StartupAction[]; preLaunchFiles: ResolvedStartupFile[]; postLaunchFiles: ResolvedStartupFile[] }
    | { kind: "saved"; context: RevertBefore["startupContext"] };
  specPath: string | null;
  specSha256: string | null;
  approval: string;
  operator: string;
  before: RevertBefore;
  resumeToken: string | null;
  leftovers: string[];
  /** How far this attempt got, so a thrown failure is still recorded; recorded is set once a ledger row exists, and
   *  committed only once the commit transaction has returned. */
  progress: { step: string; replacementStarted: boolean; recorded: boolean; committed: boolean };
  /** A revert issued by the kernel's advisor (D3's exception); its pending declaration is the advisor's to finish too. */
  issuedByAdvisor: boolean;
}

export interface SeatHandoverInput {
  seatRef: string;
  reason?: string | null;
  source?: string | null;
  operator?: string | null;
  dryRun?: boolean;
  /** Spec 0005 — change the seat's runtime with this handover. */
  runtimeChange?: RuntimeChangeRequest | null;
  /** The caller's transport identity; a runtime change needs the kernel operator's (D3). */
  caller?: HandoverCaller | null;
}

/** A revert's commit found the revert slot replaced or cleared since the revert was built. */
class RevertSlotMovedError extends Error {}

/** What a failed runtime change leaves the operator to do: nothing, check whether the predecessor still runs, or relaunch. */
type RuntimeChangeRecovery = "none" | "check-seat" | "relaunch" | "relaunch-check-seat-env" | "fix-seat-env";

function runtimeSideOf(state: RevertBefore): RuntimeSide {
  return {
    runtime: state.runtime, model: state.model, cwd: state.cwd, effort: state.effortChoice ?? state.effort,
    permission: state.permission?.mode ?? null, env: parseStoredSeatEnv(state.envJson),
  };
}

function sameEnv(a: SeatEnv | null | undefined, b: SeatEnv | null | undefined): boolean {
  const sorted = (env: SeatEnv | null | undefined) => JSON.stringify(Object.entries(env ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  return sorted(a) === sorted(b);
}

export interface RuntimeChangeSummary {
  kind: "change" | "revert";
  from: Omit<RuntimeSide, "env"> & { env: Array<{ name: string; sha256: string }> | null };
  to: Omit<RuntimeSide, "env"> & { env: Array<{ name: string; sha256: string }> | null };
  /** What inherit resolves to on the target runtime, when the permission is inherit (D4). */
  inheritResolvesTo?: ReturnType<NativePermissionStore["launchOverride"]>;
  specPath: string | null;
  specSha256: string | null;
  approval: string;
  operator: string;
  /** The predecessor runtime's files left in place (not cleaned up). */
  leftovers: string[];
  resumesPredecessor: boolean;
}

/** Env names the runtime-change verb refuses: the estate's secret-name rule. Secrets travel by the credential channel. */
const RUNTIME_CHANGE_RUNTIMES = new Set(["codex", "claude-code"]);
const RUNTIME_CHANGE_PERMISSIONS = new Set(["inherit", "floor", "full_bypass"]);

export interface SeatHandoverMutationResult {
  ok: true;
  dryRun: false;
  mutated: true;
  continuityTransferred: false;
  seat: SeatHandoverPlan["seat"];
  // The source reported to the operator is the ORIGINAL intent
  // (fresh/rebuild/fork/discovered). Non-discovered sources are internally
  // routed through a created discovery candidate, but provenance stays honest.
  source: SeatHandoverSource;
  reason: string;
  operator: string | null;
  previousOccupant: string;
  currentOccupant: string;
  previousSessionIdsSuperseded: string[];
  newSessionId: string;
  discovery: {
    id: string;
    status: "claimed";
    tmuxSession: string;
    tmuxPane: string | null;
  };
  currentStatus: SeatHandoverPlan["currentStatus"];
  handoverAt: string;
  eventSeq: number;
  sideEffects: {
    departingSessionKilled: false;
    startupContextDelivered: boolean;
    provenanceRecordWritten: false;
  };
  /** OPR.0.5.5.5 — per-source execution outcome. fork: the resolved fork origin;
   *  rebuild: EXACTLY which durable artifacts primed the successor, which
   *  declared addresses were gaps, and (when the chain is empty) the named
   *  reason — recorded, never silently dropped. Absent for fresh/discovered. */
  sourceOutcome?:
    | { mode: "fork"; forkedFrom: string; forkId?: "captured" | "pending"; limit?: string }
    | { mode: "rebuild"; primedArtifacts: Array<{ address: string; label: string }>; gaps: string[]; emptyChainReason?: string };
  /** Spec 0005 — the committed runtime change or revert; acceptance by the successor is observed after commit. */
  runtimeChange?: RuntimeChangeSummary & { changeId: string; acceptance: "pending" };
}

export type SeatHandoverResult =
  | { ok: true; plan: SeatHandoverPlan & { runtimeChange?: RuntimeChangeSummary } }
  | { ok: true; result: SeatHandoverMutationResult }
  | { ok: false; code: "missing_reason" | "invalid_source" | "successor_creation_not_implemented" | "source_not_supported" | "resume_token_unavailable" | "fork_source_not_found"; message: string; guidance: string }
  | { ok: false; code: "current_occupant_required" | "discovered_not_active" | "successor_tmux_absent" | "successor_already_managed" | "successor_is_current" | "runtime_mismatch"; message: string; guidance: string }
  | { ok: false; code: "discovered_not_found"; message: string; guidance: string }
  | { ok: false; code: "tmux_probe_failed" | "handover_commit_failed" | "handover_committed_swap_undeclared" | "handover_committed_with_error" | "successor_create_failed" | "context_delivery_failed"; message: string; guidance: string }
  | { ok: false; code: "runtime_declare_not_pending" | "runtime_declare_failed"; message: string; guidance: string }
  | { ok: false; code: "runtime_change_unauthorized" | "runtime_change_invalid" | "runtime_change_secret_env" | "runtime_change_env_not_allowed" | "runtime_change_spec_mismatch" | "runtime_change_target_startup_failed" | "runtime_revert_unavailable"; message: string; guidance: string }
  | Extract<SeatStatusResult, { ok: false }>;

interface NodeRow {
  id: string;
  runtime: string | null;
  cwd: string | null;
  // 0.5.2-07: the seat's SPEC-pinned model, threaded onto the successor binding so handover
  // does not silently revert a spec-pinned seat to the runtime default (adapter emits -m/--model).
  model: string | null;
  // 0.5.2-07 A4-profile: the seat's SPEC-pinned codex config profile (nodes.codex_config_profile),
  // threaded onto the successor binding for the same reason as model — the adapter emits `-p <profile>`.
  codex_config_profile: string | null;
  // #75: the seat's authored reasoning effort (nodes.effort). The successor binding reads the shared
  // resolver (OPR.0.7.0.7: a saved seat choice first), not this column alone.
  effort: string | null;
}

interface SessionRow {
  id: string;
  session_name: string;
  status: string;
}

interface BindingOwnerRow {
  node_id: string;
  logical_id: string;
  rig_name: string;
}

interface SeatHandoverServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  successorLauncher?: SuccessorSessionLauncher;
  now?: () => Date;
  /** OpenRig identity/activity env stamped onto a created successor session,
   *  mirroring the launch identity env. Defaults to {} (the three core identity
   *  vars are always derived internally). */
  sessionEnv?: Record<string, string | undefined>;
  /** Extra env for one runtime only (OMP's provider keys), merged over sessionEnv. */
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
  /** Where the daemon vendors its plugins; default is `plugins` under the OpenRig home (tests). */
  pluginsDir?: string;
  /** Injectable id source for the successor session name (tests). */
  newSuccessorId?: () => string;
  /** Runtime adapters keyed by runtime — used to launch a fresh successor into
   *  a LIVE agent (B1) before commit. Absent → fresh handover cannot launch. */
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  /** Claude sidecar reader for discovered-mode resume-token capture (B2). */
  contextUsageStore?: ResumeTokenCaptureDeps["contextUsageStore"];
  /** #421 — start time of the pane's current Claude process; a sidecar sampled earlier is skipped. */
  claudeProcessStartedAt?: ResumeTokenCaptureDeps["claudeProcessStartedAt"];
  /** Codex thread-id capturer for discovered-mode resume-token capture (B2). */
  resumeTokenCapturer?: ResumeTokenCaptureDeps["resumeTokenCapturer"];
  /** OPR.0.4.6.PI1 FR-6 — pi-runner sidecar reader for Pi resume-token capture. */
  piRunnerStateStore?: ResumeTokenCaptureDeps["piRunnerStateStore"];
  /** OMP runner sidecar reader for independently isolated OMP seats. */
  ompRunnerStateStore?: ResumeTokenCaptureDeps["ompRunnerStateStore"];
  /** Agy PreInvocation-hook sidecar reader (deferred conversation-id capture). */
  agyStateStore?: ResumeTokenCaptureDeps["agyStateStore"];
  /** Readiness timeout for the successor launch (tests shorten it). */
  readinessTimeoutMs?: number;
  /** Injectable sleep for the successor readiness backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * OPR.0.4.6.02 S1 — the SHARED tmux option-defaults applier, threaded into
   * the successor launcher so a FRESH handover successor gets the same
   * mouse/status/clipboard defaults as a NodeLauncher-launched seat.
   */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
  /**
   * Ghost-stage (e) seam — the per-store retiring-occupant invalidator, authored by the ghost-stage
   * slice and CALLED once at commit() so the cutover successor never inherits a predecessor's seat-name-
   * keyed state. Optional: absent until the ghost-stage slice lands → the commit call is skipped (never
   * blocking the handover). See occupant-invalidator.ts.
   */
  occupantInvalidator?: OccupantInvalidator;
  /**
   * Resolves the predecessor's bounded from-record recap for the successor boot packet (claude
   * transcript_path / codex rollout_path → parseJsonlExchanges). Optional: absent → the recap
   * sections are omitted honestly. The recap is the permanent claude-runtime leg of scrollback
   * preservation (alternate-screen seats keep no native scrollback); on codex seats the preserved
   * native scrollback is the money proof. Wired in production to ContextUsageStore + parseJsonlExchanges.
   */
  predecessorRecapResolver?: PredecessorRecapResolver;
  /**
   * OPR.0.5.3.5 mini-req 7 — resolves the AUTHORED seat recap (RECAP.md beside LEARNED, written by
   * the outgoing occupant) for the successor packet's pointer leg. Optional: absent -> the authored
   * leg is omitted (the feature never ran); a resolver that finds nothing returns the labeled
   * absence. Wired in production to seat-recap-store + the topology.root seat layout.
   */
  authoredRecapResolver?: (seatRef: string) => { address: string; chainLength: number } | { absentReason: string };
  /**
   * S19 (territory ruling qitem-20260827001530, EXACT bounds): ONE narrow call into the
   * activity oracle at the completion/rebind commit point so seat-keyed activity state
   * treats the cutover as its own visible event and the successor's rung inventory
   * starts unpromoted (never inheriting the retiree's rung authority). Optional: absent
   * → skipped, never blocks a handover.
   */
  activityOracle?: { declareOccupantSwap: (seatNodeId: string, generation: string) => void };
  /**
   * OPR.0.5.5.5 — resolves the seat's durable rebuild-priming chain (authored
   * recap chain, LEARNED, restore-packet record) in trust-precedence order for
   * `--source rebuild`. Optional: absent → rebuild executes with a named empty
   * chain. Wired in production to seat-recap-store (listRecapChain) + the
   * topology.root seat layout.
   */
  rebuildPrimingResolver?: (seatRef: string) => { artifacts: Array<{ address: string; label: string }> } | { emptyReason: string };
  /** OPR.0.5.5.5 — filesystem existence check for declared rebuild artifacts
   *  (the session-source-rebuild-resolver seam). Default: node:fs existsSync;
   *  tests inject. */
  rebuildArtifactExists?: (path: string) => boolean;
  /** Spec 0005 — the member-startup steps (PodRigInstantiator) a runtime change starts its target with. Absent → a
   *  runtime change is refused on this daemon. */
  memberStartup?: MemberStartupResolver;
  /** Spec 0005 — the env names --to-env may set. Default: runtime.change_env_allowlist, read per request. */
  runtimeChangeEnvAllowlist?: () => string[];
}

export class SeatHandoverService {
  private db: Database.Database;
  private statusService: SeatStatusService;
  private planner: SeatHandoverPlanner;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private discoveryRepo: DiscoveryRepository;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private successorLauncher: SuccessorSessionLauncher;
  private captureDeps: ResumeTokenCaptureDeps;
  private occupantInvalidator: OccupantInvalidator | null;
  private predecessorRecapResolver: PredecessorRecapResolver | null;
  private memberStartup: MemberStartupResolver | null;
  private runtimeAdapters: Record<string, RuntimeAdapter> | undefined;
  private runtimeChangeEnvAllowlist: () => string[];
  private runtimeLedger: NodeRuntimeChangeLedger;
  private authoredRecapResolver: SeatHandoverServiceDeps["authoredRecapResolver"] | null;
  private activityOracle: SeatHandoverServiceDeps["activityOracle"] | null;
  private rebuildPrimingResolver: SeatHandoverServiceDeps["rebuildPrimingResolver"] | null;
  private rebuildArtifactExists: (path: string) => boolean;
  /** Injectable sleep (tests): also carries the shared paste-then-submit settle in deliverRestorePacket. */
  private sleep: (ms: number) => Promise<void>;
  private appliedLaunchObservations: AppliedLaunchObservationStore;
  private now: () => Date;
  private pluginsDir: string | undefined;

  constructor(deps: SeatHandoverServiceDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SeatHandoverService: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SeatHandoverService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.discoveryRepo.db) throw new Error("SeatHandoverService: discoveryRepo must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("SeatHandoverService: eventBus must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.memberStartup = deps.memberStartup ?? null;
    this.runtimeAdapters = deps.runtimeAdapters;
    this.runtimeChangeEnvAllowlist = deps.runtimeChangeEnvAllowlist ?? (() =>
      String(new SettingsStore().resolveOne("runtime.change_env_allowlist" as never).value ?? "").split(",").map((name) => name.trim()).filter(Boolean));
    this.runtimeLedger = new NodeRuntimeChangeLedger(deps.db);
    this.sessionRegistry = deps.sessionRegistry;
    this.discoveryRepo = deps.discoveryRepo;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.occupantInvalidator = deps.occupantInvalidator ?? null;
    this.activityOracle = deps.activityOracle ?? null;
    this.predecessorRecapResolver = deps.predecessorRecapResolver ?? null;
    this.authoredRecapResolver = deps.authoredRecapResolver ?? null;
    this.rebuildPrimingResolver = deps.rebuildPrimingResolver ?? null;
    this.rebuildArtifactExists = deps.rebuildArtifactExists ?? existsSync;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.appliedLaunchObservations = new AppliedLaunchObservationStore(deps.db);
    this.now = deps.now ?? (() => new Date());
    this.pluginsDir = deps.pluginsDir;
    this.statusService = new SeatStatusService({ rigRepo: deps.rigRepo });
    this.planner = new SeatHandoverPlanner({ rigRepo: deps.rigRepo });
    this.successorLauncher = deps.successorLauncher ?? new SuccessorSessionLauncher(deps.tmuxAdapter, deps.discoveryRepo, {
      sessionEnv: deps.sessionEnv,
      runtimeSessionEnv: deps.runtimeSessionEnv,
      newId: deps.newSuccessorId,
      runtimeAdapters: deps.runtimeAdapters,
      readinessTimeoutMs: deps.readinessTimeoutMs,
      sleep: deps.sleep,
      tmuxOptionDefaults: deps.tmuxOptionDefaults,
    });
    this.captureDeps = {
      contextUsageStore: deps.contextUsageStore ?? null,
      claudeProcessStartedAt: deps.claudeProcessStartedAt ?? null,
      resumeTokenCapturer: deps.resumeTokenCapturer ?? null,
      piRunnerStateStore: deps.piRunnerStateStore ?? null,
      ompRunnerStateStore: deps.ompRunnerStateStore ?? null,
      agyStateStore: deps.agyStateStore ?? null,
    };
  }

  async handover(input: SeatHandoverInput): Promise<SeatHandoverResult> {
    if (input.dryRun && !input.runtimeChange) {
      const planResult = this.planner.plan({ ...input, dryRun: true });
      if (planResult.ok) {
        return { ok: true, plan: planResult.plan };
      }
      switch (planResult.code) {
        case "mutation_disabled":
          return {
            ok: false,
            code: "successor_creation_not_implemented",
            message: "Seat handover mutation is not available through dry-run planning.",
            guidance: "Re-run with --dry-run to inspect the two-phase handover plan without changing topology.",
          };
        case "missing_reason":
        case "invalid_source":
          return {
            ok: false,
            code: planResult.code,
            message: planResult.message,
            guidance: planResult.guidance,
          };
        case "seat_ref_required":
        case "seat_not_found":
        case "seat_ambiguous":
          return planResult;
      }
    }

    return this.recordingThrows(null, (attempt) => this.handoverWith(input, null, attempt));
  }

  /**
   * Spec 0005: revert a seat's most recent committed runtime change, restoring the node's runtime, model, cwd, member
   * env, effort, permission selection and startup context from the revert slot, and starting a successor under the
   * restored runtime in the same pane. Fresh by default; `resumePredecessor` resumes the predecessor's recorded
   * conversation instead. Issued by the kernel's operator, or by its advisor (D3's one exception: reverting only).
   */
  async revertRuntimeChange(input: {
    seatRef: string;
    reason?: string | null;
    approval?: string | null;
    caller?: HandoverCaller | null;
    resumePredecessor?: boolean;
    dryRun?: boolean;
  }): Promise<SeatHandoverResult> {
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return { ok: false, code: "missing_reason", message: "Missing required option: --reason <reason>", guidance: "Provide an explicit revert reason." };
    }
    const operator = this.authorizeRuntimeChange(input.caller ?? null, { revert: true });
    if (typeof operator !== "string") return operator;
    const approval = input.approval?.trim();
    if (!approval) {
      return { ok: false, code: "runtime_change_invalid", message: "A runtime revert needs --approval <ref>, recorded as attribution.", guidance: "Pass --approval with the reference of the go for this revert." };
    }
    const statusResult = this.statusService.getStatus(input.seatRef);
    if (!statusResult.ok) return statusResult;
    const node = this.lookupNode(statusResult.status);
    // Review r2 F2: the revert slot is read inside the node's lifecycle lease, so a revert is never built from a slot
    // that another change or revert is about to replace. A revert queued behind one that changed the occupant is
    // refused by the guard; that refusal is reported as nothing to revert.
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      try {
        return await guard.lifecycle([node.id], () => this.revertRuntimeChange(input));
      } catch (err) {
        if (err instanceof DeliveryGuardError && err.code === "guard_target_changed") {
          return { ok: false, code: "runtime_revert_unavailable", message: `Seat "${input.seatRef}" changed while this revert waited; nothing was reverted.`,
            guidance: "Inspect the seat and its runtime-change ledger before reverting again." };
        }
        throw err;
      }
    }
    const slot = this.runtimeLedger.revertSlot(node.id);
    if (!slot) {
      return { ok: false, code: "runtime_revert_unavailable", message: `Seat "${input.seatRef}" has no recorded runtime change to revert.`,
        guidance: "A revert undoes the seat's most recent committed runtime change; there is none." };
    }
    const before = slot.before;
    const adapter = before.runtime ? this.runtimeAdapters?.[before.runtime] : undefined;
    if (!adapter) {
      return { ok: false, code: "runtime_change_invalid", message: `This daemon cannot start a ${before.runtime ?? "unknown"} successor.`, guidance: "Check the daemon's runtime adapters." };
    }
    let resumeToken: string | null = null;
    if (input.resumePredecessor) {
      const row = before.predecessorSessionId
        ? this.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(before.predecessorSessionId) as { resume_token: string | null } | undefined
        : undefined;
      resumeToken = row?.resume_token?.trim() || null;
      if (!resumeToken) {
        return { ok: false, code: "runtime_revert_unavailable", message: "The predecessor session has no recorded resume token.",
          guidance: "Revert without --resume-predecessor to start a fresh successor." };
      }
    }
    const toSelection = before.permission ? { runtime: before.permission.runtime as NativePermissionSelection["runtime"], mode: before.permission.mode } : null;
    let launchOverride: ReturnType<NativePermissionStore["launchOverride"]>;
    try {
      launchOverride = new NativePermissionStore(this.db).launchOverride(node.id, before.runtime!, toSelection);
    } catch (error) {
      return { ok: false, code: "runtime_change_invalid", message: `Permission selection: ${(error as Error).message}`, guidance: "Inspect the recorded permission selection." };
    }
    const current = this.captureRuntimeState(node.id, null);
    const change: PreparedRuntimeChange = {
      kind: "revert", nodeId: node.id, seatRef: input.seatRef, revertsChangeId: slot.changeId,
      progress: { step: "prepare", replacementStarted: false, recorded: false, committed: false },
      issuedByAdvisor: typeof this.authorizeRuntimeChange(input.caller ?? null, { revert: false }) !== "string",
      from: runtimeSideOf(current), to: runtimeSideOf(before),
      toAuthoredEffort: before.effort, toEffortChoice: before.effortChoice, toCodexProfile: before.codexConfigProfile,
      toPermissionRow: before.permission, launchOverride, adapter,
      startup: { kind: "saved", context: before.startupContext },
      specPath: null, specSha256: null, approval, operator, before: current, resumeToken,
      leftovers: this.runtimeLeftovers(node.runtime, node.cwd),
    };
    if (input.dryRun) {
      const planned = this.planner.plan({ seatRef: input.seatRef, reason, source: "fresh", operator, dryRun: true });
      if (!planned.ok) return { ok: false, code: "runtime_change_invalid", message: "The handover plan could not be built.", guidance: "Inspect the seat with: rig seat status <seat>" };
      return { ok: true, plan: { ...planned.plan, runtimeChange: this.summarizeRuntimeChange(change) } };
    }
    return this.recordingThrows(change, (attempt) => this.handoverWith({ seatRef: input.seatRef, reason, source: "fresh", operator }, change, attempt));
  }

  private async handoverWith(input: SeatHandoverInput, revert: PreparedRuntimeChange | null,
    attempt: { change: PreparedRuntimeChange | null }): Promise<SeatHandoverResult> {
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return {
        ok: false,
        code: "missing_reason",
        message: "Missing required option: --reason <reason>",
        guidance: "Provide an explicit handover reason, for example: --reason context-wall",
      };
    }

    const parsed = parseHandoverSource(input.source);
    if (!parsed.ok) {
      return parsed;
    }
    // OPR.0.5.5.5 — execution dispatches on the SAME capability table the
    // dry-run plan renders from, so the plan can never promise a source the
    // executor refuses. Every current mode executes; a future non-executing
    // mode must declare `executes: false` in its table row to be refused here.
    if (!SEAT_HANDOVER_SOURCE_CAPABILITIES[parsed.source.mode].executes) {
      return {
        ok: false,
        code: "source_not_supported",
        message: `${parsed.source.mode} handover does not execute on this daemon.`,
        guidance: "Use a source the dry-run plan marks executable.",
      };
    }

    const statusResult = this.statusService.getStatus(input.seatRef);
    if (!statusResult.ok) {
      return statusResult;
    }
    if (!statusResult.status.current_occupant) {
      return {
        ok: false,
        code: "current_occupant_required",
        message: `Seat "${input.seatRef}" has no current occupant to hand over from.`,
        guidance: "Start or claim the current seat occupant first, then retry handover.",
      };
    }

    const node = this.lookupNode(statusResult.status);
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      return guard.lifecycle([node.id], () => this.handoverWith(input, revert, attempt));
    }
    const latestSession = this.lookupLatestSession(node.id);
    if (!latestSession) {
      return {
        ok: false,
        code: "current_occupant_required",
        message: `Seat "${input.seatRef}" has no session row to supersede.`,
        guidance: "Inspect the seat with: rig seat status <seat>",
      };
    }

    const operator = input.operator?.trim() || null;

    // Spec 0005: a runtime change is validated and its target member resolved here, before anything changes.
    let change = revert;
    if (input.runtimeChange) {
      const prepared = await this.prepareRuntimeChange({
        request: input.runtimeChange, caller: input.caller ?? null, status: statusResult.status, node,
        latestSession, sourceMode: parsed.source.mode,
      });
      if ("ok" in prepared) return prepared;
      change = prepared;
      attempt.change = change;
    }
    if (change && input.dryRun) {
      const planned = this.planner.plan({ ...input, dryRun: true });
      if (!planned.ok) return { ok: false, code: "runtime_change_invalid", message: "The handover plan could not be built.", guidance: "Run the command without the runtime-change options to see why." };
      return { ok: true, plan: { ...planned.plan, runtimeChange: this.summarizeRuntimeChange(change) } };
    }

    // OPR.0.5.5.5 fork: resolve the native conversation id BEFORE any mutation
    // (the respawn), so a missing/undiscoverable token is an honest pre-mutation
    // refusal — never a blank successor silently reported as a fork, and never a
    // mid-swap abort for a condition knowable up front.
    let forkSource: { kind: "native_id"; value: string; pendingIdAllowed: true } | null = null;
    if (parsed.source.mode === "fork") {
      const forkRef = parsed.source.ref ?? latestSession.session_name;
      const discovery = discoverResumeToken(this.db, forkRef);
      if (!discovery.ok) {
        return {
          ok: false,
          code: discovery.failure.code === "session_not_found" ? "fork_source_not_found" : "resume_token_unavailable",
          message: discovery.failure.message,
          guidance: "Fork needs a resolvable native conversation id. Inspect the source session with: rig ps --nodes",
        };
      }
      if (!discovery.result.nativeId) {
        return {
          ok: false,
          code: "resume_token_unavailable",
          message: `No native resume id is discoverable for fork source "${forkRef}" — the conversation may not have produced output yet. No successor was created and the seat is untouched.`,
          guidance: "Retry after the source session has a native conversation id, or use --source fresh.",
        };
      }
      if (node.runtime && discovery.result.runtime && node.runtime !== discovery.result.runtime) {
        return {
          ok: false,
          code: "runtime_mismatch",
          message: `Seat expects runtime "${node.runtime}", but fork source "${forkRef}" is "${discovery.result.runtime}".`,
          guidance: "Fork from a source session that runs the seat's runtime.",
        };
      }
      forkSource = { kind: "native_id", value: discovery.result.nativeId, pendingIdAllowed: true };
    }

    // Already-created successor: route straight through the discovered->commit
    // path with nothing to unwind (byte-identical to the shipped behavior).
    if (parsed.source.mode === "discovered" && parsed.source.ref) {
      return this.finalizeWithDiscovered({
        seatRef: input.seatRef,
        status: statusResult.status,
        node,
        latestSession,
        discoveredRef: parsed.source.ref,
        reportedSource: parsed.source,
        reason,
        operator,
        contextDelivered: false,
        launchToken: null,
        occupantGeneration: null,
        appliedLaunch: null,
        cleanup: null,
        change,
      });
    }

    // Full-cycle composer for fresh (CUTOVER): capture -> respawn a live successor INTO the departing
    // pane in place -> deliver captured context -> verify continuity -> rebind. The registry BINDING is
    // untouched until the commit inside finalizeWithDiscovered (the SOLE, LAST rebind), but the retiree
    // PROCESS is force-replaced at the in-place respawn (it exits in place; its provider session file is
    // the durable wake target). (fork/rebuild were rejected above; discovered was finalized above.)

    // 1. Capture the departing seat's context BEFORE the respawn replaces it.
    const capturedContext = await this.captureDepartingContext(latestSession.session_name);
    const predecessorGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid;

    // 1b. B16 — resolve the predecessor's from-record recap NOW, before the successor exists: the
    // claude sidecar is keyed by SESSION NAME and the cutover reuses the canonical name, so once the
    // successor harness boots it overwrites the very sidecar the resolver reads (the live defect:
    // the resolver ran post-launch, read the successor's fresh sidecar, and honestly found nothing —
    // silently). Resolution is a pure read; nothing downstream of it depends on the launch.
    const rawRecapResolution = this.predecessorRecapResolver
      ? this.predecessorRecapResolver({ nodeId: node.id, runtime: node.runtime, sessionName: latestSession.session_name })
      : undefined;
    // Defensive against the pre-B16 resolver contract (null = silent no-recap): an injected legacy
    // resolver must not crash the handover — its null becomes a named unavailable like every other.
    const predecessorRecapResolution: PredecessorRecapResolution =
      rawRecapResolution ?? { unavailableReason: this.predecessorRecapResolver ? "recap resolver returned no result" : "no recap resolver wired on this daemon" };

    // 2. Respawn the successor INTO the retiree's pane and launch it into a LIVE, READY agent (§2.1b
    //    seam, B1): resolve departing pane -> respawn-pane in place (preserved name) -> real runtime
    //    startup (launchHarness + readiness) -> upsertDiscoveredSession. The successor is a live agent,
    //    not a bare shell, before it can commit.
    // Seam B Guard-F1: an ORGANIC seat has no node provenance — the inherited rig
    // attachment still carries to the successor (continuity of the same seat).
    const successorPosture = this.rigRepo.getNodePolicyProvenance(node.id)?.launchPosture
      ?? this.rigRepo.getRigPolicyProvenance(statusResult.status.rig_id)?.launchPosture
      ?? "floor"; // R2 terminal: absence = the locked floor on the continuity edge too
    let permissionOverride: ReturnType<NativePermissionStore["launchOverride"]>;
    try {
      permissionOverride = change ? change.launchOverride : new NativePermissionStore(this.db).launchOverride(node.id, node.runtime ?? "");
    } catch (error) { return { ok: false, code: "successor_create_failed", message: `Permission selection: ${(error as Error).message}`,
      guidance: "No successor was created. Inspect the seat permission selection before a separately authorized retry." }; }
    const effectivePosture = permissionOverride.launchPosture ?? successorPosture;
    const successorRuntime = change ? change.to.runtime : node.runtime;
    const effectivePermissionMode = permissionOverride.permissionMode ?? (effectivePosture === "auto" && successorRuntime === "claude-code" ? "auto" : undefined);
    // Spec 0005: the target member's startup (skills, projection, pre-launch files) runs into the target cwd before
    // the successor launches. Nothing about the node changes here, and the predecessor still runs.
    if (change) {
      change.progress.step = "target-startup";
      const started = await this.startTargetMember(change, node.id, latestSession.session_name);
      if (!started.ok) {
        return this.failChange(change, { ok: false, code: "runtime_change_target_startup_failed", message: started.message,
          guidance: "Nothing about the seat changed and the predecessor still runs. Fix the target member's startup, then retry." }, "target-startup", "none");
      }
    }
    // The successor must carry its own generation from its first byte. This reservation writes no
    // ledger row; commit consumes it, while every failed pre-commit branch remains unregistered.
    const occupantGeneration = this.sessionRegistry.reserveOccupantGeneration();
    const corePluginDir = seatCorePluginDir(change ? { id: node.id, runtime: change.to.runtime } : node, this.db, undefined, this.pluginsDir);
    if (change) change.progress.step = "create-successor";
    const launch = await this.successorLauncher.createSuccessor({
      // Seam B: the successor is the SAME seat continuing — persisted policy posture carries.
      // 0.5.2-07 model fidelity: carry the seat's SPEC-pinned model so the successor launch reads the
      // spec (else the running topology drifts from the founder-designed one at every handover).
      // A4-profile: likewise carry the codex config profile (adapter emits -p) — the restore path
      // already threads it; handover must too, or a profile-pinned codex seat reverts at handover.
      node: { id: node.id, runtime: node.runtime, cwd: node.cwd, kernelAuthority: permissionOverride.kernelAuthority, teamPermissionDefault: permissionOverride.teamPermissionDefault, nonInterruptive: this.rigRepo.getRigNonInterruptive(statusResult.status.rig_id), launchPosture: effectivePosture, ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}), model: node.model, effort: readSeatEffort(this.db, node.id)?.effective ?? undefined, codexConfigProfile: node.codex_config_profile ?? undefined, seatEnv: withCorePlugin(this.rigRepo.getEffectiveSeatEnv(node.id), corePluginDir), ...(corePluginDir && node.cwd ? { seatProjectDir: node.cwd } : {}),
        // Spec 0005: a runtime change launches the target's values instead.
        ...(change ? { runtime: change.to.runtime, cwd: change.to.cwd, model: change.to.model, effort: change.to.effort ?? undefined, codexConfigProfile: change.toCodexProfile ?? undefined, seatEnv: withCorePlugin(mergeSeatEnv(this.rigRepo.getRigEnv(statusResult.status.rig_id), change.to.env), corePluginDir), ...(corePluginDir && change.to.cwd ? { seatProjectDir: change.to.cwd } : {}) } : {}) },
      departingSessionName: latestSession.session_name,
      occupantGeneration,
      // OPR.0.5.5.5: a fork-sourced successor launches as a NATIVE FORK of the
      // resolved id — it carries the incumbent context from its first byte.
      ...(forkSource ? { forkSource } : {}),
      ...(change?.resumeToken ? { resumeToken: change.resumeToken } : {}),
      onReplacementStarted: () => {
        if (change) change.progress.replacementStarted = true;
        if (predecessorGeneration) this.appliedLaunchObservations.invalidateGeneration(predecessorGeneration);
      },
    });
    if (!launch.ok) {
      return this.failChange(change, {
        ok: false,
        code: "successor_create_failed",
        message: `Handover failed at step "${launch.step}": ${launch.message}`,
        // The registry binding is unchanged (commit never ran). A resolve_pane failure leaves the live
        // retiree wholly untouched; a failure after the in-place respawn leaves the seat re-wakeable from
        // its provider session file (never destroyed). Inspect tmux/daemon logs and retry.
        guidance: launch.code === "secret_on_argv_refused"
          // Spec 0013 item 9: refused before the cutover; the predecessor still runs and nothing needs recovering.
          ? "The seat was not changed: its predecessor still runs. Remove the named variable from the seat env or the provider-auth allow-list, then retry the handover; do not relaunch."
          : "The seat's registry binding is unchanged. If the failure was after the in-place respawn, the seat is re-wakeable from its provider session file. Inspect tmux/daemon logs and retry.",
      }, `create-successor:${launch.step}:${launch.code}`,
        launch.code === "retiree_not_terminated" ? "check-seat" : launch.code === "seat_env_refused" ? "fix-seat-env"
          : launch.code === "successor_not_ready" ? "relaunch-check-seat-env" : launch.replacementStarted ? "relaunch" : "none");
    }

    // Spec 0005: the target member's post-launch startup files go to the ready successor.
    if (change) change.progress.step = "deliver-startup-files";
    if (change?.startup.kind === "member" && change.startup.postLaunchFiles.length > 0) {
      const binding = this.targetBinding(change, node.id, launch.tmuxSession, launch.tmuxPane);
      let failedFiles: string[];
      try {
        failedFiles = (await change.adapter.deliverStartup(change.startup.postLaunchFiles, binding)).failed.map((f) => `${f.path}: ${f.error}`);
      } catch (err) {
        failedFiles = [(err as Error).message];
      }
      if (failedFiles.length > 0) {
        await this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId);
        return this.failChange(change, { ok: false, code: "context_delivery_failed", message: `Handover failed at step "deliver-startup-files": ${failedFiles.join("; ")}`,
          guidance: "The node is unchanged." }, "deliver-startup-files", "relaunch");
      }
    }

    // 3. fresh: deliver the captured restore packet to the live successor BEFORE
    //    continuity verify (a blank occupant is a relaunch, not a handover).
    //    discovered is operator-prepared and needs no delivery.
    if (change) change.progress.step = "deliver-context";
    let contextDelivered = false;
    // OPR.0.5.3.5 mini-req 7 — the authored recap pointer leg, resolved through the injected
    // reader; every outcome labeled (present with chain depth / named absence / omitted when
    // the resolver itself is absent).
    let authoredRecapInfo: { authoredRecap?: { address: string; chainLength: number }; authoredRecapAbsentReason?: string } | null = null;
    if (this.authoredRecapResolver) {
      const authored = this.authoredRecapResolver(input.seatRef);
      authoredRecapInfo = "address" in authored
        ? { authoredRecap: authored }
        : { authoredRecapAbsentReason: authored.absentReason };
    }
    if (parsed.source.mode === "fresh" && !change?.resumeToken) {
      // B16 — the recap was resolved at step 1b (pre-launch); an unavailable verdict rides the
      // packet as a NAMED line, never a silent omission.
      const resolved = "recap" in predecessorRecapResolution ? predecessorRecapResolution : null;
      const delivered = await this.deliverRestorePacket(launch.tmuxSession, {
        seatRef: input.seatRef,
        reason,
        departingSession: latestSession.session_name,
        capturedContext,
        recap: resolved?.recap,
        recordPath: resolved?.recordPath,
        recapUnavailableReason: resolved ? undefined : (predecessorRecapResolution as { unavailableReason: string }).unavailableReason,
        ...(authoredRecapInfo ?? {}),
        ...(change ? { runtimeChange: { kind: change.kind, from: change.from.runtime, to: change.to.runtime } } : {}),
      });
      if (!delivered.ok) {
        // Partial: the successor is live in the preserved pane but the context packet never landed —
        // unwind the discovery candidate (cleanup marks it vanished; it NEVER kills the preserved seat)
        // and leave the binding unchanged (no false-green). The seat is re-wakeable from its session file.
        await this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId);
        return this.failChange(change, {
          ok: false,
          code: "context_delivery_failed",
          message: `Handover failed at step "deliver-restore-packet": ${delivered.message}`,
          guidance: "The successor candidate was unwound and the seat's binding is unchanged; the seat is re-wakeable from its provider session file. Retry after tmux delivery is healthy.",
        }, "deliver-restore-packet", "relaunch");
      }
      contextDelivered = true;
    }

    // OPR.0.5.5.5 — per-source execution outcome, recorded on the result so the
    // operator sees exactly what carried context (fork origin / primed set).
    let sourceOutcome: SeatHandoverMutationResult["sourceOutcome"];
    // A fork's own id is never its parent's (the fork source) or the retiring occupant's; either answer
    // from the launch-time capture is treated as not captured.
    const launchedId = launch.resumeToken?.trim() || null;
    const retireeId = (this.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(latestSession.id) as
      { resume_token: string | null } | undefined)?.resume_token?.trim() || null;
    const forkOwnId = forkSource && launchedId && launchedId !== forkSource.value && launchedId !== retireeId ? launchedId : null;
    const launchToken = forkSource
      ? (forkOwnId ? { token: forkOwnId, resumeType: launch.resumeType } : null)
      : (launchedId ? { token: launchedId, resumeType: launch.resumeType } : null);
    if (parsed.source.mode === "fork" && forkSource) {
      // A fork whose own conversation id wasn't captured at launch commits with no resume token and
      // says so: its exact resumability isn't established until the id is recorded.
      sourceOutcome = forkOwnId
        ? { mode: "fork", forkedFrom: parsed.source.ref ?? latestSession.session_name, forkId: "captured" }
        : { mode: "fork", forkedFrom: parsed.source.ref ?? latestSession.session_name, forkId: "pending",
            limit: "The fork's own conversation id wasn't captured at launch, so no resume token is recorded for this seat. It may stay unrecorded (for example when the process has logged more than one conversation); `rig ps --nodes --json` shows whether one has been. Until it is, exact resumption of this conversation isn't established, and a restore of the seat can't resume it; what restore does instead follows the seat's restore policy." };
    }
    if (parsed.source.mode === "rebuild") {
      // rebuild: the successor is a FRESH conversation primed from the seat's
      // durable chain — the live incumbent's context is deliberately not
      // trusted. The executed set, its gaps, and an empty chain are all named.
      const chain = this.rebuildPrimingResolver
        ? this.rebuildPrimingResolver(input.seatRef)
        : { emptyReason: "no rebuild priming resolver wired on this daemon" };
      let primedArtifacts: Array<{ address: string; label: string }> = [];
      let gaps: string[] = [];
      let emptyChainReason: string | undefined;
      if ("artifacts" in chain && chain.artifacts.length > 0) {
        const resolved = resolveRebuildArtifacts(
          { mode: "rebuild", ref: { kind: "artifact_set", value: chain.artifacts.map((artifact) => artifact.address) } },
          { exists: this.rebuildArtifactExists },
        );
        gaps = resolved.gaps;
        if (resolved.ok) {
          const present = new Set(resolved.files.map((file) => file.absolutePath));
          primedArtifacts = chain.artifacts.filter((artifact) => present.has(artifact.address));
        } else {
          emptyChainReason = resolved.error;
        }
      } else {
        emptyChainReason = "artifacts" in chain ? "the durable chain resolved to zero artifacts" : chain.emptyReason;
      }
      sourceOutcome = { mode: "rebuild", primedArtifacts, gaps, ...(emptyChainReason ? { emptyChainReason } : {}) };
      const delivered = await this.deliverRebuildPrimingPacket(launch.tmuxSession, {
        seatRef: input.seatRef,
        reason,
        departingSession: latestSession.session_name,
        primedArtifacts,
        gaps,
        emptyChainReason,
      });
      if (!delivered.ok) {
        // Same partial-state contract as the fresh packet: unwind the candidate,
        // binding unchanged, seat re-wakeable — never a false complete.
        await this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId);
        return this.failChange(change, {
          ok: false,
          code: "context_delivery_failed",
          message: `Handover failed at step "deliver-rebuild-priming": ${delivered.message}`,
          guidance: "The successor candidate was unwound and the seat's binding is unchanged; the seat is re-wakeable from its provider session file. Retry after tmux delivery is healthy.",
        }, "deliver-rebuild-priming", "relaunch");
      }
      contextDelivered = true;
    }

    // 4. Verify continuity + rebind via the EXISTING discovered->commit path.
    if (change) change.progress.step = "verify-and-commit";
    //    On any failure, unwind the created successor (no binding to unwind).
    return this.finalizeWithDiscovered({
      seatRef: input.seatRef,
      status: statusResult.status,
      node,
      latestSession,
      discoveredRef: launch.discoveredId,
      reportedSource: parsed.source,
      reason,
      operator,
      contextDelivered,
      // B2 (launched/fresh): the launch-scraped resume token captured by the
      // successor launcher is persisted atomically at commit (provenance scrape).
      launchToken,
      occupantGeneration,
      appliedLaunch: launch.appliedLaunch ?? null,
      sourceOutcome,
      cleanup: () => this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId),
      change,
    });
  }

  /**
   * The shared discovered->commit path (validation + presence-verify + rebind).
   * `cleanup` is invoked before returning ANY failure so a composer-created
   * successor is unwound; the discovered-source caller passes null (nothing to
   * unwind). The `hasSession` probe here is the continuity/presence verify that
   * runs BEFORE the commit releases the original binding.
   */
  private async finalizeWithDiscovered(input: {
    seatRef: string;
    status: SeatStatus;
    node: NodeRow;
    latestSession: SessionRow;
    discoveredRef: string;
    reportedSource: SeatHandoverSource;
    reason: string;
    operator: string | null;
    contextDelivered: boolean;
    /** Launch-scraped resume token for a fresh successor (persisted at commit). */
    launchToken: { token: string; resumeType?: string } | null;
    /** Source-bound generation reserved before a fresh successor started; null for discovered seats. */
    occupantGeneration: string | null;
    /** Exact enforcing value returned by the launch adapter; absent for adopted/discovered successors. */
    appliedLaunch: AppliedLaunchObservation | null;
    /** OPR.0.5.5.5 — per-source execution outcome, threaded onto the result. */
    sourceOutcome?: SeatHandoverMutationResult["sourceOutcome"];
    cleanup: (() => Promise<void>) | null;
    /** Spec 0005 — the runtime change or revert this handover commits, if any. */
    change: PreparedRuntimeChange | null;
  }): Promise<SeatHandoverResult> {
    const fail = async (result: SeatHandoverResult): Promise<SeatHandoverResult> => {
      if (input.cleanup) await input.cleanup();
      return this.failChange(input.change, result, "verify-and-commit", "relaunch");
    };

    const discovered = this.discoveryRepo.getDiscoveredSession(input.discoveredRef);
    if (!discovered) {
      return fail({
        ok: false,
        code: "discovered_not_found",
        message: `Discovery record "${input.discoveredRef}" not found.`,
        guidance: "Run discovery and list active discovered sessions before retrying.",
      });
    }
    // #981: a composer-launched successor respawns into the seat's own pane, whose discovery row the
    // previous handover claimed for this same node, and a rescan keeps that claim (#237). That claim is
    // this seat's own, so commit re-claims it. A row claimed by any other node, or a discovered-source
    // successor, still needs an active, unclaimed record.
    const ownPaneClaim = input.reportedSource.mode !== "discovered"
      && discovered.status === "claimed"
      && discovered.claimedNodeId === input.node.id
      && discovered.tmuxSession === input.latestSession.session_name;
    if (discovered.status !== "active" && !ownPaneClaim) {
      return fail({
        ok: false,
        code: "discovered_not_active",
        message: `Discovery record "${discovered.id}" is ${discovered.status}, not active.`,
        guidance: "Use an active, unclaimed discovered successor session.",
      });
    }
    // A COMPOSER-LAUNCHED successor (fresh/fork/rebuild — OPR.0.5.5.5 executes all
    // three through the same cutover) INTENTIONALLY reuses the departing session's
    // canonical name — it respawns into the retiree's pane in place, preserving the
    // seat name (that is the whole point). Only a DISCOVERED-source successor must
    // be a DISTINCT session; handing a seat to its own current session is a no-op
    // there, so the guard applies to discovered only.
    if (input.reportedSource.mode === "discovered" && discovered.tmuxSession === input.latestSession.session_name) {
      return fail({
        ok: false,
        code: "successor_is_current",
        message: "Discovered successor is already the current occupant for this seat.",
        guidance: "Use a distinct successor session.",
      });
    }

    const runtimeMismatch = this.checkRuntimeMismatch(input.change ? input.change.to.runtime : input.node.runtime, discovered.runtimeHint);
    if (runtimeMismatch) return fail(runtimeMismatch);

    // #141: a composer-launched successor reuses the seat's own session name, which an archived earlier
    // generation still names in its kept binding. Owners in archived rigs are skipped there, as in removeNode
    // (#174). A discovered successor is a separate session, so any other owner still blocks it.
    const managedOwner = this.lookupManagedOwner(discovered.tmuxSession, input.node.id, input.reportedSource.mode !== "discovered");
    if (managedOwner) {
      return fail({
        ok: false,
        code: "successor_already_managed",
        message: `Successor tmux session "${discovered.tmuxSession}" is already managed by ${managedOwner.logical_id}@${managedOwner.rig_name}.`,
        guidance: "Use an unclaimed discovered successor session.",
      });
    }

    let tmuxPresent: boolean;
    try {
      tmuxPresent = await this.tmuxAdapter.hasSession(discovered.tmuxSession);
    } catch (err) {
      return fail({
        ok: false,
        code: "tmux_probe_failed",
        message: `Could not verify successor tmux session "${discovered.tmuxSession}": ${err instanceof Error ? err.message : String(err)}`,
        guidance: "Retry after tmux health is known; probe failures are not treated as absence.",
      });
    }
    if (!tmuxPresent) {
      return fail({
        ok: false,
        code: "successor_tmux_absent",
        message: `Successor tmux session "${discovered.tmuxSession}" is not present.`,
        guidance: "Run discovery again or provide a live discovered successor session.",
      });
    }

    const committed = this.commit({
      seatRef: input.seatRef,
      status: input.status,
      node: input.node,
      latestSession: input.latestSession,
      reportedSource: input.reportedSource,
      reason: input.reason,
      operator: input.operator,
      discovered,
      contextDelivered: input.contextDelivered,
      launchToken: input.launchToken,
      occupantGeneration: input.occupantGeneration,
      appliedLaunch: input.appliedLaunch,
      sourceOutcome: input.sourceOutcome,
      change: input.change,
    });
    // A commit that landed is never unwound (review r2 follow-up): only a commit that did not land goes through fail().
    if (!committed.ok) return committed.code === "handover_committed_swap_undeclared" ? committed : fail(committed);
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(input.node.id);

    // B2 (discovered): the successor is an operator-prepared live session we did
    // NOT launch, so no launch token was scraped. Best-effort capture its live
    // resume token AT COMMIT — reusing the FR-3 pure derive-helper — so a crash
    // right after handover can still resume (the window FR-3 closes elsewhere).
    // Post-commit + non-blocking (mirrors FR-3): the async derivation cannot run
    // inside better-sqlite3's synchronous transaction. Never logs the token.
    if (input.reportedSource.mode === "discovered" && "result" in committed) {
      await this.captureDiscoveredResumeToken({
        rigId: input.status.rig_id,
        nodeId: input.node.id,
        sessionId: committed.result.newSessionId,
        sessionName: discovered.tmuxSession,
        runtime: input.change ? input.change.to.runtime : input.node.runtime,
      });
    }
    return committed;
  }

  /**
   * B2 — best-effort discovered-mode resume-token capture at commit. Derives the
   * live token via the shared FR-3 derive-helper (pure read), persists it with
   * provenance "adoption" (the rank guard governs clobber), and emits the same
   * captured/preserved/skipped events FR-3 uses. Honest failure = persist
   * nothing + a redacted skip event. NEVER throws, never logs the token.
   */
  private async captureDiscoveredResumeToken(input: {
    rigId: string; nodeId: string; sessionId: string; sessionName: string; runtime: string | null;
  }): Promise<void> {
    try {
      const derived = await deriveResumeToken(
        { runtime: input.runtime, sessionName: input.sessionName },
        this.captureDeps,
      );
      if (derived.outcome === "exempt" || derived.outcome === "noop") return;
      const runtime = input.runtime as string; // non-null past exempt
      if (derived.outcome === "skipped") {
        this.emitCaptureSkip(input, runtime, derived.reason);
        return;
      }
      const wrote = this.sessionRegistry.updateResumeToken(input.sessionId, derived.resumeType, derived.token, "adoption");
      try {
        this.eventBus.emit(wrote
          ? {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "captured", resumeType: derived.resumeType, provenance: "adoption", redacted: true,
            }
          : {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "preserved", resumeType: derived.resumeType, reason: "higher_rank_present", redacted: true,
            });
      } catch { /* best-effort */ }
    } catch {
      // best-effort — capture never fails or blocks the handover
    }
  }

  private emitCaptureSkip(
    input: { rigId: string; nodeId: string; sessionId: string; sessionName: string },
    runtime: string,
    reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "process_unreadable" | "invalid_token" | "stale_sidecar",
  ): void {
    try {
      this.eventBus.emit({
        type: "session.resume_token_captured",
        rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
        runtime, outcome: "skipped", reason, redacted: true,
      });
    } catch { /* best-effort */ }
  }

  /** Best-effort capture of the departing seat's visible terminal before the
   *  successor is created. Never throws; an empty capture is honestly recorded
   *  as "no capture available" in the restore packet. */
  private async captureDepartingContext(departingSession: string): Promise<string> {
    try {
      const screen = await this.tmuxAdapter.capturePaneScreen(departingSession);
      return screen ?? "";
    } catch {
      return "";
    }
  }

  /** OPR.0.5.5.5 — deliver the rebuild priming packet through the same shipped
   *  interactive-text transport as the restore packet. The packet points the
   *  successor at the durable artifacts (it reads them itself) and names every
   *  gap and an empty chain out loud — never a silent partial priming. */
  private async deliverRebuildPrimingPacket(
    successorSession: string,
    info: {
      seatRef: string;
      reason: string;
      departingSession: string;
      primedArtifacts: Array<{ address: string; label: string }>;
      gaps: string[];
      emptyChainReason?: string;
    },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const lines = [
      `# Seat rebuild handover — ${info.seatRef}`,
      `You are a REBUILT successor for this seat (reason: ${info.reason}, at ${this.now().toISOString()}). Your predecessor session was ${info.departingSession}; its live context was deliberately NOT carried. Prime yourself from the durable artifacts below, highest trust first.`,
    ];
    if (info.primedArtifacts.length > 0) {
      lines.push("", "Priming artifacts (read each, in order):");
      for (const artifact of info.primedArtifacts) lines.push(`- ${artifact.address} — ${artifact.label}`);
    }
    if (info.gaps.length > 0) {
      lines.push("", "Declared but MISSING on disk (known gaps, named so nothing is silently dropped):");
      for (const gap of info.gaps) lines.push(`- ${gap}`);
    }
    if (info.emptyChainReason) {
      lines.push("", `The durable chain is EMPTY: ${info.emptyChainReason}. You start from seat identity alone — say so in your first status report.`);
    }
    const sent = await this.tmuxAdapter.sendText(successorSession, lines.join("\n"));
    if (!sent.ok) {
      return { ok: false, message: (sent as { message?: string }).message ?? "send_text failed" };
    }
    // Same spike-proven 200ms settle as the restore packet (staged-not-consumed class).
    await this.sleep(200);
    const submit = await this.tmuxAdapter.sendKeys(successorSession, ["Enter"]);
    if (!submit.ok) {
      return { ok: false, message: (submit as { message?: string }).message ?? "submit failed" };
    }
    return { ok: true };
  }

  /** Deliver the captured restore packet to a fresh successor via the shipped
   *  interactive-text transport (send_text + Enter), mirroring the startup
   *  orchestrator's initial-prompt delivery. */
  private async deliverRestorePacket(
    successorSession: string,
    info: {
      seatRef: string;
      reason: string;
      departingSession: string;
      capturedContext: string;
      /** The predecessor's bounded from-record recap + record path (omitted when unresolved). */
      recap?: JsonlExchange[];
      recordPath?: string;
      /** B16 — when the recap did not resolve, the NAMED reason (rendered, never silent). */
      recapUnavailableReason?: string;
      authoredRecap?: { address: string; chainLength: number };
      authoredRecapAbsentReason?: string;
      runtimeChange?: { kind: "change" | "revert"; from: string | null; to: string | null };
    },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const packet = buildRestorePacket({ ...info, handoverAt: this.now().toISOString() });
    const sent = await this.tmuxAdapter.sendText(successorSession, packet);
    if (!sent.ok) {
      return { ok: false, message: (sent as { message?: string }).message ?? "send_text failed" };
    }
    // B16 rework (r2 live door finding): the SHARED paste-then-submit sequencing — the transport's
    // spike-proven 200ms settle between send_text and Enter (session-transport.ts, "Wait 200ms").
    // Without it the multi-KB packet sat STAGED-UNSENT as collapsed paste blocks in the successor's
    // input box (r2 measured 46s until a manual Enter) — the handover committed complete while the
    // packet was never consumed: the staged-not-consumed class, shipped by the product itself.
    await this.sleep(200);
    const submit = await this.tmuxAdapter.sendKeys(successorSession, ["Enter"]);
    if (!submit.ok) {
      return { ok: false, message: (submit as { message?: string }).message ?? "submit failed" };
    }
    return { ok: true };
  }

  /**
   * Spec 0005 — finish the occupant declaration of a committed runtime change or revert whose declaration failed after
   * the commit (handover_committed_swap_undeclared). Issued by the kernel's operator (D3), or by the kernel's advisor for
   * a pending revert it issued itself (the ledger row's kind and operator), since the advisor reverts when the operator
   * seat is the broken one. It declares the seat's current
   * occupant to the activity oracle and stamps the ledger row with who and when; it never relaunches, reverts or touches
   * the pane. Refused unless the node's latest committed change is undeclared and its occupant is still current.
   */
  async declareRuntimeOccupant(input: { seatRef: string; caller?: HandoverCaller | null }):
    Promise<{ ok: true; declared: { seatRef: string; changeId: string; sessionId: string; declaredBy: string } } | Extract<SeatHandoverResult, { ok: false }>> {
    const operator = this.authorizeRuntimeChange(input.caller ?? null, { revert: true });
    if (typeof operator !== "string") return operator as Extract<SeatHandoverResult, { ok: false }>;
    const isOperator = typeof this.authorizeRuntimeChange(input.caller ?? null, { revert: false }) === "string";
    const statusResult = this.statusService.getStatus(input.seatRef);
    if (!statusResult.ok) return statusResult;
    const node = this.lookupNode(statusResult.status);
    const notPending = (message: string) => ({ ok: false as const, code: "runtime_declare_not_pending" as const, message,
      guidance: `Nothing to declare. Inspect the seat with: rig seat status ${input.seatRef}` });
    // Like a revert (review r2 F2), the marker is read inside the node's lifecycle lease, never beside a handover.
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      try {
        return await guard.lifecycle([node.id], () => this.declareRuntimeOccupant(input));
      } catch (err) {
        if (err instanceof DeliveryGuardError && err.code === "guard_target_changed") {
          return notPending(`Seat "${input.seatRef}" changed while this declaration waited for it.`);
        }
        throw err;
      }
    }
    const latest = this.runtimeLedger.latestCommitted(node.id);
    if (!latest) return notPending(`Seat "${input.seatRef}" has no committed runtime change.`);
    if (latest.declaredAt) {
      return notPending(`The seat's latest runtime change was already declared at ${latest.declaredAt} by ${latest.declaredBy ?? "unknown"}.`);
    }
    const session = this.lookupLatestSession(node.id);
    if (!latest.generationUuid || latest.generationUuid !== this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid || !session) {
      return notPending(`A later handover replaced the occupant that the seat's latest runtime change started; there is nothing to declare for it.`);
    }
    if (!isOperator && (latest.kind !== "revert" || latest.operator !== operator)) {
      return { ok: false, code: "runtime_change_unauthorized",
        message: `The kernel's advisor may declare only a pending revert it issued itself; the seat's pending ${latest.kind} was issued by ${latest.operator}.`,
        guidance: `The kernel operator finishes it: rig seat runtime-declare ${input.seatRef}` };
    }
    try {
      this.activityOracle?.declareOccupantSwap(node.id, session.id);
    } catch (err) {
      return { ok: false, code: "runtime_declare_failed",
        message: `The activity oracle did not take the declaration: ${err instanceof Error ? err.message : String(err)}`,
        guidance: `The change stays COMMITTED. Do NOT relaunch or revert; retry: rig seat runtime-declare ${input.seatRef}` };
    }
    this.runtimeLedger.markDeclared(latest.id, operator);
    return { ok: true, declared: { seatRef: input.seatRef, changeId: latest.id, sessionId: session.id, declaredBy: operator } };
  }

  /** D3: a runtime change is issued by the kernel's operator seat, by its transport identity (X-OpenRig-Session,
   *  provenance transport:v1). A revert also admits the kernel's advisor. The body's --operator is a label only. */
  private authorizeRuntimeChange(caller: HandoverCaller | null, opts: { revert: boolean }): string | SeatHandoverResult {
    const refusal: SeatHandoverResult = {
      ok: false,
      code: "runtime_change_unauthorized",
      message: opts.revert
        ? "A runtime revert may be issued only by the kernel's operator or advisor seat (operator-agent@kernel, advisor-lead@kernel)."
        : "A runtime change may be issued only by the kernel's operator seat (operator-agent@kernel).",
      guidance: "Run it from that seat, so its transport identity names it; --operator is a label, never authority.",
    };
    if (!caller || caller.provenance !== "transport:v1") return refusal;
    const seat = this.statusService.getStatus(caller.session);
    if (!seat.ok || seat.status.rig_name !== "kernel") return refusal;
    const allowed = seat.status.logical_id === "operator.agent" || (opts.revert && seat.status.logical_id === "advisor.lead");
    return allowed ? caller.session : refusal;
  }

  /** Validate a runtime change and resolve its target member (D2-D5), changing nothing. */
  private async prepareRuntimeChange(input: {
    request: RuntimeChangeRequest;
    caller: HandoverCaller | null;
    status: SeatStatus;
    node: NodeRow;
    latestSession: SessionRow;
    sourceMode: SeatHandoverSource["mode"];
  }): Promise<PreparedRuntimeChange | SeatHandoverResult> {
    const invalid = (message: string, guidance: string): SeatHandoverResult => ({ ok: false, code: "runtime_change_invalid", message, guidance });
    const mismatch = (message: string): SeatHandoverResult => ({ ok: false, code: "runtime_change_spec_mismatch", message,
      guidance: "Declare the target in the rig spec first, then pass that spec (on the kernel rig, the packaged variant that declares it)." });
    const startupFailed = (message: string): SeatHandoverResult => ({ ok: false, code: "runtime_change_target_startup_failed", message,
      guidance: "Nothing changed. Fix the target member's agent spec or startup files, then retry." });
    const operator = this.authorizeRuntimeChange(input.caller, { revert: false });
    if (typeof operator !== "string") return operator;
    const r = input.request;
    const node = input.node;
    // A fork cannot cross harnesses, and a discovered successor gets no target startup or readiness check from the
    // handover; both are refused, so every runtime change runs its target's startup before it commits.
    if (input.sourceMode === "fork" || input.sourceMode === "discovered") {
      return invalid(`A ${input.sourceMode} source cannot carry a runtime change.`, "Use --source fresh or --source rebuild with --to-runtime.");
    }
    const approval = r.approval?.trim();
    if (!approval) return invalid("A runtime change needs --approval <ref>, recorded as attribution.", "Pass --approval with the reference of the go for this change.");
    const toRuntime = r.toRuntime?.trim() ?? "";
    if (!RUNTIME_CHANGE_RUNTIMES.has(toRuntime)) return invalid(`Runtime "${toRuntime}" is not supported for a runtime change.`, "Use codex or claude-code.");
    if (toRuntime === node.runtime) return invalid(`The seat already runs ${toRuntime}.`, "Drop --to-runtime for a same-runtime handover.");
    const adapter = this.runtimeAdapters?.[toRuntime];
    if (!adapter || !this.memberStartup) return invalid(`This daemon cannot start a ${toRuntime} successor.`, "Check the daemon's runtime adapters.");
    const toModel = r.toModel?.trim();
    if (!toModel) return invalid("A runtime change needs --to-model.", "Name the successor's model, for example --to-model claude-opus-5-5.");
    const toPermissions = r.toPermissions?.trim() ?? "";
    if (!RUNTIME_CHANGE_PERMISSIONS.has(toPermissions)) {
      return invalid("A runtime change needs --to-permissions floor, full_bypass or inherit.",
        "An inherited default is confirmed, never implied: the dry run shows what inherit resolves to on the target runtime.");
    }
    let toEnv: SeatEnv | null = null;
    // Review r2: --to-env sets only allow-listed names. With no caller authentication on a loopback daemon, an open
    // list would let any local process pass PATH, NODE_OPTIONS or LD_PRELOAD to a full_bypass seat.
    const envAllowlist = new Set(r.toEnv?.length ? this.runtimeChangeEnvAllowlist() : []);
    for (const assignment of r.toEnv ?? []) {
      const parsedEnv = parseSeatEnvAssignment(assignment);
      if (!parsedEnv.ok) return invalid(`--to-env: ${parsedEnv.error}`, "Use NAME=VALUE.");
      if (!envAllowlist.has(parsedEnv.name)) {
        return { ok: false, code: "runtime_change_env_not_allowed",
          message: `--to-env ${parsedEnv.name} is not in runtime.change_env_allowlist (${[...envAllowlist].join(", ") || "empty"}).`,
          guidance: "Only allow-listed names may be set on a runtime change. Declare other env in the rig spec, or extend the allow-list deliberately." };
      }
      if (isSecretSeatEnvName(parsedEnv.name)) {
        return { ok: false, code: "runtime_change_secret_env",
          message: `--to-env ${parsedEnv.name}: a secret-named variable is refused; its value would be stored in the node row and in shell history.`,
          guidance: "Give the seat its credentials through its credential channel, not member env." };
      }
      (toEnv ??= {})[parsedEnv.name] = parsedEnv.value;
    }
    const toCwd = r.toCwd?.trim() ? nodePath.resolve(r.toCwd.trim()) : null;
    if (toCwd && !(existsSync(toCwd) && statSync(toCwd).isDirectory())) return invalid(`--to-cwd ${toCwd} is not a directory.`, "Create the successor's working directory first.");
    const toEffort = r.toEffort?.trim() || null;

    // D2: the spec of record declares the target.
    if (!r.spec?.path || !r.spec.yaml) {
      return invalid("A runtime change needs --spec <rig.yaml>.", "Pass the rig spec that declares the target member (on the kernel rig, the packaged variant that declares it).");
    }
    let rigSpec: PodRigSpec;
    try {
      const raw = PodRigSpecCodec.parse(r.spec.yaml);
      const validation = PodRigSpecSchema.validate(raw);
      if (!validation.valid) return mismatch(`The spec is not a valid rig spec: ${validation.errors.join("; ")}`);
      rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    } catch (err) {
      return mismatch(`The spec could not be read: ${(err as Error).message}`);
    }
    if (rigSpec.name !== input.status.rig_name) return mismatch(`The spec is for rig "${rigSpec.name}", not "${input.status.rig_name}".`);
    const dot = input.status.logical_id.indexOf(".");
    const pod: RigSpecPod | undefined = rigSpec.pods.find((candidate) => candidate.id === input.status.logical_id.slice(0, dot));
    const member = pod?.members.find((candidate) => candidate.id === input.status.logical_id.slice(dot + 1));
    if (!pod || !member) return mismatch(`The spec has no member ${input.status.logical_id}.`);
    if (member.runtime !== toRuntime) return mismatch(`The spec declares ${input.status.logical_id} as ${member.runtime}, not ${toRuntime}.`);
    const rigRoot = nodePath.dirname(nodePath.resolve(r.spec.path));
    const before = this.captureRuntimeState(node.id, input.latestSession.id);

    // The kernel's spec is the packaged builtin, rewritten at each install: there the node row is authoritative after
    // the recorded change, and model, cwd and env come from the flags. Any other spec is the source of truth: every
    // value the change carries must be declared identically, so a later `rig up` of that spec starts what runs.
    const kernel = input.status.rig_name === "kernel";
    let targetCwd = toCwd ?? node.cwd;
    let targetEnv = toEnv ?? parseStoredSeatEnv(before.envJson);
    let authoredEffort: string | null = null;
    let effortChoice = toEffort;
    let codexProfile: string | null = null;
    if (!kernel) {
      if (member.model !== toModel) return mismatch(`The spec declares model ${member.model ?? "(none)"}, not ${toModel}.`);
      if (toEffort && member.effort !== toEffort) return mismatch(`The spec declares effort ${member.effort ?? "(none)"}, not ${toEffort}.`);
      if (toEnv && !sameEnv(member.env, toEnv)) return mismatch("The spec's member env differs from --to-env.");
      const declared = this.memberStartup.resolveMemberConfig({ rigSpec, rigRoot, pod, member });
      if (!declared.ok) return startupFailed(declared.error);
      if (toCwd && declared.configResult.config.cwd !== toCwd) return mismatch(`The spec's member cwd is ${declared.configResult.config.cwd}, not ${toCwd}.`);
      targetCwd = declared.configResult.config.cwd;
      targetEnv = member.env ?? null;
      authoredEffort = member.effort ?? null;
      effortChoice = null;
      codexProfile = toRuntime === "codex" ? member.codexConfigProfile ?? null : null;
    }
    if (targetEnv && Object.keys(targetEnv).length === 0) targetEnv = null;

    // Q4 (A): the target member's startup resolves now; its side effects run only once the change executes.
    const config = this.memberStartup.resolveMemberConfig({ rigSpec, rigRoot, pod, member, cwdOverride: targetCwd ?? undefined });
    if (!config.ok) return startupFailed(config.error);
    targetCwd = config.configResult.config.cwd;
    const planned = this.memberStartup.planMemberStartup({
      rigId: input.status.rig_id, rigSpec, rigRoot, pod, member,
      configResult: config.configResult, resolveResult: config.resolveResult, adapter,
      launchResult: { binding: { tmuxSession: input.latestSession.session_name }, warnings: [] },
      canonicalSessionName: input.latestSession.session_name, keptSkillWarnings: [],
    });
    if ("status" in planned) return startupFailed(planned.error);
    const memberFiles = planned.files;
    const starter = await this.memberStartup.resolveMemberStarterFiles(member);
    if (!starter.ok) return startupFailed(starter.error);
    const files = starter.files ? [...starter.files, ...memberFiles] : memberFiles;
    const actions = this.memberStartup.memberStartupActions({
      configResult: config.configResult, rigSpec, pod, member, sessionName: input.latestSession.session_name,
    });
    const { preLaunchFiles, postLaunchFiles } = partitionStartupFiles(files, "fresh_start", (path) => {
      try { return readFileSync(path, "utf-8"); } catch { return ""; }
    });

    const toSelection: NativePermissionSelection | null = toPermissions === "inherit"
      ? null
      : { runtime: toRuntime as NativePermissionSelection["runtime"], mode: toPermissions };
    let launchOverride: ReturnType<NativePermissionStore["launchOverride"]>;
    try {
      launchOverride = new NativePermissionStore(this.db).launchOverride(node.id, toRuntime, toSelection);
    } catch (error) {
      return invalid(`Permission selection: ${(error as Error).message}`, "Choose --to-permissions floor, full_bypass or inherit.");
    }
    return {
      kind: "change", nodeId: node.id, seatRef: input.status.seat_ref, revertsChangeId: null,
      progress: { step: "prepare", replacementStarted: false, recorded: false, committed: false }, issuedByAdvisor: false,
      from: runtimeSideOf(before),
      to: { runtime: toRuntime, model: toModel, cwd: targetCwd, effort: effortChoice ?? authoredEffort, permission: toSelection?.mode ?? null, env: targetEnv },
      toAuthoredEffort: authoredEffort, toEffortChoice: effortChoice, toCodexProfile: codexProfile,
      toPermissionRow: toSelection ? { runtime: toSelection.runtime, mode: toSelection.mode, actor: operator, reason: `runtime change: ${approval}` } : null,
      launchOverride, adapter,
      startup: { kind: "member", member, config, plan: planned.plan, files, actions, preLaunchFiles, postLaunchFiles },
      specPath: nodePath.resolve(r.spec.path), specSha256: createHash("sha256").update(r.spec.yaml).digest("hex"),
      approval, operator, before, resumeToken: null,
      leftovers: this.runtimeLeftovers(node.runtime, node.cwd),
    };
  }

  /** The node's runtime-bound state, as a revert slot would restore it. */
  private captureRuntimeState(nodeId: string, predecessorSessionId: string | null): RevertBefore {
    const row = this.db.prepare("SELECT runtime, model, cwd, effort, effort_choice, codex_config_profile, env_json FROM nodes WHERE id = ?")
      .get(nodeId) as { runtime: string | null; model: string | null; cwd: string | null; effort: string | null; effort_choice: string | null;
        codex_config_profile: string | null; env_json: string | null };
    const permission = this.db.prepare("SELECT runtime, mode, actor, reason FROM node_permission_selections WHERE node_id = ?")
      .get(nodeId) as RevertBefore["permission"] | undefined;
    const startupContext = this.db.prepare("SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?")
      .get(nodeId) as RevertBefore["startupContext"] | undefined;
    return {
      runtime: row.runtime, model: row.model, cwd: row.cwd, effort: row.effort, effortChoice: row.effort_choice,
      codexConfigProfile: row.codex_config_profile, envJson: row.env_json, permission: permission ?? null,
      startupContext: startupContext ?? null, predecessorSessionId,
    };
  }

  /** The predecessor runtime's files a change leaves in place, as reported to the operator (Q4 condition 3). */
  private runtimeLeftovers(runtime: string | null, cwd: string | null): string[] {
    if (!runtime || !cwd) return [];
    const names = runtime === "codex" ? ["AGENTS.md", ".agents"] : runtime === "claude-code" ? ["CLAUDE.md", ".claude"] : [];
    const found = names.map((name) => nodePath.join(cwd, name)).filter((path) => existsSync(path));
    if (runtime === "codex") found.push("~/.codex/config.toml (the OpenRig hooks written for this seat)");
    return found;
  }

  private summarizeRuntimeChange(change: PreparedRuntimeChange): RuntimeChangeSummary {
    const side = (value: RuntimeSide) => ({ ...value, env: envFingerprint(value.env) });
    return {
      kind: change.kind, from: side(change.from), to: side(change.to),
      ...(change.to.permission === null ? { inheritResolvesTo: change.launchOverride } : {}),
      specPath: change.specPath, specSha256: change.specSha256, approval: change.approval, operator: change.operator,
      leftovers: change.leftovers, resumesPredecessor: change.resumeToken !== null,
    };
  }

  private targetBinding(change: PreparedRuntimeChange, nodeId: string, tmuxSession: string, tmuxPane: string | null): NodeBinding {
    return {
      id: "", nodeId, attachmentType: "tmux", tmuxSession, tmuxWindow: null, tmuxPane, cmuxWorkspace: null, cmuxSurface: null,
      updatedAt: "", cwd: change.to.cwd ?? "", model: change.to.model ?? undefined, effort: change.to.effort ?? undefined,
      codexConfigProfile: change.toCodexProfile ?? undefined,
      ...(change.launchOverride.launchPosture ? { launchPosture: change.launchOverride.launchPosture } : {}),
      ...(change.launchOverride.permissionMode ? { permissionMode: change.launchOverride.permissionMode } : {}),
    };
  }

  /** Q4 (A): the target member's skills, projection and pre-launch files, into the target cwd, before the launch. */
  private async startTargetMember(change: PreparedRuntimeChange, nodeId: string, sessionName: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (change.startup.kind !== "member") return { ok: true };
    const skills = this.memberStartup!.reconcileMemberSkills(change.startup.config.configResult, sessionName);
    if (!skills.ok) return { ok: false, message: skills.error };
    const binding = this.targetBinding(change, nodeId, sessionName, null);
    try {
      const projected = await change.adapter.project(change.startup.plan, binding);
      if (projected.failed.length > 0) {
        return { ok: false, message: projected.failed.map((f) => `Projection failed for ${f.effectiveId}: ${f.error}`).join("; ") };
      }
      const delivered = await change.adapter.deliverStartup(change.startup.preLaunchFiles, binding);
      if (delivered.failed.length > 0) {
        return { ok: false, message: delivered.failed.map((f) => `Pre-launch file delivery failed: ${f.path}: ${f.error}`).join("; ") };
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    return { ok: true };
  }

  /** A failed runtime change or revert is recorded with its code and step only. The message is never stored: a failed
   *  respawn's message can carry the env it was given (review r2 F3). The node is untouched. */
  private failChange(change: PreparedRuntimeChange | null, result: SeatHandoverResult, step: string, recovery: RuntimeChangeRecovery): SeatHandoverResult {
    // The recovery depends on how far the cutover got (review r2, N1 and N1b). Before it, the seat is untouched and its
    // predecessor still runs, so there is nothing to recover. If ending the retiree failed, it may have been signalled
    // and its pane is left set to stay open, so the operator checks whether it still runs. After the respawn, the
    // canonical session is live and may hold the target runtime while the node still records the old one; a plain
    // --fresh launch refuses a live session, so the recovery names --stop.
    if (change && !result.ok && "guidance" in result) {
      const previous = change.from.runtime ?? "its previous runtime";
      const relaunch = `rig seat launch ${change.seatRef} --fresh --stop --reason "<why>"`;
      result = { ...result, guidance: recovery === "relaunch" || recovery === "relaunch-check-seat-env"
        ? `The node still records ${previous}. Relaunch the seat under it with: ${relaunch}`
          // Review r2 (INFO): the seat env scrub (spec 0013) refuses inside the pane, where the daemon can't see it, so
          // it surfaces as a readiness failure; the seat env mode is not known here, so the check is always named.
          + (recovery === "relaunch-check-seat-env"
            ? " If the pane shows seat_env_refused, fix the seat env policy first (rig config set seat_env.mode filter rolls it back), then relaunch."
            : "")
        : recovery === "fix-seat-env"
          // Spec 0013 (#16): the respawn was refused because the seat env allow-list could not be applied, after the
          // predecessor had ended; a relaunch is refused the same way until the policy applies again.
          ? `The seat env allow-list could not be applied, so no successor started; the predecessor has ended, and the node `
            + `still records ${previous}. Fix the seat env policy first (rig config set seat_env.mode filter rolls it back), `
            + `then relaunch with: ${relaunch}`
        : recovery === "check-seat"
          ? `The predecessor may have been signalled (TERM, then KILL) at ${step} and was not seen to exit; its pane is set to `
            + `stay open, and the node still records ${previous}. Check the seat with rig capture ${change.seatRef}: if the `
            + `predecessor still runs, no recovery is needed; if it exited, relaunch with: ${relaunch}`
          : `The seat was not changed: the failure came at ${step}, before the in-place respawn, and its predecessor still runs. `
            + "No recovery is needed; fix the cause and retry." } as SeatHandoverResult;
    }
    if (change && !result.ok) this.recordFailed(change, `${result.code} at ${step}`);
    return result;
  }

  /** One failed ledger row per attempt, holding a code and a step only (F3), and none once the change committed. */
  private recordFailed(change: PreparedRuntimeChange, failure: string): void {
    if (change.progress.recorded) return;
    change.progress.recorded = true;
    this.runtimeLedger.record({
      nodeId: change.nodeId, kind: change.kind, revertsChangeId: change.revertsChangeId, outcome: "failed", failure,
      from: change.from, to: change.to, specPath: change.specPath, specSha256: change.specSha256,
      approval: change.approval, reason: "", operator: change.operator,
    });
  }

  /** Spec 0005: a runtime change that throws, rather than returning a failure, still leaves a failed ledger row naming
   *  its step and whether the respawn ran, never the error, and the throw propagates. A throw after the commit landed is
   *  logged and returned as handover_committed_with_error instead, so it never reads as a failed handover. */
  private async recordingThrows(change: PreparedRuntimeChange | null,
    run: (attempt: { change: PreparedRuntimeChange | null }) => Promise<SeatHandoverResult>): Promise<SeatHandoverResult> {
    const attempt = { change };
    try {
      return await run(attempt);
    } catch (err) {
      const thrown = attempt.change;
      if (thrown?.progress.committed) {
        console.error(err); // as the route's error handler logged it
        const what = thrown.kind === "revert" ? "runtime revert" : "runtime change";
        return { ok: false, code: "handover_committed_with_error",
          message: `The ${what} committed, but a step after the commit failed: ${err instanceof Error ? err.message : String(err)}`,
          guidance: `The ${what} is COMMITTED: the seat runs ${thrown.to.runtime ?? "its target runtime"}. Do NOT retry, relaunch or revert to `
            + `recover. If its occupant declaration is pending, finish it `
            + `${thrown.issuedByAdvisor ? "from the advisor seat that issued this revert (or the kernel operator) " : ""}`
            + `with: rig seat runtime-declare ${thrown.seatRef} (it refuses when `
            + "nothing is pending)." };
      }
      if (thrown) this.recordFailed(thrown, `${thrown.progress.replacementStarted ? "threw_after_respawn" : "threw_before_respawn"} at ${thrown.progress.step}`);
      throw err;
    }
  }

  /** Inside the commit transaction: the node's runtime-bound state becomes the target's. A revert first checks that the
   *  revert slot still names the change it reverts (review r2 F2); if not, the whole commit rolls back. */
  private applyRuntimeChange(change: PreparedRuntimeChange, reason: string): void {
    if (change.kind === "revert" && this.runtimeLedger.revertSlot(change.nodeId)?.changeId !== change.revertsChangeId) {
      throw new RevertSlotMovedError();
    }
    const to = change.to;
    this.db.prepare("UPDATE nodes SET runtime = ?, model = ?, cwd = ?, effort = ?, effort_choice = ?, codex_config_profile = ?, env_json = ? WHERE id = ?")
      .run(to.runtime, to.model, to.cwd, change.toAuthoredEffort, change.toEffortChoice, change.toCodexProfile,
        to.env ? JSON.stringify(to.env) : null, change.nodeId);
    const row = change.toPermissionRow;
    if (row) {
      this.db.prepare(`INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(node_id) DO UPDATE SET runtime=excluded.runtime, mode=excluded.mode,
          actor=excluded.actor, reason=excluded.reason, updated_at=excluded.updated_at`)
        .run(change.nodeId, row.runtime, row.mode, row.actor, row.reason || reason);
    } else {
      this.db.prepare("DELETE FROM node_permission_selections WHERE node_id = ?").run(change.nodeId);
    }
    if (change.startup.kind === "member") {
      persistStartupContext(this.db, change.nodeId, change.startup.plan, change.startup.files, change.startup.actions, to.runtime!);
    } else if (change.startup.context) {
      const saved = change.startup.context;
      this.db.prepare("INSERT OR REPLACE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
        .run(change.nodeId, saved.projection_entries_json, saved.resolved_files_json, saved.startup_actions_json, saved.runtime);
    } else {
      this.db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(change.nodeId);
    }
  }

  /** Inside the commit transaction: the ledger row, the revert slot and the seat.runtime_changed event. */
  private recordCommittedChange(change: PreparedRuntimeChange, status: SeatStatus, reason: string, generationUuid: string | null): { changeId: string; event: PersistedEvent } {
    const changeId = this.runtimeLedger.record({
      nodeId: change.nodeId, kind: change.kind, revertsChangeId: change.revertsChangeId, outcome: "committed", generationUuid,
      from: change.from, to: change.to, specPath: change.specPath, specSha256: change.specSha256,
      approval: change.approval, reason, operator: change.operator,
    });
    if (change.kind === "change") this.runtimeLedger.setRevertSlot(change.nodeId, changeId, change.before);
    else this.runtimeLedger.clearRevertSlot(change.nodeId);
    const event = this.eventBus.persistWithinTransaction({
      type: "seat.runtime_changed", rigId: status.rig_id, nodeId: change.nodeId, logicalId: status.logical_id, changeId, kind: change.kind,
      fromRuntime: change.from.runtime, toRuntime: change.to.runtime!, fromModel: change.from.model, toModel: change.to.model,
      fromCwd: change.from.cwd, toCwd: change.to.cwd, env: envFingerprint(change.to.env), approval: change.approval, reason,
      operator: change.operator, acceptance: "pending",
    });
    return { changeId, event };
  }

  private checkRuntimeMismatch(nodeRuntime: string | null, discoveredRuntime: string): SeatHandoverResult | null {
    if (!nodeRuntime || discoveredRuntime === "unknown" || nodeRuntime === discoveredRuntime) {
      return null;
    }
    return {
      ok: false,
      code: "runtime_mismatch",
      message: `Seat expects runtime "${nodeRuntime}", but discovered successor is "${discoveredRuntime}".`,
      guidance: "Use a discovered successor with a matching runtime hint.",
    };
  }

  private lookupNode(status: SeatStatus): NodeRow {
    return this.db.prepare(
      "SELECT id, runtime, cwd, model, codex_config_profile, effort FROM nodes WHERE rig_id = ? AND logical_id = ?"
    ).get(status.rig_id, status.logical_id) as NodeRow;
  }

  private lookupLatestSession(nodeId: string): SessionRow | null {
    return this.db.prepare(
      "SELECT id, session_name, status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1"
    ).get(nodeId) as SessionRow | undefined ?? null;
  }

  private lookupManagedOwner(tmuxSession: string, targetNodeId: string, ignoreArchived: boolean): BindingOwnerRow | null {
    return findOtherSessionOwner(this.db, tmuxSession, targetNodeId, { ignoreArchived });
  }

  private commit(input: {
    seatRef: string;
    status: SeatStatus;
    node: NodeRow;
    latestSession: SessionRow;
    reportedSource: SeatHandoverSource;
    reason: string;
    operator: string | null;
    discovered: ReturnType<DiscoveryRepository["getDiscoveredSession"]> & NonNullable<unknown>;
    contextDelivered: boolean;
    launchToken: { token: string; resumeType?: string } | null;
    occupantGeneration: string | null;
    appliedLaunch: AppliedLaunchObservation | null;
      sourceOutcome?: SeatHandoverMutationResult["sourceOutcome"];
    change: PreparedRuntimeChange | null;
  }): SeatHandoverResult {
    const handoverAt = this.now().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited') ORDER BY id"
      ).all(input.node.id) as Array<{ id: string }>;
      const previousSessionIdsSuperseded = rows.map((row) => row.id);

      if (previousSessionIdsSuperseded.length > 0) {
        const placeholders = previousSessionIdsSuperseded.map(() => "?").join(",");
        this.db.prepare(
          `UPDATE sessions SET status = 'superseded', last_seen_at = datetime('now') WHERE id IN (${placeholders})`
        ).run(...previousSessionIdsSuperseded);
      }

      // Spec 0005: the node's runtime-bound state changes only here, before the successor's tenure is minted (the
      // mint records the node's runtime). The runtime the successor runs is the target from here on.
      if (input.change) this.applyRuntimeChange(input.change, input.reason);
      const successorRuntime = input.change ? input.change.to.runtime : input.node.runtime;

      this.upsertBinding(input.node.id, {
        tmuxSession: input.discovered.tmuxSession,
        tmuxWindow: input.discovered.tmuxWindow,
        tmuxPane: input.discovered.tmuxPane,
      });
      // (e/Class-B): capture the RETIRING occupant's generation BEFORE registerClaimedSession mints the
      // successor's tenure below — after that mint the node's "current" generation IS the successor's
      // (the name is reused), so this is the only point the retiree's generation is resolvable.
      const retiringGeneration =
        this.sessionRegistry.currentOccupantGenerationForSession(input.latestSession.session_name) ?? undefined;
      // atom-B: a seat handover mints a HANDOVER-kind occupant generation (not the default 'adopt').
      const newSession = this.sessionRegistry.registerClaimedSession(
        input.node.id,
        input.discovered.tmuxSession,
        "handover",
        input.occupantGeneration,
      );
      // W3: registerClaimedSession mints the successor generation. Only now may
      // the exact adapter-returned launch effect be attached to that tenure.
      // The store is best-effort, so observation persistence can never make an
      // otherwise successful handover fail.
      if (input.appliedLaunch) {
        const successorGeneration = this.sessionRegistry.currentOccupantTenure(input.node.id)?.generationUuid;
        if (successorGeneration) {
          this.appliedLaunchObservations.recordGeneration(successorGeneration, input.appliedLaunch);
        }
      }
      // B2 (launched/fresh): persist the launch-scraped resume token atomically
      // with the claim, provenance "scrape" (mirrors StartupOrchestrator's
      // launch-token capture). Validity-guarded; a malformed token is dropped,
      // never a bad write. The token is never logged.
      if (input.launchToken) {
        const validated = validateResumeToken(successorRuntime, input.launchToken.token);
        if (validated.ok) {
          this.sessionRegistry.updateResumeToken(newSession.id, validated.resumeType, validated.token, "scrape");
        }
      }
      this.discoveryRepo.markClaimed(input.discovered.id, input.node.id);
      // KI-14: the continuity label must describe THIS launch. A NULL here let node-inventory derive
      // the seat's continuity from restore_outcome — a stamp from a restore days earlier — so the
      // 2026-08-22 wave's seats reported fresh/fresh-primed while their panes ran resumed contexts.
      // fresh mode is now verified-blank at launch (successor_pane_not_blank guards it), so 'fresh'
      // is earned; a discovered successor's continuity is genuinely unknown and stays NULL.
      // OPR.0.5.5.5 — the executed source records its own continuity vocabulary
      // (the startup-orchestrator set): fresh->fresh, fork->forked,
      // rebuild->rebuilt; discovered stays null (continuity unknown to us).
      const continuityOutcome = input.reportedSource.mode === "fresh" ? "fresh"
        : input.reportedSource.mode === "fork" ? "forked"
        : input.reportedSource.mode === "rebuild" ? "rebuilt"
        : null;
      this.db.prepare(`
        UPDATE nodes SET
          occupant_lifecycle = 'active',
          continuity_outcome = ?,
          handover_result = 'complete',
          previous_occupant = ?,
          handover_at = ?
        WHERE id = ?
      `).run(continuityOutcome, input.latestSession.session_name, handoverAt, input.node.id);

      // Ghost-stage (e) re-key seam — the rebind is done; now invalidate the RETIRING occupant's
      // seat-name-keyed stores so the successor never inherits a ghost (drained compaction stage, frozen
      // telemetry sample, delayed lifecycle message to the retired generation). The ghost-stage slice
      // owns the per-store impls behind OccupantInvalidator; this seat owns this single call. Under the
      // cutover the successor reuses the seat name, so retiring === successor here — Class-A is safe by
      // TIMING (runs before the successor writes) and Class-B is gen-scoped via retiringGeneration (the
      // retiree's generation, captured above pre-mint). Optional dep: absent → skipped, never blocks.
      this.occupantInvalidator?.invalidateRetiringOccupant({
        retiringSessionName: input.latestSession.session_name,
        successorSessionName: input.discovered.tmuxSession,
        retiringGeneration,
      });

      const event = this.eventBus.persistWithinTransaction({
        type: "seat.handover_completed",
        rigId: input.status.rig_id,
        nodeId: input.node.id,
        logicalId: input.status.logical_id,
        previousOccupant: input.latestSession.session_name,
        currentOccupant: input.discovered.tmuxSession,
        source: input.reportedSource.raw,
        reason: input.reason,
        operator: input.operator,
        ...(input.sourceOutcome ? { sourceOutcome: input.sourceOutcome } : {}),
      });
      const runtimeRecord = input.change
        ? this.recordCommittedChange(input.change, input.status, input.reason, this.sessionRegistry.currentOccupantTenure(input.node.id)?.generationUuid ?? null)
        : null;
      return { newSessionId: newSession.id, previousSessionIdsSuperseded, event, runtimeRecord };
    });

    let committed: { newSessionId: string; previousSessionIdsSuperseded: string[]; event: PersistedEvent;
      runtimeRecord: { changeId: string; event: PersistedEvent } | null };
    try {
      committed = tx();
      if (input.change) input.change.progress.recorded = input.change.progress.committed = true;
    } catch (err) {
      if (err instanceof RevertSlotMovedError) {
        return { ok: false, code: "runtime_revert_unavailable", message: "The change this revert was built from is no longer the seat's latest; nothing was reverted.",
          guidance: "Another change or revert committed first. Inspect the seat and its runtime-change ledger before reverting again." };
      }
      return {
        ok: false,
        code: "handover_commit_failed",
        message: `Seat handover commit failed: ${err instanceof Error ? err.message : String(err)}`,
        guidance: "Inspect daemon logs and retry after the seat state is consistent.",
      };
    }

    // S19 ruling 01530 — the SOLE narrow call: after the commit lands, the activity
    // oracle sees the swap as its own event, keyed by the durable node id, identified
    // by the successor tenure (never the retiree's). In-memory, post-commit, optional.
    // The commit has landed, so a failure here is reported as such and never as a failed handover: nothing is unwound,
    // and the guidance never says to retry or relaunch.
    let swapUndeclared: string | null = null;
    try {
      this.activityOracle?.declareOccupantSwap(input.node.id, committed.newSessionId);
    } catch (err) {
      swapUndeclared = err instanceof Error ? err.message : String(err);
    }
    if (swapUndeclared === null && committed.runtimeRecord) this.runtimeLedger.markDeclared(committed.runtimeRecord.changeId, input.change!.operator);

    this.eventBus.notifySubscribers(committed.event);
    if (committed.runtimeRecord) this.eventBus.notifySubscribers(committed.runtimeRecord.event);
    if (swapUndeclared !== null) {
      const landed = input.change
        ? `The runtime change is COMMITTED: the seat runs ${input.change.to.runtime ?? "its target runtime"} in "${input.discovered.tmuxSession}".`
        : `The handover is COMMITTED: "${input.discovered.tmuxSession}" is the seat's occupant.`;
      return { ok: false, code: "handover_committed_swap_undeclared",
        message: `The handover committed and "${input.discovered.tmuxSession}" is the seat's occupant, but the activity oracle did not take the swap: ${swapUndeclared}`,
        guidance: `${landed} Do NOT retry, relaunch or revert to recover. Only the activity oracle's occupant declaration failed, so the seat's `
          + "activity state may still reflect its predecessor. "
          + (input.change
            ? `Finish the declaration ${input.change.issuedByAdvisor ? "from the advisor seat that issued this revert (or the kernel operator) " : ""}`
              + `with: rig seat runtime-declare ${input.change.seatRef}`
            : "No rig command re-declares a plain handover's occupant; report this to the operator.") };
    }
    const postStatus = this.statusService.getStatus(`${input.status.logical_id}@${input.status.rig_name}`);
    const currentStatus = postStatus.ok
      ? {
          sessionStatus: postStatus.status.session_status,
          startupStatus: postStatus.status.startup_status,
          occupantLifecycle: postStatus.status.occupant_lifecycle,
          continuityOutcome: postStatus.status.continuity_outcome,
          handoverResult: postStatus.status.handover_result,
          previousOccupant: postStatus.status.previous_occupant,
          handoverAt: postStatus.status.handover_at,
          restoreOutcome: postStatus.status.restore_outcome,
        }
      : {
          sessionStatus: "running",
          startupStatus: "ready" as const,
          occupantLifecycle: "active" as const,
          continuityOutcome: null,
          handoverResult: "complete" as const,
          previousOccupant: input.latestSession.session_name,
          handoverAt,
          restoreOutcome: input.status.restore_outcome,
        };

    return {
      ok: true,
      result: {
        ok: true,
        dryRun: false,
        mutated: true,
        continuityTransferred: false,
        seat: {
          ref: input.seatRef,
          rigId: input.status.rig_id,
          rigName: input.status.rig_name,
          logicalId: input.status.logical_id,
          podId: input.status.pod_id,
          podNamespace: input.status.pod_namespace,
          runtime: input.change ? input.change.to.runtime : input.status.runtime,
        },
        source: input.reportedSource,
        reason: input.reason,
        operator: input.operator,
        previousOccupant: input.latestSession.session_name,
        currentOccupant: input.discovered.tmuxSession,
        previousSessionIdsSuperseded: committed.previousSessionIdsSuperseded,
        newSessionId: committed.newSessionId,
        discovery: {
          id: input.discovered.id,
          status: "claimed",
          tmuxSession: input.discovered.tmuxSession,
          tmuxPane: input.discovered.tmuxPane,
        },
        currentStatus,
        handoverAt,
        eventSeq: committed.event.seq,
        ...(input.sourceOutcome ? { sourceOutcome: input.sourceOutcome } : {}),
        ...(input.change && committed.runtimeRecord
          ? { runtimeChange: { ...this.summarizeRuntimeChange(input.change), changeId: committed.runtimeRecord.changeId, acceptance: "pending" as const } }
          : {}),
        sideEffects: {
          departingSessionKilled: false,
          startupContextDelivered: input.contextDelivered,
          provenanceRecordWritten: false,
        },
      },
    };
  }

  private upsertBinding(nodeId: string, fields: { tmuxSession: string; tmuxWindow: string | null; tmuxPane: string | null }): void {
    const existing = this.db.prepare("SELECT id FROM bindings WHERE node_id = ?").get(nodeId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE bindings SET
          attachment_type = 'tmux',
          tmux_session = ?,
          tmux_window = ?,
          tmux_pane = ?,
          external_session_name = NULL,
          updated_at = datetime('now')
        WHERE node_id = ?
      `).run(fields.tmuxSession, fields.tmuxWindow, fields.tmuxPane, nodeId);
      return;
    }

    this.db.prepare(`
      INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_window, tmux_pane)
      VALUES (?, ?, 'tmux', ?, ?, ?)
    `).run(ulid(), nodeId, fields.tmuxSession, fields.tmuxWindow, fields.tmuxPane);
  }
}

/** Assemble the restore packet delivered to a fresh successor: seat identity + handover reason +
 *  predecessor session + the captured predecessor terminal, and a bounded LABELED-FROM-RECORD recap
 *  of the last few predecessor exchanges + a receipt line naming the predecessor record path
 *  (honest-degraded). The recap is the permanent claude-runtime leg of scrollback preservation —
 *  claude-code seats run in the tmux alternate screen, which keeps no scrollback buffer, so no
 *  successor pane can natively scroll into the predecessor conversation there; the cutover's
 *  respawn-pane owns native scrollback on codex seats. Never called "scrollback": the label must
 *  make replay unmistakable, because passing a replayed recap off as native history is the one
 *  thing the requirement cannot survive. Exported for unit test. */
export function buildRestorePacket(info: {
  seatRef: string;
  reason: string;
  departingSession: string;
  handoverAt: string;
  capturedContext: string;
  /** The last few predecessor exchanges read from the provider JSONL, bounded on count and per-exchange length. */
  recap?: Array<{ role: string; content: string }>;
  /** The predecessor provider record path (claude transcript_path / codex rollout_path). */
  recordPath?: string | null;
  /** B16 — the NAMED reason when no recap resolved; rendered as its own labeled line so the absence
   *  is visible in the pane (honest-degraded means labeled, not silent). */
  recapUnavailableReason?: string;
  /** OPR.0.5.3.5 mini-req 7 — the AUTHORED seat recap (decisions-with-rationale, written by the
   *  outgoing occupant): rendered as a POINTER to its address (no-copy composition — the packet
   *  never inlines the bytes; the successor pulls by address). */
  authoredRecap?: { address: string; chainLength: number };
  /** Labeled absence for the authored leg (B16 doctrine — never a silent omission). */
  authoredRecapAbsentReason?: string;
  /** Spec 0005 — a runtime change or revert, stated first: the predecessor conversation does not cross harnesses. */
  runtimeChange?: { kind: "change" | "revert"; from: string | null; to: string | null };
}): string {
  const captured = info.capturedContext.trim();
  const lines = [
    "=== OpenRig seat handover — restore context ===",
    `Seat: ${info.seatRef}`,
    `Reason: ${info.reason}`,
    ...(info.runtimeChange
      ? [`Runtime ${info.runtimeChange.kind === "revert" ? "reverted" : "changed"} from ${info.runtimeChange.from ?? "unknown"} to ${info.runtimeChange.to ?? "unknown"}; the predecessor conversation is not resumed.`]
      : []),
    `Predecessor session: ${info.departingSession}`,
    `Handover at: ${info.handoverAt}`,
    "",
    "--- Predecessor terminal (captured) ---",
    captured.length > 0 ? captured : "(no capture available)",
  ];
  // The from-record recap + receipt, ONLY when a record is actually available (no fabrication).
  // B16 — an absent recap is no longer a silent omission: the packet names the reason, so a
  // successor (and the operator reading the pane) can tell "nothing resolved because X" from
  // "the feature never ran".
  if (info.recap && info.recap.length > 0 && info.recordPath) {
    lines.push(
      "",
      "--- Predecessor recap (replayed from record, not the live terminal) ---",
      ...info.recap.map((e) => `${e.role}: ${e.content}`),
      "",
      `Predecessor record: ${info.recordPath}`,
      "  (honest-degraded: durable, true, and grep-able — not human-scrollable; the recap above is replayed from it)",
    );
  } else if (info.recapUnavailableReason) {
    lines.push(
      "",
      `--- Predecessor recap unavailable: ${info.recapUnavailableReason} ---`,
    );
  }
  // The AUTHORED recap leg (mini-req 7): a pointer, never inlined bytes — the
  // successor pulls by address so there is exactly one copy to trust.
  if (info.authoredRecap) {
    const chainNote = info.authoredRecap.chainLength > 0
      ? ` (${info.authoredRecap.chainLength} superseded predecessor${info.authoredRecap.chainLength === 1 ? "" : "s"} retained on the seat tree)`
      : "";
    lines.push(
      "",
      `--- Authored seat recap: ${info.authoredRecap.address}${chainNote} ---`,
      "Composed into handover/post-compaction profiles automatically (rig context profile <pack> --situation handover --rig <rig> --seat <seat>); or read it directly at the seat tree address above.",
    );
  } else if (info.authoredRecapAbsentReason) {
    lines.push(
      "",
      `--- Authored seat recap: ${info.authoredRecapAbsentReason} ---`,
    );
  }
  return lines.join("\n");
}
