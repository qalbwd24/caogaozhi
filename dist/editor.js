/* Plain-text editing with four explicit ink runs. No stored or pasted HTML. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PaperEditor = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const colors = ['black', 'red', 'blue', 'gray'];
  const validColor = (value, fallback = 'black') => colors.includes(value) ? value : fallback;
  const cleanText = value => String(value ?? '').replace(/\r\n?/g, '\n');
  const clone = value => value.map(run => ({ text: run.text, color: run.color }));

  function mergeRuns(runs) {
    const result = [];
    for (const run of runs) {
      if (!run.text) continue;
      const last = result[result.length - 1];
      if (last?.color === run.color) last.text += run.text;
      else result.push({ text: run.text, color: run.color });
    }
    return result;
  }

  function normalizedRuns(text, color, runs) {
    text = cleanText(text);
    color = validColor(color);
    if (!text) return [];
    if (!Array.isArray(runs) || runs.some(run => !run || typeof run.text !== 'string') ||
      runs.map(run => cleanText(run.text)).join('') !== text) return [{ text, color }];
    return mergeRuns(runs.map(run => ({ text: cleanText(run.text), color: validColor(run.color, color) })));
  }

  function sliceRuns(runs, start, end) {
    const result = [];
    let offset = 0;
    for (const run of runs) {
      const next = offset + run.text.length;
      if (next > start && offset < end) {
        result.push({ text: run.text.slice(Math.max(0, start - offset), Math.min(run.text.length, end - offset)), color: run.color });
      }
      offset = next;
    }
    return result;
  }

  function plainText(element) {
    let text = '';
    function walk(node) {
      if (node.nodeType === 3) { text += cleanText(node.nodeValue); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        if (node.hasAttribute('data-editor-tail')) return;
        if (node.tagName === 'BR') { text += '\n'; return; }
        if (/^(DIV|P|LI)$/.test(node.tagName) && text && !text.endsWith('\n')) text += '\n';
      }
      for (const child of node.childNodes) walk(child);
    }
    for (const child of element.childNodes) walk(child);
    return text;
  }

  function create(options) {
    const { host, node = {}, inks, onChange, onSelectionChange, onCompositionEnd } = options;
    if (!host?.ownerDocument) throw new TypeError('An editor host element is required.');
    const document = host.ownerDocument;
    const window = document.defaultView;
    const now = () => window.performance.now();
    let baseColor = validColor(node.color);
    let state = { text: cleanText(node.text), runs: normalizedRuns(node.text, baseColor, node.runs) };
    let typingColor = validColor(options.typingColor, baseColor);
    let selection = { start: state.text.length, end: state.text.length, direction: 'forward' };
    let composing = false, compositionUntil = 0, destroyed = false;
    let beforeSelection = null, nativeRange = null;
    const listeners = [];
    const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }

    function read() { return { text: state.text, runs: clone(state.runs) }; }
    function isComposing(event) {
      // Protect an IME-confirming Enter without swallowing the next Tab/color key.
      return composing || (event?.key === 'Enter' && now() < compositionUntil);
    }
    function inkValue(color) { return Array.isArray(inks?.[color]) ? inks[color][0] : inks?.[color] || 'currentColor'; }
    function caretColor() { host.style.caretColor = inkValue(typingColor); }

    function render() {
      const fragment = document.createDocumentFragment();
      for (const run of state.runs) {
        const span = document.createElement('span');
        span.dataset.ink = run.color;
        span.style.color = inkValue(run.color);
        span.textContent = run.text;
        fragment.append(span);
      }
      // A non-content trailing BR gives an empty final line a visible caret.
      if (!state.text || state.text.endsWith('\n')) {
        const tail = document.createElement('br');
        tail.setAttribute('data-editor-tail', '');
        fragment.append(tail);
      }
      host.replaceChildren(fragment);
      caretColor();
    }

    function offsetOf(container, offset) {
      try {
        const range = document.createRange();
        range.selectNodeContents(host);
        range.setEnd(container, offset);
        // During native IME input the DOM can be longer than the previous model.
        return Math.max(0, Math.min(10000, plainText(range.cloneContents()).length));
      } catch { return selection.end; }
    }

    function getSelection() {
      const current = window.getSelection();
      if (!current?.rangeCount || !host.contains(current.anchorNode) || !host.contains(current.focusNode)) return { ...selection };
      const anchor = offsetOf(current.anchorNode, current.anchorOffset);
      const focus = offsetOf(current.focusNode, current.focusOffset);
      selection = { start: Math.min(anchor, focus), end: Math.max(anchor, focus), direction: anchor > focus ? 'backward' : 'forward' };
      return { ...selection };
    }

    function textPoint(offset) {
      const walker = document.createTreeWalker(host, 4);
      let remaining = offset, last = null, current;
      while ((current = walker.nextNode())) {
        last = current;
        if (remaining <= current.nodeValue.length) return [current, remaining];
        remaining -= current.nodeValue.length;
      }
      return last ? [last, last.nodeValue.length] : [host, 0];
    }

    function setSelection(start, end = start, direction = 'forward') {
      start = Math.max(0, Math.min(state.text.length, Number(start) || 0));
      end = Math.max(start, Math.min(state.text.length, Number(end) || 0));
      selection = { start, end, direction: direction === 'backward' ? 'backward' : 'forward' };
      const current = window.getSelection();
      const first = textPoint(start), last = textPoint(end);
      if (typeof current?.setBaseAndExtent === 'function') {
        const anchor = direction === 'backward' ? last : first;
        const focus = direction === 'backward' ? first : last;
        current.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
      } else if (current) {
        const range = document.createRange();
        range.setStart(first[0], first[1]);
        range.setEnd(last[0], last[1]);
        current.removeAllRanges();
        current.addRange(range);
      }
    }

    function colorAt(offset, usePrevious = true) {
      if (!state.text) return typingColor;
      const target = Math.min(state.text.length - 1, Math.max(0, offset - (usePrevious && offset > 0 ? 1 : 0)));
      let position = 0;
      for (const run of state.runs) {
        if (target < position + run.text.length) return run.color;
        position += run.text.length;
      }
      return baseColor;
    }

    function getColor() {
      const range = getSelection();
      return range.start === range.end ? typingColor : colorAt(range.start, false);
    }

    function prepareNativeInk() {
      // The browser owns IME pre-edit DOM. Set its native typing style while
      // the caret is collapsed, before composition starts; stored runs remain
      // the source of truth and are rebuilt after composition. No sentinel
      // character is inserted into the document.
      const current = window.getSelection();
      if (composing || !current?.rangeCount || !current.isCollapsed || !host.contains(current.anchorNode)) return;
      try {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('foreColor', false, inkValue(typingColor));
      } catch { /* Committed text still receives the correct stored ink. */ }
    }

    function notifySelection() {
      if (destroyed || composing) return;
      const current = window.getSelection();
      if (!current?.rangeCount || !host.contains(current.anchorNode) || !host.contains(current.focusNode)) return;
      const next = getSelection();
      // Cursor movement and selection never choose a different pen.
      caretColor();
      onSelectionChange?.({ ...next, color: getColor() });
    }

    function emit(kind, priorSelection) {
      onChange?.(read(), { kind, beforeSelection: { ...priorSelection }, selection: getSelection() });
    }

    function replaceRange(start, end, inserted, color, kind, priorSelection) {
      const old = state.text;
      inserted = cleanText(inserted).slice(0, Math.max(0, 10000 - old.length + end - start));
      const nextRuns = mergeRuns([
        ...sliceRuns(state.runs, 0, start),
        { text: inserted, color },
        ...sliceRuns(state.runs, end, old.length)
      ]);
      const text = old.slice(0, start) + inserted + old.slice(end);
      const different = text !== old || JSON.stringify(nextRuns) !== JSON.stringify(state.runs);
      state = { text, runs: nextRuns };
      render();
      setSelection(start + inserted.length);
      if (different) emit(kind, priorSelection);
      return different;
    }

    function insertText(text, kind = 'input') {
      const prior = getSelection();
      return replaceRange(prior.start, prior.end, text, typingColor, kind, prior);
    }

    function neighboringGrapheme(offset, forward) {
      if (!graphemes) {
        if (forward) return offset + ([...state.text.slice(offset)][0]?.length || 0);
        const units = [...state.text.slice(0, offset)];
        return offset - (units[units.length - 1]?.length || 0);
      }
      const boundaries = [...graphemes.segment(state.text)].map(part => part.index);
      boundaries.push(state.text.length);
      return forward ? (boundaries.find(point => point > offset) ?? offset) : (boundaries.filter(point => point < offset).pop() ?? 0);
    }

    function acceptNative(kind) {
      const text = plainText(host).slice(0, 10000);
      const prior = beforeSelection || { ...selection };
      const replacing = nativeRange || prior;
      const nextSelection = getSelection();
      beforeSelection = nativeRange = null;
      if (text === state.text) return false;
      let start = replacing.start, oldEnd = replacing.end;
      let newEnd = start + text.length - (state.text.length - (oldEnd - start));
      // The native target range disambiguates inserting repeated characters into
      // differently colored runs. A text diff alone could move the new ink.
      if (newEnd < start || text.slice(0, start) !== state.text.slice(0, start) || text.slice(newEnd) !== state.text.slice(oldEnd)) {
        start = 0; oldEnd = state.text.length; newEnd = text.length;
        while (start < oldEnd && start < newEnd && state.text[start] === text[start]) start++;
        while (oldEnd > start && newEnd > start && state.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
      }
      state = {
        text,
        runs: mergeRuns([
          ...sliceRuns(state.runs, 0, start),
          { text: text.slice(start, newEnd), color: typingColor },
          ...sliceRuns(state.runs, oldEnd, state.text.length)
        ])
      };
      if (!composing) { render(); setSelection(nextSelection.start, nextSelection.end, nextSelection.direction); }
      emit(kind, prior);
      return true;
    }

    function setTypingColor(color) {
      typingColor = validColor(color, typingColor);
      caretColor();
      prepareNativeInk();
      onSelectionChange?.({ ...getSelection(), color: getColor() });
    }

    function setColor(color) {
      color = validColor(color, typingColor);
      const prior = getSelection();
      if (prior.start === prior.end) {
        setTypingColor(color);
        return false;
      }
      const nextRuns = mergeRuns([
        ...sliceRuns(state.runs, 0, prior.start),
        { text: state.text.slice(prior.start, prior.end), color },
        ...sliceRuns(state.runs, prior.end, state.text.length)
      ]);
      const different = JSON.stringify(nextRuns) !== JSON.stringify(state.runs);
      state.runs = nextRuns;
      render();
      host.focus({ preventScroll: true });
      setSelection(prior.start, prior.end, prior.direction);
      if (different) emit('color', prior);
      onSelectionChange?.({ ...prior, color });
      return different;
    }

    function setValue(value, range) {
      baseColor = validColor(value.color, baseColor);
      state = { text: cleanText(value.text), runs: normalizedRuns(value.text, baseColor, value.runs) };
      const restored = range || { start: state.text.length, end: state.text.length, direction: 'forward' };
      render();
      setSelection(restored.start, restored.end, restored.direction);
    }

    host.contentEditable = 'true';
    host.setAttribute('role', 'textbox');
    host.setAttribute('aria-multiline', 'true');
    if (!host.hasAttribute('aria-label')) host.setAttribute('aria-label', '在此写下想法');
    host.spellcheck = false;
    host.setAttribute('autocapitalize', 'off');
    host.setAttribute('autocomplete', 'off');
    render();

    listen(host, 'beforeinput', event => {
      beforeSelection = getSelection();
      nativeRange = null;
      const target = event.getTargetRanges?.()[0];
      if (target && host.contains(target.startContainer) && host.contains(target.endContainer)) {
        nativeRange = {
          start: offsetOf(target.startContainer, target.startOffset),
          end: offsetOf(target.endContainer, target.endOffset)
        };
      }
      if (composing || event.isComposing || event.inputType === 'insertCompositionText' || event.inputType === 'deleteCompositionText') return;
      if (!event.cancelable) return;
      if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
        if (event.data !== null) { event.preventDefault(); insertText(event.data); beforeSelection = nativeRange = null; }
      } else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault(); insertText('\n'); beforeSelection = nativeRange = null;
      } else if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
        event.preventDefault();
        const prior = getSelection();
        let start = prior.start, end = prior.end;
        if (start === end) {
          if (event.inputType === 'deleteContentBackward') start = neighboringGrapheme(start, false);
          else end = neighboringGrapheme(end, true);
        }
        replaceRange(start, end, '', typingColor, 'input', prior); beforeSelection = nativeRange = null;
      } else if (event.inputType.startsWith('format')) {
        // This editor intentionally stores only text and the four ink colors.
        event.preventDefault(); beforeSelection = nativeRange = null;
      } else if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        host.dispatchEvent(new window.CustomEvent('paper-history', { bubbles: true, detail: event.inputType === 'historyUndo' ? 'undo' : 'redo' }));
        beforeSelection = nativeRange = null;
      }
    });
    listen(host, 'input', event => acceptNative(composing || event.isComposing ? 'composition' : 'input'));
    listen(host, 'compositionstart', () => { composing = true; beforeSelection = getSelection(); });
    listen(host, 'compositionend', () => {
      composing = false; compositionUntil = now() + 55;
      acceptNative('composition');
      const range = getSelection();
      render(); setSelection(range.start, range.end, range.direction);
      onCompositionEnd?.(read(), { selection: range });
    });
    listen(host, 'paste', event => {
      if (composing) return;
      event.preventDefault();
      insertText(event.clipboardData?.getData('text/plain') || '', 'paste');
    });
    listen(host, 'drop', event => {
      // Drop behavior should not introduce images, markup or browser navigation.
      event.preventDefault();
      if (!composing && event.dataTransfer?.types.includes('text/plain')) insertText(event.dataTransfer.getData('text/plain'), 'paste');
    });
    listen(document, 'selectionchange', notifySelection);

    return {
      element: host, read, getSelection, setSelection, setColor, setTypingColor, getColor, setValue, isComposing, insertText,
      focus({ end = false } = {}) {
        host.focus({ preventScroll: true });
        if (end) setSelection(state.text.length);
        else setSelection(selection.start, selection.end, selection.direction);
        if (!composing) prepareNativeInk();
      },
      destroy() {
        destroyed = true;
        for (const remove of listeners) remove();
        host.removeAttribute('contenteditable');
      }
    };
  }

  return { normalizedRuns, create };
});
