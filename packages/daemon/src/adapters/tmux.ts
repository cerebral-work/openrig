import { DeliveryGuardError, type SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isSecretSeatEnvName, seatEnvAllowlistApplies, seatEnvScrubScript, seatKubeconfig, seatLaunchExcludedEnvKeys,
  type SeatEnvPolicy } from "../domain/seat-launch-env-filter.js";
import { SEAT_ENV_KEYS_VAR } from "../domain/seat-env.js";
import type { TmuxControlExec } from "./tmux-control.js";
import { stat } from "node:fs/promises";
import { verifyPaneIdleShell, type NativeProcessLister } from "../domain/native-process-lineage.js";

export type ExecFn = (cmd: string) => Promise<string>;

interface TmuxShellCommandOptions {
  /** Pi can send commands within the terminal byte bound directly. */
  stageIfLong?: boolean;
  /** A staged single-executable runner must replace the staging shell. */
  execInScript?: boolean;
  /** Preserve rc aliases/functions in POSIX or fish panes; other shells use /bin/sh. */
  sourceInPane?: boolean;
}

/**
 * Argv exec: run the multiplexer WITHOUT a shell (execFile-style — the
 * binary is argv[0], the rest are verbatim arguments, no quoting layer).
 * The daemon wires it on every platform: no shell process per call, and on
 * Windows/psmux no POSIX quoting or `/dev/null` redirections to depend on.
 * When absent every method uses the legacy shell-string path unchanged.
 */
export type ArgvExecFn = (argv: string[]) => Promise<string>;

/**
 * Injectable file/buffer operations for `sendText`.
 * Split out so tests can observe temp-file writes and unique-name generation
 * without touching the real filesystem; production wires node fs + os.tmpdir.
 */
export interface TmuxFileOps {
  writeFile(path: string, content: string, options?: { mode: number; flag: "wx" }): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Unique temp-file path per call - parallel `rig up` stands up many seats. */
  tmpName(): string;
  /** Unique tmux buffer name per call - a fixed name would collide under concurrency. */
  bufferName(): string;
}

// One source for the staged script's name: the generator (defaultTmuxFileOps) and the matcher
// (isStagedSendScriptPath) are both built from it.
const SEND_SCRIPT_PREFIX = "openrig-tmux-send-";
const SEND_SCRIPT_SUFFIX = ".txt";
const SEND_SCRIPT_NAME = new RegExp(
  `^${SEND_SCRIPT_PREFIX}\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${SEND_SCRIPT_SUFFIX.replace(".", "\\.")}$`,
);

/** Whether `path` names a launch script sendShellCommand staged (an absolute path with the name
 *  defaultTmuxFileOps gives it). The script removes itself first, so this is a name check only. */
export function isStagedSendScriptPath(path: string): boolean {
  return path.startsWith("/") && SEND_SCRIPT_NAME.test(path.split("/").pop() ?? "");
}

export function defaultTmuxFileOps(): TmuxFileOps {
  return {
    writeFile: (p, content, options) => fsWriteFile(p, content, { encoding: "utf8", ...options }),
    unlink: (p) => fsUnlink(p),
    tmpName: () => pathJoin(tmpdir(), `${SEND_SCRIPT_PREFIX}${process.pid}-${randomUUID()}${SEND_SCRIPT_SUFFIX}`),
    bufferName: () => `openrig_${process.pid}_${randomUUID().replace(/-/g, "")}`,
  };
}

export type TmuxResult =
  | { ok: true; warnings?: string[] }
  | { ok: false; code: string; message: string };

/** Spec 0013 item 9: a `-e NAME=VALUE` is on the tmux client's argv while it runs, and a tmux server keeps the argv
 *  of the command that started it for its whole life, so anything on the host can read it with `ps`. A secret-named
 *  variable is therefore never passed that way: the launch is refused before any tmux command runs, naming the
 *  variable and never its value. A channel that carries such a value without argv is a follow-up. */
export function secretNamedLaunchVars(env: Readonly<Record<string, string | undefined>> | undefined): string[] {
  // OPENRIG_SEAT_ENV_KEYS matches the name rule (KEY) but carries a list of declared variable names, never a value: it is
  // exempt only while its value has that shape (review r2 on #35).
  const nameList = (name: string) => name === SEAT_ENV_KEYS_VAR && /^[A-Z_][A-Z0-9_]*(,[A-Z_][A-Z0-9_]*)*$/.test(env?.[name] ?? "");
  return Object.keys(env ?? {}).filter((name) => isSecretSeatEnvName(name) && !nameList(name)).sort();
}

function secretOnArgvRefusal(env: Record<string, string> | undefined, step: string): TmuxResult | null {
  const names = secretNamedLaunchVars(env);
  if (names.length === 0) return null;
  return { ok: false, code: "secret_on_argv_refused", message: `tmux ${step} refused: the launch env holds secret-named ${names.join(", ")}, and a secret value is never put on a tmux argv. Remove it from the seat env or the provider-auth allow-list; a channel that carries it without argv is a follow-up.` };
}

/** Spec 0015: a pane pid read. `absent` is tmux's positive report that the pane is gone; `unavailable` is any other
 *  failure, which is never evidence of absence. */
export type PanePidObservation = { kind: "pid"; pid: number } | { kind: "absent" } | { kind: "unavailable" };

/** Spec 0015: a pane pid read as a typed observation. An adapter without the typed read keeps its own meaning, where a
 *  null pid has always meant the pane is gone. */
export async function readPanePid(
  tmux: Pick<TmuxAdapter, "getPanePid"> & Partial<Pick<TmuxAdapter, "observePanePid">>,
  paneId: string,
): Promise<PanePidObservation> {
  if (tmux.observePanePid) return tmux.observePanePid(paneId);
  const pid = await tmux.getPanePid(paneId);
  return pid === null ? { kind: "absent" } : { kind: "pid", pid };
}

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: number;
  active: boolean;
}

export interface TmuxPane {
  id: string;
  index: number;
  cwd: string;
  width: number;
  height: number;
  active: boolean;
}

/**
 * Cursor coordinates plus pane geometry, used by the live-terminal seed
 * (OPR.0.4.0.38). Coordinates are zero-based; geometry is the visible pane
 * size. Lifted from the FR-4 seed work so a new subscriber can paint the
 * current screen with the cursor in the right place and no row drift.
 */
export interface TmuxCursorPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * An attached tmux client — the human's terminal/CMUX tile. `name` is the
 * client identifier accepted by `switch-client -c` (the client tty by default);
 * `session` is the session the client is CURRENTLY viewing (may be the wrong or
 * a dead view, which is exactly the recovery case OPR.0.4.3.26 retargets).
 */
export interface TmuxClient {
  name: string;
  session: string;
}

/**
 * Result of a classified session probe (OPR.0.5.4.2). `absent` carries
 * positive tmux evidence; `transport_unavailable` means the tmux server could
 * not be reached and session existence was NOT determined — the two are never
 * interchangeable.
 */
export type SessionProbe =
  | { state: "present" }
  | { state: "absent" }
  | { state: "transport_unavailable"; cause: string };

const TMUX_FIELD_SEPARATOR = "|";
const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{session_created}",
  "#{session_attached}",
].join(TMUX_FIELD_SEPARATOR);
const WINDOW_FORMAT = [
  "#{window_index}",
  "#{window_name}",
  "#{window_panes}",
  "#{window_active}",
].join(TMUX_FIELD_SEPARATOR);
// tmux 3.6 sanitizes literal control characters in -F output to underscores, and
// tmux 3.3a replaces tabs with underscores, so tab-delimited rows become
// unparseable on those versions. EVERY adapter-owned format uses the printable
// delimiter instead.
const PANE_FORMAT = [
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_current_path}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
].join(TMUX_FIELD_SEPARATOR);
const CLIENT_FORMAT = [
  "#{client_name}",
  "#{client_session}",
].join(TMUX_FIELD_SEPARATOR);
const CURSOR_FORMAT = [
  "#{cursor_x}",
  "#{cursor_y}",
  "#{pane_width}",
  "#{pane_height}",
].join(TMUX_FIELD_SEPARATOR);

function isNoServerError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no server running");
}

/** The error tmux reported, without the stdout an exec error carries: in a chain that stdout is the earlier panes'
 *  text, which an agent controls. Errors that kept no stderr classify on their message. */
function tmuxReportedError(err: unknown): unknown {
  const stderr = (err as { execStderr?: unknown } | null)?.execStderr;
  return typeof stderr === "string" ? new Error(stderr) : err;
}

function isSessionAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("session not found") ||
    msg.includes("can't find session") ||
    msg.includes("no current target") ||
    msg.includes("no session");
}

function isPaneAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("can't find pane") || msg.includes("pane not found") || msg.includes("no such pane");
}

// Post-reboot the tmux socket file at /tmp/tmux-<uid>/<name> is gone, so
// `tmux has-session` exits non-zero with a transport-absent message rather than
// a server/session-absent message. probeSession() classifies this class as
// transport_unavailable — session existence NOT determined, never absence;
// only Reconciler elects to treat that state as detachable, at its own
// cold-start call site (OPR.0.5.4.2). Permission errors must remain rethrown.
function isTmuxTransportAbsentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Fail-closed: never classify a permission/authorization failure as absence.
  if (/permission denied|operation not permitted|EACCES|EPERM/i.test(msg)) {
    return false;
  }
  // tmux's socket-transport failure prefix; the parenthetical names the cause.
  //   "error connecting to /private/tmp/tmux-501/default (No such file or directory)"
  //   "error connecting to /private/tmp/tmux-501/default (Connection refused)"
  if (msg.startsWith("error connecting to")) {
    return /No such file or directory|Connection refused/.test(msg);
  }
  // Conservative bare-message variants that still reference a tmux socket path.
  if (/tmux-\d+/.test(msg) && /No such file or directory|Connection refused/.test(msg)) {
    return true;
  }
  return false;
}

/** tmux reasons that name a session or socket, never a launch value. */
const SAFE_TMUX_REASON = /^(duplicate session|can't find (session|pane|window)|no server running|session not found|no current)/;

/** A failed tmux command as its step, the names (never the values) of its `-e NAME=VALUE` launch variables
 *  and, when it is one of the known safe phrases, tmux's reason. Never the command line: an exec error's
 *  message starts with the whole command, values included, and can carry its output, so neither reaches a
 *  result, warning, log or event (SEC-178; r2 on #15). */
export function tmuxFailureMessage(err: Error): string {
  if (!err.message.startsWith("Command failed:")) return err.message;
  const command = err.message.split("\n", 1)[0]!;
  const step = /^Command failed: (?:\S*\/)?tmux(?: -[SfL] \S+)* ([a-z-]+)/.exec(command)?.[1] ?? "command";
  const names = [...new Set([...command.matchAll(/ -e '?([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]!))];
  const stderr = (err as { execStderr?: unknown; stderr?: unknown }).execStderr ?? (err as { stderr?: unknown }).stderr;
  const reason = (typeof stderr === "string" ? stderr : "").trim().split(/\r?\n/)[0] ?? "";
  return `tmux ${step} failed${names.length ? ` (env names: ${names.join(", ")})` : ""}${SAFE_TMUX_REASON.test(reason) ? `: ${reason}` : ""}`;
}

function classifyWriteError(err: unknown): TmuxResult {
  if (err instanceof DeliveryGuardError) return { ok: false, code: err.code, message: err.message };
  if (!(err instanceof Error)) {
    return { ok: false, code: "unknown", message: "tmux command failed" };
  }
  if (err.message.includes("duplicate session")) {
    return { ok: false, code: "duplicate_session", message: tmuxFailureMessage(err) };
  }
  if (err.message.includes("can't find session") || err.message.includes("no server running")) {
    return { ok: false, code: "session_not_found", message: tmuxFailureMessage(err) };
  }
  return { ok: false, code: "unknown", message: tmuxFailureMessage(err) };
}

/** A failed respawn's error names its argv, which carries every env value as `-e NAME=VALUE` (raw, or shell-quoted on
 *  the legacy path). The values are redacted and the names kept, so no caller, ledger or log receives a value. */
function redactEnvValues(result: TmuxResult, env?: Record<string, string>): TmuxResult {
  if (result.ok || !env) return result;
  let message = result.message;
  for (const value of Object.values(env)) {
    if (!value) continue;
    for (const form of new Set([value, value.replace(/'/g, "'\"'\"'")])) message = message.split(form).join("<redacted>");
  }
  return { ...result, message };
}

/** The launch warning when the parent-session identity cleanup could not finish (#771). */
function parentSessionEnvWarning(target: string, err: unknown): string {
  const reason = err instanceof Error ? tmuxFailureMessage(err) : "tmux command failed";
  return `${target}: could not remove the launching session's identity (for example CLAUDECODE) from this seat's environment, so the seat may still see it: ${reason}`;
}

/** Shell-quote a string using single quotes (POSIX-safe). */
/** One pane's text from a batched capture, with the time its chunk was read (#309 review). `text` is null for a
 *  session that is gone or an empty capture. */
export interface PaneCapture { text: string | null; capturedAt: Date; /** The listing lacked the session. */ missing?: true }

/** The most sessions one batched capture chains (#308). Not a byte bound: a chunk whose output overflows exec's buffer
 *  fails and is split in half. */
export const CAPTURE_BATCH = 24;

function shellQuote(s: string): string {
  // Replace each ' with '"'"' (end quote, double-quote the apostrophe, resume quote)
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * An exact tmux target for a session name. tmux resolves a bare name by prefix when no session has that exact name,
 * so a read or pipe for a session that just ended would act on another (`dev-impl@my-rig` on `dev-impl@my-rig2`).
 * Pane, window and session ids (`%3`, `@1`, `$2`) and `session:window.pane` targets pass through unchanged (tmux
 * turns `:` in a session name into `_`, so a `:` always means an explicit target). A pane or window command gets
 * `=name:` (as the batched capture uses); a session command gets `=name`.
 */
function exactTarget(target: string, kind: "pane" | "window" | "session"): string {
  if (/^[%@$]\d+$/.test(target) || target.includes(":")) return target;
  return kind === "session" ? `=${target}` : `=${target}:`;
}

/** Elements safe to leave bare in a POSIX shell word list. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Join argv for a POSIX shell — the legacy string form. Only used when
 *  no ArgvExecFn is wired. Flags and safe words stay bare (matching the
 *  historical template strings); anything else is single-quoted. The argv
 *  arrays stay the single source of truth for what is EXECUTED on either
 *  path — this join only renders them for a shell. */
function posixJoinArgv(argv: string[]): string {
  return argv.map((a) => (SHELL_SAFE.test(a) ? a : shellQuote(a))).join(" ");
}

function parseSessionLine(line: string): TmuxSession | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 4) return null;
  // Only the final three fields are metadata; a literal session name may
  // itself contain the printable separator, just like pane paths/window names.
  const windows = parseInt(parts.at(-3)!, 10);
  if (isNaN(windows)) return null;
  return {
    name: parts.slice(0, -3).join(TMUX_FIELD_SEPARATOR),
    windows,
    created: parts.at(-2)!,
    attached: parts.at(-1) === "1",
  };
}

function parseClientLine(line: string): TmuxClient | null {
  // First-separator split keeps any separator inside the session name intact.
  const separator = line.indexOf(TMUX_FIELD_SEPARATOR);
  if (separator <= 0) return null;
  const session = line.slice(separator + 1);
  if (session === "") return null;
  return {
    name: line.slice(0, separator),
    session,
  };
}

function parseWindowLine(line: string): TmuxWindow | null {
  const firstSeparator = line.indexOf(TMUX_FIELD_SEPARATOR);
  const lastSeparator = line.lastIndexOf(TMUX_FIELD_SEPARATOR);
  const panesSeparator = line.lastIndexOf(TMUX_FIELD_SEPARATOR, lastSeparator - 1);
  if (firstSeparator < 0 || panesSeparator <= firstSeparator || lastSeparator <= panesSeparator) return null;

  const index = parseInt(line.slice(0, firstSeparator), 10);
  const panes = parseInt(line.slice(panesSeparator + 1, lastSeparator), 10);
  if (isNaN(index) || isNaN(panes)) return null;
  return {
    index,
    name: line.slice(firstSeparator + 1, panesSeparator),
    panes,
    active: line.slice(lastSeparator + 1) === "1",
  };
}

function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 6) return null;
  const index = parseInt(parts[1]!, 10);
  const width = parseInt(parts.at(-3)!, 10);
  const height = parseInt(parts.at(-2)!, 10);
  if (isNaN(index) || isNaN(width) || isNaN(height)) return null;
  return {
    id: parts[0]!,
    index,
    cwd: parts.slice(2, -3).join(TMUX_FIELD_SEPARATOR),
    width,
    height,
    active: parts.at(-1) === "1",
  };
}

function parseLines<T>(output: string, parser: (line: string) => T | null): T[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parser)
    .filter((result): result is T => result !== null);
}

export class TmuxAdapter {
  deliveryGuard?: SeatDeliveryGuard;
  private readonly freshProbes = new Map<string, string>();
  private readonly freshManaged = new Map<string, {nodeId: string; pane: string}>();
  private readonly freshShells = new Set<string>();
  private readonly shellLaunches = new Map<string, string>();

  /** Only the private metadata probe uses this door. Success proves allocation,
   * never authority over a pre-existing or registry-managed target. */
  async createProbeSession(name: string, cwd?: string): Promise<TmuxResult> {
    if (this.deliveryGuard?.maybeTarget(name)) return { ok: false, code: "guard_target_managed", message: "A probe cannot reuse a managed seat." };
    // #188: the create itself reports the new session's id and creation time, the only identity a rollback
    // uses. An id alone is unique only for one server's lifetime.
    let created: { id: string; at: string } | null;
    try {
      const out = await this.exec(`tmux new-session -d -P -F ${shellQuote("#{session_id} #{session_created}")} -s ${shellQuote(name)}${cwd != null ? ` -c ${shellQuote(cwd)}` : ""}`);
      const match = /^(\$\d+) (\d+)$/.exec(out.trim());
      created = match ? { id: match[1]!, at: match[2]! } : null;
    } catch (err) {
      return classifyWriteError(err);
    }
    let message = "New probe pane could not be established; no input written.";
    let pane: string | null = null;
    try {
      const panes = await this.listPanes(name);
      pane = panes.length === 1 ? panes[0]!.id : null;
      // #188: a fresh tmux server reuses pane ids, so a stale seat binding can name the new pane. That
      // probe could not be cleaned up safely later, so it is not used.
      if (pane && this.deliveryGuard?.maybeTarget(pane)) message = "New probe pane is named by a managed record; no input written.";
      else if (pane) { this.freshProbes.set(name, pane); this.freshProbes.set(pane, pane); return await this.excludeFromProbe(name, pane, cwd); }
    } catch { /* no target proof, no input */ }
    // #188: remove the unusable helper by the id its own create returned, unless a managed record has
    // since claimed its name (a binding naming only the reused pane id, under another session name, is
    // stale: that pane belongs to this session). A name reused by another session has a different id.
    const byPane = pane ? this.deliveryGuard?.maybeTarget(pane) : null;
    if (!created || this.deliveryGuard?.maybeTarget(name) || byPane?.session === name) {
      return { ok: false, code: "guard_target_unknown", message: `${message} The helper session was left in place: its ownership could not be proven.` };
    }
    const removed = await this.removeCreatedSession(name, created);
    if (!removed.ok && removed.code !== "session_not_found") message += ` The helper session was not removed: ${removed.message}`;
    return { ok: false, code: "guard_target_unknown", message };
  }

  /** #188: kill the session this adapter created only while its id still names that session. tmux checks
   *  the name and creation time and kills in one command, so a later server that reuses the id is safe. */
  private async removeCreatedSession(name: string, created: { id: string; at: string }): Promise<TmuxResult> {
    const same = `#{&&:#{==:#{session_name},${name}},#{==:#{session_created},${created.at}}}`;
    try {
      const out = await this.exec(`tmux if-shell -F -t ${shellQuote(created.id)} ${shellQuote(same)} ${shellQuote(`kill-session -t '${created.id}'`)} ${shellQuote("display-message -p kept")}`);
      if (out.includes("kept")) return { ok: false, code: "guard_target_changed", message: `its id ${created.id} no longer names it (it may already be gone); nothing was killed.` };
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  private async guardedInput(target: string, write: (pane: string, beforeWrite: () => void) => Promise<TmuxResult>, allowAbsent = false): Promise<TmuxResult> {
    const guard = this.deliveryGuard;
    if (!guard) return write(target, () => {});
    try {
      const probePane = this.freshProbes.get(target);
      if (probePane && !guard.maybeTarget(target)) {
        const panes = await this.listPanes(target);
        if (panes.length !== 1 || panes[0]!.id !== probePane) throw new Error("Private probe target changed; no input written.");
        // Awaited so a refusal inside the write (#188: the probe kill) returns as a result, not a throw.
        return await write(probePane, () => {});
      }
      const created = this.freshManaged.get(target);
      const identity = created?.nodeId ?? target;
      return await guard.input(identity, async () => {
        const bound = guard.target(identity);
        const fresh = created?.nodeId === bound.nodeId && guard.ownsLifecycle(bound.nodeId);
        let panes: TmuxPane[];
        try { panes = await this.listPanes(fresh ? target : bound.session); }
        catch (error) {
          guard.checkInput(identity);
          const result = classifyWriteError(error);
          // Only termination consumes positive absence. Unknown probe failures
          // still refuse, and guard-on never reaches this observation.
          if (allowAbsent && !result.ok
            && !/permission denied|operation not permitted|EACCES|EPERM/i.test(result.message)) {
            if (result.code === "session_not_found") return result;
            // list-panes reports a missing session as "can't find window" on
            // native tmux. Do not broaden write-error classification: only
            // termination may confirm the bound session's positive absence.
            if (/can't find window/i.test(result.message)) {
              const probe = await this.probeSession(bound.session);
              guard.checkInput(identity);
              if (probe.state === "absent") return { ok: false, code: "session_not_found", message: result.message };
            }
          }
          throw error;
        }
        const pane = fresh ? created.pane : bound.pane;
        if (!pane || panes.length !== 1 || panes[0]!.id !== pane) throw new Error("Managed pane identity unavailable or changed; no input written.");
        // Revalidate registry/occupant after the asynchronous observation. Write
        // to the immutable pane ID, not a session name which could be recycled.
        return guard.input(identity, () => write(pane, () => guard.checkInput(identity)));
      });
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? "guard_target_unknown", message: String((error as Error).message) };
    }
  }


  /** Explicit internal human input; transport HTTP options cannot select this. */
  humanInput<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.humanInput(target, fn) : fn();
  }

  operation<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.operation(target, fn) : fn();
  }

  constructor(
    private exec: ExecFn,
    private fileOps: TmuxFileOps = defaultTmuxFileOps(),
    private argvExec?: ArgvExecFn,
    // CER-2889: production startup enables the fresh-shell handshake; a bare adapter keeps one paste and one Enter.
    private shellReadiness: { handshake?: boolean; listProcesses?: NativeProcessLister; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  // Spec 0013 (SEC-178): the seat_env policy. Unset, or mode "filter", keeps every path below as it was.
  private seatEnvPolicy?: () => SeatEnvPolicy | undefined | "unreadable";
  private seatEnvFileExists: (file: string) => boolean = existsSync;

  /** Read for each launch, so a seat_env change applies to the next launch. */
  setSeatEnvPolicy(resolve: () => SeatEnvPolicy | undefined | "unreadable", fileExists: (file: string) => boolean = existsSync): void {
    this.seatEnvPolicy = resolve;
    this.seatEnvFileExists = fileExists;
  }

  /** The allow-list policy when it applies to this target's seat; undefined in filter mode. Throws when the
   *  policy cannot be read and filter mode was not the last one read: the caller refuses (fail closed). */
  private async seatEnvAllowlistFor(target: string): Promise<SeatEnvPolicy | undefined> {
    const policy = this.seatEnvPolicy?.();
    if (policy === "unreadable") throw new Error("the seat_env policy could not be read");
    if (policy?.mode !== "allowlist") return undefined;
    let session = target.replace(/^=/, "").replace(/:.*$/, "");
    if (policy.rigs.length > 0 && /^[%@$]\d+$/.test(target)) {
      const argv = ["tmux", "display-message", "-p", "-t", target, "#{session_name}"];
      session = (await this.run(argv, posixJoinArgv(argv))).trim();
    }
    return seatEnvAllowlistApplies(policy, session) ? policy : undefined;
  }

  /** Spec 0013, allow-list mode: mark every name the seat may not keep removed in this session's
   *  environment (the server's global names, the names tmux's update-environment copied from the
   *  creating client, and the launch's own), then set KUBECONFIG explicitly.
   *  Logs the count dropped and the secret-named names dropped, names only. Returns the KUBECONFIG
   *  fallback warning, if any. Throws when the environment can't be read or written: the caller
   *  refuses the launch. */
  private async applySeatEnvAllowlist(sessionTarget: string, explicit: readonly string[], policy: SeatEnvPolicy,
    step: { name: string } = { name: "" }): Promise<string[]> {
    step.name = "read the global environment";
    const names: Record<string, string> = { ...await this.globalEnvironment() };
    step.name = "read update-environment";
    for (const key of await this.updateEnvironmentNames()) names[key] ??= "";
    for (const key of explicit) names[key] ??= "";
    const dropped = seatLaunchExcludedEnvKeys(names, policy, explicit);
    step.name = "remove disallowed names";
    for (const key of dropped) {
      const argv = ["tmux", "set-environment", "-t", sessionTarget, "-r", key];
      await this.run(argv, posixJoinArgv(argv));
    }
    const kube = seatKubeconfig(policy, this.seatEnvFileExists);
    step.name = "set KUBECONFIG";
    const argv = ["tmux", "set-environment", "-t", sessionTarget, "KUBECONFIG", kube.path];
    await this.run(argv, posixJoinArgv(argv));
    const secret = dropped.filter((key) => isSecretSeatEnvName(key)).sort();
    console.info(`[seat env] ${sessionTarget}: allow-list dropped ${dropped.length} names${secret.length ? `; secret-named: ${secret.join(", ")}` : ""}`);
    return kube.warning ? [`${sessionTarget}: ${kube.warning}`] : [];
  }

  /** Spec 0013: type a command that starts a process into a seat pane. In allow-list mode it is staged
   *  behind the scrub prologue, as every launch is (sendShellCommand); otherwise it is typed and submitted
   *  as before. For a launch that goes through no runtime adapter, such as the resume-metadata probe.
   *  `command` is a single executable: in allow-list mode it replaces the staging shell (exec) once the scrub
   *  has run, so it is the pane's foreground process, as when typed. The stub runtime's readiness check and the
   *  resume probe read pane_current_command, and a child of the staging subshell reads as a shell. */
  async sendLaunchCommand(target: string, command: string): Promise<TmuxResult> {
    let allowlist: SeatEnvPolicy | undefined;
    try {
      allowlist = await this.seatEnvAllowlistFor(target);
    } catch {
      return { ok: false, code: "seat_env_refused", message: `${target}: the seat env allow-list could not be applied (step: resolve the seat env policy), so nothing was sent.` };
    }
    if (allowlist) return this.sendShellCommand(target, command, undefined, { sourceInPane: true, execInScript: true });
    const sent = await this.sendText(target, command);
    if (!sent.ok) return sent;
    return this.sendKeys(target, ["Enter"]);
  }

  /** The names tmux's update-environment option copies from a creating client into a new session's
   *  environment (DISPLAY, KRB5CCNAME, SSH_CONNECTION and the rest by default). In allow-list mode they
   *  follow the allow-list like any other name; they are not the launch's own (review r2). */
  private async updateEnvironmentNames(): Promise<string[]> {
    const output = await this.run(["tmux", "show-options", "-gv", "update-environment"], "tmux show-options -gv update-environment");
    return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /** The names set in one session's own environment (not the server's global names). */
  private async sessionEnvNames(sessionTarget: string): Promise<string[]> {
    const output = await this.run(["tmux", "show-environment", "-t", sessionTarget], `tmux show-environment -t ${shellQuote(sessionTarget)}`);
    return output.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith("-") && line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")));
  }

  /**
   * Run a multiplexer command. `argv` is what is EXECUTED on both paths:
   * elements are verbatim (no quoting layer) when argvExec is wired;
   * otherwise they are POSIX-joined — byte-identical to the legacy
   * template strings for all current call sites (the suite pins them).
   * `legacy` overrides the joined form only where history quoted
   * differently (the `-F "..."` double-quoted formats); pass it ONLY to
   * preserve an exact legacy string, never to smuggle new semantics.
   */
  private async run(argv: string[], legacy?: string): Promise<string> {
    if (this.argvExec) return this.argvExec(argv);
    return this.exec(legacy ?? posixJoinArgv(argv));
  }

  /** Ends the daemon's tmux control client, and with it its session (tmux-control.ts), when tmux is driven through one. */
  async closeControlClient(): Promise<void> {
    await (this.argvExec as Partial<TmuxControlExec> | undefined)?.close?.();
  }

  /** Start an empty native terminal server, without inventing a seat/session. */
  async startServer(): Promise<TmuxResult> {
    const probeName = `openrig-startup-${randomUUID()}`;
    try {
      if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      // tmux -D keeps an empty server alive. Stays on the shell-string path
      // deliberately: detach + stdio redirection have no argv equivalent,
      // and server bootstrap is POSIX-specific (psmux auto-starts its own).
      // Native socket ownership arbitrates
      // concurrent starts; the readback below, not shell exit, proves availability.
      await this.exec("tmux -D </dev/null >/dev/null 2>&1 &");
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      }
      return { ok: false, code: "tmux_unavailable", message: "The terminal server did not become available. Check tmux and its socket permissions." };
    } catch (error) {
      return { ok: false, code: "tmux_unavailable", message: `Terminal server unavailable: ${(error as Error).message}` };
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.run(["tmux", "list-sessions", "-F", SESSION_FORMAT],
        `tmux list-sessions -F "${SESSION_FORMAT}"`);
      return parseLines(output, parseSessionLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    try {
      const output = await this.run(["tmux", "list-windows", "-t", sessionName, "-F", WINDOW_FORMAT],
        `tmux list-windows -t ${shellQuote(sessionName)} -F "${WINDOW_FORMAT}"`);
      return parseLines(output, parseWindowLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listPanes(target: string): Promise<TmuxPane[]> {
    // Callers name a session (optionally with a window), or an immutable tmux
    // id. Exact session matching prevents observing a prefix neighbor's pane.
    // A bare leading '=' belongs to the literal session name. Only qualified
    // targets already carry tmux's encoded exact-match syntax.
    const namedTarget = target.includes(":") && target.startsWith("=") ? target : `=${target}`;
    const exactTarget = /^[%$@]\d+$/.test(target) ? target
      : namedTarget.includes(":") ? namedTarget : `${namedTarget}:`;
    try {
      const output = await this.run(["tmux", "list-panes", "-t", exactTarget, "-F", PANE_FORMAT],
        `tmux list-panes -t ${shellQuote(exactTarget)} -F "${PANE_FORMAT}"`);
      return parseLines(output, parsePaneLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * Classified session probe (OPR.0.5.4.2): the three error classes tmux
   * produces are distinct answers, and the adapter must not decide for its
   * callers that a transport failure means absence.
   * - `absent` requires POSITIVE tmux evidence (the can't-find-session class).
   * - `transport_unavailable` is the no-server / socket-gone class: whether
   *   the session exists was NOT determined.
   * - Unexpected probe failures (permission denied, etc.) rethrow so callers
   *   fail closed rather than treating a probe failure as an answer.
   */
  async probeSession(name: string): Promise<SessionProbe> {
    try {
      // Use `tmux has-session` directly for reliable existence check — avoids
      // parsing format-string output from `list-sessions` which can fail when
      // tab delimiters are malformed across tmux versions.
      const target = `=${name}`; // canonical session name, never a prefix lookup
      await this.run(["tmux", "has-session", "-t", target],
        `tmux has-session -t ${shellQuote(target)}`);
      return { state: "present" }; // exit 0 = session exists
    } catch (err) {
      if (isSessionAbsenceError(err)) {
        return { state: "absent" };
      }
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) {
        return { state: "transport_unavailable", cause: (err as Error).message };
      }
      throw err;
    }
  }

  /**
   * Collapsed presence view. Kept for the consumers outside the bound
   * send/capture/nudge/walk resolution path (OPR.0.5.4.2 mini-req 6 — their
   * adoption of the classification is a named follow-on). Callers that must
   * distinguish a transport blip from absence use probeSession().
   */
  async hasSession(name: string): Promise<boolean> {
    const probe = await this.probeSession(name);
    return probe.state === "present";
  }

  async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    const secret = secretOnArgvRefusal(env, "new-session");
    if (secret) return secret;
    if (this.deliveryGuard && (!env?.OPENRIG_NODE_ID || !this.deliveryGuard.ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const result = await this.createSessionUnchecked(name, cwd, env);
    if (result.ok) {
      if (this.shellReadiness.handshake) this.freshShells.add(name);
      this.shellLaunches.delete(name);
    }
    if (result.ok && this.deliveryGuard && env?.OPENRIG_NODE_ID) {
      try {
        const panes = await this.listPanes(name);
        if (panes.length === 1) this.freshManaged.set(name, {nodeId: env.OPENRIG_NODE_ID, pane: panes[0]!.id});
      } catch { /* no fresh pane proof: subsequent writes remain refused */ }
    }
    return result;
  }

  /** The committed binding now owns identity; this is not filesystem cleanup. */
  finishLaunchBinding(session: string): void { this.freshManaged.delete(session); }

  private async createSessionUnchecked(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    // These are the daemon's resolved capture settings, not seat overrides.
    // An empty per-session value prevents the tmux server's inherited values
    // from pinning an old policy over config.json inside a newly launched seat.
    // Explicit seat settings remain authoritative.
    const seatEnv = {
      OPENRIG_TRANSCRIPTS_LINES: "",
      OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "",
      ...env,
    };
    const argv = ["tmux", "new-session", "-d", "-s", name, "-x", "160", "-y", "48"];
    if (cwd != null) argv.push("-c", cwd);
    for (const [k, v] of Object.entries(seatEnv)) argv.push("-e", `${k}=${v}`);
    // The pane new-session itself made: an after-new-session hook may select another window.
    argv.push("-P", "-F", "#{pane_id}");
    const legacyParts = ["tmux", "new-session", "-d", "-s", shellQuote(name), "-x", "160", "-y", "48"];
    if (cwd != null) legacyParts.push("-c", shellQuote(cwd));
    for (const [k, v] of Object.entries(seatEnv)) legacyParts.push("-e", shellQuote(`${k}=${v}`));
    legacyParts.push("-P", "-F", shellQuote("#{pane_id}"));
    let created: string;
    try {
      created = (await this.run(argv, legacyParts.join(" "))).trim();
    } catch (err) {
      return classifyWriteError(err);
    }
    // Spec 0013: in allow-list mode the seat keeps only allowed names, and a failure refuses the
    // launch: the session just made is removed rather than left with what it inherited.
    const createStep = { name: "resolve the seat env policy" };
    try {
      const allowlist = await this.seatEnvAllowlistFor(name);
      if (allowlist) {
        const warnings = await this.applySeatEnvAllowlist(exactTarget(name, "session"), Object.keys(seatEnv), allowlist, createStep);
        createStep.name = "restart the pane";
        if (!/^%\d+$/.test(created)) throw new Error("new-session reported no pane id");
        const respawn = ["tmux", "respawn-pane", "-k", "-t", created];
        if (cwd != null) respawn.push("-c", cwd);
        await this.run(respawn, posixJoinArgv(respawn));
        return warnings.length ? { ok: true, warnings } : { ok: true };
      }
    } catch {
      return this.refuseSeatEnv(name, createStep.name, true);
    }
    // A tmux server started from a Claude Code session or Herdr pane hands
    // their identity to every new pane. Mark it removed for this session only
    // and restart the fresh pane so its shell starts without it. The session
    // exists either way, so a failure here is a warning, never a failed launch.
    try {
      if (await this.excludeParentSessionEnv(exactTarget(name, "session"), Object.keys(seatEnv))) {
        if (!/^%\d+$/.test(created)) throw new Error(`new-session reported no pane id ("${created}"), so no pane was restarted`);
        const respawn = ["tmux", "respawn-pane", "-k", "-t", created];
        if (cwd != null) respawn.push("-c", cwd);
        await this.run(respawn, posixJoinArgv(respawn));
      }
      return { ok: true };
    } catch (err) {
      return { ok: true, warnings: [parentSessionEnvWarning(name, err)] };
    }
  }

  /** The native resume probe starts a runtime in its pane, so it drops what a seat launch drops
   *  (seat-launch-env-filter) and restarts that pane, as createSession does. Fails open with a warning. */
  private async excludeFromProbe(name: string, pane: string, cwd?: string): Promise<TmuxResult> {
    const probeStep = { name: "resolve the seat env policy" };
    try {
      const allowlist = await this.seatEnvAllowlistFor(name);
      if (allowlist) {
        const warnings = await this.applySeatEnvAllowlist(exactTarget(name, "session"), [], allowlist, probeStep);
        probeStep.name = "restart the pane";
        const respawn = ["tmux", "respawn-pane", "-k", "-t", pane];
        if (cwd != null) respawn.push("-c", cwd);
        await this.run(respawn, posixJoinArgv(respawn));
        return warnings.length ? { ok: true, warnings } : { ok: true };
      }
    } catch {
      this.freshProbes.delete(name);
      this.freshProbes.delete(pane);
      return this.refuseSeatEnv(name, probeStep.name, true);
    }
    try {
      if (await this.excludeParentSessionEnv(exactTarget(name, "session"))) {
        const respawn = ["tmux", "respawn-pane", "-k", "-t", pane];
        if (cwd != null) respawn.push("-c", cwd);
        await this.run(respawn, posixJoinArgv(respawn));
      }
      return { ok: true };
    } catch (err) {
      return { ok: true, warnings: [parentSessionEnvWarning(name, err)] };
    }
  }

  /** Spec 0013: the allow-list could not be applied, so nothing is launched. A session this launch
   *  created is removed. The result names the failing step only, never an error's text. */
  private async refuseSeatEnv(target: string, step: string, created: boolean): Promise<TmuxResult> {
    if (created) {
      const kill = ["tmux", "kill-session", "-t", exactTarget(target, "session")];
      try { await this.run(kill, posixJoinArgv(kill)); } catch { /* the refusal stands either way */ }
    }
    return { ok: false, code: "seat_env_refused", message: `${target}: the seat env allow-list could not be applied (step: ${step}), so the launch was refused` };
  }

  /** Mark the server's inherited parent-session identity, and every other name a seat launch
   * excludes (seat-launch-env-filter), as removed in one
   * session's environment, never the server's global one. Explicit seat
   * values stay. Returns whether anything was marked. Throws when the global
   * environment can't be read: the caller can't tell whether the seat inherits
   * an identity, so it reports a warning (the launch still goes ahead). */
  private async excludeParentSessionEnv(sessionTarget: string, keep: readonly string[] = []): Promise<boolean> {
    const inherited = await this.globalEnvironment();
    const keys = seatLaunchExcludedEnvKeys(inherited).filter((key) => !keep.includes(key));
    for (const key of keys) {
      const argv = ["tmux", "set-environment", "-t", sessionTarget, "-r", key];
      await this.run(argv, posixJoinArgv(argv));
    }
    return keys.length > 0;
  }

  /**
   * Bracketed paste by default, at every size. Unbracketed input can be consumed as individual
   * keystrokes by agent TUIs, losing text even below the old 8 KiB cutoff.
   * A file keeps payload bytes out of shell/tmux argv and its size limits.
   *   `-p`  bracket the paste when the receiving application enables that mode.
   *   `-r`  preserve raw LF. tmux's default paste-buffer replaces every LF with
   *         CR, and CR is SUBMIT in the Claude/Codex TUIs - a
   *         default paste of a multi-line pack would submit on every newline.
   *   `-d`  drop the buffer after a successful paste.
   * `options.bracketed: false` omits `-p` for explicit prompt answers: bytes
   * then act as keystrokes, including menu shortcuts and control keys.
   * Any trailing submit stays the caller's separate `sendKeys(["Enter"])`.
   * Cleanup unlinks the temp file in `finally`; if the buffer was loaded but the
   * paste failed (e.g. missing target), an explicit `delete-buffer` runs so no
   * buffer leaks. Unique temp + buffer names per call keep parallel `rig up`
   * seats from colliding.
   */
  async sendText(target: string, text: string, beforeInput?: () => void, options?: { bracketed?: boolean }): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => this.sendTextUnchecked(pane, text, () => { beforeWrite(); beforeInput?.(); }, options?.bracketed));
  }

  private async sendTextUnchecked(target: string, text: string, beforeWrite: () => void, bracketed = true): Promise<TmuxResult> {
    const path = this.fileOps.tmpName();
    const buffer = this.fileOps.bufferName();
    let bufferLoaded = false;
    let created = false;
    try {
      await this.fileOps.writeFile(path, text, { mode: 0o600, flag: "wx" });
      created = true;
      await this.run(["tmux", "load-buffer", "-b", buffer, path],
        `tmux load-buffer -b ${shellQuote(buffer)} ${shellQuote(path)}`);
      bufferLoaded = true;
      beforeWrite();
      // Explicit prompt answers need key input, not bracketed-paste framing.
      // Keep their bytes in the file: tmux command parsing and argv limits must
      // not alter semicolons or reject long answers (#519, #602).
      await this.run(["tmux", "paste-buffer", "-t", target, "-b", buffer, "-d", "-r", ...(bracketed ? ["-p"] : [])],
        `tmux paste-buffer -t ${shellQuote(target)} -b ${shellQuote(buffer)} -d -r${bracketed ? " -p" : ""}`);
      return { ok: true };
    } catch (err) {
      if (bufferLoaded) {
        // paste failed after load - `-d` never ran, so the buffer is still
        // resident. Best-effort delete to avoid leaking it.
        try {
          await this.run(["tmux", "delete-buffer", "-b", buffer],
        `tmux delete-buffer -b ${shellQuote(buffer)}`);
        } catch { /* best-effort cleanup */ }
      }
      return classifyWriteError(err);
    } finally {
      if (created) {
        try {
          await this.fileOps.unlink(path);
        } catch { /* best-effort cleanup */ }
      }
    }
  }

  /**
   * Launch a POSIX command in an empty shell. A newly created pane can still
   * be in canonical input mode: on macOS it silently drops input beyond 1024
   * bytes, even when paste-buffer succeeds. Only a short invocation crosses
   * that boundary; the command's PATH, quoting and arguments travel in a file.
   * The shell removes its private script when consumed (not when pasted).
   * A shell that never consumes the invocation leaves the file for diagnosis.
   */
  async sendShellCommand(target: string, command: string, beforeInput?: () => void, options: TmuxShellCommandOptions = {}): Promise<TmuxResult> {
    // Keep the managed selector for nested paste/Enter checks. A resolved pane
    // ID can also occur in detached bindings after a tmux restart; resolving it
    // again would lose the unambiguous session/node and its existing lease.
    // Each nested write still validates the lease and targets its observed pane.
    return this.guardedInput(target, () => this.sendShellCommandUnchecked(target, command, beforeInput, options));
  }

  /** Stage or send a launch while leaving a consumed script's cleanup to the receiving shell. */
  private async sendShellCommandUnchecked(target: string, command: string, beforeInput: (() => void) | undefined, options: TmuxShellCommandOptions): Promise<TmuxResult> {
    if (this.freshShells.has(target)) {
      const ready = await this.waitForFreshShell(target);
      if (!ready.ok) return ready;
      this.freshShells.delete(target);
    }
    const commandBytes = Buffer.byteLength(command, "utf8");
    // Spec 0013: in allow-list mode every command a seat runs is staged, and its script first
    // unsets the names the seat may not keep, including those the pane shell's startup files exported.
    let prologue = "";
    let allowlist: SeatEnvPolicy | undefined;
    try {
      allowlist = await this.seatEnvAllowlistFor(target);
      if (allowlist) {
        const copied = new Set(await this.updateEnvironmentNames());
        const explicit = (await this.sessionEnvNames(exactTarget(target, "session"))).filter((name) => !copied.has(name));
        prologue = `${seatEnvScrubScript(allowlist, explicit, seatKubeconfig(allowlist, this.seatEnvFileExists).path)}\n`;
      }
    } catch {
      return { ok: false, code: "seat_env_refused", message: `${target}: the seat env allow-list could not be applied, so nothing was sent.` };
    }
    // POSIX shells retain subshell isolation; unknown/unreadable panes use sh.
    const paneShell = options.sourceInPane ? (await this.getPaneCommand(target) ?? "").replace(/^-/, "") : "";
    const sourceInPane = ["bash", "zsh", "sh", "dash", "ksh"].includes(paneShell);
    let path = !allowlist && options.stageIfLong && commandBytes <= 512 ? undefined : this.fileOps.tmpName();
    let invocation = path ? sourceInPane ? `( . ${shellQuote(path)} )` : `/bin/sh ${shellQuote(path)}` : command;
    if (path && paneShell === "fish" && !allowlist) {
      const quotedPath = shellQuote(path);
      invocation = `/bin/sh ${quotedPath}`;
      // Fish single quotes reinterpret POSIX backslashes. Keep those payloads
      // (and paths) on sh, preserving existing executable launches byte-for-byte.
      if (!command.includes("\\") && !path.includes("\\")) {
        // Probe fixed syntax in the pane before sourcing, not the launch's exit
        // status: even failed cleanup must not turn a later exit into a retry.
        const sourced = `if eval 'OPENRIG_FISH_ASSIGNMENT_PROBE=1 /bin/sh -c :'; source ${quotedPath}; else; /bin/sh ${quotedPath}; end`;
        // Repeating the path must not add a refusal for previously valid TMPDIRs.
        if (Buffer.byteLength(sourced, "utf8") <= 512) invocation = sourced;
      }
    }
    if (Buffer.byteLength(invocation, "utf8") > 512) {
      // Pi commands below the canonical tty limit still fit when staging cannot.
      if (options.stageIfLong && commandBytes < 1024 && !allowlist) {
        path = undefined;
        invocation = command;
      } else {
        return { ok: false, code: "launch_path_too_long", message: "Temporary launch-script path exceeds the safe terminal input bound" };
      }
    }
    let created = false;
    try {
      if (path) {
        await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)} 2>/dev/null || command rm -f -- ${shellQuote(path)} || true\n${prologue}${options.execInScript ? "exec " : ""}${command}\n`, { mode: 0o600, flag: "wx" });
        created = true;
      }
      const text = beforeInput ? await this.guardedInput(target, (pane, check) => this.sendTextUnchecked(pane, invocation, () => { check(); beforeInput(); }))
        : await this.sendText(target, invocation);
      if (!text.ok) return text;
      const enter = beforeInput ? await this.guardedInput(target, pane => { beforeInput(); return this.sendKeysUnchecked(pane, ["Enter"]); })
        : await this.sendKeys(target, ["Enter"]);
      if (!enter.ok) {
        await this.sendKeys(target, ["C-c"]);
        return enter;
      }
      // The receiver now owns removal. Unlinking here races shell startup.
      if (path) this.shellLaunches.set(target, path);
      else this.shellLaunches.delete(target);
      created = false;
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    } finally {
      if (created && path) {
        try { await this.fileOps.unlink(path); } catch { /* best-effort cleanup */ }
      }
    }
  }

  /** Only a positive file observation means this attempt has not executed. No
   * retry or extra Enter is sent after the actual launch invocation. */
  async pendingShellLaunch(target: string): Promise<boolean> {
    const path = this.shellLaunches.get(target);
    if (!path) return false;
    try { await stat(path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.shellLaunches.delete(target);
      return false;
    }
  }

  private async waitForFreshShell(target: string): Promise<TmuxResult> {
    // This handshake is restricted to shells created by THIS adapter. It never
    // answers a runtime prompt or sends a second launch. A computed marker means
    // tty echo of the probe is not evidence that the shell executed it.
    const nonce = randomUUID().replace(/-/g, "");
    const marker = `openrig_ready_${nonce}`;
    const probe = `printf '%s%s\\n' 'openrig_ready_' '${nonce}'`;
    const sleep = this.shellReadiness.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let sent = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (sent) {
        const screen = await this.capturePaneScreen(target);
        if (screen?.split(/\r?\n/).some(line => line.trim() === marker)) return { ok: true };
      }
      // zsh can discard an early Enter while its rc files initialize. Wait for
      // positive idle-shell process evidence before every write, including an
      // extra Enter for our probe. A startup menu or child process gets no input.
      if (await verifyPaneIdleShell({ target, tmux: this, listProcesses: this.shellReadiness.listProcesses })) {
        const mode = await this.leavePaneMode(target);
        if (!mode.ok) return mode;
        if (!sent) {
          const text = await this.sendText(target, probe);
          if (!text.ok) return text;
          sent = true;
        }
        const enter = await this.sendKeys(target, ["Enter"]);
        if (!enter.ok) return enter;
      }
      await sleep(250);
    }
    return { ok: false, code: "shell_not_ready",
      message: "The new shell did not execute its readiness probe within 10 seconds; no runtime launch was sent." };
  }

  /** A failing cosmetic hook (session-created, client-attached) can leave a fresh pane in view-mode, and
   *  while a read-only client is attached, keys sent to a pane in a mode fail. The pane was created for
   *  this launch, so leave any mode before writing to it. */
  private async leavePaneMode(target: string): Promise<TmuxResult> {
    const pane = exactTarget(target, "pane");
    try {
      const inMode = await this.run(["tmux", "display-message", "-p", "-t", pane, "#{pane_in_mode}"],
        `tmux display-message -p -t ${shellQuote(pane)} ${shellQuote("#{pane_in_mode}")}`);
      if (inMode.trim() === "1") {
        await this.run(["tmux", "copy-mode", "-q", "-t", pane], `tmux copy-mode -q -t ${shellQuote(pane)}`);
      }
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async sendKeys(target: string, keys: string[], beforeInput?: () => void): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => { beforeWrite(); beforeInput?.(); return this.sendKeysUnchecked(pane, keys); });
  }

  private async sendKeysUnchecked(target: string, keys: string[]): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "send-keys", "-t", target, ...keys],
        `tmux send-keys -t ${shellQuote(target)} ${keys.map(shellQuote).join(" ")}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async setWindowOption(target: string, option: string, value: string): Promise<TmuxResult> {
    const window = exactTarget(target, "window");
    try {
      await this.run(["tmux", "set-option", "-w", "-t", window, option, value],
        `tmux set-option -w -t ${shellQuote(window)} ${shellQuote(option)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async resizeWindow(target: string, cols: number, rows: number): Promise<TmuxResult> {
    if (!Number.isFinite(cols) || !Number.isInteger(cols) || cols < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: cols must be a positive integer, got ${cols}` };
    }
    if (!Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow: rows must be a positive integer, got ${rows}` };
    }
    try {
      await this.run(["tmux", "resize-window", "-t", exactTarget(target, "window"), "-x", String(cols), "-y", String(rows)]);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async killSession(name: string): Promise<TmuxResult> {
    if (this.deliveryGuard) {
      return this.guardedInput(name, async pane => {
        const stdout = await this.run(["tmux", "display-message", "-p", "-t", pane, "#{session_id}"], `tmux display-message -p -t ${shellQuote(pane)} '#{session_id}'`);
        const sessionId = stdout.trim();
        if (!/^\$\d+$/.test(sessionId)) return { ok: false, code: "guard_target_unknown", message: "Cannot establish immutable session identity; no session killed." };
        const kill = async () => {
          const result = await this.killSessionUnchecked(sessionId);
          if (result.ok) { this.freshProbes.delete(name); this.freshProbes.delete(pane); this.freshManaged.delete(name); }
          return result;
        };
        if (this.freshProbes.get(name) === pane && !this.deliveryGuard!.maybeTarget(name) && !this.deliveryGuard!.maybeTarget(pane)) return kill();
        return this.deliveryGuard!.input(this.freshManaged.get(name)?.nodeId ?? name, kill);
      }, true);
    }
    return this.killSessionUnchecked(name);
  }

  private async killSessionUnchecked(name: string): Promise<TmuxResult> {
    // The guarded path passes the immutable `$N` id, which stays as it is; a bare name is made exact.
    const session = exactTarget(name, "session");
    // Detach first so `detach-on-destroy off` cannot switch views onto another session.
    try {
      await this.run(["tmux", "detach-client", "-s", session],
        `tmux detach-client -s ${shellQuote(session)}`);
    } catch (err) {
      // tmux 3.7 says "no current client" when nothing is attached (and for a missing session, which the kill classifies).
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("no current client")) return classifyWriteError(err);
    }
    try {
      await this.run(["tmux", "kill-session", "-t", session],
        `tmux kill-session -t ${shellQuote(session)}`);
      const pane = this.freshProbes.get(name);
      this.freshProbes.delete(name);
      if (pane) this.freshProbes.delete(pane);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover (plan 411c43de): respawn a pane IN PLACE (reuse the retiree's EXACT pane) so
   *  the successor boots below the predecessor's history — same window, same pane, predecessor scrollback
   *  PRESERVED above the boot. The command is shell-quoted as ONE unit (tmux runs it via the shell).
   *
   *  ⚠ NO `-k`: empirically (tmux 3.6a) `respawn-pane -k` force-kills+respawns atomically and CLEARS the
   *  pane's scrollback — defeating the money-proof. So the cutover terminates the retiree FIRST (graceful
   *  exit + `setRemainOnExit(true)` so the pane survives dead), waits for `isPaneDead`, then calls this
   *  WITHOUT -k on the already-dead pane — which preserves the history. respawn-pane refuses a still-live
   *  pane ("still active"), which is the correct guard: never respawn over a live retiree.
   *
   *  Optional `cwd`/`env` inject the successor's start-directory + OpenRig identity env onto the reused
   *  pane via respawn-pane's `-c`/`-e` flags (tmux ≥3.0), the SAME mechanism createSession uses. Any flags
   *  precede the command, which always stays LAST.
   *
   *  ⚠ KI-14: omitting `command` re-runs the pane's CREATION (or last-respawn) command — which is the
   *  default shell ONLY for panes createSession made. Adopted/hand-recovered panes can carry a full
   *  harness invocation there (`codex … resume <old-token>`), so an undefined respawn silently boots the
   *  OLD context. Callers that need a blank pane must pass an explicit shell (see getDefaultShell). */
  async respawnPane(
    paneTarget: string,
    command?: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<TmuxResult> {
    const secret = secretOnArgvRefusal(opts?.env, "respawn-pane");
    if (secret) return secret;
    return this.guardedInput(paneTarget, pane => this.respawnPaneUnchecked(pane, command, opts));
  }

  private async respawnPaneUnchecked(paneTarget: string, command?: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    const argv = ["tmux", "respawn-pane", "-t", exact];
    if (opts?.cwd != null) argv.push("-c", opts.cwd);
    if (opts?.env) for (const [k, v] of Object.entries(opts.env)) argv.push("-e", `${k}=${v}`);
    // The respawn command is ONE argv unit: tmux runs it via the shell.
    if (command != null && command.length > 0) argv.push(command);
    const legacyRespawn = ["tmux", "respawn-pane", "-t", shellQuote(exact)];
    if (opts?.cwd != null) legacyRespawn.push("-c", shellQuote(opts.cwd));
    if (opts?.env) for (const [k, v] of Object.entries(opts.env)) legacyRespawn.push("-e", shellQuote(`${k}=${v}`));
    if (command != null && command.length > 0) legacyRespawn.push(shellQuote(command));
    // The successor starts from the session environment: exclude inherited
    // parent-session identity there first (sessions made before this existed).
    // A failure here is a warning; the respawn goes ahead as it did before.
    let warnings: string[] | undefined;
    let allowlist: SeatEnvPolicy | undefined;
    const respawnStep = { name: "resolve the seat env policy" };
    try {
      allowlist = await this.seatEnvAllowlistFor(exact);
      if (allowlist) {
        const kept = await this.applySeatEnvAllowlist(exact, Object.keys(opts?.env ?? {}), allowlist, respawnStep);
        if (kept.length) warnings = kept;
      }
    } catch {
      return this.refuseSeatEnv(exact, respawnStep.name, false);
    }
    if (!allowlist) try {
      await this.excludeParentSessionEnv(exact, Object.keys(opts?.env ?? {}));
    } catch (err) {
      warnings = [parentSessionEnvWarning(exact, err)];
    }
    try {
      await this.run(argv, legacyRespawn.join(" "));
      return warnings ? { ok: true, warnings } : { ok: true };
    } catch (err) {
      return redactEnvValues(classifyWriteError(err), opts?.env);
    }
  }

  /** Seat-handover cutover: set the pane-scoped `remain-on-exit` so the pane SURVIVES (goes dead, not
   *  destroyed) when the retiree process exits — holding its scrollback for the successor's respawn.
   *  Set to `on` BEFORE the retiree is signalled to exit (else the pane is destroyed on exit and there
   *  is nothing to respawn into). */
  async setRemainOnExit(paneTarget: string, on: boolean): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      await this.run(["tmux", "set-option", "-p", "-t", exact, "remain-on-exit", on ? "on" : "off"],
        `tmux set-option -p -t ${shellQuote(exact)} remain-on-exit ${on ? "on" : "off"}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** The pane's OWN value for an option, without inherited window/global values: the string, null when the
   *  pane sets none, undefined when tmux could not be read. A caller that changes the option for a while
   *  restores exactly this with restorePaneOption. */
  async getPaneLocalOption(paneTarget: string, option: string): Promise<string | null | undefined> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      const output = await this.run(["tmux", "show-options", "-p", "-v", "-t", exact, option],
        `tmux show-options -p -v -t ${shellQuote(exact)} ${shellQuote(option)}`);
      // tmux prints nothing for an unset option and the value plus a newline when set (an empty value prints
      // a bare newline), so only the line ending is removed: the value comes back exactly as it was set.
      return output.length === 0 ? null : output.replace(/\r?\n$/, "");
    } catch {
      return undefined;
    }
  }

  /** Put back what getPaneLocalOption read: set the value, or unset the pane's own value when it had none. */
  async restorePaneOption(paneTarget: string, option: string, value: string | null): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    const argv = value === null
      ? ["tmux", "set-option", "-p", "-u", "-t", exact, option]
      : ["tmux", "set-option", "-p", "-t", exact, option, value];
    try {
      await this.run(argv, argv.map((part, index) => index < 2 ? part : shellQuote(part)).join(" "));
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** The pane's whole text, history and visible screen, with wrapped lines joined. Null when unreadable. */
  async capturePaneHistory(paneTarget: string): Promise<string | null> {
    const exact = exactTarget(paneTarget, "pane");
    try {
      return await this.run(["tmux", "capture-pane", "-p", "-J", "-t", exact, "-S", "-", "-E", "-"],
        `tmux capture-pane -p -J -t ${shellQuote(exact)} -S - -E -`);
    } catch {
      return null;
    }
  }

  /** Signal one process by pid. signalPaneProcess signals the pane's root, which in a shell-backed pane is
   *  the shell, not the runtime running under it. Unix `kill`, like signalPaneProcess. */
  async signalPid(pid: number, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, code: "invalid_pid", message: `Refusing to signal pid ${pid}.` };
    try {
      await this.exec(`kill -${signal} ${pid}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover: is the pane's process dead (the retiree exited; the pane held by
   *  remain-on-exit)? A known-missing pane also proves physical cutover; unknown probe errors stay false. */
  async isPaneDead(paneId: string): Promise<boolean> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", exact, "#{pane_dead}"],
        `tmux display-message -p -t ${shellQuote(exact)} "#{pane_dead}"`);
      return output.trim() === "1";
    } catch (error) {
      return isNoServerError(error) || isPaneAbsenceError(error);
    }
  }

  /** Seat-handover cutover: signal the pane's foreground process (the retiree) — `TERM` for the graceful
   *  exit-in-place, `KILL` for the bounded-timeout force fallback. Resolves the pane pid then `kill`s it;
   *  an unresolvable pid is a structured, non-throwing failure.
   *  Stays on the shell-string path deliberately: this is a Unix `kill`,
   *  not a multiplexer command (Windows needs taskkill — named follow-up). */
  async signalPaneProcess(paneId: string, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    return this.guardedInput(paneId, (pane, beforeWrite) => this.signalPaneProcessUnchecked(pane, signal, beforeWrite));
  }

  private async signalPaneProcessUnchecked(paneId: string, signal: "TERM" | "KILL", beforeWrite: () => void): Promise<TmuxResult> {
    const pid = await this.getPanePid(paneId);
    if (pid == null) {
      return { ok: false, code: "pane_pid_unavailable", message: `Could not resolve the pane pid for "${paneId}".` };
    }
    try {
      beforeWrite();
      await this.exec(`kill -${signal} ${pid}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Get the PID of the foreground process in a pane. Returns null if unavailable. */
  async getPanePid(paneId: string): Promise<number | null> {
    const observed = await this.observePanePid(paneId);
    return observed.kind === "pid" ? observed.pid : null;
  }

  /** Spec 0015: the pane's pid, or why there is none. `absent` only when tmux itself reports the pane gone ("can't find
   *  pane", on its stderr); any other failure, a timeout or an unreadable reply is `unavailable`, never absence.
   *  tmux 3.4 answers display-message on a gone pane with exit 0 and an empty reply, so an empty reply is confirmed with
   *  `list-panes -t <pane>`, which reports the absence (review r1 on #18). */
  async observePanePid(paneId: string): Promise<PanePidObservation> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", target, "#{pane_pid}"],
        `tmux display-message -p -t ${shellQuote(target)} "#{pane_pid}"`);
      const parsed = parseInt(output.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return { kind: "pid", pid: parsed };
      // Only a pane id can be confirmed gone; a session target's absence is "can't find session", never a pane's.
      if (output.trim() !== "" || !target.startsWith("%")) return { kind: "unavailable" };
      await this.run(["tmux", "list-panes", "-t", target, "-F", "#{pane_id}"],
        `tmux list-panes -t ${shellQuote(target)} -F "#{pane_id}"`);
      return { kind: "unavailable" }; // listed, but its pid can't be read
    } catch (error) {
      return isPaneAbsenceError(tmuxReportedError(error)) ? { kind: "absent" } : { kind: "unavailable" };
    }
  }

  /** KI-14: the server's `default-shell` option — what a createSession pane runs when no command is
   *  given. Used to make a respawn EXPLICIT about the blank shell instead of inheriting whatever
   *  command the pane was created with. Returns null if unavailable (caller falls back). */
  async getDefaultShell(): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "show-options", "-gv", "default-shell"]);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** Get the current foreground command in a pane. Returns null if unavailable. */
  async getPaneCommand(paneId: string): Promise<string | null> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", target, "#{pane_current_command}"],
        `tmux display-message -p -t ${shellQuote(target)} "#{pane_current_command}"`);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** Whether a pane is in a mode such as copy mode. tmux reports #{pane_in_mode} as the number of
   *  modes the pane is in, so any count above 0 is in a mode. Returns null if unavailable. */
  async isPaneInMode(paneId: string): Promise<boolean | null> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", target, "#{pane_in_mode}"],
        `tmux display-message -p -t ${shellQuote(target)} "#{pane_in_mode}"`);
      const trimmed = output.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      return Number(trimmed) > 0;
    } catch {
      return null;
    }
  }

  /** Leave the pane's current mode (copy mode) with `send-keys -X cancel`, through the same input guard as sendKeys. */
  async cancelPaneMode(target: string): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => { beforeWrite(); return this.sendKeysUnchecked(pane, ["-X", "cancel"]); });
  }

  /** A launch metadata read. Callers must never put credential values in terminal input. */
  async getSessionEnv(session: string, key: string): Promise<string | undefined> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    try {
      const output = await this.run(["tmux", "show-environment", "-t", target, key],
        `tmux show-environment -t ${shellQuote(target)} ${shellQuote(key)}`);
      if (output.trim() === `-${key}`) return undefined;
      if (!output.startsWith(`${key}=`)) throw new Error("Unexpected session environment response.");
      return output.slice(key.length + 1).replace(/\r?\n$/, "");
    } catch (error) {
      if (error instanceof Error && error.message.includes(`unknown variable: ${key}`)) return undefined;
      throw new Error("Cannot read the session's launch environment.");
    }
  }

  /** Set one variable in a session's environment: what its next spawned process inherits, not a
   *  running one. Callers that pass a value are putting it on a tmux command line. */
  async setSessionEnv(session: string, key: string, value: string): Promise<void> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    await this.run(["tmux", "set-environment", "-t", target, key, value],
      `tmux set-environment -t ${shellQuote(target)} ${shellQuote(key)} ${shellQuote(value)}`);
  }

  /** Remove one variable from a session's environment, so a process spawned there afterwards
   *  inherits the server's value for it, or none. A name that is the launching session's own
   *  identity in the server's environment (see seat-launch-env-filter) is marked removed instead, as a
   *  launch does, so the server's value does not come back. */
  async unsetSessionEnv(session: string, key: string): Promise<void> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    const parentIdentity = seatLaunchExcludedEnvKeys(await this.globalEnvironment()).includes(key);
    const flag = parentIdentity ? "-r" : "-u";
    await this.run(["tmux", "set-environment", "-t", target, flag, key],
      `tmux set-environment -t ${shellQuote(target)} ${flag} ${shellQuote(key)}`);
  }

  private async globalEnvironment(): Promise<Record<string, string>> {
    const global = await this.run(["tmux", "show-environment", "-g"], "tmux show-environment -g");
    const inherited: Record<string, string> = {};
    for (const line of global.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) inherited[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return inherited;
  }

  /** OPR.0.4.3.28 Part C — usable-presence check for a session-env variable.
   *  Returns whether the var has a nonblank value, NEVER that value, and null
   *  when the session environment cannot be inspected. Listing the environment
   *  distinguishes a genuinely absent var from `tmux show-environment <var>`'s
   *  nonzero lookup exit. */
  async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    const target = exactTarget(sessionName, "session");
    try {
      const output = await this.run(["tmux", "show-environment", "-t", target],
        `tmux show-environment -t ${shellQuote(target)}`);
      const prefix = `${varName}=`;
      return output.split(/\r?\n/).some(
        (line) => line.startsWith(prefix) && line.slice(prefix.length).trim().length > 0,
      );
    } catch {
      return null;
    }
  }

  /** Start pipe-pane to capture terminal output to a file. */
  async startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult> {
    // Shell-quote the path for safe injection into the pipe-pane command.
    // The entire pipe command is passed as a single argument to tmux,
    // which executes it via sh -c. We use shellQuote on the path.
    // The sink travels as ONE argv unit: the multiplexer runs it via a
    // shell, so its inner quoting stays POSIX here (psmux documents the same
    // `cat >` server-side form for its own path).
    const sink = "cat >> " + shellQuote(outputPath);
    const target = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "pipe-pane", "-t", target, sink],
        `tmux pipe-pane -t ${shellQuote(target)} ${shellQuote(sink)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Stop pipe-pane on a session. */
  async stopPipePane(sessionName: string): Promise<TmuxResult> {
    const target = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "pipe-pane", "-t", target],
        `tmux pipe-pane -t ${shellQuote(target)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Capture pane content (last N lines). Returns null if unavailable. */
  /**
   * Capture many sessions' panes with a few tmux calls instead of one per session (#308). A `list-sessions` runs next
   * to the first chained call and is read only when a chain fails: a target it lacks maps to null (as a failed
   * per-target capture) without a fork. The targets are captured in chunks of CAPTURE_BATCH chained commands (a
   * `display-message` marker, then `capture-pane`), each pane's output delimited by a marker unique to the call, so the
   * text equals what `capturePaneContent` returns. Targets are exact (`=<name>:`): no prefix match, and a name with a
   * "." still resolves. tmux stops a chain at its first failing command, so a failed chunk drops the targets the
   * listing lacks (`missing`) and retries, or is split in half (an oversized output, or a session gone since the
   * listing); a single session that still fails is left OUT of the map, and the caller reads it per target. A server
   * gone since the listing maps the chunk to null without a retry. Any other chain error leaves the chunk out, so the
   * caller reads each pane per target, as an unbatched read does. Null when a chain fails because the server is gone
   * or its socket can't be reached, and tmux can't be listed; a chain that fails for another reason while the listing
   * fails too leaves the chunk to per-target reads. Each entry carries the time its own chunk was read (`capturedAt`), so a slow later
   * chunk can't make an earlier capture look fresh.
   */
  async capturePanesContent(targets: string[], lines: number = 20, now: () => Date = () => new Date()): Promise<Map<string, PaneCapture> | null> {
    const listing = this.run(["tmux", "list-sessions", "-F", "#{session_name}"], "tmux list-sessions -F '#{session_name}'")
      .then((output) => new Set(output.split(/\r?\n/).filter(Boolean)), () => null);
    const out = new Map<string, PaneCapture>();
    let unlisted = false;
    /** Capture one chunk with a single chained tmux call into `out`; on failure, retry it without the unlisted targets
     *  or split it in half. */
    const captureChunk = async (chunk: string[]): Promise<void> => {
      const nonce = randomUUID().replace(/-/g, "");
      const mark = (k: number) => `__openrig_capture_${nonce}_${k}__`;
      const argv = ["tmux", ...chunk.flatMap((t, k) => [
        ...(k > 0 ? [";"] : []),
        "display-message", "-p", "-t", `=${t}:`, mark(k), ";", "capture-pane", "-p", "-t", `=${t}:`, "-S", `-${lines}`,
      ])];
      const legacy = "tmux " + chunk.map((t, k) =>
        `display-message -p -t ${shellQuote(`=${t}:`)} ${shellQuote(mark(k))} \\; capture-pane -p -t ${shellQuote(`=${t}:`)} -S -${lines}`,
      ).join(" \\; ");
      let output: string;
      let capturedAt: Date;
      try {
        output = await this.run(argv, legacy);
        capturedAt = now(); // when THIS chunk's panes were read, not when the sweep ends
      } catch (err) {
        const live = await listing;
        if (!live) {
          // A failed listing doesn't show the server is gone; the chain's own error does.
          const cause = tmuxReportedError(err);
          if (isNoServerError(cause) || isTmuxTransportAbsentError(cause)) unlisted = true;
          return;
        }
        // The listing answered, so the server was up: the targets it lacks are dropped first.
        const listedAt = now();
        const present: string[] = [];
        for (const t of chunk) {
          if (live.has(t)) present.push(t);
          else out.set(t, { text: null, capturedAt: listedAt, missing: true });
        }
        if (present.length < chunk.length) {
          if (present.length) await captureChunk(present);
          return;
        }
        const cause = tmuxReportedError(err);
        // Every half would fail the same way: the server is gone.
        if (isNoServerError(cause) || isTmuxTransportAbsentError(cause)) {
          for (const t of chunk) out.set(t, { text: null, capturedAt: listedAt });
          return;
        }
        // Halving helps only an output that overflowed exec's buffer (wide, colour-dense panes) or a session that
        // vanished since the listing. Any other error would fail every half, so the chunk is left to per-target reads.
        // Node's overflow error is the message's first line; pane text follows it.
        if (!/^.*maxBuffer length exceeded/.test((err as Error).message) && !isSessionAbsenceError(cause) && !isPaneAbsenceError(cause)) {
          return;
        } else if (chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          await Promise.all([captureChunk(chunk.slice(0, half)), captureChunk(chunk.slice(half))]);
        }
        return; // a single session that failed: read per target by the caller
      }
      const segments: Array<string[] | null> = chunk.map(() => null);
      let cur = -1;
      const outLines = output.split("\n");
      if (outLines.length && outLines[outLines.length - 1] === "") outLines.pop(); // the final newline, not a line
      for (const line of outLines) {
        const m = line.startsWith(`__openrig_capture_${nonce}_`) ? /_(\d+)__$/.exec(line) : null;
        if (m && line === mark(Number(m[1]))) {
          cur = Number(m[1]);
          segments[cur] = [];
        } else if (cur >= 0) {
          segments[cur]!.push(line);
        }
      }
      chunk.forEach((t, k) => {
        const seg = segments[k];
        if (seg == null) return; // its marker never printed: read per target
        // capture-pane prints its lines newline-terminated, as the per-target read returns them
        const text = seg.length ? seg.join("\n") + "\n" : "";
        out.set(t, { text: text === "" ? null : text, capturedAt });
      });
    };
    const unique = [...new Set(targets)];
    for (let i = 0; i < unique.length && !unlisted; i += CAPTURE_BATCH) await captureChunk(unique.slice(i, i + CAPTURE_BATCH));
    return unlisted && out.size === 0 ? null : out;
  }

  async capturePaneContent(paneId: string, lines: number = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }): Promise<string | null> {
    const target = exactTarget(paneId, "pane");
    // `-e` keeps text styling, such as the faint rendering of a suggestion.
    const styled = opts?.escapeSequences === true;
    // Verification can recover mid-word soft wraps without erasing logical newlines.
    const joined = opts?.joinWrappedLines === true;
    try {
      const output = await this.run(["tmux", "capture-pane", "-p", ...(styled ? ["-e"] : []), ...(joined ? ["-J"] : []), "-t", target, "-S", `-${lines}`],
        `tmux capture-pane -p${styled ? " -e" : ""}${joined ? " -J" : ""} -t ${shellQuote(target)} -S -${lines}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Capture the currently VISIBLE pane screen (no scrollback). Returns null if
   * unavailable. The live-terminal seed (OPR.0.4.0.38) must use the visible
   * screen, NOT `-S -<lines>` scrollback: scrollback reintroduces the row drift
   * the absolute-paint seed exists to eliminate.
   */
  async capturePaneScreen(paneId: string): Promise<string | null> {
    const target = exactTarget(paneId, "pane");
    try {
      const output = await this.run(["tmux", "capture-pane", "-p", "-t", target],
        `tmux capture-pane -p -t ${shellQuote(target)}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Get the current cursor coordinates and pane geometry. Coordinates are
   * zero-based. Returns null if unavailable or if tmux yields non-finite /
   * out-of-range values (x<0, y<0, width<1, height<1) so a bad read never
   * produces a garbage seed.
   */
  async getPaneCursorPosition(paneId: string): Promise<TmuxCursorPosition | null> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(
        ["tmux", "display-message", "-p", "-t", exact, CURSOR_FORMAT],
        `tmux display-message -p -t ${shellQuote(exact)} "${CURSOR_FORMAT}"`,
      );
      const [xRaw, yRaw, widthRaw, heightRaw] = output.trim().split(TMUX_FIELD_SEPARATOR);
      const x = Number.parseInt(xRaw ?? "", 10);
      const y = Number.parseInt(yRaw ?? "", 10);
      const width = Number.parseInt(widthRaw ?? "", 10);
      const height = Number.parseInt(heightRaw ?? "", 10);
      if (![x, y, width, height].every(Number.isFinite)) return null;
      if (x < 0 || y < 0 || width < 1 || height < 1) return null;
      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  /**
   * Set a SESSION-scoped option via `set-option -t <session>` (OPR.0.4.6.02
   * N1 JSDoc fix, arch): this is the GENERIC session-scope writer — it takes
   * ANY session option, not only `@`-prefixed user options (it is how the
   * launcher sets built-in session options like `mouse` and `status`). For
   * SERVER-scope options use `setServerOption` (`set-option -s`); the two
   * scopes are never crossed (guard b2).
   */
  async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    // set/show-option take a target-pane even when the option is session-scoped.
    const exact = exactTarget(sessionName, "pane");
    try {
      await this.run(["tmux", "set-option", "-t", exact, key, value],
        `tmux set-option -t ${shellQuote(exact)} ${shellQuote(key)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1 (guard b2): set a SERVER-scoped option via
   * `set-option -s <option> <value>` — the daemon configuring its OWN tmux
   * server (NOT a live-flip of anyone's session). NEVER targets a session
   * (`-t`): server scope and session scope are distinct and never crossed.
   * Used for `set-clipboard` / `copy-command`.
   */
  async setServerOption(option: string, value: string): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "set-option", "-s", option, value],
        `tmux set-option -s ${shellQuote(option)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1: read a SERVER-scoped option value via
   * `show-options -sv <option>` (the `-s` server-scope reader — mirrors
   * `setServerOption`). Returns null if unset or on error. For tests/proof.
   */
  async showServerOption(option: string): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "show-options", "-sv", option],
        `tmux show-options -sv ${shellQuote(option)}`);
      const v = output.trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /** Get a session-scoped user option value. Returns null if not set or error. */
  async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    // set/show-option take a target-pane even when the option is session-scoped.
    const exact = exactTarget(sessionName, "pane");
    try {
      const output = await this.run(["tmux", "show-option", "-v", "-t", exact, key],
        `tmux show-option -v -t ${shellQuote(exact)} ${shellQuote(key)}`);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  /**
  /**
   * Slice 15 — read the timestamp (Unix epoch seconds) of the last
   * activity on the pane's window. The daemon's SeatActivityService
   * compares this against the configured silence window: if the
   * timestamp is within the window the seat is `terminal-active`,
   * otherwise it's silent past the threshold.
   *
   * Why not `pane_silence_flag`: tmux 3.6a was observed to return a
   * blank value for `#{pane_silence_flag}` during slice 15 dogfood
   * (sticky-alert behavior + version-dependent emit semantics), so
   * we cannot rely on it as the primary signal. `#{window_activity}`
   * is reliably populated (the runtime updates it whenever the
   * window receives output) and is the timestamp the tmux status-line
   * activity indicators use themselves.
   *
   * Returns:
   *   - a Unix-epoch-seconds integer when the runtime exposed the value
   *   - `null` when the target is missing OR the value is unparseable
   *     (consumers treat null as "no signal", distinct from "idle").
   */
  /** readAllSessionWindowActivity with a key of each current window's active pane from the same call. tmux changes
   *  what a capture returns without counting activity on a resize, a reset, a respawn, a pane switch or a
   *  clear-history; each moves the pane's id, pid, size, history size or bytes, or its cursor. The session name stays last. */
  async readAllSessionWindows(): Promise<Map<string, { activity: number; size: string }> | null> {
    try {
      const format = ["#{window_active}", "#{window_activity}", "#{window_width}x#{window_height}:#{pane_id}:#{pane_pid}:#{pane_width}x#{pane_height}:#{history_size}:#{history_bytes}:#{cursor_x},#{cursor_y}", "#{session_name}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-windows", "-a", "-F", format], `tmux list-windows -a -F '${format}'`);
      const out = new Map<string, { activity: number; size: string }>();
      for (const line of output.split("\n")) {
        const f1 = line.indexOf(TMUX_FIELD_SEPARATOR), f2 = line.indexOf(TMUX_FIELD_SEPARATOR, f1 + 1), f3 = line.indexOf(TMUX_FIELD_SEPARATOR, f2 + 1);
        if (f1 < 0 || f2 < 0 || f3 < 0) continue;
        const activity = line.slice(f1 + 1, f2).trim(), session = line.slice(f3 + 1);
        if (!session || line.slice(0, f1) !== "1" || !/^\d+$/.test(activity) || Number(activity) <= 0) continue;
        out.set(session, { activity: Number(activity), size: line.slice(f2 + 1, f3) });
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Every session's current-window `#{window_activity}` in ONE tmux call, keyed by session name: the same value
   *  `readPaneLastActivity(<session name>)` reads (display-message -t <session> resolves to the session's current
   *  window). Only well-formed timestamps are included, so a missing key means "read it the per-target way". Null when
   *  tmux can't be read at all. The session name is the LAST field, so a separator inside it stays intact. */
  async readAllSessionWindowActivity(): Promise<Map<string, number> | null> {
    try {
      const format = ["#{window_active}", "#{window_activity}", "#{session_name}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-windows", "-a", "-F", format], `tmux list-windows -a -F '${format}'`);
      const out = new Map<string, number>();
      for (const line of output.split("\n")) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        if (first < 0 || second < 0) continue;
        const active = line.slice(0, first), activity = line.slice(first + 1, second).trim(), session = line.slice(second + 1);
        if (!session || active !== "1" || !/^\d+$/.test(activity)) continue;
        const n = Number(activity);
        if (Number.isFinite(n) && n > 0) out.set(session, n);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Every pane's pid and current command in ONE tmux call, keyed by pane id (%N): the values `getPanePid` /
   *  `getPaneCommand` read per pane. Panes without a valid pid are left out (read those per pane). Null when tmux can't
   *  be read at all. The command is the LAST field, so a separator inside it stays intact. */
  async readAllPaneProcesses(): Promise<Map<string, { pid: number; command: string | null }> | null> {
    try {
      const format = ["#{pane_id}", "#{pane_pid}", "#{pane_current_command}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-panes", "-a", "-F", format], `tmux list-panes -a -F '${format}'`);
      const out = new Map<string, { pid: number; command: string | null }>();
      for (const line of output.split("\n")) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        if (first <= 0 || second < 0) continue;
        const id = line.slice(0, first), pid = parseInt(line.slice(first + 1, second).trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        out.set(id, { pid, command: line.slice(second + 1).trim() || null });
      }
      return out;
    } catch {
      return null;
    }
  }

  async readPaneLastActivity(paneId: string): Promise<number | null> {
    const exact = exactTarget(paneId, "pane");
    try {
      const output = await this.run(
        ["tmux", "display-message", "-p", "-t", exact, "#{window_activity}"],
        `tmux display-message -p -t ${shellQuote(exact)} '#{window_activity}'`,
      );
      const trimmed = output.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    } catch {
      return null;
    }
  }

  /**
   * OPR.0.4.3.26 — list the tmux clients (human terminals / CMUX tiles) attached
   * to the server. VIEW-ONLY probe: it never mutates routing, bindings, or
   * sessions. Mirrors the read/parse/error-swallow shape of `listSessions`:
   * a "no server running" / socket-absent server yields `[]` (no attachable
   * client) so the caller emits an honest "attach first" error rather than
   * crashing. Unexpected failures (permission, etc.) rethrow.
   */
  async listClients(): Promise<TmuxClient[]> {
    try {
      const output = await this.run(["tmux", "list-clients", "-F", CLIENT_FORMAT],
        `tmux list-clients -F "${CLIENT_FORMAT}"`);
      return parseLines(output, parseClientLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * OPR.0.4.3.26 — retarget an already-attached client's VIEW to `target`
   * (`<session>` or `<session>:<window>`). This is the whole point of the
   * seat-recovery slice: it changes only what a client SEES; it never creates,
   * kills, or rebinds a session and never touches OpenRig routing/identity.
   */
  async switchClient(client: string, target: string): Promise<TmuxResult> {
    const exact = exactTarget(target, "session");
    try {
      await this.run(["tmux", "switch-client", "-c", client, "-t", exact],
        `tmux switch-client -c ${shellQuote(client)} -t ${shellQuote(exact)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }
}
