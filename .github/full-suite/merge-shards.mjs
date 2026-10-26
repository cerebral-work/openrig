// cerebral-work fork (spec 0001 item 8, CER-2937): joins the shard reports of the full-suite job into the one
// report triple per workspace that `cargo xtask suite-baseline check` reads.
//
// A shard writes <name>.shard<k>of<n>.json (vitest's JSON report), .unhandled.json (the unhandled-error count) and
// .exit (the suite's exit code). This script writes <name>.json, <name>.unhandled.json and <name>.exit.
// It refuses, naming the problem, when a shard file is missing, when shards disagree on <n>, when one test file
// appears in two shards, or when a file is not readable. A refusal is a failed job, never a pass.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHARD_FILE = /^(?<name>.+)\.shard(?<k>\d+)of(?<n>\d+)\.(?<kind>unhandled\.json|json|exit)$/;

export function mergeShards(files) {
  // files: { "<file name>": "<contents>" }
  const groups = new Map();
  for (const [file, text] of Object.entries(files)) {
    const m = SHARD_FILE.exec(file);
    if (!m) continue;
    const { name, k, n, kind } = m.groups;
    const group = groups.get(name) ?? { total: null, shards: new Map() };
    if (group.total !== null && group.total !== Number(n)) {
      throw new Error(`${name}: shards disagree on the shard count (${group.total} and ${n})`);
    }
    group.total = Number(n);
    const shard = group.shards.get(Number(k)) ?? {};
    shard[kind] = text;
    group.shards.set(Number(k), shard);
    groups.set(name, group);
  }
  if (groups.size === 0) throw new Error("no shard report found");

  const out = {};
  for (const [name, { total, shards }] of groups) {
    const merged = { testResults: [], numFailedTests: 0, numPassedTests: 0, numTotalTests: 0, success: true };
    const seen = new Set();
    let unhandled = { count: 0, errors: [] };
    let exit = 0;
    for (let k = 1; k <= total; k++) {
      const shard = shards.get(k);
      for (const kind of ["json", "unhandled.json", "exit"]) {
        if (!shard || shard[kind] === undefined) {
          throw new Error(`${name}: shard ${k} of ${total} is missing ${name}.shard${k}of${total}.${kind}`);
        }
      }
      let report, counts;
      try {
        report = JSON.parse(shard.json);
        counts = JSON.parse(shard["unhandled.json"]);
      } catch (error) {
        throw new Error(`${name}: shard ${k} of ${total} has a report that is not JSON (${error.message})`);
      }
      if (!Array.isArray(report.testResults)) throw new Error(`${name}: shard ${k} of ${total} has no testResults`);
      for (const file of report.testResults) {
        if (seen.has(file.name)) throw new Error(`${name}: the test file ${file.name} ran in two shards`);
        seen.add(file.name);
        merged.testResults.push(file);
      }
      for (const key of ["numFailedTests", "numPassedTests", "numTotalTests"]) merged[key] += Number(report[key] ?? 0);
      merged.success = merged.success && report.success !== false;
      unhandled = { count: unhandled.count + Number(counts.count ?? 0), errors: unhandled.errors.concat(counts.errors ?? []) };
      const code = Number.parseInt(shard.exit.trim(), 10);
      if (Number.isNaN(code)) throw new Error(`${name}: shard ${k} of ${total} has an exit file that is not a number`);
      exit = Math.max(exit, code);
    }
    out[`${name}.json`] = `${JSON.stringify(merged)}\n`;
    out[`${name}.unhandled.json`] = `${JSON.stringify(unhandled)}\n`;
    out[`${name}.exit`] = `${exit}\n`;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [from, to = from] = process.argv.slice(2);
  if (!from) throw new Error("usage: merge-shards.mjs <shard reports dir> [<output dir>]");
  const files = {};
  for (const file of readdirSync(from)) if (SHARD_FILE.test(file)) files[file] = readFileSync(join(from, file), "utf8");
  for (const [file, text] of Object.entries(mergeShards(files))) writeFileSync(join(to, file), text);
}
