import type { IpcErrorCode } from '@nexodesk/shared';

/**
 * An error whose message is safe to show to the user. Any other error reaching
 * the IPC boundary is logged and replaced with a generic message.
 */
export class AppError extends Error {
  constructor(readonly code: IpcErrorCode, message: string, readonly details?: string[]) {
    super(message);
    this.name = 'AppError';
  }
}
