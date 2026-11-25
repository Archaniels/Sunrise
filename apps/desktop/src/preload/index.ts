import { contextBridge, ipcRenderer } from 'electron';
import { exposePhase2SunriseApi } from './expose-api.js';

exposePhase2SunriseApi(
  contextBridge,
  (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload),
  (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
);
