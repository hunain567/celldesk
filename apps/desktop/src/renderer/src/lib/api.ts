import type { NexoDeskBridge, IpcChannel, IpcError, IpcInput, IpcOutput } from '@nexodesk/shared';

declare global {
  interface Window {
    nexodesk: NexoDeskBridge;
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
/** Fired when the backend says the session has ended, so the app can show the sign-in screen. */
export const SESSION_ENDED_EVENT = 'nexodesk:session-ended';

export async function call<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>> {
  const result = await window.nexodesk.invoke(channel, input);
  if (!result.ok) {
    if (result.error.code === 'UNAUTHENTICATED') window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    throw new ApiError(result.error);
  }
  return result.data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
