// Spec 0017 items 1 and 3: the directory that holds secret-bearing launch scripts, `<OPENRIG_HOME>/seat-env/launch/`.
// os.tmpdir() is world-listable, so a script that carries a secret-named value is written here instead: a directory only
// the daemon's user can list, checked before each use, and emptied at startup before the daemon serves.
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

/** REQ-0017-05: the directory's absolute path. A configured OPENRIG_HOME may be relative; POSIX `.` searches PATH for a
 *  name with no `/`, so every path built from this one must be absolute. */
export function secretLaunchDirPath(openrigHome: string): string {
  return path.resolve(openrigHome, "seat-env", "launch");
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

/** REQ-0017-11: why `dir` may not hold a secret-bearing file, or null when it may: it must be a directory, not a symlink,
 *  owned by `uid` (the daemon's), with mode exactly 0700. Read with lstat, so a symlink is never followed. */
export function checkSecretLaunchDir(dir: string, uid: number | undefined = process.getuid?.()): string | null {
  let st;
  try { st = lstatSync(dir); }
  catch (error) { return `${dir} can't be read (${(error as NodeJS.ErrnoException).code ?? "error"})`; }
  if (st.isSymbolicLink()) return `${dir} is a symlink`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (uid !== undefined && st.uid !== uid) return `${dir} is owned by uid ${st.uid}, not ${uid}`;
  if ((st.mode & 0o777) !== 0o700) return `${dir} has mode ${octal(st.mode)}, not 0700`;
  return null;
}

/** REQ-0017-05, REQ-0017-11: create `dir` (and its parent) with mode 0700 when absent, then check it. An existing directory
 *  is never changed: one with another mode, owner or type is refused, naming what failed. */
export function ensureSecretLaunchDir(dir: string, uid?: number): void {
  for (const level of [path.dirname(dir), dir]) {
    try { lstatSync(level); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(level, { recursive: true, mode: 0o700 });
      // mkdir applies the umask; set the mode exactly on the level this call made.
      chmodSync(level, 0o700);
    }
  }
  const problem = uid === undefined ? checkSecretLaunchDir(dir) : checkSecretLaunchDir(dir, uid);
  if (problem) throw new Error(`The secret-bearing launch directory is unsafe: ${problem}. Nothing was written.`);
}

/** REQ-0017-12: at startup, before the daemon serves, remove every file in `dir`. No launch can own one then, so none is
 *  spared. Creates the directory when absent; refuses an unsafe one without touching it. Returns how many were removed. */
export function sweepSecretLaunchDir(dir: string): number {
  ensureSecretLaunchDir(dir);
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    unlinkSync(path.join(dir, entry.name));
    removed++;
  }
  return removed;
}
