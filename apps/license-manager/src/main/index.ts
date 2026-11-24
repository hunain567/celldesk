import { LicenseCodeError, REQUEST_EXTENSION } from '@nexodesk/licensing';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotDatabase, type SqliteDatabase } from '@desktop-main/db/connection';
import { Logger } from '@desktop-main/logger';
import { LM_INVOKE } from '../shared/channels';
import { LicenseRegistry, RegistryError } from './registry';
import { LmRouter, UserError } from './router';
import { createVault, MIN_MASTER_PASSWORD, unlockVault, vaultExists, VaultError, vaultPaths } from './vault';

app.setName('NexoDesk License Manager');
app.setAppUserModelId('com.nexoerp.nexodesk.licensemanager');
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

const logger = new Logger();
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const paths = vaultPaths(join(app.getPath('userData'), 'vault'));

/** Failed unlock attempts make the next attempt wait, to slow down guessing. */
let failedUnlocks = 0;
let lockedUntil = 0;

let db: SqliteDatabase | null = null;
let registry: LicenseRegistry | null = null;
let window: BrowserWindow | null = null;

function requireRegistry(): LicenseRegistry {
  if (!registry) throw new UserError('Unlock the License Manager first.');
  return registry;
}

function openSession(database: SqliteDatabase): void {
  db = database;
  registry = new LicenseRegistry(database);
}

function closeSession(): void {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (error) {
      logger.error('Closing the License Manager database failed', error);
    }
  }
  db = null;
  registry = null;
}

function isTrusted(url: string): boolean {
  if (devServerUrl) return new URL(url).origin === new URL(devServerUrl).origin;
  return url.startsWith(pathToFileURL(join(__dirname, '../renderer/')).href);
}

function userMessage(error: unknown): string | null {
  if (error instanceof UserError || error instanceof RegistryError || error instanceof VaultError || error instanceof LicenseCodeError) {
    return error.message;
  }
  return null;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function registerHandlers(router: LmRouter): void {
  router.register('vault:state', () => ({ exists: vaultExists(paths), unlocked: registry !== null }));

  router.register('vault:create', ({ password }) => {
    if (vaultExists(paths)) throw new UserError('The License Manager is already set up. Unlock it instead.');
    if (password.length < MIN_MASTER_PASSWORD) {
      throw new UserError(`The master password must have at least ${MIN_MASTER_PASSWORD} characters.`);
    }
    openSession(createVault(paths, password, { appVersion: app.getVersion() }));
    logger.info('License Manager vault created');
    return null;
  });

  router.register('vault:unlock', ({ password }) => {
    const wait = lockedUntil - Date.now();
    if (wait > 0) throw new UserError(`Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    try {
      openSession(unlockVault(paths, password, { appVersion: app.getVersion() }));
      failedUnlocks = 0;
      return null;
    } catch (error) {
      if (error instanceof VaultError) {
        failedUnlocks += 1;
        if (failedUnlocks >= 5) lockedUntil = Date.now() + 30_000 * (failedUnlocks - 4);
      }
      throw error;
    }
  });

  router.register('vault:lock', () => {
    closeSession();
    return null;
  });

  router.register('lm:dashboard', () => requireRegistry().dashboard());
  router.register('lm:licenses', () => requireRegistry().list());
  router.register('lm:license', ({ id }) => requireRegistry().detail(id));
  router.register('lm:createLicense', (input) => ({ id: requireRegistry().createLicense(input) }));
  router.register('lm:extend', ({ id, plan, customUntil }) => {
    requireRegistry().extend(id, plan, customUntil);
    return null;
  });
  router.register('lm:setStatus', ({ id, status }) => {
    requireRegistry().setStatus(id, status);
    return null;
  });

  router.register('lm:openRequestFile', async () => {
    requireRegistry();
    const options = {
      title: 'Open activation request',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'NexoDesk activation request', extensions: ['ndreq'] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const path = result.canceled ? null : result.filePaths[0];
    if (!path) return null;
    if (!path.toLowerCase().endsWith(REQUEST_EXTENSION) || statSync(path).size > 64 * 1024) {
      throw new UserError(`Choose a NexoDesk activation request (${REQUEST_EXTENSION}).`);
    }
    return { code: readFileSync(path, 'utf8').trim() };
  });

  router.register('lm:previewRequest', ({ code }) => requireRegistry().previewRequest(code));
  router.register('lm:issueForRequest', ({ licenseId, code }) => requireRegistry().issueForRequest(licenseId, code));
  router.register('lm:issueForDevice', ({ licenseId, deviceRowId }) => requireRegistry().issueForDevice(licenseId, deviceRowId));
  router.register('lm:removeDevice', ({ deviceRowId }) => {
    requireRegistry().removeDevice(deviceRowId);
    return null;
  });

  router.register('lm:saveLicenseFile', async ({ code, fileName }) => {
    requireRegistry();
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, '-');
    const options = {
      title: 'Save licence file',
      defaultPath: join(app.getPath('desktop'), safeName),
      filters: [{ name: 'NexoDesk licence', extensions: ['ndlic'] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { path: null };
    writeFileSync(result.filePath, code, 'utf8');
    return { path: result.filePath };
  });

  router.register('lm:settings', () => {
    const current = requireRegistry();
    return {
      publicKeyPem: current.publicKeyPem(),
      revokedLicenseIds: current.revokedIds(),
      lastBackupAt: current.lastBackupAt(),
      dataDirectory: paths.directory,
    };
  });

  router.register('lm:backup', async () => {
    const current = requireRegistry();
    if (!db) throw new UserError('Unlock the License Manager first.');
    const options = { title: 'Choose where to save the License Manager backup', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = result.canceled ? null : result.filePaths[0];
    if (!folder) return { path: null };
    const target = join(folder, `NexoDesk License Manager Backup ${stamp()} ${Date.now().toString().slice(-6)}`);
    mkdirSync(target, { recursive: true });
    // Encrypted copy of the database plus the vault file needed to open it with the master password.
    snapshotDatabase(db, join(target, 'license-manager.db'));
    copyFileSync(paths.vaultFile, join(target, 'vault.json'));
    writeFileSync(
      join(target, 'README.txt'),
      'NexoDesk License Manager backup.\r\n\r\nTo restore: close License Manager, then copy license-manager.db and vault.json into\r\n' +
        `${paths.directory}\r\nThe same master password opens it. Without the master password this backup cannot be opened.\r\n`,
    );
    current.recordBackup(new Date());
    return { path: target };
  });
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'NexoDesk License Manager',
    autoHideMenuBar: true,
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  created.once('ready-to-show', () => created.show());
  created.webContents.on('will-navigate', (event, url) => {
    if (!isTrusted(url)) event.preventDefault();
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (devServerUrl) void created.loadURL(devServerUrl);
  else void created.loadFile(join(__dirname, '../renderer/index.html'));
  return created;
}

app.whenReady().then(() => {
  logger.init(join(app.getPath('userData'), 'logs'));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const router = new LmRouter((message, error) => logger.error(message, error), userMessage);
  registerHandlers(router);
  ipcMain.handle(LM_INVOKE, (event, channel: unknown, input: unknown) => {
    if (!isTrusted(event.senderFrame?.url ?? '')) return { ok: false, error: { code: 'FORBIDDEN', message: 'Request refused' } };
    return router.dispatch(channel, input);
  });
  window = createWindow();
  // Copy-paste of licence codes needs the clipboard; nothing else is granted.
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => closeSession());
