# NexoDesk by NexoERP

Offline shop management and POS for mobile phone and electronics retailers, packaged as a Windows desktop app.

Architecture and roadmap: see `docs/architecture.md`.

## Requirements (development PC)

- Windows 10 or 11, 64-bit
- Node.js 22 or newer
- pnpm 10 (`npm install -g pnpm`)
- Git

No Visual Studio or C++ build tools are needed: the SQLite engine ships prebuilt.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies and download the Electron runtime |
| `pnpm dev` | Run the app with hot reload |
| `pnpm test` | Run all automated tests |
| `pnpm typecheck` | TypeScript checks for every package |
| `pnpm build` | Production build into `apps/desktop/out` |
| `pnpm dist:win` | Build the Windows installer into `apps/desktop/release` |

During development the data folder can be redirected so real shop data is never touched:

```powershell
$env:NEXODESK_DATA_DIR = "D:\nexodesk-dev-data"; pnpm dev
```

Packaged builds always use `%APPDATA%\NexoDesk`.

## Repository layout

```
apps/desktop/        Electron app: main process, preload bridge, React renderer
  src/main/          Backend: database, migrations, services, IPC
  src/preload/       The only bridge between UI and backend (allow-listed channels)
  src/renderer/      React UI and design system
  test/              Automated tests (Vitest)
packages/shared/     IPC contract (zod), money helpers, shared types
docs/                Architecture and decisions
```

## Data on the shop PC

| Path under `%APPDATA%\NexoDesk` | Contents |
| --- | --- |
| `data\nexodesk.db` | Business database, encrypted (SQLCipher v4) |
| `keys\database.key` | Database key, protected by Windows DPAPI |
| `safety\` | Verified copies taken before database upgrades |
| `logs\` | Daily log files, kept 30 days |

The uninstaller never deletes this folder.
