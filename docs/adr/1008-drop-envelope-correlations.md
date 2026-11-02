# ADR 1008 — drop the `envelope_correlations` table

Status: Proposed

## Context

ADR 1007 deleted the acceptor, the only writer of `envelope_correlations`. The table held 0 rows in the production census of 2026-10-30, and the owner approved the drop that day. It stays in the schema for one release so a rollback to a pre-1007 revision still finds it.

## Decision

Once a release after ADR 1007 is live with no rollback pending, a forward migration drops the table on Postgres and SQLite, and the storage methods that read and write it are deleted, along with the cascade deletes that name it.

## Alternatives

- Drop it with ADR 1007. Rejected: the table is cheap to keep and a rollback would fail against a missing table.
- Keep it. Rejected: nothing writes it.

## Plan

1. Re-measure the row count in production; a non-zero count stops the work.
2. Add the migrations, and delete the storage methods and cascade entries.
