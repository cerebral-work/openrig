import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface EdgeAddResult {
  ok: boolean;
  status?: "created" | "exists" | "removed";
  edge?: { id: string; sourceId: string; targetId: string; kind: string };
  code?: string;
  error?: string;
}

// Spec 0008: add an edge between two seats that already exist in a rig. Writes one edge row and
// relaunches nothing. For edges to a pod being added, use the `crossPodEdges` key of `rig expand`.
export function edgeCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("edge").description("Manage edges between existing seats of a rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("add")
    .description("Add an edge between two existing nodes (no relaunch; rig ID and sessions are kept)")
    .argument("<rig-id>", "ID of the target rig")
    .argument("<from>", "Logical id of the source node, e.g. orch.lead")
    .argument("<to>", "Logical id of the target node, e.g. dev.build")
    .requiredOption("--kind <kind>", "Edge kind: delegates_to, spawned_by, can_observe, collaborates_with or escalates_to")
    .option("--json", "JSON output for agents")
    .action(async (rigId: string, from: string, to: string, opts: { kind: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<EdgeAddResult>(`/api/rigs/${encodeURIComponent(rigId)}/edges`, { from, to, kind: opts.kind });
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        if (res.status >= 400 || !data.ok) process.exitCode = 1;
        return;
      }
      if (res.status >= 400 || !data.ok) {
        console.error(data.error ?? `Edge add failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }
      console.log(data.status === "exists"
        ? `Edge ${opts.kind} ${from} -> ${to} already exists`
        : `Added ${opts.kind} edge ${from} -> ${to}`);
    });

  // CER-2981: remove one edge, the reverse of add. Deletes one edge row and relaunches nothing; the daemon records who
  // removed it. An absent edge is an error, never success.
  cmd
    .command("remove")
    .description("Remove an edge between two existing nodes (no relaunch; rig ID and sessions are kept)")
    .argument("<rig-id>", "ID of the target rig")
    .argument("<from>", "Logical id of the source node, e.g. orch.lead")
    .argument("<to>", "Logical id of the target node, e.g. dev.build")
    .requiredOption("--kind <kind>", "Edge kind: delegates_to, spawned_by, can_observe, collaborates_with or escalates_to")
    .option("--json", "JSON output for agents")
    .action(async (rigId: string, from: string, to: string, opts: { kind: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const query = new URLSearchParams({ from, to, kind: opts.kind });
      const res = await client.delete<EdgeAddResult>(`/api/rigs/${encodeURIComponent(rigId)}/edges?${query}`);
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        if (res.status >= 400 || !data.ok) process.exitCode = 1;
        return;
      }
      if (res.status >= 400 || !data.ok) {
        console.error(data.error ?? `Edge remove failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }
      console.log(`Removed ${opts.kind} edge ${from} -> ${to}`);
    });

  return cmd;
}
