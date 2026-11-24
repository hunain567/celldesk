import { contextBridge, ipcRenderer } from 'electron';
import { LM_CHANNEL_NAMES, LM_INVOKE } from '../shared/channels';

const allowed = new Set<string>(LM_CHANNEL_NAMES);

contextBridge.exposeInMainWorld(
  'licenseManager',
  Object.freeze({
    invoke(channel: string, input?: unknown): Promise<unknown> {
      if (typeof channel !== 'string' || !allowed.has(channel)) {
        return Promise.resolve({ ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } });
      }
      return ipcRenderer.invoke(LM_INVOKE, channel, input);
    },
  }),
);
