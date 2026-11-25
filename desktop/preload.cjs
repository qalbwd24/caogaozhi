'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('paperDesktop',Object.freeze({
  saveScreenshot:()=>ipcRenderer.invoke('paper:save-screenshot'),
  loadWallpaper:()=>ipcRenderer.invoke('paper:local-wallpaper'),
  onTools:(callback)=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=()=>callback();
    ipcRenderer.on('paper:tools',listener);
    return ()=>ipcRenderer.removeListener('paper:tools',listener);
  },
  onColorStep:(callback)=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,direction)=>{
      if(direction===-1||direction===1)callback(direction);
    };
    ipcRenderer.on('paper:color-step',listener);
    return ()=>ipcRenderer.removeListener('paper:color-step',listener);
  }
}));
