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

## Licensing (`packages/licensing`, `apps/desktop/src/main/licensing`, `apps/license-manager`)

No server. NexoERP issues signed, device-bound licence files from the private **License Manager** app.

**Documents** (text, also saved as files): activation request `NDREQ1.…` (`.ndreq`) signed by the shop
computer's device key; licence `NDLIC1.…` (`.ndlic`) signed by the NexoERP vendor key (Ed25519). The
signed bytes are the base64url payload, so any edit breaks the signature.

**Shop computer**
- Device id = SHA-256 of Windows MachineGuid + motherboard serial (drive serial left out so an SSD swap
  keeps the licence). Device key pair: Ed25519, private key sealed with DPAPI in `keys\device.key`.
- A licence must match both the device id and the device public key. Copying files to another PC fails;
  a reinstall that removed the device key needs a new file (License Manager keeps the same slot).
- Vendor public key is compiled in (`src/main/licensing/vendor-key.ts`). `pnpm dist:win` refuses to build
  while it is empty.
- States: unlicensed, invalid, clock-problem, active, expiring (7 days), grace (licence `graceDays`),
  expired (read-only), revoked (id in `packages/licensing/src/revoked.ts`). Backups and restore always work.
- `LicenseService.assertCanWrite()` must be called by every service that creates business records.
- Clock rollback: the newest time seen is kept in the encrypted database, a DPAPI-sealed file and the
  registry (`HKCU\Software\NexoERP\NexoDesk`). A clock more than 10 minutes behind it, or behind the
  licence issue time, is a clock problem (read-only) until corrected. A licence issued in the last 2 days
  resets the mark, which clears a clock that was once set far ahead by mistake.

**License Manager** (owner's laptop only)
- Data in `%APPDATA%\NexoDesk License Manager\vault\`: SQLCipher database keyed by scrypt(master password)
  and `vault.json` (salt). No password recovery. Vendor key pair generated on first run, stored inside.
- Licences (monthly, 6 months, yearly, custom), device limit, grace days; activate from a request,
  renewal files for registered computers, extend, suspend, revoke, remove computer, activation history.
- Backup writes an encrypted copy plus `vault.json` to a chosen folder; reminder after 7 days.
- Limits of offline licensing: suspension and device removal take effect when the current file expires;
  revocation when the shop installs a release that lists the id.

## Users, roles and setup

- First run shows the setup wizard: **new shop** (shop details, owner account, backups, licence; the last
  two can be skipped) or **restore from a backup** (allowed without sign-in only until setup is complete).
- Accounts in `users`; passwords and PINs hashed with scrypt (N=2^15, built into Node.js, so no extra
  native module). Owner-created accounts must choose their own password at first sign-in; a PIN only
  works after that.
- 5 wrong attempts lock an account for 5 minutes; an owner password reset also unlocks it. The shop
  always keeps at least one active owner.
- Roles and permissions are defined in `packages/shared/src/auth.ts`. Every IPC channel has an access
  rule in `apps/desktop/src/main/ipc/access.ts` (public, setup-only, signed-in, or a permission); a test
  fails if a channel has no rule. The screen hides what a role cannot use, and the backend refuses it anyway.
- The session lives only in the main process and ends after the shop's auto-lock time without requests
  (default 15 minutes); the screen also locks itself on inactivity.
- The audit log records the signed-in username for every action.

## Milestones

| Milestone | Status |
| --- | --- |
| M0 Foundation | Done: secure shell, encrypted DB, migrations, audit log, IPC contract, design tokens, System screen, installer config |
| M1 Backup and Restore | Done: engine, schedule, retention, Restore Center, crash-safe swap, 36 backup/restore tests |
| M2 Licensing | Done: signed device-bound licences, clock guard, Licence screen, License Manager app |
| M3 Users and setup | Done: setup wizard, sign-in with password or PIN, roles, Users and Shop screens, auto-lock |
| M4 Inventory and Purchases | Next |
| M5–M8 | Planned |
