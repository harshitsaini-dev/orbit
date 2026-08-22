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
