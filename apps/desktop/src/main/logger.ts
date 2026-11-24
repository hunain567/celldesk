import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'info' | 'warn' | 'error';

const RETENTION_DAYS = 30;

/**
 * Small file logger for the main process. One file per day in the logs folder,
 * files older than 30 days are removed at start-up. Never logs keys or passwords.
 */
export class Logger {
  private directory: string | null = null;

  init(directory: string): void {
    mkdirSync(directory, { recursive: true });
    this.directory = directory;
    this.prune();
  }

  info(message: string, data?: unknown): void {
    this.write('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write('warn', message, data);
  }

  error(message: string, error?: unknown): void {
    this.write('error', message, error);
  }

  private write(level: Level, message: string, data?: unknown): void {
    const now = new Date();
    let suffix = '';
    if (data instanceof Error) {
      suffix = ` | ${data.name}: ${data.message}${data.stack ? `\n${data.stack}` : ''}`;
      if (data.cause) suffix += `\n  caused by: ${String(data.cause instanceof Error ? data.cause.stack : data.cause)}`;
    } else if (data !== undefined) {
      try {
        suffix = ` | ${JSON.stringify(data)}`;
      } catch {
        suffix = ' | [unserialisable data]';
      }
    }
    const line = `${now.toISOString()} [${level.toUpperCase()}] ${message}${suffix}\n`;
    if (level === 'error') console.error(line.trimEnd());
    else console.log(line.trimEnd());
    if (!this.directory) return;
    try {
      appendFileSync(join(this.directory, `main-${now.toISOString().slice(0, 10)}.log`), line, 'utf8');
    } catch {
      // Logging must never crash the app.
    }
  }

  private prune(): void {
    if (!this.directory) return;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(this.directory)) {
      if (!/^main-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const path = join(this.directory, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path);
      } catch {
        // Ignore files that disappear or are locked.
      }
    }
  }
}

export const logger = new Logger();
