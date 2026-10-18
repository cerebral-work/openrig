// Spec 0017 items 1-3 (SEC-183): the channel that delivers a daemon secret to a launched runtime without any argv.
// Values come only from the daemon's own environment through one resolver (REQ-0017-16). They are written as
// single-quoted `export` lines into a 0600 file, in a 0700 directory checked with lstat, which the reading shell
// deletes before it reads a value. Nothing here logs, returns or throws a value; failures name the step only.
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSecretSeatEnvName } from "./seat-launch-env-filter.js";

/** A runtime's secret launch values: exactly the secret-named names of the daemon's own launch sources. */
export type DaemonSecretResolver = (runtime: string | null | undefined) => Readonly<Record<string, string>>;

/** REQ-0017-16: one resolver, built at startup, over the provider-auth allow-list's values and the per-runtime env. */
export function buildDaemonSecretResolver(
  providerAuthEnv: Readonly<Record<string, string | undefined>>,
  runtimeSessionEnv: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>,
): DaemonSecretResolver {
  const pick = (env: Readonly<Record<string, string | undefined>> | undefined) =>
    Object.entries(env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "" && isSecretSeatEnvName(entry[0]));
  return (runtime) => Object.freeze(Object.fromEntries([
    ...pick(providerAuthEnv),
    ...(runtime && Object.hasOwn(runtimeSessionEnv, runtime) ? pick(runtimeSessionEnv[runtime]) : []),
  ]));
}

/** The launch env tmux may carry: `env` without the names the daemon delivers through the channel. */
export function withoutDaemonSecrets<T extends Record<string, string | undefined>>(env: T, secrets: Readonly<Record<string, string>>): T {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !Object.hasOwn(secrets, name))) as T;
}

/** `<OPENRIG_HOME>/seat-env/launch`, absolute: a configured OPENRIG_HOME may be relative, and POSIX `.` searches PATH for
 *  a name with no slash. */
export function secretLaunchDir(openRigHome: string): string {
  return join(resolve(openRigHome), "seat-env", "launch");
}

export type SecretLaunchDirCheck = { ok: true } | { ok: false; code: "secret_launch_dir_refused"; message: string };

/** REQ-0017-11: create the directory with mode 0700 if absent, then require, by lstat, a directory that is not a symlink,
 *  owned by this uid, mode exactly 0700. Anything else refuses the launch before a file is written. */
export async function ensureSecretLaunchDir(dir: string, uid: number | undefined = process.getuid?.()): Promise<SecretLaunchDirCheck> {
  const refuse = (why: string): SecretLaunchDirCheck => ({ ok: false, code: "secret_launch_dir_refused",
    message: `The secret launch directory ${dir} ${why}, so the launch was refused and nothing was written. Fix or remove it, then launch again.` });
  try { await mkdir(dir, { recursive: true, mode: 0o700 }); } catch { /* lstat below says what is there */ }
  let stat;
  try { stat = await lstat(dir); } catch { return refuse("could not be created or read"); }
  if (stat.isSymbolicLink()) return refuse("is a symbolic link");
  if (!stat.isDirectory()) return refuse("is not a directory");
  if (uid !== undefined && stat.uid !== uid) return refuse(`is owned by uid ${stat.uid}, not the daemon's uid ${uid}`);
  if ((stat.mode & 0o777) !== 0o700) return refuse(`has mode ${(stat.mode & 0o777).toString(8)}, not 700`);
  return { ok: true };
}

/** R1, REQ-0017-09: the first line of every secret-bearing staged script. A pane shell with xtrace or verbose on would
 *  otherwise print each export line, value included, to the pane. */
export const SECRET_SCRIPT_TRACE_GUARD = "{ set +xv; } 2>/dev/null";

/** REQ-0017-10: each value as the single-quoted operand of its own `export NAME='…'` line, nothing else on the line. */
export function secretExportLines(values: Readonly<Record<string, string>>): string {
  return Object.entries(values).map(([name, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`secret launch value: invalid name ${JSON.stringify(name)}`);
    if (value.includes("\0")) throw new Error(`secret launch value: ${name} contains a NUL byte`);
    return `export ${name}='${value.replaceAll("'", `'\\''`)}'\n`;
  }).join("");
}

/** Item 2, REQ-0017-06: the managed launch's wrapper. The shell opens the file on descriptor 3, deletes it, then sources
 *  the open descriptor, so an aborting `.` (dash exits on a special builtin's error) leaves nothing behind. A failed open
 *  exits non-zero (2 under dash) and runs nothing. */
export const MANAGED_SECRET_WRAPPER = `exec 3<"$0" || exit 1; rm -f -- "$0"; . /dev/fd/3; s=$?; exec 3<&-; [ "$s" -eq 0 ] && exec "$@"`;

/** REQ-0017-12: delete every file in the directory, at startup, before the daemon serves. Returns how many. */
export async function sweepSecretLaunchDir(dir: string): Promise<number> {
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    try { await unlink(join(dir, name)); removed++; } catch { /* a directory or a race; the next sweep sees it */ }
  }
  return removed;
}
