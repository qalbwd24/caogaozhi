'use strict';
// Curves are a presentation layer: routing never changes a note or a saved edge.
// Text is a soft obstacle. A short, readable overlap is preferable to a long detour.
function obstacle(n,pad=3) { return {l:n.x-pad,r:n.x+n.w+pad,t:n.y-pad,b:n.y+n.h+pad}; }
function bounds(points) { return {l:Math.min(...points.map(p=>p.x)),r:Math.max(...points.map(p=>p.x)),t:Math.min(...points.map(p=>p.y)),b:Math.max(...points.map(p=>p.y))}; }
function boxesTouch(a,b) { return a.l<=b.r && a.r>=b.l && a.t<=b.b && a.b>=b.t; }
function cubicAt([a,b,c,d],t) {
  const u=1-t;
  return {x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x,y:u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*d.y};
}
function segmentCross(a,b,c,d) {
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  return cross(a,b,c)*cross(a,b,d)<-.01 && cross(c,d,a)*cross(c,d,b)<-.01;
}
function routeClamp(value,low,high) { return Math.max(low,Math.min(high,value)); }
function routeCenter(n) { return {x:n.x+n.w/2,y:n.y+n.h/2}; }
function routeFamilies(A,B) {
  const a=routeCenter(A), b=routeCenter(B), dx=b.x-a.x, dy=b.y-a.y;
  const horizontal=Math.abs(dx)-(A.w+B.w)/2, vertical=Math.abs(dy)-(A.h+B.h)/2;
  const primary=horizontal>24 && (Math.abs(dx)>Math.abs(dy)*.8 || vertical<20) ? 'h' :
    vertical>12 ? 'v' : horizontal>=vertical ? 'h' : 'v';
  return [primary,primary==='h'?'v':'h'];
}
function routeSides(A,B,family) {
  const a=routeCenter(A), b=routeCenter(B);
  return family==='h' ? (b.x>=a.x?['r','l']:['l','r']) : (b.y>=a.y?['b','t']:['t','b']);
}
function routePort(rect,side,offset=0,gap=7) {
  const c=routeCenter(rect), horizontal=side==='l'||side==='r';
  const extent=(horizontal?rect.h:rect.w)/2;
  offset=routeClamp(offset,-Math.max(0,extent-5),Math.max(0,extent-5));
  const normal=side==='r'?{x:1,y:0}:side==='l'?{x:-1,y:0}:side==='b'?{x:0,y:1}:{x:0,y:-1};
  return {p:{x:c.x+normal.x*(rect.w/2+gap)+(horizontal?0:offset),y:c.y+normal.y*(rect.h/2+gap)+(horizontal?offset:0)},normal};
}
function routeSegments(points) {
  return points.slice(1).map((b,i)=>({a:points[i],b,length:Math.hypot(b.x-points[i].x,b.y-points[i].y),box:bounds([points[i],b])}));
}
function routeInside(segment,rect) {
  if (!boxesTouch(segment.box,rect)) return 0;
  const {a,b}=segment, dx=b.x-a.x, dy=b.y-a.y;
  let start=0,end=1;
  if (Math.abs(dx)<1e-8) { if(a.x<rect.l||a.x>rect.r) return 0; }
  else { const left=(rect.l-a.x)/dx,right=(rect.r-a.x)/dx;start=Math.max(start,Math.min(left,right));end=Math.min(end,Math.max(left,right)); }
  if (Math.abs(dy)<1e-8) { if(a.y<rect.t||a.y>rect.b) return 0; }
  else { const top=(rect.t-a.y)/dy,bottom=(rect.b-a.y)/dy;start=Math.max(start,Math.min(top,bottom));end=Math.min(end,Math.max(top,bottom)); }
  return Math.max(0,end-start)*segment.length;
}
function routeCandidate(from,to,bend,handle,preference) {
  const p=from.p,q=to.p,dx=q.x-p.x,dy=q.y-p.y,distance=Math.max(1,Math.hypot(dx,dy));
  const perpendicular={x:-dy/distance,y:dx/distance};
  const control=(port)=>{
    const v={x:port.normal.x*handle+perpendicular.x*bend,y:port.normal.y*handle+perpendicular.y*bend};
    const outward=v.x*port.normal.x+v.y*port.normal.y;
    if(outward<3) { v.x+=port.normal.x*(3-outward);v.y+=port.normal.y*(3-outward); }
    return {x:port.p.x+v.x,y:port.p.y+v.y};
  };
  const cubic=[p,control(from),control(to),q];
  const samples=routeClamp(Math.ceil(distance/38),10,22);
  const points=Array.from({length:samples+1},(_,i)=>cubicAt(cubic,i/samples));
  const segments=routeSegments(points),length=segments.reduce((sum,s)=>sum+s.length,0);
  let turns=0;
  for(let i=1;i<segments.length;i++) {
    const a=segments[i-1],b=segments[i],dot=(a.b.x-a.a.x)*(b.b.x-b.a.x)+(a.b.y-a.a.y)*(b.b.y-b.a.y);
    if(a.length&&b.length) turns+=Math.acos(routeClamp(dot/(a.length*b.length),-1,1));
  }
  const number=n=>Math.round(n*100)/100;
  const point=p=>number(p.x)+' '+number(p.y);
  return {cubic,points,segments,length,distance,box:bounds(points),bend,preference,turns,
    path:'M'+point(p)+' C'+point(cubic[1])+' '+point(cubic[2])+' '+point(q)};
}
function routeScore(curve,A,B,others,previous,meta) {
  const {segments,box,length,distance}=curve;
  let score=length+(length-distance)*1.3+curve.turns*9+curve.preference;
  // Long hairpins and loops lose even when they avoid every obstacle.
  score+=Math.max(0,length-distance*1.45-30)*5;
  for(let i=0;i<segments.length;i++) for(let j=i+2;j<segments.length;j++) {
    if(boxesTouch(segments[i].box,segments[j].box)&&segmentCross(segments[i].a,segments[i].b,segments[j].a,segments[j].b)) return Infinity;
  }
  // Start and end must remain legible; other notes use deliberately soft costs.
  for(const own of [obstacle(A,-1),obstacle(B,-1)]) {
    const inside=segments.reduce((sum,s)=>sum+routeInside(s,own),0);
    score+=inside*30;
  }
  for(const rect of others) {
    if(!boxesTouch(box,rect)) continue;
    let outside=0,core=0;
    for(const segment of segments) { outside+=routeInside(segment,rect); if(rect.core)core+=routeInside(segment,rect.core); }
    score+=outside*1.1+core*1.8+(core>2?12:0);
  }
  let crossings=0;
  for(const wire of previous) {
    if(!boxesTouch(box,wire.box)||wire.a===meta.a||wire.a===meta.b||wire.b===meta.a||wire.b===meta.b) continue;
    let met=false;
    const wireSegments=wire.segments||routeSegments(wire.points);
    for(const a of segments) {
      if(met)break;
      for(const b of wireSegments) if(boxesTouch(a.box,b.box)&&segmentCross(a.a,a.b,b.a,b.b)) {met=true;break;}
    }
    if(met)crossings++;
    if(crossings>=8)break;
  }
  return score+crossings*12;
}
function routeLabelBox(p,label='') {
  const width=Math.min(210,Math.max(24,[...label].reduce((n,c)=>n+(c.charCodeAt(0)>255?12:6.5),0)));
  return {l:p.x-width/2-3,r:p.x+width/2+3,t:p.y-22,b:p.y-5};
}
function routeLabel(curve,obstacles,label='') {
  let best=null,score=Infinity;
  for(const t of [.5,.4,.6,.3,.7]) {
    const p=cubicAt(curve.cubic,t),box=routeLabelBox(p,label);
    let cost=Math.abs(t-.5)*35;
    for(const rect of obstacles)if(boxesTouch(box,rect))cost+=30;
    if(cost<score){score=cost;best=p;}
  }
  return best;
}
function edgeGeometry(A,B,others=[],previous=[],options={}) {
  if(typeof options!=='object')options={};
  const families=routeFamilies(A,B),meta=options, candidates=[];
  for(let index=0;index<families.length;index++) {
    const [as,bs]=routeSides(A,B,families[index]);
    const aOffset=options.offsets?.[as]?.a||0,bOffset=options.offsets?.[bs]?.b||0;
    const from=routePort(A,as,aOffset,['reverse','double'].includes(options.arrow)?10:7);
    const to=routePort(B,bs,bOffset,['single','double'].includes(options.arrow)?10:7);
    const distance=Math.hypot(to.p.x-from.p.x,to.p.y-from.p.y);
    const clearance=(to.p.x-from.p.x)*from.normal.x+(to.p.y-from.p.y)*from.normal.y;
    // Short clearances need short handles; otherwise a near-vertical link curls
    // back on itself between adjacent paragraphs and looks like a bracket.
    const handle=Math.min(routeClamp(distance*.38,12,140),Math.max(3,clearance*.45));
    const lane=options.lane||0,gentle=Math.min(54,distance*.14),wide=Math.min(105,distance*.3);
    const bends=options.parallel && lane ?
      [lane,lane+Math.sign(lane)*gentle,...(index?[]:[lane+Math.sign(lane)*wide])] :
      index?[lane,lane+gentle,lane-gentle]:[lane,lane+gentle,lane-gentle,lane+wide,lane-wide];
    for(const bend of bends) candidates.push(routeCandidate(from,to,bend,handle,index*20+Math.abs(bend-lane)*.18));
  }
  let chosen=candidates[0],best=Infinity;
  const relevant=previous.slice(-40);
  for(const curve of candidates) {
    const score=routeScore(curve,A,B,others,relevant,meta);
    if(score<best-1.5){chosen=curve;best=score;}
  }
  return {...chosen,label:routeLabel(chosen,[...others,obstacle(A,1),obstacle(B,1),...previous.map(w=>w.labelBox).filter(Boolean)],options.label),routed:chosen!==candidates[0],attempted:true};
}
function routeEdgeSettings(nodes) {
  const settings=new Map(),groups=new Map(),pairs=new Map();
  for(const e of model.edges) {
    const A=nodes.get(e.a),B=nodes.get(e.b);if(!A||!B)continue;
    const [as,bs]=routeSides(A,B,routeFamilies(A,B)[0]);
    settings.set(e.id,{a:e.a,b:e.b,arrow:e.arrow,label:e.label,offsets:{},lane:0});
    for(const [id,side,other,end] of [[e.a,as,B,'a'],[e.b,bs,A,'b']]) {
      const key=id+'\u0000'+side;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({edge:e.id,id,side,end,remote:side==='r'||side==='l'?other.y+other.h/2:other.x+other.w/2});
    }
    const key=[e.a,e.b].sort().join('\u0000');
    if(!pairs.has(key))pairs.set(key,[]);
    pairs.get(key).push(e);
  }
  for(const list of groups.values()) {
    list.sort((a,b)=>a.remote-b.remote||a.edge.localeCompare(b.edge));
    const rect=nodes.get(list[0].id),side=list[0].side,span=Math.min(side==='r'||side==='l'?rect.h*.28:rect.w*.28,18);
    list.forEach((item,i)=>{
      const offset=list.length>1?(i/(list.length-1)-.5)*2*span:0;
      const settingsForEdge=settings.get(item.edge);
      settingsForEdge.offsets[side]||={};settingsForEdge.offsets[side][item.end]=offset;
    });
  }
  for(const list of pairs.values()) if(list.length>1) {
    list.sort((a,b)=>a.id.localeCompare(b.id));
    list.forEach((e,i)=>{
      settings.get(e.id).lane=(i-(list.length-1)/2)*30*(e.a.localeCompare(e.b)<0?1:-1);
      settings.get(e.id).parallel=true;
    });
  }
  return settings;
}
let paperRouteCache={key:'',curves:new Map()};
function draw() {
  const defs=svgEl('defs',{});
  for(const [key,[color]] of Object.entries(inks)) {
    const marker=svgEl('marker',{id:'arrow-'+key,viewBox:'0 0 12 10',refX:10,refY:5,markerWidth:8,markerHeight:7,orient:'auto-start-reverse'});
    marker.append(svgEl('path',{d:'M1 1 L10 5 1 9',stroke:color,'stroke-width':1.5,fill:'none'}));defs.append(marker);
  }
  const fragment=document.createDocumentFragment();fragment.append(defs);
  const nodes=new Map(model.nodes.map(n=>[n.id,size(n)]));
  const cacheKey=JSON.stringify([[...nodes].map(([id,n])=>[id,n.x,n.y,n.w,n.h]),model.edges.map(e=>[e.id,e.a,e.b,e.arrow,e.label])]);
  const cached=paperRouteCache.key===cacheKey;
  if(!cached)paperRouteCache={key:cacheKey,curves:new Map()};
  const blockers=[...nodes].map(([id,rect])=>({id,...obstacle(rect,3),core:obstacle(rect,-4)}));
  const settings=routeEdgeSettings(nodes),wires=[];
  for(const e of model.edges) {
    const A=nodes.get(e.a),B=nodes.get(e.b);if(!A||!B)continue;
    const others=blockers.filter(rect=>rect.id!==e.a&&rect.id!==e.b);
    const curve=cached?paperRouteCache.curves.get(e.id):edgeGeometry(A,B,others,wires,settings.get(e.id));
    if(!cached)paperRouteCache.curves.set(e.id,curve);
    wires.push({a:e.a,b:e.b,points:curve.points,segments:curve.segments,box:curve.box,...(e.label?{labelBox:routeLabelBox(curve.label,e.label)}:{})});
    const color=inks[e.color]?e.color:'black';
    const hit=svgEl('path',{d:curve.path,class:'hit','data-edge':e.id,tabindex:0,role:'button','aria-label':'选择连线'+(e.label?'：'+e.label:'')});
    const wire=svgEl('path',{d:curve.path,class:'wire'+(e.id===edgeId?' chosen':''),stroke:inks[color][0],'stroke-linecap':'round','stroke-linejoin':'round'});
    if(e.style==='dash')wire.setAttribute('stroke-dasharray','6 5');
    if(e.arrow==='single'||e.arrow==='double')wire.setAttribute('marker-end','url(#arrow-'+color+')');
    if(e.arrow==='reverse'||e.arrow==='double')wire.setAttribute('marker-start','url(#arrow-'+color+')');
    fragment.append(hit,wire);
    if(e.label) {
      const label=svgEl('text',{x:curve.label.x,y:curve.label.y-8,'text-anchor':'middle',fill:inks[color][0],stroke:'#fce3bf','stroke-width':4,'paint-order':'stroke','font-size':12,'stroke-linejoin':'round'});
      label.textContent=e.label;fragment.append(label);
    }
  }
  if(preview) {
    const n=node(preview.id);
    if(n) {
      const rect=nodes.get(preview.id), target=nodes.get(preview.target);
      let curve;
      if(target) {
        // Snap to the same curved router as an actual connection, never to a visible handle.
        const others=blockers.filter(b=>b.id!==preview.id&&b.id!==preview.target);
        curve=edgeGeometry(rect,target,others,wires,{a:preview.id,b:preview.target,arrow:'none'});
      } else {
        const end={x:preview.x,y:preview.y}, c=routeCenter(rect);
        const dx=end.x-c.x,dy=end.y-c.y;
        const side=Math.abs(dx)/Math.max(1,rect.w)>=Math.abs(dy)/Math.max(1,rect.h)
          ? (dx<0?'l':'r') : (dy<0?'t':'b');
        const from=routePort(rect,side,0,7), vx=end.x-from.p.x,vy=end.y-from.p.y;
        const distance=Math.hypot(vx,vy), lead=vx*from.normal.x+vy*from.normal.y;
        if(lead>1) {
          const to={p:end,normal:{x:-vx/distance,y:-vy/distance}};
          curve=routeCandidate(from,to,0,Math.min(120,distance*.35,lead*.65),0);
        }
      }
      if(curve)fragment.append(svgEl('path',{d:curve.path,class:'wire wire-preview'+(target?' snapped':''),stroke:inks[ink]?.[0]||'#7a624e','stroke-linecap':'round'}));
    }
  }
  svg.replaceChildren(fragment);
}
