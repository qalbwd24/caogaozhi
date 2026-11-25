'use strict';
const $ = id => document.getElementById(id);
const paper = $('paper'), board = $('board'), noteLayer = $('notes'), svg = $('links'), panel = $('panel');
const paperGrid = document.createElement('div');
paperGrid.id = 'paper-grid'; paperGrid.setAttribute('aria-hidden','true'); paper.prepend(paperGrid);
let drawnGridStep = NaN;
const inks = {black:['#322b25','黑 · 正文'],red:['#ad3536','红 · 重点、易错'],blue:['#285f94','蓝 · 启发、观点'],gray:['#796e61','铅 · 想法、待定']};
const colors = Object.keys(inks);
const inkCaptions = {black:'黑:正文',red:'红:重点',blue:'蓝:新颖',gray:'铅:待定'};
const arrows = {none:'无箭头',single:'正向',reverse:'反向',double:'双向'};
const newId = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
const blank = () => ({nodes:[], edges:[]});
const clone = value => JSON.parse(JSON.stringify(value));
let model = blank(), selected = null, edgeId = null, ink = 'black', source = null, editing = null;
let cam = {x:0,y:0,z:1}, gesture = null, pinch = null, preview = null, space = false, panelType = '';
let workspace, loading = true, drawFrame = 0, wheelFrame = 0, saveError = '', renaming = false;
let panelAnchor = null, panelReturn = null, toolPage = '', toolTarget = null, toolEditorSelection = null;
const toolColumns = [];
let hover = null, hoverTimer = 0, movable = null, inkHintTimer = 0;
const settingDefaults = {hoverDelay:440,inkHint:true,lineStyle:'solid',zoomLocked:false};
let touchpadProbe = null, touchpadProbeTimer = 0;
let preferences = {...settingDefaults};
try { const saved = JSON.parse(localStorage.getItem('caogaozhi.preferences.v1') || '{}'); if ([300,440,650].includes(saved.hoverDelay)) preferences.hoverDelay = saved.hoverDelay; if (typeof saved.inkHint === 'boolean') preferences.inkHint = saved.inkHint; if (saved.lineStyle === 'dash') preferences.lineStyle = 'dash'; if (typeof saved.zoomLocked === 'boolean') preferences.zoomLocked = saved.zoomLocked; } catch { /* nonessential UI preferences */ }
function savePreferences() { try { localStorage.setItem('caogaozhi.preferences.v1',JSON.stringify(preferences)); } catch { /* retains the choice for this session */ } }
const wheelMotion = [], heldControls = new Set();
let lastPointer = null, viewSaveTimer = 0;
const dom = new Map(), histories = new Map(), focusMemory = new Map();
const node = id => model.nodes.find(n => n.id === id);
const edge = id => model.edges.find(e => e.id === id);
const snap = () => JSON.stringify(model);

function normalize(raw) {
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || raw.nodes.length > 2000 || raw.edges.length > 4000) throw Error('草稿结构不正确');
  const ids = new Set(), edgeIds = new Set();
  const nodes = raw.nodes.map(n => {
    if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id) || !Number.isFinite(n.x) || !Number.isFinite(n.y) || Math.abs(n.x) > 1e6 || Math.abs(n.y) > 1e6 || typeof n.text !== 'string' || n.text.length > 10000) throw Error('文字块数据不正确');
    ids.add(n.id);
    const color = colors.includes(n.color) ? n.color : 'black';
    const result = {id:n.id,x:n.x,y:n.y,text:n.text,color};
    if (n.runs) result.runs = PaperEditor.normalizedRuns(n.text,color,n.runs);
    if (n.sticky === true) result.sticky = true;
    if (Number.isInteger(n.order) && n.order > 0 && n.order < 1e7) result.order = n.order;
    if (typeof n.parentId === 'string') result.parentId = n.parentId;
    if (typeof n.parallelId === 'string' && n.parallelId.length > 0 && n.parallelId.length <= 128) result.parallelId = n.parallelId;
    return result;
  });
  for (const n of nodes) if (!ids.has(n.parentId) || n.parentId === n.id) delete n.parentId;
  const edges = raw.edges.map(e => {
    if (!e || typeof e.id !== 'string' || !e.id || edgeIds.has(e.id) || !ids.has(e.a) || !ids.has(e.b) || e.a === e.b) throw Error('连线数据不正确');
    edgeIds.add(e.id);
    return {id:e.id,a:e.a,b:e.b,style:e.style === 'dash' ? 'dash' : 'solid',arrow:Object.hasOwn(arrows,e.arrow) ? e.arrow : 'none',color:colors.includes(e.color) ? e.color : 'gray',label:typeof e.label === 'string' ? e.label.slice(0,80) : '',...(e.kind === 'child' ? {kind:'child'} : {})};
  });
  return {nodes,edges};
}
function announce(message) { $('announcement').textContent = message; }
function reportSaveError(error, info) {
  saveError = info?.blocked ? '原有保存无法读取，已保留原数据。当前修改可先导出，避免丢失。' : '暂时无法保存。当前文字仍在本页，请重试保存或导出草稿。';
  $('save-error').hidden = false;
  $('save-error').title = saveError;
  announce(saveError);
}
function savedModel() {
  const nodes = model.nodes.filter(n => n.text.trim()), ids = new Set(nodes.map(n => n.id));
  return {nodes:nodes.map(n => { const copy = {...n}; if (!ids.has(copy.parentId)) delete copy.parentId; return copy; }),edges:model.edges.filter(e => ids.has(e.a) && ids.has(e.b))};
}
function persist() {
  if (!workspace || loading) return;
  try { workspace.updateActive({model:savedModel(),cam,ink}); }
  catch (error) { reportSaveError(error); }
}
function flush() {
  applyWheelPan();
  if (viewSaveTimer) { clearTimeout(viewSaveTimer); viewSaveTimer = 0; }
  if (editing) {
    const n = node(editing.id), value = editing.controller.read();
    if (n) { n.text = value.text; n.runs = value.runs; }
  }
  persist();
  const ok = workspace.save();
  if (ok) { saveError = ''; $('save-error').hidden = true; }
  return ok;
}
function historyFor() {
  const id = workspace.state.activeId;
  if (!histories.has(id)) histories.set(id,{past:[],future:[],group:null,at:0});
  return histories.get(id);
}
function capture(selection) {
  return {model:clone(model),selected,edgeId,ink,editId:editing?.id || null,selection:selection || editing?.controller.getSelection() || null};
}
function changed(before, group = null) {
  const h = historyFor();
  if (JSON.stringify(before.model) !== snap()) {
    const now = performance.now();
    if (!group || h.group !== group || now - h.at > 800) {
      h.past.push(before);
      if (h.past.length > 120) h.past.shift();
    }
    h.group = group; h.at = now; h.future.length = 0;
  }
  persist(); sync();
}
function breakHistoryGroup() { if (workspace) historyFor().group = null; }
function detachEditor() {
  if (!editing) return;
  const current = editing; editing = null;
  current.controller.destroy(); current.host.remove();
}
function restore(state) {
  detachEditor();
  model = normalize(state.model); ink = colors.includes(state.ink) ? state.ink : 'black';
  selected = node(state.selected) ? state.selected : null; edgeId = edge(state.edgeId) ? state.edgeId : null; source = null;
  closePanel(); render();
  if (state.editId && node(state.editId)) openEditor(node(state.editId),state.selection);
  else if (selected) dom.get(selected)?.focus({preventScroll:true});
  persist(); sync();
}
function undo() {
  if (editing?.controller.isComposing()) return;
  const h = historyFor(); if (!h.past.length) return;
  h.future.push(capture()); const prior = h.past.pop(); h.group = null;
  restore(prior);
}
function redo() {
  if (editing?.controller.isComposing()) return;
  const h = historyFor(); if (!h.future.length) return;
  h.past.push(capture()); const next = h.future.pop(); h.group = null;
  restore(next);
}

function paperGridFor(camera) {
  const step = 20 * camera.z;
  const phase = v => ((v % step) + step) % step;
  return {step, x: phase(camera.x), y: phase(camera.y)};
}
function camera(save = true) {
  const g = paperGridFor(cam);
  if (drawnGridStep !== g.step) {
    paperGrid.style.setProperty('--paper-grid-step', g.step + 'px');
    drawnGridStep = g.step;
  }
  paperGrid.style.transform = 'translate3d(' + g.x + 'px,' + g.y + 'px,0)';
  board.style.transform = 'translate3d(' + cam.x + 'px,' + cam.y + 'px,0) scale(' + cam.z + ')';
  const fitLabel = Math.round(cam.z * 100) + '%', fitControl = $('fit');
  const fitTitle = '显示全部 · Ctrl+0';
  if (fitControl.title !== fitTitle) fitControl.title = fitTitle;
  if (fitControl.textContent !== fitLabel) fitControl.textContent = fitLabel;
  if (save && workspace && !loading) workspace.updateActive({cam});
}
function relative(x,y) { const b = paper.getBoundingClientRect(); return {x:x-b.left,y:y-b.top}; }
function world(x,y) { const p = relative(x,y); return {x:(p.x-cam.x)/cam.z,y:(p.y-cam.y)/cam.z}; }
function center() { return {x:paper.clientWidth/2,y:paper.clientHeight/2}; }
function zoomCamera(camera,z,p) {
  z = Math.min(3,Math.max(.2,z));
  if (z === camera.z) return;
  camera.x = p.x - (p.x-camera.x)*z/camera.z;
  camera.y = p.y - (p.y-camera.y)*z/camera.z;
  camera.z = z;
}
function zoom(z,p) {
  const factor = z/cam.z;
  applyWheelPan(); zoomCamera(cam,cam.z*factor,p); camera();
}
function size(n) { const d = dom.get(n.id); return {x:n.x,y:n.y,w:d?.offsetWidth || 220,h:d?.offsetHeight || 32}; }
function svgEl(tag,attrs) { const t = document.createElementNS('http://www.w3.org/2000/svg',tag); Object.entries(attrs).forEach(([k,v]) => t.setAttribute(k,v)); return t; }
function drawParallelGuides() {
  const groups = new Map(), layer = $('parallel-guides'), fragment = document.createDocumentFragment();
  for (const n of model.nodes) {
    if (!n.parallelId || (!n.text.trim() && editing?.id !== n.id)) continue;
    if (!groups.has(n.parallelId)) groups.set(n.parallelId,[]);
    groups.get(n.parallelId).push(n);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const boxes = members.map(size);
    const xs = boxes.map(r => r.x+r.w/2), ys = boxes.map(r => r.y+r.h/2);
    const byX = Math.max(...xs)-Math.min(...xs) > (Math.max(...ys)-Math.min(...ys))*1.15;
    boxes.sort((a,b) => byX ? a.x+a.w/2-b.x-b.w/2 || a.y-b.y : a.y+a.h/2-b.y-b.h/2 || a.x-b.x);
    const path = [];
    for (let i=1;i<boxes.length;i++) {
      const a=boxes[i-1], b=boxes[i];
      const ax=a.x+a.w/2,ay=a.y+a.h/2,bx=b.x+b.w/2,by=b.y+b.h/2;
      if (bx-a.x-a.w>0 && (b.x>a.x+a.w+8 || Math.abs(bx-ax)>Math.abs(by-ay)*1.4)) {
        const x1=a.x+a.w+4,x2=b.x-4,m=(x1+x2)/2;
        if (x2>x1) { path.push('M',x1,ay,'C',m,ay,m,by,x2,by); continue; }
      }
      if (b.y>=a.y+a.h+8) {
        const y1=a.y+a.h+4,y2=b.y-4,m=(y1+y2)/2;
        path.push('M',ax,y1,'C',ax,m,bx,m,bx,y2);
      } else if (a.x>=b.x+b.w+8) {
        const x1=a.x-4,x2=b.x+b.w+4,m=(x1+x2)/2;
        path.push('M',x1,ay,'C',m,ay,m,by,x2,by);
      } else if (a.y>=b.y+b.h+8) {
        const y1=a.y-4,y2=b.y+b.h+4,m=(y1+y2)/2;
        path.push('M',ax,y1,'C',ax,m,bx,m,bx,y2);
      }
    }

    fragment.append(svgEl('path',{class:'parallel-guide',d:path.join(' ')}));
  }
  layer.replaceChildren(fragment);
}
function scheduleDraw() { if (!drawFrame) drawFrame = requestAnimationFrame(() => { drawFrame = 0; drawParallelGuides(); draw(); }); }
function fit() {
  applyWheelPan();
  if (!model.nodes.length) { cam = {x:0,y:0,z:1}; camera(); return; }
  const boxes = model.nodes.map(size), x = Math.min(...boxes.map(n => n.x)), y = Math.min(...boxes.map(n => n.y));
  const w = Math.max(...boxes.map(n => n.x+n.w))-x, h = Math.max(...boxes.map(n => n.y+n.h))-y, pad = 55;
  cam.z = Math.max(.2,Math.min(1,(paper.clientWidth-pad*2)/Math.max(1,w),(paper.clientHeight-pad*2)/Math.max(1,h)));
  cam.x = (paper.clientWidth-w*cam.z)/2-x*cam.z; cam.y = (paper.clientHeight-h*cam.z)/2-y*cam.z; camera();
}
function reveal(n) {
  const s = size(n), pad = 32, right = (n.x+s.w)*cam.z+cam.x, bottom = (n.y+s.h)*cam.z+cam.y;
  if (right > paper.clientWidth-pad) cam.x -= right-(paper.clientWidth-pad);
  if (n.x*cam.z+cam.x < pad) cam.x = pad-n.x*cam.z;
  if (bottom > paper.clientHeight-pad) cam.y -= bottom-(paper.clientHeight-pad);
  if (n.y*cam.z+cam.y < pad) cam.y = pad-n.y*cam.z;
  camera();
}
function freeSpot(x,y) {
  for (let i=0;i<model.nodes.length+1;i++) {
    const overlap = model.nodes.map(size).find(b => x < b.x+b.w+28 && x+220 > b.x-28 && y < b.y+b.h+18 && y+34 > b.y-8);
    if (!overlap) break;
    y = overlap.y+overlap.h+24;
  }
  return {x,y};
}
function makeNote(n) {
  const d = document.createElement('div'); d.className = 'note'; d.dataset.node = n.id; d.tabIndex = 0; d.setAttribute('role','group');
  const number = document.createElement('span'); number.className = 'number'; number.setAttribute('aria-hidden','true');
  const content = document.createElement('span'); content.className = 'content';
  d.append(number,content); noteLayer.append(d); dom.set(n.id,d); return d;
}
function drawText(el,n) {
  const fragments = PaperEditor.normalizedRuns(n.text,n.color,n.runs);
  el.replaceChildren();
  for (const run of fragments) { const span = document.createElement('span'); span.textContent = run.text; span.style.color = inks[run.color][0]; el.append(span); }
}
function render() {
  for (const [id,d] of dom) if (!node(id)) { d.remove(); dom.delete(id); }
  for (const n of model.nodes) {
    const d = dom.get(n.id) || makeNote(n), ed = editing?.id === n.id;
    d.style.left = n.x + 'px'; d.style.top = n.y + 'px'; d.style.color = inks[n.color][0];
    d.classList.toggle('selected',selected === n.id || source === n.id); d.classList.toggle('editing',ed); d.classList.toggle('sticky',n.sticky === true);
    d.querySelector('.number').hidden = !n.order; d.querySelector('.number').textContent = n.order ? n.order + '.' : '';
    const content = d.querySelector('.content'); content.hidden = ed; if (!ed) drawText(content,n);
    d.setAttribute('aria-label',n.text || '空白文字块');
  }
  scheduleDraw(); sync(); placeInkHint();
}
function sync() {
  if (!workspace) return;
  const h = historyFor(); $('undo').disabled = !h.past.length; $('redo').disabled = !h.future.length;
  paper.classList.toggle('pan',space);
  const e = edge(edgeId), n = node(selected), active = e?.color || (editing?.controller?.isComposing() ? ink : editing?.controller?.getColor()) || ink;
  $('inspector-name').textContent = e ? '连线' : editing ? '输入' : inkCaptions[active];
  $('edge-controls').hidden = !e;
  if (e) { $('stroke-style').value = e.style; $('stroke-arrow').value = e.arrow; }
  $('inspect-more').hidden = !e && !n;
  $('inspect-more').setAttribute('aria-expanded',String(panelType === 'props' && !panel.hidden));
  for (const b of $('palette').children) b.setAttribute('aria-pressed',String(b.dataset.ink === active));
  $('file').setAttribute('aria-expanded',String(panelType === 'file' && !panel.hidden));
}
function openEditor(n,selection,point) {
  if (!n) return;
  if (editing?.id === n.id) { editing.controller.focus(); return; }
  finishEdit(); closePanel(); clearHover(); selected = n.id; edgeId = null; source = null;
  const host = document.createElement('div'); host.className = 'editor'; host.setAttribute('aria-label','草稿文字');
  editing = {id:n.id,host,controller:null};
  render(); dom.get(n.id).append(host);
  const controller = PaperEditor.create({host,node:n,inks,typingColor:ink,
    onChange(value,meta) {
      if (!editing || editing.id !== n.id) return;
      const before = editing.colorBefore || capture(meta.beforeSelection);
      n.text = value.text; n.runs = value.runs;
      const group = meta.kind === 'input' || meta.kind === 'composition' ? 'typing:'+n.id : null;
      changed(before,group); scheduleDraw(); reveal(n);
    },
    onSelectionChange() {
      if (editing?.controller) { sync(); placeInkHint(); }
    }
  });
  editing.controller = controller;
  controller.focus({end:true});
  window.paperDesktop?.preferChineseAtFirstEdit?.();
  if (selection) controller.setSelection(selection.start,selection.end,selection.direction);
  else if (point) {
    const range = document.caretRangeFromPoint?.(point.x,point.y);
    if (range && host.contains(range.startContainer)) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  }
  host.addEventListener('blur',() => {
    queueMicrotask(() => { if (editing?.host === host && !host.contains(document.activeElement) && !(toolPage && panelReturn === host && panel.contains(document.activeElement))) finishEdit(); });
  });
  reveal(n); sync();
}
function finishEdit() {
  if (!editing) return;
  const {id,controller} = editing, n = node(id), value = controller.read();
  if (n) { n.text = value.text; n.runs = value.runs; }
  detachEditor();
  if (n && !n.text.trim()) {
    model.nodes = model.nodes.filter(k => k.id !== id); model.edges = model.edges.filter(e => e.a !== id && e.b !== id);
    for (const child of model.nodes) if (child.parentId === id) delete child.parentId;
    if (selected === id) selected = null;
    const h = historyFor();
    while (h.past.length && JSON.stringify(h.past.at(-1).model) === snap()) h.past.pop();
  }
  breakHistoryGroup(); persist(); render();
}
function createEdge(a,b,arrow='none',kind) {
  if (a === b || model.edges.some(e => e.a === a && e.b === b)) return null;
  const e = {id:newId(),a,b,style:kind === 'child' ? 'solid' : preferences.lineStyle,arrow,color:ink,label:'',...(kind ? {kind} : {})}; model.edges.push(e); return e;
}
function newNote(x,y,{parent=null,child=false,arrow='none',order=null,parallelId=null,place=false,before:nullBefore=null}={}) {
  finishEdit(); const before = nullBefore || capture();
  if (place) ({x,y} = freeSpot(x,y));
  const n = {id:newId(),x:Math.round(x),y:Math.round(y),text:'',color:ink,...(order ? {order} : {})};
  if (child && node(parent)) n.parentId = parent;
  if (parallelId) n.parallelId = parallelId;
  model.nodes.push(n); if (parent && node(parent)) createEdge(parent,n.id,arrow,child ? 'child' : undefined);
  selected = n.id; edgeId = null; openEditor(n);
  changed(before,'typing:'+n.id);
}
function extend(kind) {
  const n = node(editing?.id || selected); if (!n || !n.text.trim()) { if (kind === 'sibling') finishEdit(); return; }
  const s = size(n), before = capture();
  let order = n.order ? n.order+1 : null;
  if (kind === 'sibling' && !n.order) {
    const match = /^(\d+)\.\s+(\S[\s\S]*)$/.exec(n.text);
    if (match && Number(match[1]) > 0 && Number(match[1]) < 9999999) {
      const skip = n.text.length-match[2].length;
      const fragments = PaperEditor.normalizedRuns(n.text,n.color,n.runs); let at = 0;
      n.runs = fragments.map(r => { const take = Math.max(0,skip-at); at += r.text.length; return {...r,text:r.text.slice(take)}; }).filter(r => r.text);
      n.text = match[2]; n.order = Number(match[1]); order = n.order+1;
      editing?.controller.setValue(n,{start:n.text.length,end:n.text.length});
    }
  }
  if (kind === 'child') newNote(n.x+s.w+78,n.y,{parent:n.id,child:true,arrow:'single',place:true,before});
  else {
    n.parallelId ||= newId();
    const members = model.nodes.filter(item => item.parallelId === n.parallelId).map(size);
    const viewport = {x:-cam.x/cam.z,y:-cam.y/cam.z,w:paper.clientWidth/cam.z,h:paper.clientHeight/cam.z};
    const place = PaperParallelPlacement.siblingSpot(s,members,model.nodes.map(size),{width:Math.max(150,Math.min(220,s.w)),height:34,viewport});
    newNote(place.x,place.y,{parent:n.parentId || null,child:!!n.parentId,arrow:n.parentId ? 'single' : 'none',order,parallelId:n.parallelId,before});
  }
}
function selectNode(id) {
  if (editing?.id !== id) finishEdit();
  selected = id; edgeId = null;
  closePanel(); render();
}
function selectEdge(id) { finishEdit(); selected = null; edgeId = id; closePanel(); render(); }
function placeInkHint() {
  const tip = $('ink-hint');
  if (tip.hidden) return;
  const v = paper.getBoundingClientRect(), s = $('surface').getBoundingClientRect();
  let a = null;
  if (editing) {
    const selection = window.getSelection();
    if (selection?.focusNode && editing.host.contains(selection.focusNode)) {
      const range = document.createRange(); range.setStart(selection.focusNode,selection.focusOffset); range.collapse(true);
      const b = range.getBoundingClientRect(); if (b.height > 0) a = b;
    }
    a ||= editing.host.getBoundingClientRect();
  } else if (edgeId) {
    const hit = [...svg.querySelectorAll('[data-edge]')].find(p=>p.dataset.edge===edgeId);
    const matrix = hit?.getScreenCTM();
    if (matrix) {
      const p = hit.getPointAtLength(hit.getTotalLength()/2).matrixTransform(matrix);
      a = {left:p.x,right:p.x,top:p.y,bottom:p.y};
    }
  } else if (selected) {
    a = dom.get(selected)?.getBoundingClientRect();
  }
  if (a && (a.right < v.left || a.left > v.right || a.bottom < v.top || a.top > v.bottom)) a = null;
  const width = tip.offsetWidth, height = tip.offsetHeight, gap = 12;
  const x = a ? (a.right+gap+width <= v.right-6 ? a.right+gap : a.left-gap-width) : (v.left+v.right-width)/2;
  const y = a ? (a.top-height-8 >= v.top+6 ? a.top-height-8 : a.bottom+gap) : v.top+Math.min(v.height*.43,210);
  const clamp = (n,min,max) => Math.max(min,Math.min(max,n));
  tip.style.left = clamp(x,v.left+6,v.right-width-6)-s.left+'px';
  tip.style.top = clamp(y,v.top+6,v.bottom-height-6)-s.top+'px';
}
function showActionHint(c,scope,label,display=scope + ' · ' + label,force=false) {
  announce(scope + '：' + label);
  if (!preferences.inkHint && !force) return;
  const tip = $('ink-hint'); tip.style.setProperty('--hint-ink',inks[c][0]);
  tip.querySelector('span').textContent = display; tip.hidden = false; placeInkHint();
  clearTimeout(inkHintTimer); inkHintTimer = setTimeout(() => { tip.hidden = true; },1050);
}
function toggleZoomLock() {
  applyWheelPan();
  preferences.zoomLocked = !preferences.zoomLocked;
  savePreferences();
  closePanel(true); camera(false);
  const label = preferences.zoomLocked ? '已锁定' : '已解除锁定';
  showActionHint(ink,'触控板缩放',label,'触控板缩放' + label,true);
}
function showInkHint(c,scope='笔色') { showActionHint(c,scope,inkCaptions[c],inkCaptions[c]); }
function applyTypingInk(c) {
  breakHistoryGroup(); ink = c;
  editing?.controller?.setTypingColor(c);
  persist(); sync(); showInkHint(c);
}
function setInk(c) {
  if (!colors.includes(c)) return;
  if (editing?.controller?.isComposing()) {
    applyTypingInk(c); return;
  }
  breakHistoryGroup();
  const before = capture();
  if (editing) {
    const range = editing.controller.getSelection();
    if (range.start === range.end) { applyTypingInk(c); return; }
    editing.colorBefore = before;
    editing.controller.setColor(c);
    editing.colorBefore = null;
    ink = c;
    editing.controller.setTypingColor(c);
    showInkHint(c,'选中文字');
    persist(); sync(); return;
  }
  ink = c; persist(); sync(); showInkHint(c);
}
function chooseInk(c) { if (edge(edgeId)) setEdgeAttr('color',c); else setInk(c); }
function cycleInk() {
  const current = (editing?.controller?.isComposing() ? ink : editing?.controller?.getColor()) || ink;
  setInk(colors[(colors.indexOf(current)+1)%colors.length]);
}
function stepPaperShortcut(code) {
  if (document.activeElement?.closest('input,select,dialog')) return;
  if (code === 'F18') { cycleInk(); return; }
  if (code !== 'F17') return;
  const e = edge(edgeId);
  if (!e) { showActionHint(ink,'箭头','先选中一条连线'); return; }
  const modes=Object.keys(arrows);
  setEdgeAttr('arrow',modes[(modes.indexOf(e.arrow)+1)%modes.length]);
}
function setEdgeAttr(key,value) {
  const e = edge(edgeId);
  if (!e || e[key] === value || (key === 'arrow' && !Object.hasOwn(arrows,value))) return;
  const before = capture(); e[key] = value; changed(before); scheduleDraw();
  if (key === 'color') showInkHint(value,'连线');
  if (key === 'arrow') showActionHint(e.color,'箭头',arrows[value]);
}

function renderTabs() {
  if (renaming) return;
  const state = workspace.state; $('tabs').replaceChildren();
  for (const id of state.openIds) {
    const doc = state.documents.find(d => d.id === id), active = state.activeId === id;
    const wrapper = document.createElement('div'); wrapper.className = 'tab' + (active ? ' active' : ''); wrapper.dataset.tab = id;
    const tab = document.createElement('button'); tab.className = 'tab-button'; tab.setAttribute('role','tab'); tab.setAttribute('aria-selected',String(active)); tab.tabIndex = active ? 0 : -1; tab.textContent = doc.title; tab.title = doc.title; tab.dataset.tabId = id;
    tab.onclick = () => activateTab(id); tab.ondblclick = () => renameTab(id);
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-label','关闭 '+doc.title); close.title = '关闭标签，保留草稿'; close.onclick = () => closeTab(id);
    wrapper.append(tab,close); $('tabs').append(wrapper);
  }
  document.title = workspace.active().title + ' · 草稿纸';
  $('tabs').querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function rememberFocus() {
  focusMemory.set(workspace.state.activeId,{selected,edgeId,editId:editing?.id || null,selection:editing?.controller.getSelection() || null});
}
function loadDocument(restoreFocus=true) {
  loading = true; detachEditor(); clearHover(); clearGestureCursor(); applyWheelPan();
  const current = workspace.active(); model = normalize(current.model); cam = {...current.cam}; ink = current.ink;
  selected = null; edgeId = null; source = null; gesture = null; preview = null; pinch = null; space = false;
  const memory = focusMemory.get(current.id);
  if (restoreFocus && memory) { selected = node(memory.selected) ? memory.selected : null; edgeId = edge(memory.edgeId) ? memory.edgeId : null; }
  closePanel(); render(); camera(false); renderTabs(); loading = false;
  if (restoreFocus && node(memory?.editId)) openEditor(node(memory.editId),memory.selection);
}
function activateTab(id) {
  if (id === workspace.state.activeId) return;
  if (editing?.controller.isComposing()) return;
  rememberFocus(); finishEdit(); applyWheelPan(); flush(); workspace.activate(id); loadDocument();
}
function addTab(initial=blank(),title) {
  if (editing?.controller.isComposing()) return;
  rememberFocus(); finishEdit(); applyWheelPan(); flush(); workspace.createDocument(title,initial); loadDocument(false); workspace.save();
  if (model.nodes.length) fit(); else paper.focus({preventScroll:true});
}
function closeTab(id=workspace.state.activeId) {
  if (editing?.controller.isComposing()) return;
  const active = id === workspace.state.activeId;
  if (active) { rememberFocus(); finishEdit(); applyWheelPan(); flush(); }
  workspace.close(id); workspace.save();
  if (active) loadDocument(); else renderTabs();
}
function reopenTab(id) {
  rememberFocus(); finishEdit(); applyWheelPan(); flush();
  if (workspace.reopen(id)) { loadDocument(); workspace.save(); }
}
function nextTab(direction) {
  const state = workspace.state, index = state.openIds.indexOf(state.activeId);
  activateTab(state.openIds[(index+direction+state.openIds.length)%state.openIds.length]);
}
function renameTab(id=workspace.state.activeId) {
  if (renaming || editing?.controller.isComposing()) return;
  finishEdit(); closePanel();
  const state = workspace.state, doc = state.documents.find(d => d.id === id);
  const wrapper = [...$('tabs').children].find(d => d.dataset.tab === id);
  if (!doc || !wrapper) return;
  renaming = true; const input = document.createElement('input'); input.value = doc.title; input.maxLength = 100; input.setAttribute('aria-label','草稿名称');
  wrapper.replaceChildren(input); input.focus(); input.select(); let done = false;
  const complete = cancelled => { if (done) return; done = true; renaming = false; if (!cancelled) workspace.rename(id,input.value); renderTabs(); workspace.save(); paper.focus({preventScroll:true}); };
  input.onkeydown = e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); complete(e.key === 'Escape'); } };
  input.onblur = () => complete(false);
}

function closePanel(restoreFocus=false) {
  const previous = panelReturn, held = toolEditorSelection;
  const resume = !!(held && editing?.host === previous && (restoreFocus || panel.contains(document.activeElement)));
  panel.hidden = true; panelType = ''; panelAnchor = panelReturn = toolTarget = toolEditorSelection = null; toolPage = ''; toolColumns.length = 0; sync();
  if (resume) {
    editing.controller.focus(); editing.controller.setSelection(held.start,held.end,held.direction);
  } else if (restoreFocus) {
    const target = previous?.isConnected && !previous.closest('[hidden]') && !previous.disabled
      ? previous : dom.get(selected) || paper;
    target.focus({preventScroll:true});
  }
}
function showPanel(type,title,anchor=null,returnTo=document.activeElement) {
  panel.replaceChildren(); toolColumns.length = 0; panel.removeAttribute('data-cascade');
  panelType = type; panelAnchor = anchor;
  panelReturn = returnTo && returnTo !== document.body && !panel.contains(returnTo) ? returnTo : paper;
  panel.toggleAttribute('data-anchored',!!anchor); panel.hidden = false;
  panel.style.removeProperty('--menu-x'); panel.style.removeProperty('--menu-y'); panel.scrollTop = 0;
  clearHover();
  const heading = document.createElement('strong'); heading.textContent = title; panel.append(heading);
  const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label','关闭菜单'); close.onclick = () => closePanel(true); panel.append(close); sync();
}
function placePanel() {
  if (!panelAnchor || panel.hidden) return;
  const {width,height,left,top} = $('surface').getBoundingClientRect(), gap = 7;
  const w = panel.offsetWidth, h = panel.offsetHeight;
  const x = panelAnchor.x-left, y = panelAnchor.y-top;
  const choose = (p,extent,limit) => {
    const candidate = p+gap+extent <= limit-gap ? p+gap : p-gap-extent;
    return Math.max(gap,Math.min(limit-gap-extent,candidate));
  };
  panel.style.setProperty('--menu-x',choose(x,w,width)+'px');
  panel.style.setProperty('--menu-y',choose(y,h,height)+'px');
}
function menuBody() { return toolColumns.at(-1)?.body || panel; }
function menuItems() { return [...menuBody().querySelectorAll('.menu-item:not(:disabled),input:not(:disabled),select:not(:disabled)')]; }
function keyboardAnchor() {
  const object = dom.get(selected) || (edgeId && [...svg.querySelectorAll('.hit')].find(e => e.dataset.edge === edgeId));
  const v = paper.getBoundingClientRect(), r = object?.getBoundingClientRect();
  if (r && r.right >= v.left && r.left <= v.right && r.bottom >= v.top && r.top <= v.bottom) {
    return {x:Math.min(v.right-8,r.right),y:Math.min(v.bottom-8,Math.max(v.top+8,(r.top+r.bottom)/2))};
  }
  if (lastPointer && lastPointer.x >= v.left && lastPointer.x < v.right && lastPointer.y >= v.top && lastPointer.y < v.bottom) return lastPointer;
  return {x:v.left+22,y:v.top+20};
}
function pbutton(label,fn,key='',disabled=false,klass='') {
  const button = document.createElement('button'); button.className = 'menu-item '+klass; button.disabled = disabled;
  const text = document.createElement('span'); text.textContent = label; button.append(text);
  if (key) { const hint = document.createElement('kbd'); hint.textContent = key; button.append(hint); }
  button.onclick = fn; menuBody().append(button); return button;
}
function divider() { menuBody().append(document.createElement('hr')); }
function markMenuFocus(target) {
  panel.querySelector('[data-menu-focus]')?.removeAttribute('data-menu-focus');
  if (target.matches('.tool-column .menu-item,.tool-column input,.tool-column select')) target.setAttribute('data-menu-focus','');
}
function focusMenuItem(target) {
  markMenuFocus(target);
  target.focus({preventScroll:true});
}
panel.addEventListener('focusin',e => markMenuFocus(e.target));
function focusMenu() { placePanel(); focusMenuItem(menuItems()[0] || menuBody()); }
function removeSelection() {
  finishEdit(); const before = capture();
  if (edgeId) { model.edges = model.edges.filter(e => e.id !== edgeId); edgeId = null; }
  else if (selected) {
    const id = selected; model.nodes = model.nodes.filter(n => n.id !== id); model.edges = model.edges.filter(e => e.a !== id && e.b !== id);
    for (const n of model.nodes) if (n.parentId === id) delete n.parentId;
    selected = null;
  }
  changed(before); closePanel(); render(); paper.focus({preventScroll:true});
}
function startLink(id) { finishEdit(); selected = id; edgeId = null; source = id; closePanel(); render(); announce('请选择要连接的文字，或点击空白创建目标。'); }
function openProps(anchor=null,returnTo=document.activeElement,submenu=false) {
  finishEdit(); const e = edge(edgeId), n = node(selected); if (!e && !n) { openFile(anchor,returnTo); return; }
  if (!submenu) showPanel('props',e ? '连线' : '文字',anchor,returnTo);
  if (e) {
    const label = document.createElement('label'); label.textContent = '关系'; const input = document.createElement('input'); input.maxLength = 80; input.value = e.label; input.setAttribute('aria-label','关系说明'); input.onchange = () => setEdgeAttr('label',input.value); label.append(input); menuBody().append(label);
    const field = (title,key,options) => {
      const label = document.createElement('label'); label.textContent = title; const select = document.createElement('select'); select.setAttribute('aria-label',title);
      for (const [value,text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
      select.value = e[key]; select.onchange = () => setEdgeAttr(key,select.value); label.append(select); menuBody().append(label);
    };
    field('线型','style',[['solid','实线'],['dash','虚线']]); field('方向','arrow',Object.entries(arrows));
    field('颜色','color',colors.map(c => [c,inks[c][1].split(' · ')[0]]));
    pbutton('反转起点与终点',() => { const before = capture(); [e.a,e.b] = [e.b,e.a]; changed(before); scheduleDraw(); });
    pbutton('删除连线',removeSelection,'Delete',false,'trash');
  } else {
    pbutton('继续编辑',() => { closePanel(); openEditor(n); });
    const sticky = pbutton(n.sticky ? '去掉便签背景' : '添加便签背景',() => {
      const before = capture();
      if (n.sticky) delete n.sticky; else n.sticky = true;
      changed(before); closePanel(true); render();
    },n.sticky ? '已开启' : '');
    sticky.setAttribute('aria-pressed',String(!!n.sticky));
    pbutton('新建子块',() => { closePanel(); extend('child'); },'Tab');
    pbutton('新建同级',() => { closePanel(); extend('sibling'); },'Enter');
    pbutton('从这里连线',() => startLink(n.id));
    const label = document.createElement('label'); label.textContent = '块颜色';
    const picker = document.createElement('select'); picker.setAttribute('aria-label','整块文字颜色');
    const runs = PaperEditor.normalizedRuns(n.text,n.color,n.runs), distinct = new Set(runs.map(r => r.color));
    if (distinct.size > 1) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '混合颜色'; option.disabled = true; picker.append(option);
    }
    for (const c of colors) {
      const option = document.createElement('option'); option.value = c; option.textContent = inks[c][1].split(' · ')[0]; picker.append(option);
    }
    picker.value = distinct.size > 1 ? '' : runs[0]?.color || n.color;
    picker.onchange = () => {
      const color = picker.value; if (!colors.includes(color)) return;
      const before = capture(); n.color = color; n.runs = n.text ? [{text:n.text,color}] : []; changed(before); render();
      picker.querySelector('option[value=""]')?.remove(); showInkHint(color,'整块文字');
    };
    label.append(picker); menuBody().append(label);
    pbutton('删除文字',removeSelection,'Delete',false,'trash');
  }
  focusMenu();
}
function exportJson() {
  flush();
  const current = workspace.active();
  const blob = new Blob([JSON.stringify({version:2,title:current.title,...savedModel()},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = current.title.replace(/[\\/:*?"<>|]/g,'_')+'.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); closePanel();
}
function example() {
  const texts = [['一个问题，几条思路','black',80,70],['先写下，再归纳','black',80,172],['从哪一步开始？','gray',370,120],['新的联系','blue',370,230],['别漏掉前提','red',80,300]];
  const nodes = texts.map(([text,color,x,y]) => ({id:newId(),text,color,x,y}));
  return {nodes,edges:[[0,1],[1,3],[2,3]].map(([a,b]) => ({id:newId(),a:nodes[a].id,b:nodes[b].id,style:'solid',arrow:'single',color:'gray',label:''}))};
}
function openFile(anchor=null,returnTo=document.activeElement) {
  finishEdit(); showPanel('file','草稿与操作',anchor,returnTo);
  pbutton('新建草稿',() => addTab(),window.paperDesktop ? 'Ctrl+T' : ''); pbutton('重命名',() => renameTab(),'F2');
  pbutton('关闭当前标签',() => closeTab(),window.paperDesktop ? 'Ctrl+W' : '');
  pbutton('恢复最近关闭',() => reopenTab(),window.paperDesktop ? 'Ctrl+Shift+T' : '',!workspace.state.closedIds.length);
  if (workspace.state.closedIds.length) pbutton('查看已关闭草稿',openClosed);
  divider(); pbutton('立即保存',() => { flush(); closePanel(); },'Ctrl+S');
  pbutton('导出当前草稿',exportJson,'Ctrl+Shift+E'); pbutton('导入为新标签',() => $('upload').click(),'Ctrl+O');
  pbutton('打印 / 保存 PDF',() => { closePanel(); window.print(); },'Ctrl+P');
  if (window.paperDesktop) pbutton('保存截图',() => { closePanel(); window.paperDesktop.saveScreenshot(); },'Ctrl+Shift+S');
  divider(); pbutton('显示全部',() => { closePanel(); fit(); },'Ctrl+0');
  pbutton('新标签查看示例',() => addTab(example(),'示例'));
  pbutton('快捷键与操作',showHelp,'F1');
  focusMenu();
}
const toolGroups = {
  ink:'笔颜色', line:'线型', draft:'草稿与标签', edit:'编辑与对象', transfer:'保存与导出', view:'画布与视野', settings:'设置'
};
function toggleTools() {
  if (dialogOpen() || editing?.controller.isComposing() || renaming) return;
  if (!panel.hidden && toolPage) { closePanel(true); return; }
  const anchor = keyboardAnchor(), origin = document.activeElement;
  closePanel(); toolTarget = editing?.host || origin;
  toolEditorSelection = editing?.controller.getSelection() || null;
  panelAnchor = anchor;
  showTools('root');
}
function removeToolColumns(keep) {
  while (toolColumns.length > keep) {
    const {body,owner} = toolColumns.pop();
    owner?.setAttribute('aria-expanded','false');
    body.remove();
  }
  toolPage = toolColumns.at(-1)?.page || '';
}
function showTools(page,owner=null) {
  const anchor = panelAnchor, origin = toolTarget;
  if (!owner) {
    showPanel('tools','工具',anchor,origin);
    panel.replaceChildren();
  } else {
    const parentIndex = toolColumns.findIndex(c => c.body.contains(owner));
    if (parentIndex < 0) return;
    removeToolColumns(parentIndex+1);
  }
  toolPage = page;
  const body = document.createElement('section');
  const title = page === 'root' ? '工具' : page === 'object' ? (edge(edgeId) ? '连线' : '文字') :
    page === 'closed' ? '已关闭草稿' : toolGroups[page];
  body.className = 'tool-column'; body.tabIndex = -1; body.id = 'tool-column-'+page;
  body.setAttribute('aria-label',title);
  const heading = document.createElement('strong'); heading.textContent = title; body.append(heading);
  if (!owner) {
    const close = document.createElement('button'); close.className = 'close'; close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label','关闭菜单'); close.onclick = () => closePanel(true); body.append(close);
  } else owner.setAttribute('aria-expanded','true');
  panel.append(body); toolColumns.push({page,body,owner}); panel.setAttribute('data-cascade','');
  if (page === 'object') { openProps(anchor,origin,true); return; }
  if (page === 'closed') { openClosed(true); return; }
  const branch = (id,label) => {
    const b = pbutton(label,() => showTools(id,b),'→'); b.dataset.menuPage = id;
    b.setAttribute('aria-label',label+'，进入子菜单');
    b.setAttribute('aria-expanded','false');
    b.setAttribute('aria-controls','tool-column-'+id);
    return b;
  };
  if (page === 'root') {
    for (const [id,title] of Object.entries(toolGroups)) {
      branch(id,title);
      if (id === 'line') {
        const locked = preferences.zoomLocked;
        const button = pbutton(locked ? '解锁触控板缩放' : '锁定触控板缩放',toggleZoomLock,
          locked ? '已锁定' : '未锁定');
        button.setAttribute('aria-pressed',String(locked));
      }
    }
    pbutton('快捷键与操作',showHelp,'F1');
  } else if (page === 'ink') {
    for (const c of colors) {
      const active = (editing?.controller.getColor() || ink) === c;
      const button = pbutton(inks[c][1],() => {closePanel(true);setInk(c);},active ? '当前' : '');
      button.style.color = inks[c][0];
    }
  } else if (page === 'line') {
    const current = edge(edgeId);
    for (const [style,label] of [['solid','实线'],['dash','虚线']]) {
      pbutton(label,() => {
        closePanel(true);
        if (current) {setEdgeAttr('style',style);showActionHint(current.color,'线型',label);}
        else {preferences.lineStyle=style;savePreferences();showActionHint(ink,'下一条线',label);}
      },(current?.style || preferences.lineStyle)===style ? '当前' : '');
    }
    divider();
    for (const [mode,label] of Object.entries(arrows)) pbutton(label,() => {closePanel(true);setEdgeAttr('arrow',mode);},current?.arrow===mode ? '当前' : '',!current);
  } else if (page === 'draft') {
    pbutton('新建草稿',() => addTab(),window.paperDesktop ? 'Ctrl+T' : ''); pbutton('重命名',() => renameTab(),'F2');
    pbutton('关闭当前标签',() => closeTab(),'Ctrl+W');
    pbutton('恢复最近关闭',() => reopenTab(),window.paperDesktop ? 'Ctrl+Shift+T' : '',!workspace.state.closedIds.length);
    if (workspace.state.closedIds.length) branch('closed','查看已关闭草稿');
  } else if (page === 'edit') {
    const history = historyFor();
    pbutton('撤销',() => {closePanel();undo();},'Ctrl+Z',!history.past.length);
    pbutton('重做',() => {closePanel();redo();},'Ctrl+Y',!history.future.length);
    if (node(selected) || edge(edgeId)) branch('object','当前对象');
    pbutton('新建文字块',() => {closePanel();freshIdea();},'Ctrl+Enter');
  } else if (page === 'transfer') {
    pbutton('立即保存',() => {flush();closePanel(true);},'Ctrl+S');
    pbutton('导出当前草稿',exportJson,'Ctrl+Shift+E');
    pbutton('导入为新标签',() => {closePanel();$('upload').click();},'Ctrl+O');
    pbutton('打印 / 保存 PDF',() => {closePanel();window.print();},'Ctrl+P');
    if (window.paperDesktop) pbutton('保存截图',() => {closePanel();window.paperDesktop.saveScreenshot();},'Ctrl+Shift+S');
  } else if (page === 'view') {
    pbutton('显示全部',() => {closePanel(true);fit();},'Ctrl+0');
    pbutton('放大',() => {closePanel(true);zoom(cam.z*1.15,center());},'Ctrl++');
    pbutton('缩小',() => {closePanel(true);zoom(cam.z/1.15,center());},'Ctrl+-');
    pbutton('新标签查看示例',() => addTab(example(),'示例'));
  } else if (page === 'settings') {
    const setting = (label,description,apply) => {
      const button = pbutton(label,() => {apply();savePreferences();value.textContent = description();});
      const value = document.createElement('kbd'); value.textContent = description(); button.append(value);
    };
    setting('换色提示',() => preferences.inkHint ? '开' : '关',() => { preferences.inkHint = !preferences.inkHint; if (!preferences.inkHint) $('ink-hint').hidden = true; });
    pbutton('触控板诊断',() => { closePanel(true); beginTouchpadProbe(); },'8 秒');
    if (window.paperDesktop?.probeShortcuts) pbutton('快捷键诊断',() => { closePanel(true); void runShortcutProbe(); },'8 秒');
    const delays = [300,440,650];
    setting('悬停拖动等待',() => preferences.hoverDelay+' ms',() => {preferences.hoverDelay = delays[(delays.indexOf(preferences.hoverDelay)+1)%delays.length];});
  }
  focusMenu();
}
function backTools() {
  if (toolColumns.length < 2) return false;
  const {owner} = toolColumns.at(-1);
  removeToolColumns(toolColumns.length-1);
  placePanel();
  focusMenuItem(owner);
  return true;
}
function openClosed(submenu=false) {
  if (submenu !== true) showPanel('closed','已关闭草稿',panelAnchor,panelReturn);
  const state = workspace.state;
  for (const id of [...state.closedIds].reverse()) { const doc = state.documents.find(d => d.id === id); pbutton(doc.title,() => reopenTab(id)); }
  focusMenu();
}
function showHelp() { finishEdit(); closePanel(); $('manual').showModal(); }
$('save-error').onclick = () => {
  showPanel('save','保存遇到问题'); const text = document.createElement('p'); text.textContent = saveError; panel.append(text);
  pbutton('重新保存',() => { if (flush()) closePanel(); }); pbutton('导出当前草稿',exportJson); focusMenu();
};
$('new-tab').onclick = () => addTab();
document.querySelector('.pages').addEventListener('pointerdown',e => {
  // Capture the current caret in activate/close, before the browser blurs it.
  if (editing && e.button === 0 && !e.target.closest('input')) e.preventDefault();
});
$('file').onclick = () => panelType === 'file' ? closePanel(true) : openFile(null,$('file')); $('fit').onclick = fit;
$('undo').onclick = undo; $('redo').onclick = redo;
for (const id of ['undo','redo','fit']) $(id).addEventListener('pointerdown',e => e.preventDefault());
$('inspect-more').onclick = () => panelType === 'props' ? closePanel(true) : openProps(null,$('inspect-more'));
$('stroke-style').onchange = () => setEdgeAttr('style',$('stroke-style').value);
$('stroke-arrow').onchange = () => setEdgeAttr('arrow',$('stroke-arrow').value);
for (const [key,[color,label]] of Object.entries(inks)) {
  const button = document.createElement('button'); button.className = 'swatch'; button.dataset.ink = key; button.style.setProperty('--ink-color',color); button.setAttribute('aria-label',label); button.title = label;
  const dot = document.createElement('span'); dot.setAttribute('aria-hidden','true'); button.append(dot);
  // Apply before the browser/IME can move focus off the insertion point.
  // Device clicks are handled here; keyboard and assistive activation use click.
  button.addEventListener('pointerdown',e => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault(); chooseInk(key);
  });
  button.addEventListener('mousedown',e => e.preventDefault());
  button.addEventListener('click',e => { if (e.detail === 0) chooseInk(key); });
  $('palette').append(button);
}
$('upload').onchange = async () => {
  const file = $('upload').files[0]; $('upload').value = ''; if (!file) return;
  try { if (file.size > 8*1024*1024) throw Error('文件超过 8 MB'); const raw = JSON.parse(await file.text()); addTab(normalize(raw),typeof raw.title === 'string' ? raw.title : file.name.replace(/\.json$/i,'')); }
  catch (error) { showPanel('error','无法导入'); const text = document.createElement('p'); text.textContent = '请选用有效的草稿 JSON。'+error.message; panel.append(text); }
};

function dialogOpen() { return !!document.querySelector('dialog[open]'); }
function freshIdea() {
  const p = center(); newNote((p.x-cam.x)/cam.z,(p.y-cam.y)/cam.z,{place:true});
}
function navigateNodes(direction) {
  if (!model.nodes.length) return;
  const current = node(selected);
  if (!current) { selectNode(model.nodes[0].id); dom.get(selected)?.focus({preventScroll:true}); return; }
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight', sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1;
  const candidates = model.nodes.filter(n => n.id !== current.id).map(n => {
    const dx = n.x-current.x, dy = n.y-current.y, main = (horizontal ? dx : dy)*sign;
    return {n,main,score:main+Math.abs(horizontal ? dy : dx)*1.8};
  }).filter(c => c.main > 0).sort((a,b) => a.score-b.score);
  if (candidates[0]) { selected = candidates[0].n.id; edgeId = null; render(); reveal(candidates[0].n); dom.get(selected)?.focus({preventScroll:true}); }
}
function connectTarget(id) {
  if (!source || source === id) return;
  const before = capture(), result = createEdge(source,id); source = null;
  if (result) { selected = null; edgeId = result.id; changed(before); render(); }
}
document.addEventListener('keydown',e => {
  if (e.key === 'Control') heldControls.add(e.code || e.key);
},true);
document.addEventListener('keyup',e => {
  if (e.key === 'Control') heldControls.delete(e.code || e.key);
},true);
document.addEventListener('keydown',e => {
  if (e.altKey || e.getModifierState?.('AltGraph')) return;
  const key = e.key || '', k = key.toLowerCase(), cmd = e.ctrlKey || e.metaKey;
  const field = e.target.closest?.('input,select,dialog');
  if ((key === 'F17' || e.code === 'F17' || e.keyCode === 128 || key === 'F18' || e.code === 'F18' || e.keyCode === 129) && !field) {
    e.preventDefault(); if (!e.repeat) stepPaperShortcut(key === 'F17' || e.code === 'F17' || e.keyCode === 128 ? 'F17' : 'F18'); return;
  }
  if (e.isComposing || e.keyCode === 229 || editing?.controller?.isComposing(e)) return;
  if (cmd && k === 's' && !e.shiftKey) { e.preventDefault(); flush(); return; }
  const inPanel = !panel.hidden && panel.contains(e.target);
  if (key === 'Escape') {
    if (cmd || e.shiftKey || dialogOpen() || renaming || (!inPanel && field)) return;
    e.preventDefault();
    if (e.repeat) return;
    if (!panel.hidden) closePanel(true);
    else if (source || gesture || pinch || preview) {
      cancelMoveIfActive(); gesture = pinch = preview = null; source = null; points.clear();
      clearGestureCursor(); clearHover(); render();
    } else toggleTools();
    return;
  }
  if ((key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) && !dialogOpen() && (!field || inPanel)) {
    e.preventDefault(); if (e.repeat) return;
    if (inPanel) closePanel(true); else openProps(keyboardAnchor(),document.activeElement);
    return;
  }
  if (inPanel) {
    if (toolPage && !cmd) {
      if (key === 'ArrowRight' && e.target.dataset.menuPage) { e.preventDefault(); e.target.click(); return; }
      if (key === 'ArrowLeft' && !e.target.matches('input') && backTools()) { e.preventDefault(); return; }
    }
    if (!cmd && (key === 'ArrowDown' || key === 'ArrowUp')) {
      const items = menuItems();
      if (!items.length) return;
      e.preventDefault();
      const index = items.indexOf(document.activeElement), down = key === 'ArrowDown';
      const next = items[index < 0 ? (down ? 0 : items.length-1) : (index+(down ? 1 : items.length-1))%items.length];
      if (toolPage) { focusMenuItem(next); next.scrollIntoView({block:'nearest'}); }
      else next.focus();
      return;
    }
    if (key === 'Enter' && e.target.matches('button:not(:disabled)')) {
      e.preventDefault(); if (!e.repeat) e.target.click();
    } else if (key === 'Enter' && e.target.matches('select') && e.target.showPicker) {
      try { e.target.showPicker(); e.preventDefault(); } catch { /* Keep the native Enter fallback. */ }
    } else if (key === 'Enter' && e.target.matches('input')) {
      e.preventDefault(); e.target.blur(); e.target.focus({preventScroll:true});
    }
    return; // Keep Space and Tab native.
  }
  if (field) return;
  if (cmd && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (cmd && k === 'y') { e.preventDefault(); redo(); return; }
  if (cmd && k === 't' && !e.shiftKey && window.paperDesktop) { e.preventDefault(); addTab(); return; }
  if (cmd && k === 't' && e.shiftKey && window.paperDesktop) { e.preventDefault(); reopenTab(); return; }
  if (cmd && k === 'w' && window.paperDesktop) { e.preventDefault(); closeTab(); return; }
  if (cmd && (key === 'PageUp' || key === 'PageDown')) { e.preventDefault(); nextTab(key === 'PageUp' ? -1 : 1); return; }
  if (key === 'F2') { e.preventDefault(); renameTab(); return; }
  if (key === 'F1') { e.preventDefault(); showHelp(); return; }
  if (cmd && k === 'e' && e.shiftKey) { e.preventDefault(); exportJson(); return; }
  if (cmd && k === 'o') { e.preventDefault(); $('upload').click(); return; }
  if (cmd && k === 'p') { e.preventDefault(); finishEdit(); closePanel(); window.print(); return; }
  if (cmd && key === 'Enter') { e.preventDefault(); freshIdea(); return; }
  if (cmd && ['+','=','-','0'].includes(key)) { e.preventDefault(); if (key === '0') fit(); else zoom(cam.z*(key === '-' ? 1/1.15 : 1.15),center()); return; }
  if (e.target.closest?.('#tabs') && ['ArrowLeft','ArrowRight'].includes(key)) {
    e.preventDefault(); nextTab(key === 'ArrowLeft' ? -1 : 1); $('tabs').querySelector('[aria-selected="true"]')?.focus(); return;
  }
  if (e.target.closest?.('button') || e.target.closest?.('#panel')) return;
  if (source && !editing && (key === 'Enter' || key === 'Tab')) {
    e.preventDefault();
    if (key === 'Enter') connectTarget(selected);
    else { const index = model.nodes.findIndex(n => n.id === selected); selected = model.nodes[(index+1)%model.nodes.length]?.id; render(); }
    return;
  }
  if ((editing || selected) && !cmd) {
    if (key === 'Tab' && !e.shiftKey) { e.preventDefault(); extend('child'); return; }
    if (key === 'Tab' && e.shiftKey) {
      const parent = node(node(editing?.id || selected)?.parentId); e.preventDefault();
      if (parent) { finishEdit(); selectNode(parent.id); openEditor(parent); } return;
    }
    if (key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); if (e.repeat) return;
      if (editing) {
        const id = editing.id; finishEdit();
        (dom.get(id) || paper).focus({preventScroll:true});
      } else extend('sibling');
      return;
    }
    if (key === 'Enter' && e.shiftKey && editing) { e.preventDefault(); editing.controller.insertText('\n'); return; }
  }
  if (editing) return;
  if (key === ' ' && !cmd) { e.preventDefault(); space = true; sync(); return; }
  if ((key === 'Delete' || key === 'Backspace') && (selected || edgeId)) { e.preventDefault(); removeSelection(); return; }
  if (key === 'Enter' && edgeId) { e.preventDefault(); openProps(keyboardAnchor()); return; }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key) && !cmd) { e.preventDefault(); navigateNodes(key); return; }
  if (key === 'Enter' && !selected && !edgeId) { e.preventDefault(); freshIdea(); }
});
document.addEventListener('paper-history',e => { e.preventDefault(); e.detail === 'redo' ? redo() : undo(); });
document.addEventListener('keyup',e => {
  if (e.key === ' ') { space = false; sync(); }
});
// The native bridge transports legacy -1/+1 values for F17/F18.
window.paperDesktop?.onColorStep?.(direction => stepPaperShortcut(direction === -1 ? 'F17' : 'F18'));

function queueWheelMotion(dx,dy,scale=0,anchor=null) {
  if (!(dx || dy || scale)) return;
  const last = wheelMotion.at(-1);
  if (!scale && last && !last.scale) { last.dx += dx; last.dy += dy; }
  else wheelMotion.push({dx,dy,scale,anchor});
  if (!wheelFrame) wheelFrame = requestAnimationFrame(() => { wheelFrame = 0; applyWheelPan(); });
}
function applyWheelPan() {
  if (wheelFrame) { cancelAnimationFrame(wheelFrame); wheelFrame = 0; }
  if (!wheelMotion.length) return;
  // Keep the order of different zoom origins and apply translation before zoom
  // within each native packet. Only publish the final camera once per frame.
  for (const {dx,dy,scale,anchor} of wheelMotion) {
    cam.x += dx; cam.y += dy;
    if (scale) zoomCamera(cam,cam.z*Math.exp(scale),anchor);
  }
  wheelMotion.length = 0;
  camera(false);
  // The viewport follows each display frame; save once the gesture settles.
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => {
    viewSaveTimer = 0;
    if (workspace && !loading) workspace.updateActive({cam});
  }, 100);
}
function touchpadMessage(value) {
  const feedback = $('touchpad-feedback');
  feedback.querySelector('span').textContent = value; feedback.hidden = false;
}
async function runShortcutProbe() {
  touchpadMessage('接下来 8 秒：在草稿纸里把有问题的 Caps 组合连续按两次。只统计 F17 和 F18。');
  try {
    const result = await window.paperDesktop.probeShortcuts();
    if (!result) return;
    const summary = Object.entries(result).map(([k,n]) => k+' 按下'+n.down+'/松开'+n.up+'/转发'+n.used+(n.repeat?' (重复'+n.repeat+')':''));
    touchpadMessage(summary.join(' · '));
  } catch { touchpadMessage('未能完成快捷键诊断。'); }
}
function beginTouchpadProbe() {
  clearTimeout(touchpadProbeTimer);
  touchpadProbe = {both:0,xOnly:0,yOnly:0,axisSwitches:0,lastAxis:'',maxMinorRatio:0,native:0,wheel:0};
  touchpadMessage('请在纸面上双指斜滑，再不抬手拐个弯。8 秒后显示结果。');
  touchpadProbeTimer = setTimeout(finishTouchpadProbe,8000);
}
function collectTouchpadSample(dx,dy,path) {
  const probe = touchpadProbe;
  if (!probe || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const x = Math.abs(dx), y = Math.abs(dy), axis = x > 0 && y > 0 ? 'both' : x > 0 ? 'xOnly' : y > 0 ? 'yOnly' : '';
  if (!axis) return;
  probe[axis]++; probe[path]++;
  if (probe.lastAxis && probe.lastAxis !== axis) probe.axisSwitches++;
  if (axis === 'both') probe.maxMinorRatio = Math.max(probe.maxMinorRatio,Math.round(100*Math.min(x,y)/Math.max(x,y)));
  probe.lastAxis = axis;
}
function finishTouchpadProbe() {
  if (!touchpadProbe) return;
  clearTimeout(touchpadProbeTimer);
  const {both,xOnly,yOnly,axisSwitches,maxMinorRatio,native,wheel} = touchpadProbe;
  touchpadProbe = null;
  window.paperDesktop?.saveTouchpadProbe?.({both,xOnly,yOnly,axisSwitches,maxMinorRatio,native,wheel}).catch(() => {});
  const total = both+xOnly+yOnly;
  touchpadMessage(total ? '触控板诊断：双轴 '+both+' / '+total+'；原生 '+native+'，滚轮 '+wheel+'。' : '没有收到滚动位移。请重新开始，再在纸面内双指滑动。');
}
$('touchpad-feedback').querySelector('button').onclick = () => {
  clearTimeout(touchpadProbeTimer); touchpadProbe = null; $('touchpad-feedback').hidden = true;
};
window.paperDesktop?.onTouchpad?.((dx,dy,scale,x,y) => {
  if (loading || gesture || !$('panel').hidden) return;
  clearHover();
  collectTouchpadSample(dx,dy,'native');
  const zoomStep = preferences.zoomLocked ? 0 : scale;
  const at = zoomStep ? (Number.isFinite(x) && Number.isFinite(y) ? relative(x,y) : center()) : null;
  queueWheelMotion(dx,dy,zoomStep,at);
});
paper.addEventListener('wheel',e => {
  e.preventDefault();
  const mode = e.deltaMode;
  clearHover();
  const dx = e.deltaX*(mode === 1 ? 18 : mode === 2 ? paper.clientWidth : 1);
  const dy = e.deltaY*(mode === 1 ? 18 : mode === 2 ? paper.clientHeight : 1);
  if (e.ctrlKey || e.metaKey) {
    // Chromium also represents a trackpad pinch as Ctrl+wheel, without a Control keydown.
    const implicitTrackpadPinch = e.ctrlKey && !e.metaKey && !heldControls.size;
    if (!implicitTrackpadPinch || !preferences.zoomLocked) queueWheelMotion(0,0,-dy*.006,relative(e.clientX,e.clientY));
    return;
  }
  if (e.isTrusted) collectTouchpadSample(dx,dy,'wheel');
  // Consume X and Y as supplied; never filter, swap or favor either axis in the app.
  queueWheelMotion(-dx,-dy);
},{passive:false});
function moveCohort(n) {
  return (n.parallelId ? model.nodes.filter(m => m.parallelId === n.parallelId) : [n])
    .map(item => ({item,x:item.x,y:item.y}));
}
function applyCohort(cohort,dx,dy) {
  for (const pos of cohort) { pos.item.x = pos.x+dx; pos.item.y = pos.y+dy; }
}
function cancelMoveIfActive() {
  if (gesture?.type === 'move' && gesture.moved) { applyCohort(gesture.cohort,0,0); render(); }
}
function clearHover() {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = 0; hover = null;
  if (movable) dom.get(movable)?.classList.remove('move-ready');
  movable = null;
}
function noteHover(e) {
  const target = e.target.closest('[data-node]');
  const id = target?.dataset.node;
  if (space || e.buttons || e.pointerType === 'touch' || !panel.hidden || !node(id) || editing?.id === id) { clearHover(); return; }
  if (movable === id) return;
  if (hover?.id === id && Math.hypot(e.clientX-hover.x,e.clientY-hover.y) < 5) return;
  clearHover(); hover = {id,x:e.clientX,y:e.clientY};
  hoverTimer = setTimeout(() => {
    hoverTimer = 0;
    if (hover?.id !== id || gesture || !panel.hidden || editing?.id === id) return;
    const current = document.elementFromPoint(hover.x,hover.y)?.closest('[data-node]');
    if (current?.dataset.node !== id) { clearHover(); return; }
    movable = id; dom.get(id)?.classList.add('move-ready');
  },preferences.hoverDelay);
}
function clearGestureCursor() { delete paper.dataset.gesture; paper.classList.remove('grabbing'); }
const points = new Map();
function noteHit(x,y,target,allowNear=true) {
  const direct = target?.closest('[data-node]');
  if (direct) return direct.dataset.node;
  if (!allowNear) return null;
  // A few screen pixels of tolerance around actual blocks, independent of zoom.
  for (const [dx,dy] of [[0,-4],[-4,0],[4,0],[0,4]]) {
    const block = document.elementFromPoint(x+dx,y+dy)?.closest('[data-node]');
    if (block && noteLayer.contains(block)) return block.dataset.node;
  }
  return null;
}
function fingers() {
  const [a,b] = points.values();
  return {p:relative((a.x+b.x)/2,(a.y+b.y)/2),dist:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};
}
function stepScreenZoom(g,e) {
  const step = g.lastY - e.clientY;
  g.lastY = e.clientY;
  if (step && (e.ctrlKey || heldControls.size)) queueWheelMotion(0,0,step*.008,g.anchor);
}
paper.addEventListener('pointerdown',e => {
  if (e.target.closest('button')) return;
  if (e.pointerType === 'touch') {
    if (gesture?.type === 'touchZoom') { e.preventDefault(); return; }
    if (!points.size && e.button === 0 && (e.ctrlKey || heldControls.size) && panel.hidden && !dialogOpen()) {
      e.preventDefault(); clearHover(); applyWheelPan();
      points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      gesture = {id:e.pointerId,type:'touchZoom',lastY:e.clientY,anchor:relative(e.clientX,e.clientY)};
      paper.setPointerCapture?.(e.pointerId); return;
    }
    points.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (points.size === 2) {
      cancelMoveIfActive();
      gesture = null; preview = null; clearGestureCursor(); clearHover(); scheduleDraw(); pinch = {...fingers(),cam:{...cam}}; e.preventDefault(); return;
    }
    if (points.size > 1 || pinch) return;
  }
  // Windows can emit contextmenu before pointerup. Let the dedicated context
  // event choose the object, without capturing or suppressing the right click.
  if (![0,1].includes(e.button)) return;
  const inEditor = e.target.closest('.editor');
  if (inEditor && e.button === 0 && !space) return;
  const lid = e.target.closest('[data-edge]')?.dataset.edge;
  const id = noteHit(e.clientX,e.clientY,e.target,!lid), canMove = !!id && movable === id;
  clearHover();
  const beforeInteraction = capture();
  const pan = e.button === 1 || space;
  if (!pan && id) finishEdit();
  e.preventDefault(); applyWheelPan();
  const base = {id:e.pointerId,x:e.clientX,y:e.clientY,moved:false,cx:cam.x,cy:cam.y};
  if (pan) gesture = {...base,type:'pan'};
  else if (source) gesture = {...base,type:'connectTap',nodeId:id};
  else if (id && node(id)) {
    const n = node(id);
    gesture = canMove ? {...base,type:'move',n,cohort:moveCohort(n),before:beforeInteraction} : {...base,type:'note',from:id};
  }
  else if (lid) gesture = {...base,type:'edge',lid};
  else gesture = {...base,type:'blank'};
  paper.setPointerCapture?.(e.pointerId);
});
paper.addEventListener('pointermove',e => {
  lastPointer = {x:e.clientX,y:e.clientY};
  if (points.has(e.pointerId)) points.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if (gesture?.type === 'touchZoom' && gesture.id === e.pointerId) { stepScreenZoom(gesture,e); return; }
  if (pinch && points.size >= 2) {
    const f = fingers(), z = Math.max(.2,Math.min(3,pinch.cam.z*f.dist/pinch.dist));
    cam = {z,x:f.p.x-(pinch.p.x-pinch.cam.x)*z/pinch.cam.z,y:f.p.y-(pinch.p.y-pinch.cam.y)*z/pinch.cam.z}; camera(); return;
  }
  if (gesture?.id !== e.pointerId) { if (!gesture && !pinch) noteHover(e); return; }
  const g = gesture, dx = e.clientX-g.x, dy = e.clientY-g.y;
  const takingPan = g.type === 'pan';
  if (Math.hypot(dx,dy) > (e.pointerType === 'touch' ? 7 : takingPan ? 2 : 4)) g.moved = true;
  if (!g.moved) return;
  if (g.type === 'note') {
    paper.dataset.gesture = 'link';
    const target = noteHit(e.clientX,e.clientY,document.elementFromPoint(e.clientX,e.clientY));
    preview = target === g.from ? null : {id:g.from,target,...world(e.clientX,e.clientY)};
    scheduleDraw();
  }
  if (g.type === 'move') {
    paper.dataset.gesture = 'move';
    applyCohort(g.cohort,dx/cam.z,dy/cam.z);
    if (!g.dragStarted) {
      g.dragStarted = true; selected = g.n.id; edgeId = null; render();
    } else {
      for (const {item} of g.cohort) {
        const element = dom.get(item.id);
        if (element) { element.style.left = item.x+'px'; element.style.top = item.y+'px'; }
      }
      scheduleDraw();
    }
  }
  if (takingPan) { cam.x = g.cx+dx; cam.y = g.cy+dy; camera(false); paper.classList.add('grabbing'); }
});
function tapConnect(id,p) {
  if (!source) return;
  if (source === id) { source = null; render(); return; }
  if (id) connectTarget(id);
  else { const from = source; source = null; newNote(p.x,p.y,{parent:from}); }
}
paper.addEventListener('pointerup',e => {
  points.delete(e.pointerId);
  if (pinch) { if (!points.size) pinch = null; return; }
  if (gesture?.id !== e.pointerId) return;
  const g = gesture; gesture = null; clearGestureCursor();
  if (paper.hasPointerCapture?.(e.pointerId)) paper.releasePointerCapture(e.pointerId);
  if (g.type === 'touchZoom') { stepScreenZoom(g,e); applyWheelPan(); return; }
  if (g.type === 'pan' && g.moved) {
    cam.x = g.cx + e.clientX-g.x; cam.y = g.cy + e.clientY-g.y; camera(); return;
  }
  const p = world(e.clientX,e.clientY);
  if (g.type === 'blank' && !g.moved) { finishEdit(); closePanel(); newNote(p.x,p.y); }
  if (g.type === 'move') {
    if (g.moved) { changed(g.before); selectNode(g.n.id); dom.get(g.n.id)?.focus({preventScroll:true}); }
    else { selectNode(g.n.id); openEditor(g.n,null,{x:e.clientX,y:e.clientY}); }
  }
  if (g.type === 'edge' && !g.moved) { finishEdit(); selectEdge(g.lid); paper.focus({preventScroll:true}); }
  if (g.type === 'connectTap' && !g.moved) { finishEdit(); tapConnect(g.nodeId,p); }
  if (g.type === 'note' && !g.moved) { selectNode(g.from); openEditor(node(g.from),null,{x:e.clientX,y:e.clientY}); }
  if (g.type === 'note' && g.moved) {
    preview = null;
    if (g.moved) {
      const target = document.elementFromPoint(e.clientX,e.clientY);
      const id = noteHit(e.clientX,e.clientY,target);
      const rect = paper.getBoundingClientRect();
      if (id && id !== g.from) { const before = capture(), link = createEdge(g.from,id); changed(before); if (link) selectEdge(link.id); }
      else if (!id && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) newNote(p.x,p.y,{parent:g.from});
      scheduleDraw();
    }
  }
});
function cancelGesture(e) {
  points.delete(e.pointerId); if (!points.size) pinch = null;
  if (gesture?.id !== e.pointerId) return;
  cancelMoveIfActive();
  if (gesture.type === 'pan' && gesture.moved) camera();
  if (gesture.type === 'touchZoom') applyWheelPan();
  gesture = null; preview = null; scheduleDraw(); clearGestureCursor();
}
paper.addEventListener('pointercancel',cancelGesture);
paper.addEventListener('pointerleave',clearHover);
function showPaperContext(target,anchor) {
  const hit = target.closest('[data-node],[data-edge]');
  const lid = hit?.dataset.edge;
  const id = hit?.dataset.node || (!lid && noteHit(anchor.x,anchor.y,target));
  if (id && node(id)) { selectNode(id); openProps(anchor,dom.get(id)); }
  else if (lid && edge(lid)) { selectEdge(lid); openProps(anchor,paper); }
  else openFile(anchor,paper);
}
paper.addEventListener('contextmenu',e => {
  e.preventDefault();
  showPaperContext(e.target,e.clientX || e.clientY ? {x:e.clientX,y:e.clientY} : keyboardAnchor());
});
document.addEventListener('pointerdown',e => {
  if (!panel.hidden && !e.target.closest('#panel,#file,#inspect-more,#save-error')) closePanel();
});
window.addEventListener('blur',() => { heldControls.clear(); space = false; cancelMoveIfActive(); gesture = null; pinch = null; points.clear(); preview = null; clearHover(); clearGestureCursor(); sync(); flush(); });
window.addEventListener('pagehide',flush);
window.addEventListener('beforeunload',flush);
document.addEventListener('visibilitychange',() => { if (document.hidden) flush(); });
window.addEventListener('resize',() => { scheduleDraw(); placePanel(); placeInkHint(); });
window.addEventListener('beforeprint',() => {
  finishEdit(); if (!model.nodes.length) return;
  const boxes = model.nodes.map(size), x = Math.min(...boxes.map(r => r.x)), y = Math.min(...boxes.map(r => r.y));
  const w = Math.max(...boxes.map(r => r.x+r.w))-x, h = Math.max(...boxes.map(r => r.y+r.h))-y, pad = 30, z = Math.min(1,550/(w+pad*2),720/(h+pad*2));
  paper.style.setProperty('--print-w',Math.ceil((w+pad*2)*z)+'px'); paper.style.setProperty('--print-h',Math.ceil((h+pad*2)*z)+'px');
  paper.style.setProperty('--print-t','translate('+((pad-x)*z)+'px,'+((pad-y)*z)+'px) scale('+z+')');
});
let storage, hadWorkspace = false;
try { storage = window.localStorage; hadWorkspace = !!storage.getItem(PaperWorkspace.DEFAULT_KEY); } catch (error) { reportSaveError(error); }
workspace = PaperWorkspace.create({storage,normalize,makeId:newId,onError:reportSaveError});
loadDocument(false);
if (!hadWorkspace && model.nodes.length) fit();
