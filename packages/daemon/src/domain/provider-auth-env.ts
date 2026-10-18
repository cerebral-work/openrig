// The provider credentials and routing a seat launch may take from the daemon's own environment, named in
// recovery.provider_auth_env_allowlist. Moved from startup.ts (spec 0017 item 4, REQ-0017-20) so seat env validation
// and the CLI refuse the same names the daemon delivers: provider routing comes only from the daemon, like the keys.
import { OMP_PROVIDER_ENV_VARS, OMP_PROVIDER_EXTRA_ENV_VARS } from "../adapters/pi-runner-protocol.js";

export const KNOWN_PROVIDER_AUTH_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // The Claude-side counterpart of OPENAI_BASE_URL: a key or token issued by an
  // Anthropic-compatible gateway is only valid together with that gateway's
  // endpoint, so both must be able to reach the seat.
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  // OPR.0.4.6.PI1 FR-7 — Pi seat providers. Without these in the KNOWN set,
  // a daemon-launched Pi seat can never receive its provider key (the
  // pi-runner's own deny-by-default allowlist then has nothing to pass
  // through). Double opt-in preserved: the operator must still name each var
  // in recovery.provider_auth_env_allowlist. OpenRouter is the founder-ruled
  // preferred path (2026-07-06); zai/kimi-coding are the secondary natives;
  // minimax follows the same per-family pattern (one key var per native slug).
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  // Issue #194: the bearer token of a Codex Amazon Bedrock provider
  // (`env_key = "AWS_BEARER_TOKEN_BEDROCK"`). Still forwarded only when the
  // operator names it in recovery.provider_auth_env_allowlist.
  "AWS_BEARER_TOKEN_BEDROCK",
]);

// OMP seat providers, derived from the runner's OMP map so a key the runner
// can pass is always admissible. Admitted only into OMP seats' launch env;
// every other runtime keeps KNOWN_PROVIDER_AUTH_ENV above. Double opt-in is
// unchanged: the operator names each var, and the runner forwards only the
// declared provider's var.
// A provider whose key is scoped to one endpoint (a self-hosted LiteLLM proxy)
// contributes its base-URL variable too: admitting the key alone would hand the
// seat an unusable credential, so the pair travels together — the same pairing
// KNOWN_PROVIDER_AUTH_ENV makes for ANTHROPIC_BASE_URL / OPENAI_BASE_URL.
export const OMP_PROVIDER_AUTH_ENV: Record<string, true> = Object.fromEntries(
  [
    ...Object.values(OMP_PROVIDER_ENV_VARS),
    ...Object.values(OMP_PROVIDER_EXTRA_ENV_VARS).flat(),
  ].map((name) => [name, true as const]),
);

/** Spec 0017 item 4 (REQ-0017-20): whether `name` is in the known provider-auth set, keys and routing names alike. */
export function isProviderAuthEnvName(name: string): boolean {
  return KNOWN_PROVIDER_AUTH_ENV.has(name) || Object.hasOwn(OMP_PROVIDER_AUTH_ENV, name);
}
