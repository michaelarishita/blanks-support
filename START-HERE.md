# Blanks Support — how to open this project

## Open Claude Code (the builder)

Open the **Terminal** app, then:

```bash
cd ~/Projects/blanks-support
claude
```

That's it. Claude Code reads `CLAUDE.md` automatically, so it already knows
the architecture, the roadmap, and every gotcha we've hit.

If a session gets long and it suggests `/clear`, take it — but push your
commits first. Then reopen with a one-line pointer, e.g.
"Read CLAUDE.md and DROP-5-DEPLOY-AND-META.md. Continue at A1."

## Run the app locally (the dev server)

Open a **second** Terminal window (⌘N) — one for Claude Code, one for the
server:

```bash
cd ~/Projects/blanks-support
npm run dev
```

Leave it running. Stop it with **Ctrl+C**.

- Dashboard: http://localhost:3000
- Customer form: http://localhost:3000/widget

**Restart the dev server whenever** `.env.local` changes, or after
migrations, or if the UI shows a stale/hydration error. Ctrl+C, then
`npm run dev` again. This fixes more weirdness than anything else.

## The other places things live

| What | Where |
|---|---|
| Database, users, SQL Editor | supabase.com → `blanks-support` project |
| Hosting, env vars, logs | vercel.com → `blanks-support` project |
| Code history | github.com/michaelarishita/blanks-support |
| Gmail API + OAuth client | console.cloud.google.com → `blanks-support` |
| Domain DNS | godaddy.com → blankssportsnutrition.com |
| Team email accounts | admin.google.com → Directory → Users |

## Commands worth knowing

```bash
npm run dev      # start the local site
npm run build    # production build (must pass before committing)
npm test         # the test suite
git push         # send commits to GitHub (and trigger a Vercel deploy)
```

If git complains about a lock file (a quirk from the Cowork folder bridge):

```bash
rm -f .git/*.lock .git/objects/maintenance.lock
```

## Running a database migration

New `.sql` files land in `supabase/migrations/`. To apply one: open the
file, copy everything, go to Supabase → **SQL Editor** → **New query** →
paste → **Run**. Then restart the dev server.

The dashboard shows a banner if a migration hasn't been run — trust it.

## Two values never to change

- `TOKEN_ENCRYPTION_KEY` — must be identical locally and in Vercel.
  Regenerating it makes every connected Gmail account undecryptable.
- `SUPPORT_EMAIL` — currently `hello@blankssportsnutrition.com`. The
  `support@` address is still routing to the old setup during the
  parallel run.
