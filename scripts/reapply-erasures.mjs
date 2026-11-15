/**
 * Re-run completed erasures (e.g. after a database restore).
 *
 *   node scripts/reapply-erasures.mjs [--dry-run]
 *
 * Idempotent. Prints counts only — no personal data.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const runner = resolve(root, "scripts/_reapply-erasures-run.mts");
const args = ["--yes", "tsx", runner];
if (dryRun) args.push("--dry-run");

const result = spawnSync("npx", args, {
  cwd: root,
  encoding: "utf8",
  shell: true,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
