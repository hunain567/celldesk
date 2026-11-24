import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * The License Manager reuses NexoDesk's database layer and design system
 * directly from the desktop app's source through these aliases.
 */
const desktopMain = resolve(__dirname, '../desktop/src/main');
const desktopUi = resolve(__dirname, '../desktop/src/renderer/src');

const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'license-manager-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`),
  };
}

export default defineConfig({
  main: {
    resolve: { alias: { '@desktop-main': desktopMain } },
    build: {
      externalizeDeps: { exclude: ['@nexodesk/licensing', 'zod'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') }, external: ['electron'] },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@ui': desktopUi } },
    plugins: [react(), contentSecurityPolicy()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
  },
});
