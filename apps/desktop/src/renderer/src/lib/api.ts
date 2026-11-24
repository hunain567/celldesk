import type { CellDeskBridge, IpcChannel, IpcError, IpcInput, IpcOutput } from '@celldesk/shared';

declare global {
  interface Window {
    celldesk: CellDeskBridge;
  }
}

/** Error thrown by `call()` when the main process returns a failure result. */
export class ApiError extends Error {
  constructor(readonly error: IpcError) {
    super(error.message);
    this.name = 'ApiError';
  }
}

/**
 * Calls a main-process channel and returns its data, or throws ApiError with a
 * message that is safe to show to the user.
 */
export async function call<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>> {
  const result = await window.celldesk.invoke(channel, input);
  if (!result.ok) throw new ApiError(result.error);
  return result.data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
