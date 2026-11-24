# Working rules for this repository

- Everything inside the code and the app is in English: UI labels, messages, comments, docs.
- Read `docs/architecture.md` before changing structure. Do not rewrite working modules unnecessarily.
- No placeholder buttons or fake functionality. Navigation lists only screens that exist.
- Money is integer paisa. Never use floating point for amounts.
- Database changes only through a new numbered migration; never edit a released migration.
- The renderer never gets Node.js access. New backend features are new channels in
  `packages/shared/src/ipc.ts` and `channels.ts` (the test suite checks they match).
- Backup, restore and licensing changes must come with automated tests.
- Run `pnpm test` and `pnpm typecheck` before every commit.
- Commits use the owner's identity only (Hunain <engr.hunainraza@gmail.com>), with no co-author or
  session attribution lines.
