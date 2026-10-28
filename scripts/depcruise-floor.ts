/**
 * A guard on the guard (§3, ADR 0001): dependency-cruiser passes vacuously
 * when it cannot parse TypeScript — with a TS major it does not support
 * installed, it cruises only the two .js files and reports no violations.
 * That happened for real on 2026-10-27 (Dependabot bumped typescript to 7).
 * So the depcruise step also asserts that a sane number of modules was
 * actually cruised; the floor is far below the true count (~150) and far
 * above the vacuous one (2).
 */

const FLOOR = 60;

const proc = Bun.spawnSync(
  [
    "bunx",
    "--bun",
    "depcruise",
    "packages",
    "adapters",
    "--config",
    ".dependency-cruiser.cjs",
    "--output-type",
    "json",
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const out = proc.stdout.toString();
let modules = -1;
try {
  modules = (JSON.parse(out) as { modules: unknown[] }).modules.length;
} catch {
  // fall through: -1 fails the floor below with the raw output in the message
}
if (modules < FLOOR) {
  console.error(
    `depcruise cruised ${modules} modules (floor ${FLOOR}) — the purity gate is vacuous.\n` +
      `Most likely the installed typescript major is one dependency-cruiser cannot parse (ADR 0001).\n` +
      `${proc.stderr.toString().trim()}`,
  );
  process.exit(1);
}
console.log(`depcruise cruised ${modules} modules (floor ${FLOOR}) — gate is live`);
