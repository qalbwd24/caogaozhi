'use strict';
const {app, BrowserWindow, Menu, session, dialog, ipcMain}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {writeFile}=require('node:fs/promises');

app.setName('草稿纸');
app.setPath('userData',path.join(app.getPath('appData'),'Caogaozhi'));
if(process.platform==='win32') app.setAppUserModelId('com.caogaozhi.scratchpad');
let mainWindow, saving=false;
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

function openPaper(){
  if(mainWindow) return;
  mainWindow=new BrowserWindow({
    title:'草稿纸', width:1120,height:770, minWidth:580,minHeight:475,
    show:false, backgroundColor:'#fce3bf',icon:path.join(__dirname,'icon.png'),
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false,preload:path.join(__dirname,'preload.cjs')}
  });
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,navigationURL)=>{
    const url=typeof navigationURL==='string'?navigationURL:navigationURL?.url;
    if(!url||url.split('?')[0]!==paperURL)event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown'||input.isComposing)return;
    const key=String(input.key||'').toLowerCase();
    const code=String(input.code||'').toLowerCase();
    if(input.shift&&(input.control||input.meta)&&!input.alt&&key==='s'){
      event.preventDefault();
      void saveScreenshot(mainWindow);
      return;
    }
    // Handle the remapped function keys before Chromium can turn them into a
    // second DOM keydown. The web editor uses the same color action for its
    // browser key/keyCode fallback. Other function keys stay available.
    if(!input.control&&!input.meta&&!input.alt){
      const direction=key==='f17'||code==='f17'?-1:key==='f18'||code==='f18'?1:0;
      if(direction){
        event.preventDefault();
        mainWindow.webContents.send('paper:color-step',direction);
      }
    }
  });
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
    ipcMain.handle('paper:save-screenshot',(event)=>{
      if(!mainWindow||event.sender!==mainWindow.webContents||
         event.senderFrame?.url.split('?')[0]!==paperURL)return false;
      return saveScreenshot(mainWindow);
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
