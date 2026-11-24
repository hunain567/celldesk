import { BrowserWindow, nativeTheme, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface WindowOptions {
  devServerUrl: string | undefined;
  isPackaged: boolean;
}

/** URL prefix every trusted page must start with. IPC from anything else is refused. */
export function trustedOrigin(options: WindowOptions): string {
  if (options.devServerUrl) return new URL(options.devServerUrl).origin;
  return pathToFileURL(join(__dirname, '../renderer/')).href;
}

export function isTrustedUrl(url: string, options: WindowOptions): boolean {
  const origin = trustedOrigin(options);
  return options.devServerUrl ? new URL(url).origin === origin : url.startsWith(origin);
}

/** Locks down the default session: no permissions (camera, notifications, etc.) are ever granted. */
export function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'NexoDesk',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1218' : '#f6f7f9',
    autoHideMenuBar: true,
    // Packaged builds take the icon from the signed .exe; development runs need it set here.
    ...(options.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !options.isPackaged,
    },
  });

  window.once('ready-to-show', () => window.show());

  // The app never navigates away from its own pages or opens new windows.
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url, options)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
}
