// What an OpenRig-managed seat must not inherit from the tmux server it is launched on.
// A tmux server recreated from a herdr pane carries that pane's identity and the herdr server's
// control socket (HERDR_SOCKET_PATH); a seat started there would act as that native pane.
// This applies to seat launches only. The daemon's own process keeps HERDR_SOCKET_PATH for its
// herdr transport (terminal/herdr-transport.ts), so removeParentSessionEnv stays as it is.
// A list of rules rather than one check, so the seat-env allow-list (SEC-178) can replace it.
import { parentSessionEnvKeys } from "./parent-session-env.js";

/** Every variable under these prefixes is excluded from a seat launch. */
export const SEAT_LAUNCH_EXCLUDED_ENV_PREFIXES = ["HERDR_"] as const;

/** The names in `env` a seat launch must not inherit: the launching session's identity
 * (parent-session-env), then every name under an excluded prefix. Names only, never values. */
export function seatLaunchExcludedEnvKeys(env: Readonly<Record<string, string | undefined>>): string[] {
  const keys = parentSessionEnvKeys(env);
  for (const key of Object.keys(env)) {
    if (!keys.includes(key) && SEAT_LAUNCH_EXCLUDED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
  }
  return keys;
}
