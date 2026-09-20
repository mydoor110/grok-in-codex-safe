import fs from "node:fs";
import { verifyDelivery } from "./lib/acceptance.mjs";
if (process.argv.includes('--self-test')) process.stdout.write('verification-ready');
else {
  const { job, processOk, exitCode } = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(verifyDelivery(job, processOk, exitCode, event => process.send?.(event))));
}
