'use strict';
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {test}=require('node:test');
const vm=require('node:vm');
const read=rel=>readFileSync(require('node:path').join(__dirname,'..',rel),'utf8');

test('real preload and main IPC allow retry after unfocused/early requests, not after a write',async()=>{
  const handlers=new Map(), paperURL='file:///paper/index.html', frame={url:paperURL+'?desktop=1'};
  const webContents={mainFrame:frame};
  const event={sender:webContents,senderFrame:frame};
  let focused=false, response=0, calls=0, api;
  const mainWindow={isFocused:()=>focused,isDestroyed:()=>false,webContents,getNativeWindowHandle:()=>Buffer.alloc(8)};
  const source=read('desktop/main.cjs');
  const get=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const ctx={paperURL,mainWindow,imeModeRequested:null,process:{platform:'win32',arch:'x64'},
    ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},
    require:()=>({preferChinese:()=>{calls++;return response;}})};
  vm.runInNewContext(get('const imeResults=','function openPaper()')+
    get("    ipcMain.handle('paper:ime-mode-requested'","    ipcMain.handle('paper:save-screenshot'"),ctx);
  vm.runInNewContext(read('desktop/preload.cjs'),{require:()=>({
    contextBridge:{exposeInMainWorld:(_,v)=>api=v},
    ipcRenderer:{invoke:async name=>handlers.get(name)(event)}
  })});
  assert.equal(await api.queryImeModeRequest(),null);
  assert.equal(await api.preferChineseAtFirstEdit(),'deferred');
  assert.equal(calls,0);
  focused=true;
  assert.equal(handlers.get('paper:initial-edit')({...event,senderFrame:{...frame}}),'unavailable');
  assert.equal(calls,0);
  assert.equal(await api.preferChineseAtFirstEdit(),'deferred');
  response=1;
  assert.equal(await api.preferChineseAtFirstEdit(),'unavailable');
  response=4;
  assert.equal(await api.preferChineseAtFirstEdit(),'unconfirmed');
  assert.equal(await api.queryImeModeRequest(),'unconfirmed');
  response=3;
  assert.equal(await api.preferChineseAtFirstEdit(),'unconfirmed');
  assert.equal(calls,3);
});

function rendererHarness(results) {
  const code=read('dist/app.js'), frames=[], listeners={};
  let focused=true, fieldActive=true, composing=false, calls=0;
  const ctx={editing:{host:{contains:()=>fieldActive},controller:{isComposing:()=>composing}},
    document:{hasFocus:()=>focused},window:{addEventListener:(name,fn)=>listeners[name]=fn,
      paperDesktop:{preferChineseAtFirstEdit:async()=>results[calls++]}},
    requestAnimationFrame:f=>frames.push(f)};
  vm.runInNewContext(code.slice(code.indexOf('let imeIntentSerial'),code.indexOf('function openEditor(')),ctx);
  return {ctx,frames,listeners,calls:()=>calls,run:async()=>{const fn=frames.shift();fn?.();await Promise.resolve();await Promise.resolve();},
    setFocus:v=>focused=v,setField:v=>fieldActive=v,setComposition:v=>composing=v};
}
test('only deliberate edit triggers request; retry allows unsettled native focus',async()=>{
  const t=rendererHarness(['deferred','readback']);
  t.ctx.requestEditorChinese();
  t.ctx.requestEditorChinese({isTrusted:false});
  assert.equal(t.frames.length,0);
  t.setFocus(false);t.ctx.requestEditorChinese({isTrusted:true});await t.run();
  assert.equal(t.calls(),0);
  t.setFocus(true);t.ctx.requestEditorChinese({isTrusted:true});await t.run();
  assert.equal(t.calls(),1);
  await t.run();assert.equal(t.calls(),2);
  t.ctx.requestEditorChinese({isTrusted:true});await t.run();
  assert.equal(t.calls(),2);
});
test('typing, composition and lost editor focus veto pending retries',async()=>{
  const t=rendererHarness(['deferred','deferred','deferred']), trusted={isTrusted:true};
  t.ctx.requestEditorChinese(trusted);await t.run();t.listeners.keydown(trusted);await t.run();
  assert.equal(t.calls(),1);
  t.ctx.requestEditorChinese(trusted);t.setComposition(true);await t.run();
  assert.equal(t.calls(),1);
  t.setComposition(false);t.ctx.requestEditorChinese(trusted);await t.run();t.setField(false);await t.run();
  assert.equal(t.calls(),2);
});
