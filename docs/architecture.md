# CellDesk architecture

The full audit and architecture plan is kept in the project document
"CellDesk — Project Audit & Architecture Plan" (https://claude.ai/artifact/WsCTst5BtCKhoM296BViN4).
This file records what is implemented and the decisions code depends on.

## Decisions (24 Nov 2026)

- Windows desktop only, fully offline. No ERPNext, no cloud sync in Phase 1.
- Product name: CellDesk by NexoERP.
- Licensing: no online server. A private CellDesk License Manager on the owner's laptop signs device-bound
  licence files (`.cdlic`, Ed25519). Shops receive renewals by USB or WhatsApp.
- Money is stored as integer paisa. Posted documents are never edited, only reversed.

## Process model

- **Main process** is the backend: database, business rules, backups, licence checks.
- **Preload** exposes one function, `window.celldesk.invoke(channel, input)`, for channels in
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

## Milestones

| Milestone | Status |
| --- | --- |
| M0 Foundation | Done: secure shell, encrypted DB, migrations, audit log, IPC contract, design tokens, System screen, installer config |
| M1 Backup and Restore | Next |
| M2 Licensing | Planned |
| M3–M8 | Planned |
