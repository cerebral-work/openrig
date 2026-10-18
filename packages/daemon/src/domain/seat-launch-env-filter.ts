// What an OpenRig-managed seat must not inherit from the tmux server it is launched on.
// A tmux server recreated from a herdr pane carries that pane's identity and the herdr server's
// control socket (HERDR_SOCKET_PATH); a seat started there would act as that native pane.
// This applies to seat launches only. The daemon's own process keeps HERDR_SOCKET_PATH for its
// herdr transport (terminal/herdr-transport.ts), so removeParentSessionEnv stays as it is.
// A list of rules rather than one check, so the seat-env allow-list (SEC-178) can replace it.
//
// Spec 0013 (SEC-178): seat_env.mode = allowlist inverts the rule. A seat then keeps only the base
// names, the launch's own names and the named exceptions; secret-named names are refused even when
// listed, and KUBECONFIG is set explicitly. "filter" (the default) is the rule above, unchanged.
import { parentSessionEnvKeys } from "./parent-session-env.js";
import { parseSessionName } from "./session-name.js";

/** Every variable under these prefixes is excluded from a seat launch. */
export const SEAT_LAUNCH_EXCLUDED_ENV_PREFIXES = ["HERDR_"] as const;

export type SeatEnvMode = "filter" | "allowlist";

export interface SeatEnvPolicy {
  mode: SeatEnvMode;
  /** Names, and `PREFIX*` patterns, a seat keeps (seat_env.base). */
  base: readonly string[];
  /** Exact secret-named names the operator approved by name (seat_env.exceptions). */
  exceptions: readonly string[];
  /** The scoped kubeconfig a seat gets (seat_env.kubeconfig). */
  kubeconfig: string;
  /** Rigs allow-list mode applies to; empty means every rig (seat_env.rigs). */
  rigs: readonly string[];
}

/** The default base list: shell and session basics, tmux ancestry, OpenRig metadata, the SSH agent
 *  socket, and WSL interop for the 1Password signing bridge (op-ssh-sign-wsl.exe). Interop keeps
 *  Windows reachable from a seat, a known residual of the seat-user plan (G12). */
export const SEAT_ENV_DEFAULT_BASE: readonly string[] = [
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "PWD", "SHLVL",
  // The locale: LANG, LANGUAGE and the POSIX LC_ categories, named, not LC_* (review r2).
  "LANG", "LANGUAGE", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
  "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TZ",
  // The XDG base directories, named, not XDG_* (review r2).
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
  "TMPDIR", "TMUX", "TMUX_PANE", "OPENRIG_*", "SSH_AUTH_SOCK",
  "WSL_INTEROP", "WSL_DISTRO_NAME", "WSLENV", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
];

/** Secret-named: refused in allow-list mode even when the base list or the launch names it. */
export const SEAT_ENV_SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CRED|PASSPHRASE|PRIVATE/i;

/** Never kept in allow-list mode, not by the base list, a named exception or a launch's own names:
 *  1Password service-account credentials. `PREFIX*` entries match by prefix. */
export const SEAT_ENV_NEVER: readonly string[] = ["OP_SERVICE_ACCOUNT_TOKEN", "OP_SA_*"];

/** Kept although secret-named. The daemon mints it per seat as that seat's own scoped activity
 *  credential (startup.ts launchSessionEnv); it is not an inherited operator secret, and allow-list
 *  mode must not break activity hooks (SEC-178 ruling, 2026-10-18). One name, never a pattern. */
export const SEAT_ENV_ACTIVITY_TOKEN = "OPENRIG_ACTIVITY_HOOK_TOKEN";

/** KUBECONFIG while the scoped file is absent. Left unset, kubectl would fall back to
 *  ~/.kube/config; this path cannot exist and an unprivileged seat cannot create it, so the seat
 *  inherits no kubeconfig. Kubeconfig files stay readable by the seat's unix user (out of scope). */
export const SEAT_ENV_DENY_KUBECONFIG = "/nonexistent/openrig-seat-env/kubeconfig";

function matchesBase(name: string, base: readonly string[]): boolean {
  return base.some((entry) => entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry);
}

/** Whether a name is on the never list. */
export function seatEnvNever(name: string): boolean {
  return matchesBase(name, SEAT_ENV_NEVER);
}

/** Whether allow-list mode keeps `name`. `explicit` are the names the launch sets itself. */
export function seatEnvKeeps(name: string, policy: SeatEnvPolicy, explicit: readonly string[] = []): boolean {
  if (seatEnvNever(name)) return false;
  if (name === SEAT_ENV_ACTIVITY_TOKEN || policy.exceptions.includes(name)) return true;
  if (SEAT_ENV_SECRET_NAME.test(name)) return false;
  return explicit.includes(name) || matchesBase(name, policy.base);
}

/** The names in `env` a seat launch must not inherit. Filter mode: the launching session's identity
 *  (parent-session-env), then every name under an excluded prefix. Allow-list mode: that identity
 *  and every name `seatEnvKeeps` refuses. Names only, never values. */
export function seatLaunchExcludedEnvKeys(env: Readonly<Record<string, string | undefined>>,
  policy?: SeatEnvPolicy, explicit: readonly string[] = []): string[] {
  const keys = parentSessionEnvKeys(env);
  const allowlist = policy?.mode === "allowlist";
  for (const key of Object.keys(env)) {
    if (keys.includes(key)) continue;
    if (allowlist ? !seatEnvKeeps(key, policy, explicit) : SEAT_LAUNCH_EXCLUDED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
  }
  return keys;
}

/** Whether allow-list mode applies to a seat session. A pilot names rigs; a session name that
 *  carries no rig (a probe) follows the mode, the stricter choice. */
export function seatEnvAllowlistApplies(policy: SeatEnvPolicy | undefined, session: string): policy is SeatEnvPolicy {
  if (policy?.mode !== "allowlist") return false;
  if (policy.rigs.length === 0) return true;
  const parsed = parseSessionName(session);
  return parsed.kind !== "canonical" || policy.rigs.includes(parsed.rig);
}

/** The KUBECONFIG a seat gets: the scoped file, or a path that names no file while it is absent. */
export function seatKubeconfig(policy: SeatEnvPolicy, exists: (file: string) => boolean): { path: string; warning?: string } {
  if (exists(policy.kubeconfig)) return { path: policy.kubeconfig };
  return {
    path: SEAT_ENV_DENY_KUBECONFIG,
    warning: `seat_env.kubeconfig ${policy.kubeconfig} is absent, so KUBECONFIG is ${SEAT_ENV_DENY_KUBECONFIG}: the seat inherits no kubeconfig and kubectl does not fall back to ~/.kube/config`,
  };
}

const list = (raw: string): string[] => raw.split(",").map((entry) => entry.trim()).filter(Boolean);

/** The policy from the five seat_env settings. Refused entries become warnings (names only). */
export function seatEnvPolicyFromSettings(raw: { mode: string; base: string; exceptions: string; kubeconfig: string; rigs: string }): { policy: SeatEnvPolicy; warnings: string[] } {
  const warnings: string[] = [];
  const base = list(raw.base).filter((name) => {
    if (seatEnvNever(name)) {
      warnings.push(`seat_env.base names ${name}, which is never passed to a seat`);
      return false;
    }
    if (!SEAT_ENV_SECRET_NAME.test(name)) return true;
    warnings.push(`seat_env.base names ${name}, which is secret-named; list it in seat_env.exceptions instead`);
    return false;
  });
  const exceptions = list(raw.exceptions).filter((name) => {
    if (seatEnvNever(name)) warnings.push(`seat_env.exceptions names ${name}, which is never passed to a seat`);
    else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) warnings.push(`seat_env.exceptions entry ${name} is not an exact name`);
    else return true;
    return false;
  });
  const mode: SeatEnvMode = raw.mode === "allowlist" ? "allowlist" : "filter";
  return { policy: { mode, base, exceptions, kubeconfig: raw.kubeconfig, rigs: list(raw.rigs) }, warnings };
}

/** The policy as each launch reads it. When the settings cannot be read, launches are refused ("unreadable")
 *  unless filter mode is the last policy read: never a silent fall back to the full environment (review r2). */
export function seatEnvPolicyReader(
  readSettings: () => { mode: string; base: string; exceptions: string; kubeconfig: string; rigs: string },
  warn: (line: string) => void = console.warn,
): () => SeatEnvPolicy | undefined | "unreadable" {
  let last: SeatEnvPolicy | undefined;
  return () => {
    try {
      const { policy, warnings } = seatEnvPolicyFromSettings(readSettings());
      for (const warning of warnings) warn(`[seat env] ${warning}`);
      last = policy;
      return policy;
    } catch {
      warn("[seat env] the seat_env settings could not be read; launches are refused unless filter mode was the last policy read.");
      return last?.mode === "filter" ? last : "unreadable";
    }
  };
}

/** Case-insensitive sh glob for one word, for example KEY -> [Kk][Ee][Yy]. */
function caseless(word: string): string {
  return [...word].map((c) => /[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c).join("");
}

/** The POSIX sh lines a launch script runs first in allow-list mode (bash, zsh, dash and sh alike).
 *  It runs in the launch's own subshell, after the pane shell's startup files, so names those files
 *  export are dropped too:
 *  - names come from awk's ENVIRON keys, which a multi-line value or an exported function body cannot
 *    fool, and which include bash's exported functions (BASH_FUNC_<name>%%);
 *  - a listing that produced nothing refuses: without awk on the pane's PATH both loops would run zero
 *    times and the command would run with every name (review r2, R1b);
 *  - each name the seat may not keep is unset (a function with unset -f). A name that cannot be unset
 *    (a readonly export, a non-identifier name) is tried in a throwaway subshell first, so no shell
 *    aborts on it;
 *  - the environment is listed again, and if any name the seat may not keep is still there the script
 *    prints seat_env_refused with its step and the surviving NAMES (never a value) on the pane's stderr
 *    and exits 126: the command never runs (review r2, R1). The seat then fails readiness, which the
 *    daemon records;
 *  - the loops run with noglob (set -f), so a listed name such as PAT* cannot match a file in the
 *    working directory; the shell's setting is restored for the command.
 *  Then KUBECONFIG is exported. Only names and the KUBECONFIG path appear; no value is read into it. */
export function seatEnvScrubScript(policy: SeatEnvPolicy, explicit: readonly string[], kubeconfig: string): string {
  const word = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;
  const keep = [SEAT_ENV_ACTIVITY_TOKEN, ...policy.exceptions].filter((name) => word.test(name) && !seatEnvNever(name));
  const secret = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CRED", "PASSPHRASE", "PRIVATE"].map((w) => `*${caseless(w)}*`);
  // `_` and OLDPWD are the shell's own (bash exports `_` to every command it runs); gawk adds AWKPATH and
  // AWKLIBPATH to ENVIRON itself; SHELLOPTS and BASHOPTS are bash's option flags, readonly, so an rc that
  // exports them would otherwise make every bash launch refuse (review r2). None is secret-named.
  const allowed = [...policy.base, ...explicit, "_", "OLDPWD", "AWKPATH", "AWKLIBPATH", "SHELLOPTS", "BASHOPTS"]
    .filter((name) => word.test(name));
  const quotedPath = `'${kubeconfig.replace(/'/g, `'\\''`)}'`;
  // The refusal names the step and, where some survive, the names: never a value.
  const refuse = (step: string, names?: string) =>
    `{ IFS=$__openrig_ifs; printf 'openrig: seat_env_refused (step: %s%s); the command was not run\\n' '${step}' ${names ? `"; names:${names}"` : "''"} >&2; exit 126; }`;
  return [
    `__openrig_names() { awk 'BEGIN { for (k in ENVIRON) print k }'; }`,
    `__openrig_keeps() {`,
    `  case "$1" in`,
    `    ${SEAT_ENV_NEVER.join("|")}) return 1 ;;`,
    `    ${keep.join("|")}) return 0 ;;`,
    `    ${secret.join("|")}) return 1 ;;`,
    ...(allowed.length ? [`    ${allowed.join("|")}) return 0 ;;`] : []),
    `    *) return 1 ;;`,
    `  esac`,
    `}`,
    `__openrig_ifs=$IFS`,
    `IFS='`,
    `'`,
    `case $- in *f*) __openrig_glob= ;; *) __openrig_glob=1 ;; esac`,
    `set -f`,
    `[ -n "$(__openrig_names)" ] || ${refuse("list the environment")}`,
    `for __openrig_n in $(__openrig_names); do`,
    `  __openrig_keeps "$__openrig_n" && continue`,
    `  case "$__openrig_n" in`,
    `    BASH_FUNC_*) __openrig_f=\${__openrig_n#BASH_FUNC_}; unset -f "\${__openrig_f%\\%\\%}" 2>/dev/null ;;`,
    `    *) if (unset "$__openrig_n") 2>/dev/null; then unset "$__openrig_n"; else ${refuse("remove a name that cannot be unset", " $__openrig_n")}; fi ;;`,
    `  esac`,
    `done`,
    `[ -n "$(__openrig_names)" ] || ${refuse("list the environment")}`,
    `__openrig_left=`,
    `for __openrig_n in $(__openrig_names); do`,
    `  __openrig_keeps "$__openrig_n" || __openrig_left="$__openrig_left $__openrig_n"`,
    `done`,
    `[ -z "$__openrig_left" ] || ${refuse("re-list the environment", "$__openrig_left")}`,
    `IFS=$__openrig_ifs`,
    `[ -z "$__openrig_glob" ] || set +f`,
    `unset -f __openrig_names __openrig_keeps`,
    `unset __openrig_n __openrig_f __openrig_ifs __openrig_glob __openrig_left`,
    `KUBECONFIG=${quotedPath}; export KUBECONFIG`,
  ].join("\n");
}
