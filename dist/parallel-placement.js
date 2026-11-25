(function(root,factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaperParallelPlacement = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  const GAP = 20, MARGIN = 12, MAX_LANES = 17;
  const DIRECTIONS = [
    {key:'below',vertical:true,sign:1},
    {key:'right',vertical:false,sign:1},
    {key:'above',vertical:true,sign:-1},
    {key:'left',vertical:false,sign:-1}
  ];
  const finite = Number.isFinite;
  const rect = r => r && [r.x,r.y,r.w,r.h].every(finite) && r.w > 0 && r.h > 0 ?
    {x:r.x,y:r.y,w:r.w,h:r.h} : null;
  const same = (a,b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  const center = r => ({x:r.x+r.w/2,y:r.y+r.h/2});
  const size = (n,fallback) => finite(n) && n > 0 ? Math.ceil(n) : fallback;

  function directionOrder(a, group) {
    if (!group.length) return ['below','right','above','left'];
    const origin = center(a), diffs = group.map(r => center(r)).filter(p => p.x !== origin.x || p.y !== origin.y)
      .map(p => ({dx:p.x-origin.x,dy:p.y-origin.y}));
    if (!diffs.length) return ['below','right','above','left'];
    // A long or sparse cohort should not outweigh several close aligned notes.
    let h = 0, v = 0;
    for (const {dx,dy} of diffs) { const d = Math.hypot(dx,dy); h += Math.abs(dx)/d; v += Math.abs(dy)/d; }
    const horizontal = h > v*1.12;
    // Use the order of the existing cohort when the anchor occurs in it.
    // If absent, continue the dominant axis in the conventional direction.
    const i = group.findIndex(r => same(r,a));
    const before = i > 0 ? center(group[i-1]) : null, after = i >= 0 && i + 1 < group.length ? center(group[i+1]) : null;
    const delta = p => horizontal ? p.x-origin.x : p.y-origin.y;
    const progression = (after ? delta(after) : 0) || (before ? -delta(before) : 0);
    if (horizontal) return progression < 0 ? ['left','right','below','above'] : ['right','left','below','above'];
    return progression < 0 ? ['above','below','right','left'] : ['below','above','right','left'];
  }

  function overlapRatio(x,y,w,h,v) {
    if (!v) return 1;
    const ix = Math.max(0,Math.min(x+w,v.x+v.w)-Math.max(x,v.x));
    const iy = Math.max(0,Math.min(y+h,v.y+v.h)-Math.max(y,v.y));
    return ix*iy/(w*h);
  }

  function lanesFor(a,group,all,d,w,h) {
    const cross = d.vertical ? 'x' : 'y', crossSize = d.vertical ? 'w' : 'h';
    const crossLength = d.vertical ? w : h, base = a[cross];
    // Prioritize the anchor lane and nearby offsets; obstacle boundaries supply
    // extra lanes so a clean corner/between-column gap needn't be skipped.
    const values = new Set([Math.round(base)]);
    const radius = Math.max(22,Math.min(52,crossLength*.4));
    for (const r of [radius,-radius,radius*2,-radius*2]) values.add(Math.round(base+r));
    const around = [...group,...all].map(o => ({
      o, distance: Math.abs(o.x-a.x)+Math.abs(o.y-a.y)
    })).filter(item => item.distance <= 360).sort((a,b)=>a.distance-b.distance ||
      a.o.x-b.o.x || a.o.y-b.o.y || a.o.w-b.o.w || a.o.h-b.o.h).slice(0,20);
    for (const {o} of around) {
      for (const p of [Math.round(o[cross]),Math.floor(o[cross]-crossLength-MARGIN),
        Math.ceil(o[cross]+o[crossSize]+MARGIN)]) {
        if (Math.abs(p-base) <= 150) values.add(p);
      }
    }
    return [...values].sort((a,b)=>Math.abs(a-base)-Math.abs(b-base)||a-b).slice(0,MAX_LANES);
  }

  function cast(lane,start,d,w,h,sorted) {
    const p = d.vertical ? 'y' : 'x', q = d.vertical ? 'x' : 'y';
    const pSize = d.vertical ? 'h' : 'w', qSize = d.vertical ? 'w' : 'h';
    const length = d.vertical ? h : w, crossLength = d.vertical ? w : h;
    let at = start;
    for (const o of sorted) {
      if (lane + crossLength + MARGIN <= o[q] || lane >= o[q]+o[qSize]+MARGIN) continue;
      const lo = o[p]-length-MARGIN, hi = o[p]+o[pSize]+MARGIN;
      if (d.sign > 0) {
        if (at <= lo) break;
        if (at < hi) at = Math.ceil(hi);
      } else {
        if (at >= hi) break;
        if (at > lo) at = Math.floor(lo);
      }
    }
    return d.vertical ? {x:lane,y:at} : {x:at,y:lane};
  }

  function siblingSpot(anchor,members=[],obstacles=[],{width,height,viewport}={}) {
    const a = rect(anchor) || {x:0,y:0,w:160,h:38};
    const w = size(width,Math.ceil(Math.max(72,Math.min(a.w,220)))), h = size(height,38), v = rect(viewport);
    const group = Array.isArray(members) ? members.map(rect).filter(Boolean) : [];
    const all = [a,...group,...(Array.isArray(obstacles) ? obstacles.map(rect).filter(Boolean) : [])];
    const order = directionOrder(a,group), bias = group.some(r=>!same(r,a)) ? [0,22,32,36] : [0,28,30,32];
    let best = null;
    for (const d of DIRECTIONS) {
      const primary = d.vertical ? 'y' : 'x', length = d.vertical ? 'h' : 'w', cross = d.vertical ? 'x' : 'y';
      const wanted = d.vertical ? h : w;
      const start = d.sign > 0 ? Math.ceil(a[primary]+a[length]+GAP) : Math.floor(a[primary]-wanted-GAP);
      const sorted = [...all].sort(d.sign > 0 ?
        (a,b)=>a[primary]-b[primary] : (a,b)=>(b[primary]+b[length])-(a[primary]+a[length]));
      const rank = order.indexOf(d.key);
      for (const lane of lanesFor(a,group,all,d,w,h)) {
        const p = cast(lane,start,d,w,h,sorted);
        const advance = Math.abs(p[primary]-start), lateral = Math.abs(p[cross]-a[cross]);
        const score = Math.hypot(advance,lateral)*1.05 + lateral*.12 + bias[rank] +
          14*(1-overlapRatio(p.x,p.y,w,h,v));
        // Comparison order is fixed; reordering obstacles cannot change exact ties.
        if (!best || score < best.score-1e-9 ||
          (Math.abs(score-best.score)<=1e-9 && (rank<best.rank || rank===best.rank && (p.y<best.y || p.y===best.y && p.x<best.x)))) {
          best = {...p,score,rank};
        }
      }
    }
    return {x:best.x,y:best.y};
  }

  return {siblingSpot};
});
