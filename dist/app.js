'use strict';
const $ = id => document.getElementById(id);
const paper = $('paper'), board = $('board'), noteLayer = $('notes'), svg = $('links'), panel = $('panel');
const inks = {black:['#322b25','黑 · 正文'],red:['#ad3536','红 · 重点、易错'],blue:['#285f94','蓝 · 启发、观点'],gray:['#796e61','铅 · 想法、待定']};
const colors = Object.keys(inks);
const newId = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
const blank = () => ({nodes:[], edges:[]});
const clone = value => JSON.parse(JSON.stringify(value));
let model = blank(), selected = null, edgeId = null, ink = 'black', source = null, editing = null;
let cam = {x:0,y:0,z:1}, gesture = null, pinch = null, preview = null, space = false, panelType = '';
let workspace, loading = true, drawFrame = 0, wheelFrame = 0, saveError = '', renaming = false;
let wheelDelta = {x:0,y:0}, lastPointer = null;
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
    return result;
  });
  for (const n of nodes) if (!ids.has(n.parentId) || n.parentId === n.id) delete n.parentId;
  const edges = raw.edges.map(e => {
    if (!e || typeof e.id !== 'string' || !e.id || edgeIds.has(e.id) || !ids.has(e.a) || !ids.has(e.b) || e.a === e.b) throw Error('连线数据不正确');
    edgeIds.add(e.id);
    return {id:e.id,a:e.a,b:e.b,style:e.style === 'dash' ? 'dash' : 'solid',arrow:['none','single','double'].includes(e.arrow) ? e.arrow : 'none',color:colors.includes(e.color) ? e.color : 'gray',label:typeof e.label === 'string' ? e.label.slice(0,80) : '',...(e.kind === 'child' ? {kind:'child'} : {})};
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

function camera(save = true) {
  board.style.transform = 'translate(' + cam.x + 'px,' + cam.y + 'px) scale(' + cam.z + ')';
  $('fit').textContent = Math.round(cam.z * 100) + '%';
  if (save && workspace && !loading) workspace.updateActive({cam});
}
function relative(x,y) { const b = paper.getBoundingClientRect(); return {x:x-b.left,y:y-b.top}; }
function world(x,y) { const p = relative(x,y); return {x:(p.x-cam.x)/cam.z,y:(p.y-cam.y)/cam.z}; }
function center() { return {x:paper.clientWidth/2,y:paper.clientHeight/2}; }
function zoom(z,p) {
  applyWheelPan();
  z = Math.min(3,Math.max(.2,z));
  cam.x = p.x - (p.x-cam.x)*z/cam.z; cam.y = p.y - (p.y-cam.y)*z/cam.z; cam.z = z; camera();
}
function size(n) { const d = dom.get(n.id); return {x:n.x,y:n.y,w:d?.offsetWidth || 220,h:d?.offsetHeight || 32}; }
function svgEl(tag,attrs) { const t = document.createElementNS('http://www.w3.org/2000/svg',tag); Object.entries(attrs).forEach(([k,v]) => t.setAttribute(k,v)); return t; }
function scheduleDraw() { if (!drawFrame) drawFrame = requestAnimationFrame(() => { drawFrame = 0; draw(); }); }
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
  const port = document.createElement('button'); port.className = 'port'; port.type = 'button'; port.textContent = '+'; port.setAttribute('aria-label','从此处连线');
  d.append(number,content,port); noteLayer.append(d); dom.set(n.id,d); return d;
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
  scheduleDraw(); sync();
}
function sync() {
  if (!workspace) return;
  const h = historyFor(); $('undo').disabled = !h.past.length; $('redo').disabled = !h.future.length;
  paper.classList.toggle('pan',space);
  const e = edge(edgeId), n = node(selected), active = e?.color || (editing ? ink : n?.color || ink);
  $('inspector-name').textContent = e ? '连线' : editing ? '输入' : n ? '文字' : '笔色';
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
  finishEdit(); closePanel(); selected = n.id; edgeId = null; source = null;
  const host = document.createElement('div'); host.className = 'editor'; host.setAttribute('aria-label','草稿文字');
  editing = {id:n.id,host,controller:null};
  render(); dom.get(n.id).insertBefore(host,dom.get(n.id).querySelector('.port'));
  const controller = PaperEditor.create({host,node:n,inks,typingColor:ink,
    onChange(value,meta) {
      if (!editing || editing.id !== n.id) return;
      const before = editing.colorBefore || capture(meta.beforeSelection);
      n.text = value.text; n.runs = value.runs;
      const group = meta.kind === 'input' || meta.kind === 'composition' ? 'typing:'+n.id : null;
      changed(before,group); scheduleDraw(); reveal(n);
    },
    onSelectionChange() {
      if (editing?.controller) { ink = editing.controller.getColor(); sync(); }
    }
  });
  editing.controller = controller;
  controller.focus({end:true});
  if (selection) controller.setSelection(selection.start,selection.end,selection.direction);
  else if (point) {
    const range = document.caretRangeFromPoint?.(point.x,point.y);
    if (range && host.contains(range.startContainer)) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  }
  host.addEventListener('blur',() => {
    queueMicrotask(() => { if (editing?.host === host && !host.contains(document.activeElement)) finishEdit(); });
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
  const e = {id:newId(),a,b,style:'solid',arrow,color:ink,label:'',...(kind ? {kind} : {})}; model.edges.push(e); return e;
}
function newNote(x,y,{parent=null,child=false,arrow='none',order=null,place=false,before:nullBefore=null}={}) {
  finishEdit(); const before = nullBefore || capture();
  if (place) ({x,y} = freeSpot(x,y));
  const n = {id:newId(),x:Math.round(x),y:Math.round(y),text:'',color:ink,...(order ? {order} : {})};
  if (child && node(parent)) n.parentId = parent;
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
  else newNote(n.x,n.y+s.h+20,{parent:n.parentId || null,child:!!n.parentId,arrow:n.parentId ? 'single' : 'none',order,place:true,before});
}
function selectNode(id) {
  if (editing?.id !== id) finishEdit();
  selected = id; edgeId = null;
  if (node(id)) ink = node(id).color;
  closePanel(); render();
}
function selectEdge(id,properties=false) { finishEdit(); selected = null; edgeId = id; closePanel(); render(); if (properties) openProps(); }
function setInk(c) {
  if (!colors.includes(c)) return;
  breakHistoryGroup();
  const before = capture();
  ink = c;
  if (editing) {
    editing.colorBefore = before;
    editing.controller.setColor(c);
    editing.colorBefore = null;
    persist(); sync(); return;
  }
  const n = node(selected);
  if (n) { n.color = c; n.runs = n.text ? [{text:n.text,color:c}] : []; changed(before); render(); }
  else { persist(); sync(); }
}
function cycleInk(direction) {
  if (editing?.controller.isComposing() || document.activeElement?.closest('input,select,dialog')) return;
  const e = edge(edgeId), current = e?.color || (editing ? ink : node(selected)?.color || ink);
  const next = colors[(colors.indexOf(current)+direction+colors.length)%colors.length];
  if (e) setEdgeAttr('color',next); else setInk(next);
}
function setEdgeAttr(key,value) { const e = edge(edgeId); if (!e || e[key] === value) return; const before = capture(); e[key] = value; changed(before); scheduleDraw(); }

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
  loading = true; detachEditor(); applyWheelPan();
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

function closePanel() { panel.hidden = true; panelType = ''; sync(); }
function showPanel(type,title) {
  panel.replaceChildren(); panelType = type; panel.hidden = false;
  const heading = document.createElement('strong'); heading.textContent = title; panel.append(heading);
  const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label','关闭菜单'); close.onclick = () => { closePanel(); paper.focus({preventScroll:true}); }; panel.append(close); sync();
}
function pbutton(label,fn,key='',disabled=false,klass='') {
  const button = document.createElement('button'); button.className = 'menu-item '+klass; button.disabled = disabled;
  const text = document.createElement('span'); text.textContent = label; button.append(text);
  if (key) { const hint = document.createElement('kbd'); hint.textContent = key; button.append(hint); }
  button.onclick = fn; panel.append(button); return button;
}
function divider() { panel.append(document.createElement('hr')); }
function focusMenu() { panel.querySelector('.menu-item:not(:disabled),input,select')?.focus({preventScroll:true}); }
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
function openProps() {
  finishEdit(); const e = edge(edgeId), n = node(selected); if (!e && !n) { openFile(); return; }
  showPanel('props',e ? '连线' : '文字');
  if (e) {
    const label = document.createElement('label'); label.textContent = '关系'; const input = document.createElement('input'); input.maxLength = 80; input.value = e.label; input.setAttribute('aria-label','关系说明'); input.onchange = () => setEdgeAttr('label',input.value); label.append(input); panel.append(label);
    const field = (title,key,options) => {
      const label = document.createElement('label'); label.textContent = title; const select = document.createElement('select'); select.setAttribute('aria-label',title);
      for (const [value,text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
      select.value = e[key]; select.onchange = () => setEdgeAttr(key,select.value); label.append(select); panel.append(label);
    };
    field('线型','style',[['solid','实线'],['dash','虚线']]); field('方向','arrow',[['none','无箭头'],['single','单箭头'],['double','双箭头']]);
    field('颜色','color',colors.map(c => [c,inks[c][1].split(' · ')[0]]));
    pbutton('反转起点与终点',() => { const before = capture(); [e.a,e.b] = [e.b,e.a]; changed(before); scheduleDraw(); });
    pbutton('删除连线',removeSelection,'Delete',false,'trash');
  } else {
    pbutton('继续编辑',() => { closePanel(); openEditor(n); });
    pbutton('新建子块',() => { closePanel(); extend('child'); },'Tab');
    pbutton('新建同级',() => { closePanel(); extend('sibling'); },'Enter');
    pbutton('从这里连线',() => startLink(n.id));
    pbutton('删除文字',removeSelection,'Delete',false,'trash');
  }
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
function openFile() {
  if (panelType === 'file') { closePanel(); return; }
  finishEdit(); showPanel('file','草稿与操作');
  pbutton('新建草稿',() => addTab(),'Ctrl+Alt+N'); pbutton('重命名',() => renameTab(),'F2');
  pbutton('关闭当前标签',() => closeTab(),window.paperDesktop ? 'Ctrl+W' : '');
  pbutton('恢复最近关闭',() => reopenTab(),'Ctrl+Alt+T',!workspace.state.closedIds.length);
  if (workspace.state.closedIds.length) pbutton('查看已关闭草稿',openClosed);
  divider(); pbutton('立即保存',() => { flush(); closePanel(); },'Ctrl+S');
  pbutton('导出当前草稿',exportJson,'Ctrl+Shift+E'); pbutton('导入为新标签',() => $('upload').click(),'Ctrl+O');
  pbutton('打印 / 保存 PDF',() => { closePanel(); window.print(); },'Ctrl+P');
  if (window.paperDesktop) pbutton('保存截图',() => { closePanel(); window.paperDesktop.saveScreenshot(); },'Ctrl+Shift+S');
  divider(); pbutton('显示全部',() => { closePanel(); fit(); },'Ctrl+0');
  pbutton('新标签查看示例',() => addTab(example(),'示例'));
  pbutton('快捷键与操作',showHelp,'F1');
}
function openClosed() {
  showPanel('closed','已关闭草稿');
  const state = workspace.state;
  for (const id of [...state.closedIds].reverse()) { const doc = state.documents.find(d => d.id === id); pbutton(doc.title,() => reopenTab(id)); }
  focusMenu();
}
function showHelp() { finishEdit(); closePanel(); $('manual').showModal(); }
$('save-error').onclick = () => {
  showPanel('save','保存遇到问题'); const text = document.createElement('p'); text.textContent = saveError; panel.append(text);
  pbutton('重新保存',() => { if (flush()) closePanel(); }); pbutton('导出当前草稿',exportJson);
};
$('new-tab').onclick = () => addTab();
document.querySelector('.pages').addEventListener('pointerdown',e => {
  // Capture the current caret in activate/close, before the browser blurs it.
  if (editing && e.button === 0 && !e.target.closest('input')) e.preventDefault();
});
$('file').onclick = openFile; $('fit').onclick = fit;
$('undo').onclick = undo; $('redo').onclick = redo;
for (const id of ['undo','redo','fit']) $(id).addEventListener('pointerdown',e => e.preventDefault());
$('inspect-more').onclick = () => panelType === 'props' ? closePanel() : openProps();
$('stroke-style').onchange = () => setEdgeAttr('style',$('stroke-style').value);
$('stroke-arrow').onchange = () => setEdgeAttr('arrow',$('stroke-arrow').value);
for (const [key,[color,label]] of Object.entries(inks)) {
  const button = document.createElement('button'); button.className = 'swatch'; button.dataset.ink = key; button.style.setProperty('--ink-color',color); button.setAttribute('aria-label',label); button.title = label;
  const dot = document.createElement('span'); dot.setAttribute('aria-hidden','true'); button.append(dot);
  button.addEventListener('pointerdown',e => e.preventDefault()); button.onclick = () => edge(edgeId) ? setEdgeAttr('color',key) : setInk(key); $('palette').append(button);
}
$('upload').onchange = async () => {
  const file = $('upload').files[0]; $('upload').value = ''; if (!file) return;
  try { if (file.size > 8*1024*1024) throw Error('文件超过 8 MB'); const raw = JSON.parse(await file.text()); addTab(normalize(raw),typeof raw.title === 'string' ? raw.title : file.name.replace(/\.json$/i,'')); }
  catch (error) { showPanel('error','无法导入'); const text = document.createElement('p'); text.textContent = '请选用有效的草稿 JSON。'+error.message; panel.append(text); }
};

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
  if (e.isComposing || e.keyCode === 229 || editing?.controller.isComposing(e)) return;
  const key = e.key || '', k = key.toLowerCase(), cmd = e.ctrlKey || e.metaKey;
  const field = e.target.closest?.('input,select,dialog');
  if ((key === 'F17' || e.code === 'F17' || e.keyCode === 128 || key === 'F18' || e.code === 'F18' || e.keyCode === 129) && !field) {
    e.preventDefault(); cycleInk(key === 'F17' || e.code === 'F17' || e.keyCode === 128 ? -1 : 1); return;
  }
  if (cmd && k === 's' && !e.shiftKey && !e.altKey) { e.preventDefault(); flush(); return; }
  if (field) return;
  if (cmd && k === 'z' && !e.altKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (cmd && k === 'y' && !e.altKey) { e.preventDefault(); redo(); return; }
  if (cmd && ((e.altKey && k === 'n') || (k === 't' && !e.altKey && !e.shiftKey && window.paperDesktop))) { e.preventDefault(); addTab(); return; }
  if (cmd && ((e.altKey && k === 't') || (e.shiftKey && k === 't' && window.paperDesktop))) { e.preventDefault(); reopenTab(); return; }
  if (cmd && k === 'w' && window.paperDesktop) { e.preventDefault(); closeTab(); return; }
  if (cmd && (key === 'PageUp' || key === 'PageDown')) { e.preventDefault(); nextTab(key === 'PageUp' ? -1 : 1); return; }
  if (key === 'F2') { e.preventDefault(); renameTab(); return; }
  if (key === 'F1') { e.preventDefault(); showHelp(); return; }
  if (cmd && k === 'e' && e.shiftKey) { e.preventDefault(); exportJson(); return; }
  if (cmd && k === 'o') { e.preventDefault(); $('upload').click(); return; }
  if (cmd && k === 'p') { e.preventDefault(); finishEdit(); closePanel(); window.print(); return; }
  if (cmd && key === 'Enter') { e.preventDefault(); freshIdea(); return; }
  if (cmd && ['+','=','-','0'].includes(key)) { e.preventDefault(); if (key === '0') fit(); else zoom(cam.z*(key === '-' ? 1/1.15 : 1.15),center()); return; }
  if (key === 'F10' && e.shiftKey) { e.preventDefault(); openProps(); focusMenu(); return; }
  if (e.target.closest?.('#tabs') && ['ArrowLeft','ArrowRight'].includes(key) && !e.altKey) {
    e.preventDefault(); nextTab(key === 'ArrowLeft' ? -1 : 1); $('tabs').querySelector('[aria-selected="true"]')?.focus(); return;
  }
  if (e.target.closest?.('#panel') && ['ArrowDown','ArrowUp'].includes(key)) {
    e.preventDefault(); const elements = [...panel.querySelectorAll('button:not(:disabled),input,select')], i = elements.indexOf(document.activeElement);
    elements[(i+(key === 'ArrowDown' ? 1 : elements.length-1))%elements.length]?.focus(); return;
  }
  if (key === 'Escape') {
    e.preventDefault(); const id = editing?.id;
    finishEdit(); source = null; preview = null; closePanel();
    if (!id) { selected = null; edgeId = null; }
    paper.focus({preventScroll:true}); render(); return;
  }
  if (e.altKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key)) {
    e.preventDefault(); const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0, dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
    const n = node(selected), step = e.shiftKey ? 40 : 10;
    if (n) { const before = capture(); n.x += dx*step; n.y += dy*step; changed(before,'move:'+n.id); render(); }
    else { cam.x += dx*step*3; cam.y += dy*step*3; camera(); }
    return;
  }
  if (e.target.closest?.('.port') && (key === 'Enter' || key === ' ')) { e.preventDefault(); startLink(e.target.closest('[data-node]').dataset.node); paper.focus(); return; }
  if (e.target.closest?.('button') || e.target.closest?.('#panel')) return;
  if (source && !editing && (key === 'Enter' || key === 'Tab')) {
    e.preventDefault();
    if (key === 'Enter') connectTarget(selected);
    else { const index = model.nodes.findIndex(n => n.id === selected); selected = model.nodes[(index+1)%model.nodes.length]?.id; render(); }
    return;
  }
  if ((editing || selected) && !cmd && !e.altKey) {
    if (key === 'Tab' && !e.shiftKey) { e.preventDefault(); extend('child'); return; }
    if (key === 'Tab' && e.shiftKey) {
      const parent = node(node(editing?.id || selected)?.parentId); e.preventDefault();
      if (parent) { finishEdit(); selectNode(parent.id); openEditor(parent); } return;
    }
    if (key === 'Enter' && !e.shiftKey) { e.preventDefault(); extend('sibling'); return; }
    if (key === 'Enter' && e.shiftKey && editing) { e.preventDefault(); editing.controller.insertText('\n'); return; }
  }
  if (editing) return;
  if (key === ' ' && !cmd && !e.altKey) { e.preventDefault(); space = true; sync(); return; }
  if ((key === 'Delete' || key === 'Backspace') && (selected || edgeId)) { e.preventDefault(); removeSelection(); return; }
  if (key === 'Enter' && edgeId) { e.preventDefault(); openProps(); focusMenu(); return; }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key) && !cmd) { e.preventDefault(); navigateNodes(key); return; }
  if (key === 'Enter' && !selected && !edgeId) { e.preventDefault(); freshIdea(); }
});
document.addEventListener('paper-history',e => { e.preventDefault(); e.detail === 'redo' ? redo() : undo(); });
document.addEventListener('keyup',e => { if (e.key === ' ') { space = false; sync(); } });
window.paperDesktop?.onColorStep?.(direction => cycleInk(direction));

function applyWheelPan() {
  if (wheelFrame) { cancelAnimationFrame(wheelFrame); wheelFrame = 0; }
  if (!wheelDelta.x && !wheelDelta.y) return;
  cam.x -= wheelDelta.x; cam.y -= wheelDelta.y; wheelDelta = {x:0,y:0}; camera();
}
paper.addEventListener('wheel',e => {
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? paper.clientHeight : 1;
  let dx = e.deltaX*scale, dy = e.deltaY*scale;
  if (e.ctrlKey || e.metaKey) { zoom(cam.z*Math.exp(-dy*.006),relative(e.clientX,e.clientY)); return; }
  // Preserve both axes from precision trackpads; only remap a genuinely vertical mouse wheel.
  if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
  wheelDelta.x += dx; wheelDelta.y += dy;
  if (!wheelFrame) wheelFrame = requestAnimationFrame(applyWheelPan);
},{passive:false});
const points = new Map();
function fingers() {
  const [a,b] = points.values();
  return {p:relative((a.x+b.x)/2,(a.y+b.y)/2),dist:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};
}
paper.addEventListener('pointerdown',e => {
  if (e.target.closest('button:not(.port)')) return;
  if (e.pointerType === 'touch') {
    points.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (points.size === 2) {
      if (gesture?.type === 'move' && gesture.moved) { gesture.n.x = gesture.ox; gesture.n.y = gesture.oy; render(); }
      gesture = null; preview = null; scheduleDraw(); pinch = {...fingers(),cam:{...cam}}; e.preventDefault(); return;
    }
    if (points.size > 1 || pinch) return;
  }
  if (e.button !== 0 && e.button !== 1) return;
  if (e.target.closest('.editor') && e.button === 0 && !e.altKey && !space) return;
  const id = e.target.closest('[data-node]')?.dataset.node, lid = e.target.closest('[data-edge]')?.dataset.edge;
  const editMemory = editing ? {id:editing.id,selection:editing.controller.getSelection()} : null;
  const beforeInteraction = capture();
  const pan = e.button === 1 || space;
  if (!pan) finishEdit();
  e.preventDefault(); applyWheelPan();
  const base = {id:e.pointerId,x:e.clientX,y:e.clientY,moved:false,cx:cam.x,cy:cam.y};
  if (pan) gesture = {...base,type:'pan'};
  else if (e.target.closest('.port') && node(id)) gesture = {...base,type:'link',from:id};
  else if (source) gesture = {...base,type:'connectTap',nodeId:id};
  else if (id && node(id)) { const n = node(id); gesture = {...base,type:'move',n,ox:n.x,oy:n.y,before:beforeInteraction,editMemory}; }
  else if (lid) gesture = {...base,type:'edge',lid};
  else gesture = {...base,type:'blank'};
  paper.setPointerCapture?.(e.pointerId);
});
paper.addEventListener('pointermove',e => {
  lastPointer = {x:e.clientX,y:e.clientY};
  if (points.has(e.pointerId)) points.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if (pinch && points.size >= 2) {
    const f = fingers(), z = Math.max(.2,Math.min(3,pinch.cam.z*f.dist/pinch.dist));
    cam = {z,x:f.p.x-(pinch.p.x-pinch.cam.x)*z/pinch.cam.z,y:f.p.y-(pinch.p.y-pinch.cam.y)*z/pinch.cam.z}; camera(); return;
  }
  if (gesture?.id !== e.pointerId) return;
  const g = gesture, dx = e.clientX-g.x, dy = e.clientY-g.y;
  if (Math.hypot(dx,dy) > (e.pointerType === 'touch' ? 7 : 4)) g.moved = true;
  if (!g.moved) return;
  if (g.type === 'link') { preview = {id:g.from,...world(e.clientX,e.clientY)}; scheduleDraw(); }
  if (g.type === 'move') {
    g.n.x = g.ox+dx/cam.z; g.n.y = g.oy+dy/cam.z;
    if (!g.dragStarted) {
      g.dragStarted = true; selected = g.n.id; edgeId = null; render();
    } else {
      const element = dom.get(g.n.id);
      element.style.left = g.n.x+'px'; element.style.top = g.n.y+'px';
      scheduleDraw();
    }
  }
  if (g.type === 'pan' || g.type === 'blank') { cam.x = g.cx+dx; cam.y = g.cy+dy; camera(); paper.classList.add('grabbing'); }
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
  const g = gesture; gesture = null; paper.classList.remove('grabbing');
  if (paper.hasPointerCapture?.(e.pointerId)) paper.releasePointerCapture(e.pointerId);
  const p = world(e.clientX,e.clientY);
  if (g.type === 'blank' && !g.moved) { closePanel(); newNote(p.x,p.y); }
  if (g.type === 'move') {
    if (g.moved) { changed(g.before); selectNode(g.n.id); if (g.editMemory?.id === g.n.id) openEditor(g.n,g.editMemory.selection); else dom.get(g.n.id)?.focus({preventScroll:true}); }
    else { selectNode(g.n.id); openEditor(g.n,null,{x:e.clientX,y:e.clientY}); }
  }
  if (g.type === 'edge' && !g.moved) { selectEdge(g.lid); paper.focus({preventScroll:true}); }
  if (g.type === 'connectTap' && !g.moved) tapConnect(g.nodeId,p);
  if (g.type === 'link') {
    preview = null;
    if (g.moved) {
      const id = document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-node]')?.dataset.node;
      const rect = paper.getBoundingClientRect();
      if (id && id !== g.from) { const before = capture(), link = createEdge(g.from,id); changed(before); if (link) selectEdge(link.id); }
      else if (!id && e.clientY >= rect.top && e.clientY <= rect.bottom) newNote(p.x,p.y,{parent:g.from});
      scheduleDraw();
    } else { startLink(g.from); paper.focus(); }
  }
});
function cancelGesture(e) {
  points.delete(e.pointerId); if (!points.size) pinch = null;
  if (gesture?.id !== e.pointerId) return;
  if (gesture.type === 'move' && gesture.moved) { gesture.n.x = gesture.ox; gesture.n.y = gesture.oy; render(); }
  gesture = null; preview = null; scheduleDraw(); paper.classList.remove('grabbing');
}
paper.addEventListener('pointercancel',cancelGesture);
paper.addEventListener('contextmenu',e => {
  if (e.target.closest('.editor')) return;
  e.preventDefault();
  const id = e.target.closest('[data-node]')?.dataset.node, lid = e.target.closest('[data-edge]')?.dataset.edge;
  if (id) { selectNode(id); openProps(); }
  else if (lid) selectEdge(lid,true);
  else openFile();
});
document.addEventListener('pointerdown',e => {
  if (!panel.hidden && !e.target.closest('#panel,#file,#inspect-more,#save-error')) closePanel();
});
window.addEventListener('blur',() => { space = false; gesture = null; pinch = null; points.clear(); preview = null; paper.classList.remove('grabbing'); sync(); flush(); });
window.addEventListener('pagehide',flush);
window.addEventListener('beforeunload',flush);
document.addEventListener('visibilitychange',() => { if (document.hidden) flush(); });
window.addEventListener('resize',scheduleDraw);
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
