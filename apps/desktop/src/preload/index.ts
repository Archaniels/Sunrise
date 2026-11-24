import { contextBridge, ipcRenderer } from 'electron';
import { exposeSunriseApi } from './expose-api.js';

exposeSunriseApi(contextBridge, (channel: string, payload?: unknown) =>
  ipcRenderer.invoke(channel, payload),
);
