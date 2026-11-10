import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("repeated limit failures retain bounded heap, responses and filesystem handles", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx",
    fileURLToPath(new URL("./fixtures/resource-probe.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 45_000, maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const report = JSON.parse(stdout);
  expect(report.measuredFailures).toBe(720);
  expect(report.opens).toBe(report.closes);
  expect(report.samples.every((sample: { trackedHandles: number }) => sample.trackedHandles === 0)).toBe(true);
  console.info("Resource probe:", JSON.stringify(report));
}, 50_000);
