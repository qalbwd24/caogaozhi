'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('paperDesktop',Object.freeze({
  preferChineseAtFirstEdit:()=>ipcRenderer.invoke('paper:initial-edit'),
  saveScreenshot:()=>ipcRenderer.invoke('paper:save-screenshot'),
  saveTouchpadProbe:(summary)=>ipcRenderer.invoke('paper:save-touchpad-probe',summary),
  queryImeModeRequest:()=>ipcRenderer.invoke('paper:ime-mode-requested'),
  probeShortcuts:()=>ipcRenderer.invoke('paper:probe-shortcuts'),
  onTouchpad:(callback)=>{
    if(typeof callback!=='function')return;
    ipcRenderer.on('paper:touchpad',(_event,dx,dy,zoom,x,y,ctrl)=>{
      if([dx,dy,zoom].every(Number.isFinite))callback(dx,dy,zoom,x,y,ctrl===true);
    });
  },
  onColorStep:(callback)=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,direction)=>{
      if(direction!==-1 && direction!==1)return;
      const result=callback(direction);
      if(result==='applied'||result==='blocked'||result==='no-edge')
        ipcRenderer.send('paper:shortcut-result',direction,result);
    };
    ipcRenderer.on('paper:color-step',listener);
    return ()=>ipcRenderer.removeListener('paper:color-step',listener);
  }
}));
