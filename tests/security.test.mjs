import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertWorkspacePath,
  enforceInvocationSecurity,
  resolveGitWorkspace,
  sanitizedEnvironment
} from "../plugins/grok-safe/mcp/security.mjs";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-safe-security-"));
  assert.equal(spawnSync("git", ["init"], { cwd: root }).status, 0);
  return fs.realpathSync(root);
}

test("workspace resolver requires and canonicalizes a Git repository", () => {
  const root = repo();
  fs.mkdirSync(path.join(root, "src"));
  assert.equal(resolveGitWorkspace(path.join(root, "src")), root);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "grok-safe-plain-"));
  assert.throws(() => resolveGitWorkspace(plain), /Git repository/);
});

test("path guard rejects traversal outside the workspace", () => {
  const root = repo();
  assert.doesNotThrow(() => assertWorkspacePath(root, "src/file.js", "file"));
  assert.throws(() => assertWorkspacePath(root, "../secret.txt", "file"), /inside/);
});

test("sensitive files and remote mutations require user approval", () => {
  const root = repo();
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=redacted\n");
  assert.throws(
    () => enforceInvocationSecurity("grok_rescue", {}, root),
    /Sensitive files detected/
  );
  assert.doesNotThrow(() =>
    enforceInvocationSecurity("grok_rescue", { sensitiveApproved: true }, root)
  );
  assert.throws(
    () => enforceInvocationSecurity("grok_review", { postPending: true }, root),
    /explicit user approval/
  );
});

test("environment sanitizer drops unrelated secrets", () => {
  const env = sanitizedEnvironment({
    Path: "bin",
    XAI_API_KEY: "needed-by-grok",
    AWS_SECRET_ACCESS_KEY: "drop-me",
    GH_TOKEN: "drop-me-too"
  });
  assert.equal(env.Path, "bin");
  assert.equal(env.XAI_API_KEY, "needed-by-grok");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GROK_SAFE_SUPERVISED, "1");
});
