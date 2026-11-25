'use strict';
const {contextBridge,ipcRenderer}=require('electron');
let requestedChinese=false;
contextBridge.exposeInMainWorld('paperDesktop',Object.freeze({
  preferChineseAtFirstEdit:()=>{
    if(requestedChinese)return;
    requestedChinese=true;
    ipcRenderer.send('paper:initial-edit');
  },
  saveScreenshot:()=>ipcRenderer.invoke('paper:save-screenshot'),
  saveTouchpadProbe:(summary)=>ipcRenderer.invoke('paper:save-touchpad-probe',summary),
  probeShortcuts:()=>ipcRenderer.invoke('paper:probe-shortcuts'),
  onTouchpad:(callback)=>{
    if(typeof callback!=='function')return;
    ipcRenderer.on('paper:touchpad',(_event,dx,dy,zoom,x,y)=>{
      if([dx,dy,zoom].every(Number.isFinite))callback(dx,dy,zoom,x,y);
    });
  },
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
