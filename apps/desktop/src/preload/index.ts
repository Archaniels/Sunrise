import { contextBridge, ipcRenderer } from 'electron';
import { exposePhase2SunriseApi } from './expose-api.js';

exposePhase2SunriseApi(contextBridge, (channel: string, payload?: unknown) =>
  ipcRenderer.invoke(channel, payload),
);
