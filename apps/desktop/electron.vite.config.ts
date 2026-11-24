import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Strict Content Security Policy for the packaged app. Only local scripts,
 * styles and fonts may load; nothing from the network. The dev server needs
 * inline scripts for hot reload, so the policy is added to production builds only.
 */
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
    name: 'nexodesk-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`),
  };
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@nexodesk/shared', '@nexodesk/licensing', 'zod'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      // A sandboxed preload must be one self-contained file.
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), contentSecurityPolicy()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
