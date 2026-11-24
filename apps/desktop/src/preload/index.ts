import { IPC_CHANNEL_NAMES, IPC_INVOKE_CHANNEL } from '@nexodesk/shared/channels';
import { contextBridge, ipcRenderer } from 'electron';

const allowed = new Set<string>(IPC_CHANNEL_NAMES);

/**
 * The only API the renderer receives. It can call listed channels and nothing
 * else: no Node.js, no file system, no raw ipcRenderer.
 */
const bridge = Object.freeze({
  invoke(channel: string, input?: unknown): Promise<unknown> {
    if (typeof channel !== 'string' || !allowed.has(channel)) {
      return Promise.resolve({ ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } });
    }
    return ipcRenderer.invoke(IPC_INVOKE_CHANNEL, channel, input);
  },
});

contextBridge.exposeInMainWorld('nexodesk', bridge);
