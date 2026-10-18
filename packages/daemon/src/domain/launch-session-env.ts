// The launch identity and activity environment every fresh seat gets: NodeLauncher at launch, the handover
// successor launcher, the typed launch command (SeatLaunchEnvironment) and the managed Claude launch.
//
// Spec 0013 item 9: it never carries the activity-hook token. This env reaches tmux as `-e NAME=VALUE`, and a tmux
// server keeps the argv that started it, so `ps` would show the token for the server's whole life. Seats read the
// token from <OPENRIG_HOME>/activity-endpoint.json (mode 0600), which the daemon writes at startup.

export interface LaunchSessionEnvInput {
  path: string | undefined;
  openRigHome: string;
  port: string | undefined;
  host: string | undefined;
  /** The daemon's resolved activity endpoint, as written to <OPENRIG_HOME>/activity-endpoint.json. Only its URL is
   *  placed in the env; the token stays in that file. */
  activityEndpoint: { baseUrl: string; token: string };
  providerAuthEnv: Record<string, string>;
  home: string;
  user: string | undefined;
  logname: string | undefined;
  codexHome: string | undefined;
}

export function buildLaunchSessionEnv(input: LaunchSessionEnvInput): Record<string, string | undefined> {
  return {
    PATH: input.path,
    OPENRIG_HOME: input.openRigHome,
    OPENRIG_PORT: input.port,
    OPENRIG_HOST: input.host,
    OPENRIG_URL: input.activityEndpoint.baseUrl,
    ...input.providerAuthEnv,
    HOME: input.home,
    USER: input.user,
    LOGNAME: input.logname,
    CODEX_HOME: input.codexHome,
  };
}
