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
  'backup:status',
  'backup:chooseFolder',
  'backup:setup',
  'backup:addDestination',
  'backup:removeDestination',
  'backup:setSchedule',
  'backup:runNow',
  'backup:history',
  'restore:chooseFile',
  'restore:inspect',
  'restore:verify',
  'restore:start',
  'restore:lastOutcome',
  'license:status',
  'license:requestCode',
  'license:saveRequestFile',
  'license:importFile',
  'license:importCode',
] as const;

/** The single Electron IPC channel used for all request/response calls. */
export const IPC_INVOKE_CHANNEL = 'nexodesk:invoke';

/** The single Electron channel the main process uses to push events to the screen. */
export const IPC_EVENT_CHANNEL = 'nexodesk:event';
