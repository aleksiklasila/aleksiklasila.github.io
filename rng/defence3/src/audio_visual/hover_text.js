// Hover text shows only while Ctrl or Shift is held over an element.
// Native `title` tooltips cannot be gated, so the title of the one element
// under the mouse is taken off while it is hovered (and put back when the
// mouse leaves) and shown here instead. Nothing else in the DOM changes and
// nothing watches the document: a page-wide attribute observer cost the
// 100k fixture ~115 -> 2 FPS.
let hoverTextHeld = false;
let hoverTextSourceEl = null;
let hoverTextValue = '';
let hoverTextElement = null;
let hoverTextPoint = null;

// The element's title as its owner set it (bottom bar patches compare it).
function hoverTextOf(el) {
    return el === hoverTextSourceEl && !el.hasAttribute('title') ? hoverTextValue : (el.getAttribute('title') || '');
}

function releaseHoverTitle() {
    const el = hoverTextSourceEl;
    hoverTextSourceEl = null;
    if (el && hoverTextValue && !el.hasAttribute('title')) el.setAttribute('title', hoverTextValue);
    hoverTextValue = '';
}

function claimHoverTitle(target) {
    let el = target;
    for (; el && el.nodeType === 1; el = el.parentElement) {
        // Sliders have their own detail tooltip (count_bars.js).
        if (el.classList.contains('count-control')) { el = null; break; }
        if (el === hoverTextSourceEl || el.hasAttribute('title')) break;
    }
    if (el && el.nodeType !== 1) el = null;
    if (el !== hoverTextSourceEl) { releaseHoverTitle(); hoverTextSourceEl = el; }
    // (Also when its owner set the title again while it was hovered.)
    if (el && el.hasAttribute('title')) {
        hoverTextValue = el.getAttribute('title');
        el.removeAttribute('title');
    }
}

function updateHoverText() {
    if (document.body.classList.contains('hover-text-on') !== hoverTextHeld) document.body.classList.toggle('hover-text-on', hoverTextHeld);
    const text = hoverTextHeld && hoverTextSourceEl && hoverTextSourceEl.isConnected && hoverTextPoint ? hoverTextValue : '';
    if (!text) {
        if (hoverTextElement && !hoverTextElement.hidden) hoverTextElement.hidden = true;
        return;
    }
    if (!hoverTextElement) {
        hoverTextElement = document.createElement('div');
        hoverTextElement.id = 'hover-text-tip';
        hoverTextElement.setAttribute('role', 'tooltip');
        document.body.appendChild(hoverTextElement);
    }
    if (hoverTextElement.textContent !== text) hoverTextElement.textContent = text;
    hoverTextElement.hidden = false;
    const width = hoverTextElement.offsetWidth, height = hoverTextElement.offsetHeight;
    const below = hoverTextPoint.y + 18;
    hoverTextElement.style.left = Math.max(4, Math.min(window.innerWidth - width - 4, hoverTextPoint.x + 12)) + 'px';
    hoverTextElement.style.top = (below + height <= window.innerHeight - 4 ? below : Math.max(4, hoverTextPoint.y - height - 8)) + 'px';
}

function bindHoverTextEvents() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    const fromPointer = ev => {
        hoverTextHeld = ev.ctrlKey || ev.shiftKey;
        hoverTextPoint = { x: ev.clientX, y: ev.clientY };
        claimHoverTitle(ev.target);
        if (hoverTextHeld || (hoverTextElement && !hoverTextElement.hidden)) updateHoverText();
    };
    document.addEventListener('pointerover', fromPointer, true);
    document.addEventListener('pointermove', fromPointer, true);
    document.addEventListener('pointerout', ev => {
        if (!ev.relatedTarget) { releaseHoverTitle(); updateHoverText(); }
    }, true);
    const fromKey = ev => {
        if (ev.key !== 'Control' && ev.key !== 'Shift') return;
        const held = ev.ctrlKey || ev.shiftKey;
        if (held !== hoverTextHeld) { hoverTextHeld = held; updateHoverText(); }
    };
    window.addEventListener('keydown', fromKey, true);
    window.addEventListener('keyup', fromKey, true);
    window.addEventListener('blur', () => { hoverTextHeld = false; updateHoverText(); });
}

bindHoverTextEvents();
