'use strict';
const {TouchpadMotion}=require('./touchpad-motion.cjs');

function attachWindowsTouchpad(win, screen) {
  if(process.platform!=='win32'||process.arch!=='x64')return;
  let device;
  try {
    device=require('./touchpad-win32-x64.node');
    if(typeof device.start!=='function'||typeof device.stop!=='function'||typeof device.poll!=='function')return;
  } catch { return; }
  const motion=new TouchpadMotion();
  let timer;
  function stop(){
    if(!timer)return;
    clearInterval(timer);timer=undefined;
    device.stop();
    motion.reset();
  }
  function start(){
    if(timer||!win.isFocused()||!device.start(win.getNativeWindowHandle()))return;
    timer=setInterval(()=>{
      if(win.isDestroyed()||win.webContents.isDestroyed()||!win.isFocused()){stop();return;}
      // A single IPC delivery per tick, even if Windows reported several contact frames.
      let dx=0,dy=0,z=0,anchor;
      motion.consume(device.poll(),performance.now(),(x,y,zoom,px,py)=>{
        dx+=x;dy+=y;z+=zoom;
        if(zoom)anchor=screen.screenToDipPoint({x:px,y:py});
      });
      if(dx||dy||z){
        const rect=anchor&&win.getContentBounds();
        win.webContents.send('paper:touchpad',dx,dy,z,rect?anchor.x-rect.x:null,rect?anchor.y-rect.y:null);
      }
    },8);
    timer.unref();
  }
  win.on('focus',start);
  win.on('blur',stop);
  win.on('closed',stop);
  start();
}
module.exports={attachWindowsTouchpad};
