// The NARROW `@openrig/daemon/seat-env-secret-name` surface (spec 0017 item 4): the one secret-name rule, its exemption
// list and the check, so the CLI's `seat_env.base` and `rig up --env` checks use the daemon's copy, never their own.
export { SEAT_ENV_SECRET_NAME, SEAT_ENV_SECRET_NAME_EXEMPTIONS, isSecretSeatEnvName } from "./domain/seat-launch-env-filter.js";
// REQ-0017-20: the known provider-auth set, which seat env refuses.
export { isProviderAuthEnvName } from "./domain/provider-auth-env.js";
