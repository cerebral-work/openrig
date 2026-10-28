// Spec 0017 items 1 and 3: the directory that holds secret-bearing launch scripts. Only the daemon's user may list it
// (os.tmpdir() is world-listable), it is checked before each use, and every file in it is removed at startup.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSecretLaunchDir, ensureSecretLaunchDir, secretLaunchDirPath, sweepSecretLaunchDir } from "../src/domain/secret-launch-dir.js";

describe.skipIf(process.platform === "win32")("secret launch directory (spec 0017)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "openrig-secret-dir-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("REQ-0017-05: resolves under OPENRIG_HOME to an absolute path, even from a relative home", () => {
    expect(secretLaunchDirPath("/srv/openrig")).toBe("/srv/openrig/seat-env/launch");
    const relative = secretLaunchDirPath("relative-home");
    expect(path.isAbsolute(relative)).toBe(true);
    expect(relative.endsWith(path.join("relative-home", "seat-env", "launch"))).toBe(true);
  });

  it("REQ-0017-05: creates the directory with mode 0700 when absent", () => {
    const dir = secretLaunchDirPath(home);
    ensureSecretLaunchDir(dir);
    const st = lstatSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(lstatSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
  });

  it("REQ-0017-11: refuses a directory with another mode and leaves its mode alone", () => {
    const dir = secretLaunchDirPath(home);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect(() => ensureSecretLaunchDir(dir)).toThrow(/mode 0755, not 0700/);
    expect(lstatSync(dir).mode & 0o777).toBe(0o755);
  });

  it("REQ-0017-11: refuses a symlink, even to a 0700 directory of ours", () => {
    const real = path.join(home, "real");
    mkdirSync(real, { mode: 0o700 });
    const dir = secretLaunchDirPath(home);
    mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    symlinkSync(real, dir);
    expect(() => ensureSecretLaunchDir(dir)).toThrow(/is a symlink/);
  });

  it("REQ-0017-11: refuses a directory owned by another uid", () => {
    const dir = secretLaunchDirPath(home);
    ensureSecretLaunchDir(dir);
    const other = (process.getuid?.() ?? 0) + 1;
    expect(checkSecretLaunchDir(dir, other)).toMatch(/owned by uid \d+, not \d+/);
    expect(() => ensureSecretLaunchDir(dir, other)).toThrow(/owned by uid/);
  });

  it("REQ-0017-11: refuses a plain file in the directory's place", () => {
    const dir = secretLaunchDirPath(home);
    mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    writeFileSync(dir, "", { mode: 0o600 });
    expect(() => ensureSecretLaunchDir(dir)).toThrow(/not a directory/);
  });

  it("REQ-0017-12: the startup sweep removes every file, including one written a moment ago", () => {
    const dir = secretLaunchDirPath(home);
    ensureSecretLaunchDir(dir);
    for (const name of ["openrig-tmux-send-1-old.txt", "fresh", "another"]) writeFileSync(path.join(dir, name), "export X='sentinel'\n", { mode: 0o600 });
    expect(sweepSecretLaunchDir(dir)).toBe(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("REQ-0017-12: the sweep creates a missing directory and refuses an unsafe one without touching its files", () => {
    const dir = secretLaunchDirPath(home);
    expect(sweepSecretLaunchDir(dir)).toBe(0);
    expect(existsSync(dir)).toBe(true);
    writeFileSync(path.join(dir, "kept"), "", { mode: 0o600 });
    chmodSync(dir, 0o750);
    expect(() => sweepSecretLaunchDir(dir)).toThrow(/mode 0750/);
    expect(existsSync(path.join(dir, "kept"))).toBe(true);
  });
});
