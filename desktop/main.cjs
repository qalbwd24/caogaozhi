'use strict';
const {app, BrowserWindow, Menu, session, dialog, ipcMain, screen}=require('electron');
const path=require('node:path');
const {attachWindowsTouchpad}=require('./windows-touchpad.cjs');
const {pathToFileURL}=require('node:url');
const {writeFile}=require('node:fs/promises');

app.setName('草稿纸');
app.setPath('userData',path.join(app.getPath('appData'),'Caogaozhi'));
if(process.platform==='win32') app.setAppUserModelId('com.caogaozhi.scratchpad');
let mainWindow, saving=false, keyProbe=null, startupPinyin=false;
const paper=path.join(__dirname,'dist','index.html');
const paperURL=pathToFileURL(paper).href;

async function saveScreenshot(win){
  if(!win||win.isDestroyed()||saving)return false;
  saving=true;
  try {
    const png=(await win.webContents.capturePage()).toPNG();
    if(!png.length)throw Error('没有取得窗口图像。');
    const stamp=new Date().toISOString().slice(0,16).replace(/[T:]/g,'-');
    const result=await dialog.showSaveDialog(win,{
      title:'保存草稿纸截图',
      defaultPath:path.join(app.getPath('pictures'),'草稿纸-'+stamp+'.png'),
      filters:[{name:'PNG 图片',extensions:['png']}]
    });
    if(result.canceled||!result.filePath)return false;
    await writeFile(result.filePath,png);
    return true;
  } catch(error) {
    dialog.showErrorBox('未能保存截图',error.message);
    return false;
  } finally { saving=false; }
}

function shortcutName(key,code) {
  const value=[String(key || '').toUpperCase(),String(code || '').toUpperCase()];
  return value.find(k => k==='F17'||k==='F18');
}
function noteShortcut(name,input,dispatched=false) {
  if (!name || !keyProbe) return;
  const row=keyProbe[name];
  if(dispatched) {row.used++; return;}
  if(input.type==='keyUp') row.up++;
  if(input.type==='keyDown') {
    row.down++;
    if(input.isAutoRepeat)row.repeat++;
    if(input.isComposing)row.composing++;
    if(input.alt||input.control||input.meta)row.modifier++;
  }
}

function prepareChinese(win,chooseProfile) {
  if(process.platform!=='win32'||process.arch!=='x64'||!win||win.isDestroyed()||!win.isFocused())return false;
  try {
    const input=require('./touchpad-win32-x64.node'), handle=win.getNativeWindowHandle();
    const selected=chooseProfile ? input.selectPinyin?.(handle)===true : false;
    input.preferChinese?.(handle);
    return selected;
  } catch { return false; }
}

function openPaper(){
  if(mainWindow) return;
  mainWindow=new BrowserWindow({
    title:'草稿纸', width:1120,height:770, minWidth:580,minHeight:475,
    show:false, backgroundColor:'#f7e3c5',icon:path.join(__dirname,'icon.png'),
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false,preload:path.join(__dirname,'preload.cjs')}
  });
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,navigationURL)=>{
    const url=typeof navigationURL==='string'?navigationURL:navigationURL?.url;
    if(!url||url.split('?')[0]!==paperURL)event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event',(event,input)=>{
    const fn=shortcutName(input.key,input.code);
    noteShortcut(fn,input);
    if(input.type!=='keyDown'||input.alt)return;
    const key=String(input.key||'').toLowerCase();
    const code=String(input.code||'').toLowerCase();
    if(!input.isComposing&&input.shift&&(input.control||input.meta)&&key==='s'){
      event.preventDefault();
      void saveScreenshot(mainWindow);
      return;
    }
    // Handle the remapped function keys before Chromium can turn them into a
    // second DOM keydown. The renderer also handles keys in browser previews.
    const direction=key==='f17'||code==='f17'?-1:key==='f18'||code==='f18'?1:0;
    if(direction){
      event.preventDefault();
      if(!input.isAutoRepeat){noteShortcut(fn,input,true);mainWindow.webContents.send('paper:color-step',direction);}
      return;
    }
  });
  attachWindowsTouchpad(mainWindow,screen);
  mainWindow.once('focus',()=>{ startupPinyin=prepareChinese(mainWindow,true); });
  mainWindow.once('ready-to-show',()=>mainWindow?.show());
  mainWindow.on('closed',()=>{mainWindow=null;});
  mainWindow.loadFile(paper,{query:{desktop:'1'}}).catch((error)=>{
    dialog.showErrorBox('无法打开草稿纸','请完整解压后从原目录启动“草稿纸.exe”。\n\n'+error.message);
    app.quit();
  });
}

if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.focus();}});
  app.whenReady().then(()=>{
    Menu.setApplicationMenu(null);
    ipcMain.handle('paper:probe-shortcuts',async event=>{
      const w=mainWindow;
      if(keyProbe || !w || event.sender!==w.webContents ||
         event.senderFrame!==w.webContents.mainFrame || event.senderFrame?.url.split('?')[0]!==paperURL) return null;
      const probe={F17:{down:0,up:0,repeat:0,composing:0,modifier:0,used:0},
        F18:{down:0,up:0,repeat:0,composing:0,modifier:0,used:0}};
      keyProbe=probe;
      await new Promise(resolve=>setTimeout(resolve,8000));
      if(keyProbe===probe)keyProbe=null;
      return probe;
    });

    let initialEditorFocusSeen=false;
    ipcMain.on('paper:initial-edit',event=>{
      const win=mainWindow;
      if(initialEditorFocusSeen || !win || !win.isFocused() || event.sender!==win.webContents ||
         event.senderFrame!==win.webContents.mainFrame || event.senderFrame?.url.split('?')[0]!==paperURL)return;
      initialEditorFocusSeen=true;
      prepareChinese(win,!startupPinyin);
    });

    ipcMain.handle('paper:save-screenshot',(event)=>{
      if(!mainWindow||event.sender!==mainWindow.webContents||
         event.senderFrame?.url.split('?')[0]!==paperURL)return false;
      return saveScreenshot(mainWindow);
    });
    ipcMain.handle('paper:save-touchpad-probe',async(event,value)=>{
      if(!mainWindow||event.sender!==mainWindow.webContents||
         event.senderFrame?.url.split('?')[0]!==paperURL)return false;
      const keys=['both','xOnly','yOnly','axisSwitches','maxMinorRatio','native','wheel'];
      if(!value||!keys.every(k=>Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=100000)||value.maxMinorRatio>100)return false;
      const summary=Object.fromEntries(keys.map(k=>[k,value[k]]));
      try {
        await writeFile(path.join(app.getPath('userData'),'touchpad-diagnostic.json'),
          JSON.stringify({at:new Date().toISOString(),...summary})+'\n');
        return true;
      } catch { return false; }
    });
    session.defaultSession.setPermissionRequestHandler((_contents,_permission,respond)=>respond(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    openPaper();
    app.on('activate',openPaper);
  });
  app.on('window-all-closed',()=>{
    // Renderer beforeunload/pagehide flushes its pending model first; ask
    // Chromium to flush the resulting DOM storage before leaving the app.
    session.defaultSession.flushStorageData();
    if(process.platform!=='darwin')app.quit();
  });
}
