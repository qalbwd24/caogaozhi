'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {siblingSpot} = require('../dist/parallel-placement.js');
const anchor = {x:10,y:20,w:100,h:32};
const opt = {width:90,height:36};

function clear(p,rects,options=opt) {
  assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
  for(const r of rects) assert.ok(
    p.x+options.width+12<=r.x || p.x>=r.x+r.w+12 ||
    p.y+options.height+12<=r.y || p.y>=r.y+r.h+12,
    JSON.stringify({p,r})
  );
}
test('prefers natural aligned space below an isolated note',()=>{
  assert.deepEqual(siblingSpot(anchor,[],[],opt),{x:10,y:72});
});
test('tries nearby sides and holes before a long jump',()=>{
 const below={x:-60,y:65,w:270,h:180};
 const upper={x:-30,y:-45,w:210,h:40};
 const right={x:125,y:-5,w:70,h:66};
 const p=siblingSpot(anchor,[],[below,upper,right],opt);
 clear(p,[anchor,below,upper,right]);
 assert.ok(p.x<anchor.x-80 && Math.abs(p.y-anchor.y)<80);
});
test('member geometry takes precedence when a horizontal cohort can continue',()=>{
 const predecessor={x:-109,y:20,w:90,h:32}, members=[predecessor,anchor];
 assert.deepEqual(siblingSpot(anchor,members,[],opt),{x:130,y:20});
 assert.deepEqual(siblingSpot(predecessor,[anchor,predecessor],[],opt),{x:-219,y:20});
});
test('fills gaps and avoids existing aligned group members even if omitted from obstacles',()=>{
 const next={x:10,y:128,w:105,h:38}, farther={x:10,y:195,w:95,h:38};
 const gap=siblingSpot(anchor,[anchor,next,farther],[],opt);
 clear(gap,[anchor,next,farther]);
 assert.deepEqual(gap,{x:10,y:72});
});
test('world bounds are a soft preference, not permission to overlap text',()=>{
 const blocker={x:-400,y:-150,w:500,h:500};
 const right={x:126,y:-120,w:80,h:380};
 const v={x:0,y:0,w:32,h:32};
 const p=siblingSpot(anchor,[],[blocker,right],{...opt,viewport:v});
 clear(p,[anchor,blocker,right]);
});
test('fractional negative geometry plus dense fallback is deterministic and non-mutating',()=>{
 const a={x:-123.75,y:-59.5,w:130.25,h:38.5};
 const obstacles=Array.from({length:100},(_,i)=>({x:-600+(i%10)*110.5,y:-310+Math.floor(i/10)*56.75,w:100,h:48}));
 const viewport={x:-350,y:-180,w:580,h:290};
 const before=JSON.stringify({a,obstacles});
 const p=siblingSpot(a,[a],obstacles,{...opt,viewport});
 clear(p,[a,...obstacles]);
 assert.deepEqual(p,siblingSpot(a,[a],[...obstacles].reverse(),{...opt,viewport}));
 assert.equal(JSON.stringify({a,obstacles}),before);
});
test('fractional clearance and immediate right-side offset are honored',()=>{
 const a={x:-53.75,y:8.125,w:70.875,h:23.75}, below={x:-100.125,y:50.1,w:115.6,h:36.125};
 const p=siblingSpot(a,[],[below],{width:65.2,height:24.125});
 clear(p,[a,below],{width:Math.ceil(65.2),height:Math.ceil(24.125)});
});
test('invalid/degenerate obstacle data is ignored and the fallback stays finite',()=>{
 const p=siblingSpot(null,[],[null,{x:0,y:1,w:0,h:0},{x:NaN,y:0,w:130,h:42}]);
 assert.deepEqual(p,{x:0,y:58});
});
