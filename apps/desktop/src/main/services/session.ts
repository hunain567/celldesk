import type { SessionUser } from '@nexodesk/shared';

export const DEFAULT_AUTO_LOCK_MINUTES = 15;

/**
 * The signed-in user, kept only in the main process. Any request after the
 * idle limit finds the session ended, even if the screen never locked itself.
 */
export class SessionManager {
  private user: SessionUser | null = null;
  private lastActivity = 0;

  constructor(
    private readonly idleLimitMs: () => number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(user: SessionUser): void {
    this.user = user;
    this.lastActivity = this.now();
  }

  end(): void {
    this.user = null;
  }

  /** Current user, or null when nobody is signed in or the session went idle. Counts as activity. */
  current(): SessionUser | null {
    if (!this.user) return null;
    if (this.now() - this.lastActivity > this.idleLimitMs()) {
      this.user = null;
      return null;
    }
    this.lastActivity = this.now();
    return this.user;
  }

  replace(user: SessionUser | null): void {
    if (user) this.user = user;
    else this.end();
  }

  /** Name recorded in the audit log for actions taken now. */
  actor(): string {
    return this.user?.username ?? 'system';
  }
}
