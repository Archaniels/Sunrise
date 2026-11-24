import { contextBridge, ipcRenderer } from 'electron';
import { exposePhase1SunriseApi } from './expose-api.js';

exposePhase1SunriseApi(contextBridge, (channel: string, payload?: unknown) =>
  ipcRenderer.invoke(channel, payload),
);
