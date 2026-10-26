import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeShards } from "../.github/full-suite/merge-shards.mjs";

const report = (names, extra = {}) =>
  JSON.stringify({ numTotalTests: names.length, numPassedTests: names.length, numFailedTests: 0, success: true, testResults: names.map((name) => ({ name, status: "passed", assertionResults: [] })), ...extra });
const shard = (name, k, n, { names, unhandled = 0, exit = 0, extra }) => ({
  [`${name}.shard${k}of${n}.json`]: report(names, extra),
  [`${name}.shard${k}of${n}.unhandled.json`]: JSON.stringify({ count: unhandled, errors: unhandled ? ["boom"] : [] }),
  [`${name}.shard${k}of${n}.exit`]: `${exit}\n`,
});

test("two shards become one report with every file, the summed counts and the highest exit code", () => {
  const out = mergeShards({
    ...shard("daemon", 1, 2, { names: ["/r/a.test.ts"], unhandled: 1, exit: 0 }),
    ...shard("daemon", 2, 2, { names: ["/r/b.test.ts", "/r/c.test.ts"], exit: 1, extra: { success: false, numFailedTests: 1 } }),
  });
  const merged = JSON.parse(out["daemon.json"]);
  assert.deepEqual(merged.testResults.map((f) => f.name), ["/r/a.test.ts", "/r/b.test.ts", "/r/c.test.ts"]);
  assert.equal(merged.numTotalTests, 3);
  assert.equal(merged.numFailedTests, 1);
  assert.equal(merged.success, false);
  assert.deepEqual(JSON.parse(out["daemon.unhandled.json"]), { count: 1, errors: ["boom"] });
  assert.equal(out["daemon.exit"], "1\n");
});

test("workspaces merge separately", () => {
  const out = mergeShards({ ...shard("daemon", 1, 1, { names: ["/r/a.test.ts"] }), ...shard("cli", 1, 1, { names: ["/r/x.test.ts"] }) });
  assert.deepEqual(Object.keys(out).sort(), ["cli.exit", "cli.json", "cli.unhandled.json", "daemon.exit", "daemon.json", "daemon.unhandled.json"]);
});

test("a missing shard is refused and names the file", () => {
  const files = { ...shard("daemon", 1, 3, { names: ["/r/a.test.ts"] }), ...shard("daemon", 3, 3, { names: ["/r/c.test.ts"] }) };
  assert.throws(() => mergeShards(files), /shard 2 of 3 is missing daemon\.shard2of3\.json/);
});

test("a shard with one of its three files missing is refused", () => {
  const files = shard("daemon", 1, 1, { names: ["/r/a.test.ts"] });
  delete files["daemon.shard1of1.exit"];
  assert.throws(() => mergeShards(files), /missing daemon\.shard1of1\.exit/);
});

test("shards that disagree on the count are refused", () => {
  const files = { ...shard("daemon", 1, 2, { names: ["/r/a.test.ts"] }), ...shard("daemon", 2, 3, { names: ["/r/b.test.ts"] }) };
  assert.throws(() => mergeShards(files), /disagree on the shard count/);
});

test("one test file in two shards is refused", () => {
  const files = { ...shard("daemon", 1, 2, { names: ["/r/a.test.ts"] }), ...shard("daemon", 2, 2, { names: ["/r/a.test.ts"] }) };
  assert.throws(() => mergeShards(files), /ran in two shards/);
});

test("a report that is not JSON, or an exit file that is not a number, is refused", () => {
  const bad = shard("daemon", 1, 1, { names: ["/r/a.test.ts"] });
  bad["daemon.shard1of1.json"] = "{not json";
  assert.throws(() => mergeShards(bad), /not JSON/);
  const bad2 = shard("daemon", 1, 1, { names: ["/r/a.test.ts"] });
  bad2["daemon.shard1of1.exit"] = "oops\n";
  assert.throws(() => mergeShards(bad2), /not a number/);
});

test("no shard files at all is refused", () => {
  assert.throws(() => mergeShards({ "readme.txt": "x" }), /no shard report found/);
});
