'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('paperDesktop',Object.freeze({
  saveScreenshot:()=>ipcRenderer.invoke('paper:save-screenshot')
}));
