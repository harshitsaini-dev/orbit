# Migrations

Written by hand, and **registered in `meta/_journal.json`**.

`drizzle-kit generate` stopped being usable after `0004`: it diffs the schema against the last
snapshot it wrote, and there are no snapshots past that one, so it now asks an interactive
question about every table it cannot match. That is why the files here are hand-written.

The part that is easy to get wrong, and did get got wrong once: **the journal is the migration
list.** `drizzle-kit migrate` reads it and nothing else. A `.sql` file sitting in this directory
with no entry in `meta/_journal.json` never runs — the deployed database simply does not have
the table, and nothing says so until a query fails.

So adding a migration is two steps:

1. `NNNN_short_name.sql`, with `--> statement-breakpoint` between statements.
2. An entry appended to `meta/_journal.json` with the next `idx` and a `tag` matching the
   filename without its extension.

The test database reads the journal too, for exactly this reason — a migration that would not
run on a real database must not silently work in the tests.

## Check the schema afterwards, not the message

`drizzle-kit migrate` prints "migrations applied successfully" whether or not it applied
anything to the database you meant. It did exactly that once: drizzle-kit reads a `.env` from
its own working directory — `packages/db`, where there is none — so `DATABASE_URL` was
undefined, `resolveDatabaseUrl` fell back to the local `orbit.db`, and the migration landed
there while production stayed a version behind. The command reported success both times.

`drizzle.config.ts` now loads the repo root `.env` explicitly, which fixes the cause. The habit
is still worth keeping: after migrating a deployed database, query it and confirm the thing you
added is actually there. A schema that looks migrated and is not becomes a 500 on the first
request that touches the new column.
