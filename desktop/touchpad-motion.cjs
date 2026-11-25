'use strict';

// Win32 coordinates are hundredths of a millimetre. Keep movement in CSS
// pixels, not physical screen pixels, so display scaling doesn't alter speed.
const GAIN=.11, STRIDE=7;
class TouchpadMotion {
  reset(){ this.prev=null; this.inertia=null; this.vx=0; this.vy=0; this.slop=0; }
  constructor(){ this.reset(); }
  consume(frames, now, emit, allowCoast=true){
    if(!allowCoast){this.inertia=null;this.vx=this.vy=0;}
    for(let i=0;i+STRIDE<=frames.length;i+=STRIDE){
      const [phase,x,y,square,px,py,t]=frames.slice(i,i+STRIDE);
      if(phase===98){ // begin, or contact identity changed
        this.reset();
        this.prev={x,y,square,px,py,t};
        continue;
      }
      if(phase===99){ this.reset(); continue; }
      if(phase===101){
        const age=this.prev?(t-this.prev.t)>>>0:Infinity;
        if(allowCoast && age<=65 && Math.hypot(this.vx,this.vy)>.11){
          this.inertia={t:now,start:now};
        }
        this.prev=null;
        continue;
      }
      const p=this.prev;
      if(phase!==109 || !p)continue;
      const dx=(x-p.x)*GAIN,dy=(y-p.y)*GAIN;
      const step=(t-p.t)>>>0;
      this.prev={x,y,square,px,py,t};
      if(Math.abs(dx)>180 || Math.abs(dy)>180){this.vx=this.vy=0;continue;}
      const log=square>900 && p.square>900 ? Math.log(square/p.square)/2 : 0;
      this.slop+=log;
      let zoom=0;
      if(Math.abs(this.slop)>.032) {
        zoom=Math.sign(this.slop)*Math.min(.2,Math.abs(this.slop)-.02);
        this.slop=Math.sign(this.slop)*.02;
      }
      if(!allowCoast || zoom || !step || step>70){ this.vx=this.vy=0; }
      else {
        const a=.7;
        this.vx=this.vx*(1-a)+a*dx/step;this.vy=this.vy*(1-a)+a*dy/step;
      }
      if(dx||dy||zoom)emit(dx,dy,zoom,px,py);
    }
    if(this.inertia){
      const d=now-this.inertia.t, age=now-this.inertia.start;
      if(d>64 || age>360 || Math.hypot(this.vx,this.vy)<.045){this.inertia=null;return;}
      if(d>0){
        const fade=Math.exp(-d/82);
        this.vx*=fade;this.vy*=fade;
        this.inertia.t=now;
        emit(this.vx*d,this.vy*d,0,null,null);
      }
    }
  }
}
module.exports={TouchpadMotion};
