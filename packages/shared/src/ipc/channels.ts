export const IPC_CHANNELS = {
  APP_VERSION: 'app:version',
  APP_HEALTH: 'app:health',
  WINDOW_GET_STATE: 'window:getState',
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
} as const;

export type IpcChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const PRELOAD_EXPOSED_KEYS = ['app', 'window', 'shell'] as const;

export const FORBIDDEN_PRELOAD_KEYS = [
  'ipcRenderer',
  'require',
  'process',
  'Buffer',
  'fs',
  'child_process',
  'electron',
] as const;
