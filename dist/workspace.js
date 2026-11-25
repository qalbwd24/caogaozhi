/* Draft Paper's local workspace. The original v1 key is never changed. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PaperWorkspace = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_KEY = 'caogaozhi.workspace.v2';
  var LEGACY_KEY = 'caogaozhi.local.v1';
  var INKS = ['black', 'red', 'blue', 'gray'];
  var SAVE_DELAY = 150;

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function blank() { return { nodes: [], edges: [] }; }
  function titleOf(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : '未命名';
  }
  function cameraOf(value) {
    value = value || {};
    return {
      x: Number.isFinite(value.x) ? value.x : 0,
      y: Number.isFinite(value.y) ? value.y : 0,
      z: Number.isFinite(value.z) && value.z > 0 ? value.z : 1
    };
  }
  function defaultNormalize(value) {
    if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
      throw new Error('草稿内容格式不正确');
    }
    return value;
  }

  function create(options) {
    options = options || {};
    var storage = options.storage;
    var key = options.key || DEFAULT_KEY;
    var legacyKey = options.legacyKey || LEGACY_KEY;
    if (key === legacyKey) throw new Error('新工作区与旧草稿必须使用不同的保存位置');
    var normalize = options.normalize || defaultNormalize;
    var makeId = options.makeId || function () {
      return typeof crypto === 'object' && crypto.randomUUID ? crypto.randomUUID() :
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    };
    var state;
    var timer = null;
    var dirty = false;
    var blocked = false;
    var disposed = false;
    var lastError = null;
    var lastFailure = '';

    function report(error, operation, sourceKey) {
      lastError = error instanceof Error ? error : new Error(String(error));
      var signature = operation + ':' + sourceKey + ':' + lastError.message;
      if (signature === lastFailure) return;
      lastFailure = signature;
      if (typeof options.onError === 'function') {
        try { options.onError(lastError, { operation: operation, key: sourceKey, blocked: blocked }); }
        catch (_) { /* An error message must not prevent editing or recovery. */ }
      }
    }
    function cleanModel(value) { return copy(normalize(copy(value))); }
    function freshId() {
      var used = new Set(state ? state.documents.map(function (doc) { return doc.id; }) : []);
      for (var i = 0; i < 20; i++) {
        var id = String(makeId());
        if (id && !used.has(id)) return id;
      }
      var base = 'paper-' + Date.now().toString(36);
      for (var suffix = 0; used.has(base + '-' + suffix); suffix++) { /* Find a free ID. */ }
      return base + '-' + suffix;
    }
    function makeDocument(title, model) {
      return {
        id: freshId(), title: titleOf(title), model: cleanModel(model === undefined ? blank() : model),
        cam: cameraOf(), ink: 'black'
      };
    }
    function initial(model) {
      var doc = makeDocument(undefined, model);
      return { version: 2, activeId: doc.id, openIds: [doc.id], closedIds: [], documents: [doc] };
    }
    function readState(raw) {
      if (!raw || raw.version !== 2 || !Array.isArray(raw.documents) || !raw.documents.length ||
          !Array.isArray(raw.openIds)) throw new Error('工作区格式不正确或版本不受支持');
      var ids = new Set();
      var documents = raw.documents.map(function (doc) {
        if (!doc || typeof doc.id !== 'string' || !doc.id || ids.has(doc.id)) {
          throw new Error('工作区中的草稿编号不正确');
        }
        ids.add(doc.id);
        return {
          id: doc.id, title: titleOf(doc.title), model: cleanModel(doc.model),
          cam: cameraOf(doc.cam), ink: INKS.includes(doc.ink) ? doc.ink : 'black'
        };
      });
      var openIds = Array.from(new Set(raw.openIds.filter(function (id) { return ids.has(id); })));
      if (!openIds.length) openIds.push(ids.has(raw.activeId) ? raw.activeId : documents[0].id);
      var closedIds = Array.from(new Set((Array.isArray(raw.closedIds) ? raw.closedIds : [])
        .filter(function (id) { return ids.has(id) && !openIds.includes(id); })));
      documents.forEach(function (doc) {
        if (!openIds.includes(doc.id) && !closedIds.includes(doc.id)) closedIds.push(doc.id);
      });
      return {
        version: 2, activeId: openIds.includes(raw.activeId) ? raw.activeId : openIds[0],
        openIds: openIds, closedIds: closedIds, documents: documents
      };
    }
    function read() {
      var sourceKey = key;
      try {
        if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
          throw new Error('本地保存不可用');
        }
        var value = storage.getItem(key);
        if (value !== null && value !== undefined) {
          state = readState(JSON.parse(value));
          return;
        }
        sourceKey = legacyKey;
        var legacy = storage.getItem(legacyKey);
        if (legacy !== null && legacy !== undefined) {
          state = initial(JSON.parse(legacy));
          schedule();
          return;
        }
      } catch (error) {
        // Never replace unreadable or newer data with a freshly created empty sheet.
        blocked = true;
        report(error, 'read', sourceKey);
      }
      state = initial();
    }
    function current() {
      return state.documents.find(function (doc) { return doc.id === state.activeId; });
    }
    function schedule() {
      dirty = true;
      if (blocked || disposed || timer !== null) return;
      // A bounded delay also saves during continuous typing, not only after a pause.
      timer = setTimeout(function () { timer = null; save(); }, SAVE_DELAY);
    }
    function save() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (blocked) return false;
      try {
        storage.setItem(key, JSON.stringify(state));
        dirty = false;
        lastError = null;
        lastFailure = '';
        return true;
      } catch (error) {
        dirty = true;
        report(error, 'write', key);
        return false;
      }
    }
    function createDocument(title, model) {
      var doc = makeDocument(title, model);
      state.documents.push(doc);
      state.openIds.push(doc.id);
      state.activeId = doc.id;
      schedule();
      return copy(doc);
    }
    function updateActive(patch) {
      patch = patch || {};
      var doc = current();
      // Validate every supplied value before changing the stored document.
      var changes = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'model')) changes.model = cleanModel(patch.model);
      if (Object.prototype.hasOwnProperty.call(patch, 'cam')) changes.cam = cameraOf(patch.cam);
      if (Object.prototype.hasOwnProperty.call(patch, 'ink')) changes.ink = INKS.includes(patch.ink) ? patch.ink : 'black';
      if (Object.prototype.hasOwnProperty.call(patch, 'title')) changes.title = titleOf(patch.title);
      Object.assign(doc, changes);
      schedule();
      return copy(doc);
    }
    function activate(id) {
      var doc = state.documents.find(function (entry) { return entry.id === id; });
      if (!doc) return false;
      if (!state.openIds.includes(id)) state.openIds.push(id);
      state.closedIds = state.closedIds.filter(function (closedId) { return closedId !== id; });
      state.activeId = id;
      schedule();
      return copy(doc);
    }
    function rename(id, title) {
      var doc = state.documents.find(function (entry) { return entry.id === id; });
      if (!doc) return false;
      doc.title = titleOf(title);
      schedule();
      return copy(doc);
    }
    function close(id) {
      var index = state.openIds.indexOf(id);
      if (index < 0) return false;
      state.openIds.splice(index, 1);
      state.closedIds = state.closedIds.filter(function (closedId) { return closedId !== id; });
      state.closedIds.push(id);
      if (!state.openIds.length) createDocument();
      else if (state.activeId === id) state.activeId = state.openIds[Math.min(index, state.openIds.length - 1)];
      schedule();
      return true;
    }
    function reopen(id) {
      if (id === undefined) id = state.closedIds[state.closedIds.length - 1];
      if (!state.closedIds.includes(id)) return false;
      return activate(id);
    }

    read();
    return {
      get state() { return copy(state); },
      get blocked() { return blocked; },
      get lastError() { return lastError; },
      get hasPendingSave() { return dirty; },
      key: key,
      active: function () { return copy(current()); },
      createDocument: createDocument,
      updateActive: updateActive,
      activate: activate,
      rename: rename,
      close: close,
      reopen: reopen,
      save: save,
      flush: save,
      // For page teardown / tests. Explicitly call save() first to flush changes.
      dispose: function () { disposed = true; if (timer !== null) { clearTimeout(timer); timer = null; } }
    };
  }

  return { create: create, DEFAULT_KEY: DEFAULT_KEY, LEGACY_KEY: LEGACY_KEY };
});
