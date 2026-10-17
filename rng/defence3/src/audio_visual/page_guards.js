// The page is a game, not a document: no native drag and drop, no text
// selection outside text fields, no scrolled layout, no browser shortcuts or
// page zoom from the modifiers held while playing. A native drag swallows
// the mouseup: the game's box selection then stayed open and followed the
// bare mouse while the browser dragged a faded image of the whole page.
function pageGuardEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.nodeName === 'TEXTAREA') return true;
    return el.nodeName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|file|color)$/i.test(el.type);
}

// Read-only text meant to be copied (data-selectable, e.g. the stats map
// viewer): selectable, Ctrl+C copies, Ctrl+A selects only it.
function pageGuardSelectable(el) {
    if (el && el.nodeType !== 1) el = el.parentElement;
    return !!(el && el.closest && el.closest('[data-selectable]'));
}

function pageGuardInMatch() {
    return typeof gameStarted !== 'undefined' && gameStarted;
}

// (Reading the selection forces a style and layout update: 54 ms on a press
// in a big match. Only after the browser said the selection changed.)
let pageGuardSelectionChanged = false;
function pageGuardClearSelection() {
    if (!pageGuardSelectionChanged) return;
    pageGuardSelectionChanged = false;
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && selection.rangeCount && !selection.isCollapsed && !pageGuardEditable(document.activeElement)
        && !pageGuardSelectable(selection.anchorNode)) selection.removeAllRanges();
}

// Scroll only `container` (not every ancestor, as scrollIntoView does) so
// that `el` is visible in it.
function scrollIntoViewWithin(el, container) {
    if (!el || !container || !container.contains(el)) return;
    const box = container.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < box.top) container.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) container.scrollTop += Math.min(r.bottom - box.bottom, r.top - box.top);
}

// The game screen's layout boxes never scroll. The browser still scrolls
// overflow:hidden boxes for focus, scrollIntoView or a drag near an edge,
// which moved every panel and the canvas off their places.
const PAGE_GUARD_FIXED_LAYOUT = ['main-row', 'center-column', 'game-area', 'left-panel', 'right-panel', 'bottom-bar', 'build-bar', 'minimap-wrap', 'renderer3d-host'];

function pageGuardResetScroll(el) {
    if (el && (el.scrollTop || el.scrollLeft)) { el.scrollTop = 0; el.scrollLeft = 0; }
}

function bindPageGuards() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    // (?guards=0: off, to reproduce what they prevent.)
    if (/[?&]guards=0/.test(location.search)) return;
    // (Nothing in the game uses native drag and drop: queue reordering and
    // sliders are pointer-driven.)
    document.addEventListener('dragstart', ev => {
        if (!pageGuardEditable(ev.target)) ev.preventDefault();
    }, true);
    document.addEventListener('selectstart', ev => {
        const target = ev.target && ev.target.nodeType === 1 ? ev.target : ev.target && ev.target.parentElement;
        if (!pageGuardEditable(target) && !pageGuardSelectable(target)) ev.preventDefault();
    }, true);
    document.addEventListener('selectionchange', () => { pageGuardSelectionChanged = true; });
    document.addEventListener('pointerdown', ev => {
        if (!pageGuardEditable(ev.target) && !pageGuardSelectable(ev.target)) pageGuardClearSelection();
    }, true);
    document.addEventListener('scroll', ev => {
        const el = ev.target;
        if (el === document) { pageGuardResetScroll(document.scrollingElement); pageGuardResetScroll(document.body); }
        else if (el && (el === document.body || PAGE_GUARD_FIXED_LAYOUT.includes(el.id))) pageGuardResetScroll(el);
    }, true);
    // Ctrl and Shift are held in a match (hover text, add-to-selection,
    // queueing) while WASD pans and the wheel zooms: those must not reach the
    // browser as Ctrl+S (save), Ctrl+D (bookmark), Ctrl+Shift+S (web capture,
    // which dims and freezes the page), Ctrl+F, Ctrl+A or page zoom. Reload
    // and developer tools stay. (Ctrl+W/T/N are the browser's alone.)
    window.addEventListener('keydown', ev => {
        if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || pageGuardEditable(ev.target)) return;
        const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
        const selectable = pageGuardSelectable(ev.target) ? ev.target.closest('[data-selectable]') : null;
        if (key === 'a') {
            ev.preventDefault();
            if (selectable) getSelection().selectAllChildren(selectable);
            return;
        }
        if (selectable && key === 'c') return;
        if (!pageGuardInMatch()) return;
        if (key === 'r' || key === 'F5' || (ev.shiftKey && (key === 'i' || key === 'j' || key === 'c'))) return;
        if (/^[a-z0-9=+\-_]$/.test(key)) ev.preventDefault();
    }, true);
    // Ctrl+wheel (and trackpad pinch) over the panels zoomed the whole page;
    // over the game area it already zooms the camera (main.js).
    window.addEventListener('wheel', ev => {
        if (ev.ctrlKey && pageGuardInMatch()) ev.preventDefault();
    }, { capture: true, passive: false });
}

bindPageGuards();
