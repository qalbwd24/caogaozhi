'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {TouchpadMotion}=require('../desktop/touchpad-motion.cjs');
const b=(x,y,s,t)=>[98,x,y,s,300,400,t];
const m=(x,y,s,t)=>[109,x,y,s,300,400,t];
const e=t=>[101,0,0,0,0,0,t];
const c=()=>[99,0,0,0,0,0,0];
function next(motion,records,now=1000){
  const out=[];
  motion.consume(records.flat(),now,(...v)=>out.push(v));
  return out;
}
test('a single two-finger stroke can turn horizontal to vertical and back',()=>{
  const s=10000, moves=next(new TouchpadMotion(),[b(0,0,s,1),m(100,0,s,9),m(100,100,s,17),m(-100,200,s,25)]);
  assert.deepEqual(moves.map(v=>v.slice(0,3)),[[11,0,0],[0,11,0],[-22,11,0]]);
});
test('vertical-starting contacts can turn horizontal without rearming',()=>{
  const s=10000, moves=next(new TouchpadMotion(),[b(0,0,s,1),m(0,-200,s,9),m(-100,-200,s,17)]);
  assert.deepEqual(moves.map(v=>v.slice(0,3)),[[0,-22,0],[-11,0,0]]);
});
test('stable center and span jitter do not zoom, real pinch keeps the screen anchor',()=>{
  const p=new TouchpadMotion();
  assert.deepEqual(next(p,[b(10,10,10000,1),m(10,10,10100,9),m(10,10,9900,17)]),[]);
  const [first]=next(p,[m(10,10,12100,25)]);
  assert.equal(first[0],0); assert.equal(first[1],0); assert.ok(first[2]>0);
  assert.deepEqual(first.slice(3),[300,400]);
  assert.ok(next(p,[m(10,10,8100,33)])[0][2]<0);
});
test('coast follows both axes, cancels immediately on new fingers or focus loss',()=>{
  const p=new TouchpadMotion(), s=10000;
  next(p,[b(0,0,s,1),m(80,100,s,9),e(13)],100);
  const [coast]=next(p,[],108);
  assert.ok(coast[0]>0&&coast[1]>0);
  assert.deepEqual(next(p,[b(1000,1000,s,20)],116),[]);
  assert.deepEqual(next(p,[c()],124),[]);
  p.reset(); assert.deepEqual(next(p,[],132),[]);
});
test('a pause before release or a replaced contact cannot jump the viewport',()=>{
  const p=new TouchpadMotion(),s=10000;
  next(p,[b(0,0,s,1),m(100,100,s,9),e(100)],1000);
  assert.deepEqual(next(p,[],1008),[]);
  assert.deepEqual(next(p,[b(300,300,s,110),c(),m(-100,-100,s,120)]),[]);
});

test('Ctrl zoom must not leave motion that can turn into pan inertia after release',()=>{
  const p=new TouchpadMotion(),s=10000, out=[];
  p.consume([b(0,0,s,1),m(110,120,s,9)].flat(),100,(...v)=>out.push(v),false);
  assert.equal(out.length,1);
  assert.deepEqual(next(p,[e(13)],108),[]);
  assert.deepEqual(next(p,[],119),[]);
});
