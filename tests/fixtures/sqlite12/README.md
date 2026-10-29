# SQLite driver 12 upgrade fixtures

These synthetic fixtures exercise databases written with `better-sqlite3@12.11.1` (SQLite 3.53.2)
and opened with the current driver through `PersistentStore`. `provenance.json` records the driver,
SQLite version, schema, contents and file sizes. Their contents are dedicated to the public domain
under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). They contain no manuscript or
user data.

All databases use the production `editorial_state` schema, `user_version = 1`, `journal_mode = WAL`,
and `synchronous = FULL`. The initial row has namespace `upgrade`, ID `before`, and JSON value
`{"text":"Café — 東京 😀","revision":12}`.

- `baseline.sqlite` was checkpointed and closed normally with the old driver.
- `interrupted.sqlite` contains the same checkpointed initial state.
- `interrupted.sqlite-wal` adds a committed `upgrade` / `committed` row with value
  `{"checkpoint":true}` before the automatic checkpoint threshold was reached. The writer was
  terminated with SIGKILL after the synchronous commit without closing its connection. No
  shared-memory file is distributed; the current driver must reconstruct it and recover the
  committed WAL record.

To regenerate, use a disposable Node environment with exactly `better-sqlite3@12.11.1`, create the
table below, set the pragmas above, and insert the initial row through bound parameters. Run
`PRAGMA wal_checkpoint(TRUNCATE)`. For the baseline, close the connection. For the interrupted
fixture, set `PRAGMA wal_autocheckpoint = 0`, insert the committed row, and terminate that writer
without closing its database. Copy its database and WAL together, excluding the rebuildable `-shm`
file. Never generate these fixtures with the new driver.

```sql
CREATE TABLE editorial_state (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(namespace, id)
);
```

The integration test copies every file to a temporary directory before opening it. It proves that
the additional row exists only in the WAL, verifies Unicode, schema and integrity after reopening,
exercises nested savepoint and outer rollback boundaries, and checks competing claims from
independent processes. It does not establish network-filesystem safety or native Scrivener behavior.

Sources: [version 12.11.1](https://github.com/WiseLibs/better-sqlite3/tree/v12.11.1),
[transaction behavior](https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/api.md#transactionfunction---function),
[SQLite WAL recovery](https://www.sqlite.org/wal.html).
