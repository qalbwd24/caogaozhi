'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('paperDesktop',Object.freeze({
  saveScreenshot:()=>ipcRenderer.invoke('paper:save-screenshot'),
  onColorStep:(callback)=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,direction)=>{
      if(direction===-1||direction===1)callback(direction);
    };
    ipcRenderer.on('paper:color-step',listener);
    return ()=>ipcRenderer.removeListener('paper:color-step',listener);
  }
}));
