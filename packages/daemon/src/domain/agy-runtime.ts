// Google Antigravity CLI ("agy", verified against 1.4.0) runtime helpers.
// Pure/side-effect-bounded pieces shared by the adapter, the resume adapter and
// resume-token capture: screen classification, launch-argument validation, and
// the additive edits OpenRig makes to agy's global config under ~/.gemini.
//
// Every file write here is additive (other keys/entries are preserved), atomic
// (temp file + rename) and mode-preserving. Callers pass the home directory so
// tests run against a temp HOME and never touch the real ~/.gemini.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { shellQuote } from "../adapters/shell-quote.js";

export const AGY_MODES = ["accept-edits", "auto", "plan"] as const;
export type AgyMode = (typeof AGY_MODES)[number];

/** `agy` resumes a conversation by UUID (`agy --conversation <uuid>`). */
export const AGY_CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the mode, undefined when unset, or throws. agy itself only WARNS on a bad --mode, so OpenRig must reject it. */
export function validateAgyMode(mode: string | undefined | null): AgyMode | undefined {
  const m = mode?.trim();
  if (!m) return undefined;
  if (!(AGY_MODES as readonly string[]).includes(m)) {
    throw new Error(`Invalid agy --mode "${m}" (allowed: ${AGY_MODES.join(", ")})`);
  }
  return m as AgyMode;
}

// ── Screen classification ─────────────────────────────────────────────────

export type AgyScreenState = "trust" | "ready" | "working" | "unknown";

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const BRAILLE_SPINNER_RE = /[⠁-⣿]\s+Generating\.\.\./;

/**
 * Classify an agy 1.4.0 pane. Evidence: recorded live captures (trust dialog,
 * idle, working, done). The trust dialog wins over everything (it is shown
 * even with --dangerously-skip-permissions); `esc to cancel` / the spinner
 * line mean a turn is running; a bottom-left `? for shortcuts` footer with no
 * working marker is the idle, input-ready screen.
 */
export function classifyAgyScreen(content: string | null | undefined): AgyScreenState {
  const text = (content ?? "").replace(ANSI_RE, "");
  if (/Do you trust the contents of this project\?/.test(text)) return "trust";
  if (/^esc to cancel\b/m.test(text) || BRAILLE_SPINNER_RE.test(text)) return "working";
  if (/^\? for shortcuts\b/m.test(text)) return "ready";
  return "unknown";
}

// ── ~/.gemini paths ───────────────────────────────────────────────────────

export function agySettingsPath(homeDir: string = os.homedir()): string {
  return nodePath.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
}

export function agyHooksPath(homeDir: string = os.homedir()): string {
  return nodePath.join(homeDir, ".gemini", "config", "hooks.json");
}

function readJsonObject(path: string): { obj: Record<string, unknown>; raw: string | null } {
  if (!fs.existsSync(path)) return { obj: {}, raw: null };
  const raw = fs.readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object; refusing to rewrite it`);
  }
  return { obj: parsed as Record<string, unknown>, raw };
}

/** Serialize with the existing file's indent and trailing-newline convention so untouched entries keep their bytes. */
function serializeLike(raw: string | null, obj: Record<string, unknown>): string {
  let indent: string | number = 2;
  const m = raw?.match(/^\{\s*\n([ \t]+)\S/);
  if (m) indent = m[1]!.includes("\t") ? "\t" : m[1]!.length;
  const trailingNewline = raw === null ? true : raw.endsWith("\n");
  return `${JSON.stringify(obj, null, indent)}${trailingNewline ? "\n" : ""}`;
}

/** Temp file in the same directory + rename; an existing file keeps its permission bits. */
export function writeFileAtomic(path: string, content: string, defaultMode = 0o644): void {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  let mode = defaultMode;
  try { mode = fs.statSync(path).mode & 0o7777; } catch { /* new file */ }
  const tmp = `${path}.openrig-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode); // umask can narrow the create mode
    fs.renameSync(tmp, path);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// ── Trust seeding ─────────────────────────────────────────────────────────

/**
 * Additively add `cwd` to `trustedWorkspaces` in agy's settings.json. Every
 * other key is preserved; an already-listed workspace leaves the file
 * byte-identical (no write). A settings file that is not a JSON object is
 * never rewritten (the error propagates; the adapter surfaces it).
 * Returns true when the file was changed.
 */
export function ensureAgyWorkspaceTrusted(cwd: string, homeDir?: string): boolean {
  const path = agySettingsPath(homeDir);
  const { obj: settings, raw } = readJsonObject(path);
  const existing = settings["trustedWorkspaces"];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`${path}: trustedWorkspaces is not an array; refusing to rewrite it`);
  }
  const list = (existing as unknown[] | undefined) ?? [];
  if (list.includes(cwd)) return false;
  settings["trustedWorkspaces"] = [...list, cwd];
  writeFileAtomic(path, serializeLike(raw, settings), 0o600);
  return true;
}

// ── Hook registration ─────────────────────────────────────────────────────

export const AGY_HOOK_ENTRY_NAME = "openrig";

interface TopLevelEntry { key: string; valueStart: number; valueEnd: number }

/** Skip one JSON value starting at `i` (after whitespace); returns the index just past it. Strings, escapes and nesting are tracked. */
function skipJsonValue(raw: string, i: number): number {
  const c = raw[i];
  if (c === '"') {
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j] === "\\") j++;
      else if (raw[j] === '"') return j + 1;
    }
    throw new Error("unterminated string");
  }
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (ch === '"') { j = skipJsonValue(raw, j) - 1; continue; }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { depth--; if (depth === 0) return j + 1; }
    }
    throw new Error("unterminated container");
  }
  let j = i;
  while (j < raw.length && !/[,}\s]/.test(raw[j]!)) j++;
  return j;
}

/** Locate every top-level member of a JSON object document, plus the index of its closing brace. */
function scanTopLevel(raw: string): { entries: TopLevelEntry[]; close: number } {
  const ws = (i: number) => { while (i < raw.length && /\s/.test(raw[i]!)) i++; return i; };
  let i = ws(0);
  if (raw[i] !== "{") throw new Error("not a JSON object");
  i = ws(i + 1);
  const entries: TopLevelEntry[] = [];
  while (raw[i] !== "}") {
    if (raw[i] !== '"') throw new Error("expected a member name");
    const keyEnd = skipJsonValue(raw, i);
    const key = JSON.parse(raw.slice(i, keyEnd)) as string;
    i = ws(keyEnd);
    if (raw[i] !== ":") throw new Error("expected ':'");
    const valueStart = ws(i + 1);
    const valueEnd = skipJsonValue(raw, valueStart);
    entries.push({ key, valueStart, valueEnd });
    i = ws(valueEnd);
    if (raw[i] === ",") i = ws(i + 1);
  }
  return { entries, close: i };
}

/**
 * Set one top-level member of a JSON object document by TEXTUAL splice, so every other byte
 * (formatting, escapes, line endings, other hooks) stays exactly as it was. A new member is appended
 * after the last one in the file's own indent style; an existing member has only its value replaced.
 * The result is parsed and checked (other members deep-equal, the target equal to `value`) before
 * it is returned; any doubt throws and the caller writes nothing.
 */
export function spliceTopLevelMember(raw: string, key: string, value: unknown): string {
  const before = JSON.parse(raw) as Record<string, unknown>;
  const { entries, close } = scanTopLevel(raw);
  const multiline = /^\s*\{[ \t]*\r?\n/.test(raw);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = raw.match(/\{[ \t]*\r?\n([ \t]+)"/);
  const unit = indentMatch ? indentMatch[1]! : "  ";
  const valueText = multiline
    ? JSON.stringify(value, null, unit).split("\n").join(`${eol}${unit}`)
    : JSON.stringify(value);
  const existing = entries.find((e) => e.key === key);
  let out: string;
  if (existing) {
    out = raw.slice(0, existing.valueStart) + valueText + raw.slice(existing.valueEnd);
  } else if (entries.length === 0) {
    out = multiline
      ? `${raw.slice(0, raw.indexOf("{") + 1)}${eol}${unit}${JSON.stringify(key)}: ${valueText}${eol}${raw.slice(close)}`
      : `{${JSON.stringify(key)}:${valueText}${raw.slice(close)}`;
  } else {
    const last = entries[entries.length - 1]!;
    const member = multiline ? `,${eol}${unit}${JSON.stringify(key)}: ${valueText}` : `,${JSON.stringify(key)}:${valueText}`;
    out = raw.slice(0, last.valueEnd) + member + raw.slice(last.valueEnd);
  }
  const after = JSON.parse(out) as Record<string, unknown>;
  const expected = { ...before, [key]: value };
  if (JSON.stringify(Object.keys(after).sort()) !== JSON.stringify(Object.keys(expected).sort())
    || Object.keys(expected).some((k) => JSON.stringify(after[k]) !== JSON.stringify(expected[k]))) {
    throw new Error("internal check failed: spliced JSON does not match the intended document");
  }
  return out;
}

/**
 * Idempotently register OpenRig's PreInvocation hook in agy's global
 * ~/.gemini/config/hooks.json under the hook name `openrig`. All other named
 * hooks (e.g. `moshi-hook`, `moshi-operator-ask`) stay BYTE-FOR-BYTE untouched
 * (textual splice, see spliceTopLevelMember); when the file already holds the
 * same `openrig` block nothing is written.
 *
 * Schema: hooks.json is keyed by hook name, each block maps an event to a FLAT
 * handler list for PreInvocation (a matcher/hooks wrapper is only valid for the
 * PreToolUse/PostToolUse events and would invalidate the whole file). Source:
 * herdr's Antigravity installer (src/integration/targets.rs), written against
 * agy 1.2.x; not re-verified on 1.4.0.
 */
export function registerAgyHook(hookScriptPath: string, homeDir?: string): boolean {
  const path = agyHooksPath(homeDir);
  const { obj: hooks, raw } = readJsonObject(path);
  const desired = {
    PreInvocation: [{ type: "command", command: `bash ${shellQuote(hookScriptPath)}`, timeout: 10 }],
  };
  const current = hooks[AGY_HOOK_ENTRY_NAME];
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(desired)) return false;
  const next = raw === null || raw.trim() === ""
    ? `${JSON.stringify({ [AGY_HOOK_ENTRY_NAME]: desired }, null, 2)}\n`
    : spliceTopLevelMember(raw, AGY_HOOK_ENTRY_NAME, desired);
  writeFileAtomic(path, next, 0o644);
  return true;
}

// ── Deferred conversation-id sidecar (written by the hook script) ─────────

export function agyHookStatePath(stateRoot: string, sessionName: string): string {
  return nodePath.join(stateRoot, `${sessionName}.json`);
}

export function readAgyConversationId(
  stateRoot: string,
  sessionName: string,
): { ok: true; conversationId: string } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
  if (sessionName.includes("/") || sessionName.includes("..")) return { ok: false, reason: "missing_sidecar" };
  const path = agyHookStatePath(stateRoot, sessionName);
  if (!fs.existsSync(path)) return { ok: false, reason: "missing_sidecar" };
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { conversationId?: unknown };
    const id = typeof parsed.conversationId === "string" ? parsed.conversationId.trim() : "";
    return id ? { ok: true, conversationId: id } : { ok: false, reason: "missing_sidecar" };
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}

// ── Launch preparation ────────────────────────────────────────────────────

/**
 * Everything OpenRig must have in place in agy's global config before an agy
 * process starts in a seat:
 *  - the seat cwd is in `trustedWorkspaces` (otherwise agy shows a trust dialog
 *    even under --dangerously-skip-permissions). A failure here THROWS: the
 *    launch must not proceed into a dialog OpenRig will never answer.
 *  - the `openrig` PreInvocation hook is registered. A failure here only
 *    produces a warning: the seat still works, it just cannot capture a resume
 *    token.
 */
export function prepareAgyLaunch(opts: {
  cwd: string;
  homeDir?: string;
  hookScriptPath?: string;
}): { warnings: string[] } {
  const warnings: string[] = [];
  ensureAgyWorkspaceTrusted(opts.cwd, opts.homeDir);
  if (opts.hookScriptPath) {
    try {
      registerAgyHook(opts.hookScriptPath, opts.homeDir);
    } catch (err) {
      warnings.push(`agy hook registration failed (resume-token capture disabled): ${(err as Error).message}`);
    }
  }
  return { warnings };
}
