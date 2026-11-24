# NexoDesk architecture

The full audit and architecture plan is kept in the project document
"NexoDesk — Project Audit & Architecture Plan" (https://claude.ai/artifact/WsCTst5BtCKhoM296BViN4).
This file records what is implemented and the decisions code depends on.

## Decisions (24 Nov 2026)

- Windows desktop only, fully offline. No ERPNext, no cloud sync in Phase 1.
- Product name: NexoDesk by NexoERP.
- Licensing: no online server. A private NexoDesk License Manager on the owner's laptop signs device-bound
  licence files (`.ndlic`, Ed25519). Shops receive renewals by USB or WhatsApp.
- Money is stored as integer paisa. Posted documents are never edited, only reversed.

## Process model

- **Main process** is the backend: database, business rules, backups, licence checks.
- **Preload** exposes one function, `window.nexodesk.invoke(channel, input)`, for channels in
  `packages/shared/src/channels.ts` only.
- **Renderer** is sandboxed, has no Node.js access, and runs under a strict Content Security Policy in
  production builds.
- Every IPC request is checked by `IpcRouter`: the sender page must be the app's own, the channel must
  exist in the contract and the input must pass its zod schema. Unexpected errors are logged and the
  renderer receives a generic message.

## Database

- SQLite via `better-sqlite3-multiple-ciphers`, SQLCipher v4 format, WAL journal, `synchronous=FULL`.
- The 256-bit key is generated on first run and stored with Windows DPAPI (Electron `safeStorage`).
  If the database exists but the key file does not, the app refuses to create a new key.
- Migrations live in `apps/desktop/src/main/db/migrations`, numbered from 1 without gaps. All pending
  migrations run in one transaction. Before upgrading an existing database the app writes an encrypted
  snapshot (`VACUUM INTO`) to `safety\`, verifies it opens and passes `integrity_check`, and only then
  migrates. A database newer than the app is never written to.
- `audit_log` is append-only (triggers refuse UPDATE and DELETE) and hash-chained, so edits made by
  bypassing the triggers are detected by `AuditLog.verify()`.

## Backup and restore (`apps/desktop/src/main/backup`)

**File format `.ndbak` (format 1)**: magic `NDBAK1\n`, header length, plain JSON header (date, app and schema
version, install id, kind, key id, recovery-wrapped key), then AES-256-GCM over gzip(manifest + database
snapshot), then the 16-byte tag. Magic, length and header are authenticated as additional data. The
manifest holds the snapshot's SHA-256, size, table row counts and the database key, so a backup opens on
any PC that has the backup key. (gzip is used instead of the zstd mentioned in the plan: it is built into
Node.js and needs no native module.)

**Keys**: a random 256-bit backup key lives in `backup_config` inside the encrypted database. A copy
wrapped with the owner's recovery password (scrypt N=2^17, r=8, p=1 + AES-256-GCM) is stored in the
config and in every backup header. Same-PC restores need no password; other PCs need the recovery password.

**Backup run** (`BackupService.run`):
1. `VACUUM INTO` an encrypted snapshot in `tmp\`, run `integrity_check` + `foreign_key_check`, hash it.
2. For each enabled location (max 3): check folder, write-probe and free space (2x snapshot size).
3. Write `<location>\NexoDesk Backups\<install>\NexoDesk_<date>_<kind>.ndbak.partial` (`wx`), fsync.
4. Read the file back, decrypt, decompress and compare with the snapshot hash; only then rename to `.ndbak`.
5. Record per-location results in `backup_files` and the run in `backup_runs`; a line goes to
   `logs\backup-journal.jsonl`. Result is `success`, `partial` or `failed` — never success unless every
   location verified.
6. Apply retention: 14 daily, 8 weekly, 12 monthly scheduled backups; safety backups 90 days; manual
   backups never; the newest verified backup never.

**Schedule**: off / daily / weekly / monthly at a local time. The main process checks every minute,
first 2 minutes after start-up. A slot missed while the PC was off runs at the next check; a failed
scheduled run is retried after 30 minutes. Runs left `running` by a crash are marked failed at start-up.

**Restore** (`RestoreService` + `swap.ts`):
1. Inspect header (no key needed) and check compatibility: newer schema is refused.
2. Decrypt the whole file into `restore\staging.db`, verify hash and integrity.
3. Re-encrypt (`PRAGMA rekey`) with this PC's database key, run migrations, check again.
4. Verified safety copy of the live database to `safety\`, plus a `pre-restore` backup to the backup
   locations when they are available.
5. Write `restore\restore-journal.json` (`prepared`), close the database, move live to
   `nexodesk.db.pre-restore-<time>` and staging to live (journal `swapped`), restart the app.
6. At every start, before opening the database: a `prepared` journal is rolled back; a `swapped` journal
   is completed if the new database opens and passes `integrity_check`, otherwise the original is put back.

Paths for backup locations and restore files are accepted from the screen only if the user picked them
in a native dialog in the same session (`PathGrants`).

## Milestones

| Milestone | Status |
| --- | --- |
| M0 Foundation | Done: secure shell, encrypted DB, migrations, audit log, IPC contract, design tokens, System screen, installer config |
| M1 Backup and Restore | Done: engine, schedule, retention, Restore Center, crash-safe swap, 36 backup/restore tests |
| M2 Licensing | Next |
| M3–M8 | Planned |
