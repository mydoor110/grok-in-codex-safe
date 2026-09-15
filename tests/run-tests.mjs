import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testTemp = path.resolve(".test-tmp");
fs.mkdirSync(testTemp, { recursive: true });

const result = spawnSync(process.execPath, ["--test", "tests"], {
  stdio: "inherit",
  env: { ...process.env, TEMP: testTemp, TMP: testTemp, GROK_HOME: path.join(testTemp, "grok-home"), GIT_CEILING_DIRECTORIES: testTemp }
});
process.exit(result.status ?? 1);
