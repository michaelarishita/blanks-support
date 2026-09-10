/**
 * Prints every migration that lives on an unmerged branch but not on main —
 * `npm run migrations:pending`.
 *
 * Migrations are applied BY HAND from the Supabase SQL editor, but they are
 * written on feature branches, where the person doing the applying cannot open
 * them. That gap cost an hour once: 0023 existed only on afk/alert-kill-switch,
 * AND the branch's copy was broken (a now() index predicate that aborts the
 * paste), and neither fact was visible from main.
 *
 * This surfaces them: one command, the branch it lives on, and the full SQL,
 * ready to paste. If the same file exists on several branches with DIFFERENT
 * contents, that is flagged loudly — a divergent migration is the exact hazard
 * above, and the one worth catching before it reaches the SQL editor.
 *
 * The healthy state is "nothing pending": once a migration has landed on main
 * (the migrations-on-main-first rule in CLAUDE.md), it stops showing here.
 */
import { execSync } from "node:child_process";

function git(args: string[]): string {
  return execSync(`git ${args.map((a) => `'${a}'`).join(" ")}`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Best-effort refresh so the branch tips are current; never fatal offline.
try {
  git(["fetch", "origin", "--quiet"]);
} catch {
  console.warn("(could not fetch origin — reporting against local refs)\n");
}

const MIGRATIONS_DIR = "supabase/migrations";

function migrationFiles(ref: string): string[] {
  try {
    return git(["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_DIR])
      .split("\n")
      .filter((f) => f.endsWith(".sql"));
  } catch {
    return [];
  }
}

const onMain = new Set(migrationFiles("origin/main"));

const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
  .split("\n")
  .map((b) => b.trim())
  .filter((b) => b && b !== "origin/main" && b !== "origin/HEAD");

// file -> (contents -> branches that carry that exact version)
const pending = new Map<string, Map<string, string[]>>();

for (const branch of branches) {
  for (const file of migrationFiles(branch)) {
    if (onMain.has(file)) continue; // already canonical on main
    const contents = git(["show", `${branch}:${file}`]);
    const variants = pending.get(file) ?? new Map<string, string[]>();
    variants.set(contents, [...(variants.get(contents) ?? []), branch]);
    pending.set(file, variants);
  }
}

if (pending.size === 0) {
  console.log(
    "No pending migrations — every migration on an unmerged branch is already on main."
  );
  process.exit(0);
}

console.log(
  `${pending.size} migration file(s) exist on an unmerged branch but NOT on main.\n` +
    "Apply each in the SQL editor, then land the file on main.\n"
);

let divergent = false;
for (const file of [...pending.keys()].sort()) {
  const variants = pending.get(file)!;
  console.log("=".repeat(72));
  if (variants.size > 1) {
    divergent = true;
    console.log(`${file}  ⚠️  DIVERGENT — ${variants.size} different versions exist:`);
    for (const branchList of variants.values()) console.log(`    • ${branchList.join(", ")}`);
    console.log("Reconcile to one version before applying. Showing each:");
  } else {
    const [[, branchList]] = variants;
    console.log(`${file}  (on: ${branchList.join(", ")})`);
  }
  console.log("=".repeat(72));
  let i = 0;
  for (const [contents, branchList] of variants) {
    if (variants.size > 1) console.log(`\n----- version ${++i} (${branchList.join(", ")}) -----`);
    console.log(contents);
  }
}

// Non-zero only when a file DIVERGES across branches — that is the one state a
// person must act on. "Pending but consistent" is normal mid-flight and does
// not fail a script that might gate on this.
process.exit(divergent ? 1 : 0);
