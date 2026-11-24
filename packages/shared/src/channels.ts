/**
 * Plain list of IPC channel names, kept free of runtime dependencies so the
 * sandboxed preload script can import it without bundling zod.
 * A unit test checks that this list matches `ipcContract` exactly.
 */
export const IPC_CHANNEL_NAMES = [
  'system:info',
  'system:integrityCheck',
  'settings:get',
  'settings:set',
  'audit:verify',
] as const;

/** The single Electron IPC channel used for all request/response calls. */
export const IPC_INVOKE_CHANNEL = 'celldesk:invoke';
