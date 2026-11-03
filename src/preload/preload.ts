import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { VoiceApi } from '../shared/types';

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: VoiceApi = {
  getSnapshot: () => ipcRenderer.invoke('snapshot'),
  addFolder: (kind) => ipcRenderer.invoke('add-folder', kind),
  addPaths: (paths) => ipcRenderer.invoke('add-paths', paths),
  removeFolder: (id) => ipcRenderer.invoke('remove-folder', id),
  setFolderKind: (id, kind) => ipcRenderer.invoke('set-folder-kind', id, kind),
  rescan: () => ipcRenderer.invoke('rescan'),
  updateBookState: (id, patch) => ipcRenderer.invoke('update-book-state', id, patch),
  resetBook: (id) => ipcRenderer.invoke('reset-book', id),
  pickCover: (id) => ipcRenderer.invoke('pick-cover', id),
  clearCover: (id) => ipcRenderer.invoke('clear-cover', id),
  showInFolder: (id) => ipcRenderer.invoke('show-in-folder', id),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  reportNowPlaying: (info) => ipcRenderer.send('now-playing', info),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onLibraryChanged: (cb) => subscribe('library-changed', cb),
  onScanProgress: (cb) => subscribe('scan-progress', cb),
  onCommand: (cb) => subscribe('command', cb),
  onOpenBook: (cb) => subscribe('open-book', cb),
  onFlush: (cb) => subscribe('flush', cb),
};

contextBridge.exposeInMainWorld('voice', api);
