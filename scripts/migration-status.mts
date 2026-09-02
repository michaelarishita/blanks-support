/**
 * Prints what the database actually has — `npm run migrations`.
 *
 * This exists because a note asking people to check did not work. The claim
 * "migration NNNN needs running" was carried forward from memory three times
 * after it had been applied, and each time somebody was sent to the SQL editor
 * for nothing. A pointer that is sometimes wrong is worse than no pointer.
 *
 * So the check is one command with no ceremony, and the rule in CLAUDE.md is
 * that its OUTPUT must appear beside any statement about migration state.
 * "Did I paste the output?" is answerable by looking; "did I remember to
 * check?" is not.
 *
 * Reads the same `checkSchema` the in-app banner uses, so the command and the
 * banner cannot disagree.
 */
import fs from "node:fs";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq).trim();
  process.env[key] ||= trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
}

const { checkSchema } = await import("../lib/schema-check.ts");
const status = await checkSchema(true);

if (status.error) {
  // A failed check is not a clean bill of health, and must not read as one.
  console.log(`COULD NOT CHECK: ${status.error}`);
  process.exit(2);
}

const applied = status.checks.filter((c) => c.state === "applied").length;
console.log(`applied    : ${applied} of ${status.checks.length}`);
console.log(
  `MISSING    : ${status.missing.length ? status.missing.map((m) => m.file).join(", ") : "none"}`
);
console.log(
  `UNVERIFIED : ${status.unverified.length ? status.unverified.map((m) => m.file).join(", ") : "none"}`
);

for (const check of status.missing) {
  console.log(`  ! ${check.file} — missing ${check.missing}`);
}
for (const check of status.unverified) {
  console.log(`  ? ${check.file} — ${check.unverified}`);
}

// Non-zero when something is genuinely outstanding, so this can gate a script.
// `unverified` deliberately does NOT fail: "could not check" is not "missing".
process.exit(status.missing.length ? 1 : 0);
