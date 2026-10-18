/**
 * Launch environment a rig declares for its seats: `env:` at rig level and at member level in
 * rig.yaml, plus one-off `rig up --env KEY=VALUE` overrides.
 *
 * These values are written into the seat's tmux launch command line and the process environment.
 * Local processes can read them (#306), so they are for non-secret settings only.
 */

import { isSecretSeatEnvName } from "./seat-launch-env-filter.js";
import { isProviderAuthEnvName } from "./provider-auth-env.js";

export type SeatEnv = Record<string, string>;

/** Spec 0017 item 4: the refusal code for a secret-named seat env name. */
export const SEAT_ENV_SECRET_NAME_CODE = "seat_env_secret_name";

/** Spec 0017 item 4: why a secret-named name is refused as seat env, or null. Seat env is stored in plaintext (rig.yaml,
 *  the database and its backups) or exposed (a CLI's argv, shell history), so a credential comes only from the daemon's
 *  environment. Names only, never values. */
export function seatEnvSecretNameError(name: string): string | null {
  if (!isSecretSeatEnvName(name)) return null;
  return `${SEAT_ENV_SECRET_NAME_CODE}: "${name}" is secret-named, and seat env is for non-secret settings (it is stored in plaintext). Give a seat credentials through the provider-auth allow-list (recovery.provider_auth_env_allowlist), not seat env`;
}

/** REQ-0017-20: the refusal code for a known provider name that is not secret-named (a routing name). */
export const SEAT_ENV_PROVIDER_AUTH_NAME_CODE = "seat_env_provider_auth_name";

/** REQ-0017-20: why a provider routing name is refused as seat env, or null. A secret-named provider name (a key) is
 *  refused by seatEnvSecretNameError instead; together they cover the whole known set. Names only, never values. */
export function seatEnvProviderNameError(name: string): string | null {
  if (isSecretSeatEnvName(name) || !isProviderAuthEnvName(name)) return null;
  return `${SEAT_ENV_PROVIDER_AUTH_NAME_CODE}: "${name}" is a provider routing name. Provider routing and credentials come only from the daemon's provider-auth allow-list (recovery.provider_auth_env_allowlist), never seat env`;
}

/** REQ-0017-20: the provider routing names in a request's envOverride mapping, sorted; names only. */
export function providerSeatEnvOverrideNames(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw).filter((name) => seatEnvProviderNameError(name) !== null).sort();
}

/** Spec 0017 item 4: the secret-named names in a request's envOverride mapping, sorted; names only. */
export function secretSeatEnvOverrideNames(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw).filter(isSecretSeatEnvName).sort();
}

/** Spec 0017 item 4: the refusal message for a request override that names a secret-named variable. */
export function secretSeatEnvOverrideMessage(names: readonly string[]): string {
  return `envOverride ${names.join(", ")}: ${SEAT_ENV_SECRET_NAME_CODE}: secret-named, and --env is for non-secret settings. `
    + "The value was already exposed on the command line and in the shell history: rotate it if it was a real credential. "
    + "Give a seat credentials through the provider-auth allow-list (recovery.provider_auth_env_allowlist).";
}

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_PREFIX = "OPENRIG_";

/** Tmux session variable listing the declared keys, so the managed Claude `env -i` launch can
 *  forward exactly those variables from the pane shell. Reserved by the OPENRIG_ prefix. */
export const SEAT_ENV_KEYS_VAR = "OPENRIG_SEAT_ENV_KEYS";

export function validateSeatEnvName(name: string): string | null {
  if (!NAME.test(name)) return `"${name}" is not a valid name; names match ^[A-Z_][A-Z0-9_]*$`;
  if (name.startsWith(RESERVED_PREFIX)) return `"${name}" is reserved; ${RESERVED_PREFIX}* names belong to OpenRig`;
  return null;
}

/** Validate a raw `env:` block. `path` prefixes each message, e.g. `env` or `pods[0].members[1].env`. */
export function validateSeatEnv(raw: unknown, path: string): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [`${path}: must be a mapping of NAME: value`];
  }
  const errors: string[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const nameError = validateSeatEnvName(name) ?? seatEnvSecretNameError(name) ?? seatEnvProviderNameError(name);
    if (nameError) errors.push(`${path}.${name}: ${nameError}`);
    if (typeof value !== "string") {
      errors.push(`${path}.${name}: value must be a string (quote numbers and booleans, e.g. "1")`);
    } else if (value === "") {
      errors.push(`${path}.${name}: value must not be empty (the launch omits empty variables)`);
    } else if (value.includes("\0")) {
      errors.push(`${path}.${name}: value must not contain a NUL byte`);
    }
  }
  return errors;
}

/** Normalize an already-validated `env:` block; an absent or empty block stays undefined. */
export function normalizeSeatEnv(raw: unknown): SeatEnv | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][];
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The one-off env a request body carries, or undefined when it carries none this launch can
 *  use. `/api/up` and `/api/bundles/install` answered requests with an `envOverride` field as if
 *  the field weren't there before it meant something; a malformed one keeps getting that answer
 *  rather than a new refusal. The CLI checks `--env` itself before sending. */
export function readSeatEnvOverride(raw: unknown): SeatEnv | undefined {
  if (raw === undefined || validateSeatEnv(raw, "envOverride").length > 0) return undefined;
  return normalizeSeatEnv(raw);
}

/** Parse the `KEY=VALUE` form `rig up --env` takes. The value may contain `=`. */
export function parseSeatEnvAssignment(text: string): { ok: true; name: string; value: string } | { ok: false; error: string } {
  const eq = text.indexOf("=");
  if (eq <= 0) return { ok: false, error: `"${text}" is not KEY=VALUE` };
  const name = text.slice(0, eq);
  const value = text.slice(eq + 1);
  const nameError = validateSeatEnvName(name);
  if (nameError) return { ok: false, error: nameError };
  if (value === "") return { ok: false, error: `${name}: value must not be empty (the launch omits empty variables)` };
  if (value.includes("\0")) return { ok: false, error: `${name}: value must not contain a NUL byte` };
  return { ok: true, name, value };
}

/** Effective env for one seat: rig, then member, then a one-off override. Later wins. */
export function mergeSeatEnv(...layers: Array<SeatEnv | null | undefined>): SeatEnv {
  return Object.assign({}, ...layers.filter(Boolean));
}

export function parseStoredSeatEnv(json: string | null | undefined): SeatEnv | null {
  if (!json) return null;
  try {
    return normalizeSeatEnv(JSON.parse(json)) ?? null;
  } catch {
    return null;
  }
}

/** The variables a launch hands the seat: the env itself plus the key list the managed Claude
 *  launch reads back. Empty when the seat declares nothing, so existing seats are unchanged. */
export function seatEnvLaunchVars(env: SeatEnv): SeatEnv {
  const keys = Object.keys(env);
  return keys.length > 0 ? { ...env, [SEAT_ENV_KEYS_VAR]: keys.join(",") } : {};
}
