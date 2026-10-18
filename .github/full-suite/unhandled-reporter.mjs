// cerebral-work fork (spec 0001 item 8, CER-2937): records how many unhandled errors a vitest run caught.
// vitest's JSON reporter doesn't record them, and a run can fail on one while every test passes, so the
// full-suite job's baseline check (`cargo xtask suite-baseline check`) reads this count beside that report.
// Writes {"count": N, "errors": [first lines]} to the path in FULL_SUITE_UNHANDLED_OUT.
import { writeFileSync } from "node:fs";

export default class UnhandledErrorCount {
  onTestRunEnd(_testModules, unhandledErrors) {
    const out = process.env.FULL_SUITE_UNHANDLED_OUT;
    if (!out) throw new Error("FULL_SUITE_UNHANDLED_OUT is not set");
    const errors = unhandledErrors.map((error) => String(error?.message ?? error).split("\n")[0].slice(0, 300));
    writeFileSync(out, `${JSON.stringify({ count: unhandledErrors.length, errors })}\n`);
  }
}
