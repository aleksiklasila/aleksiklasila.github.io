"use strict";

function showMenuActions(anchor, actions) {
    const menu = document.getElementById('menu-action-popover');
    if (menu.matches(':popover-open')) {
        const sameAnchor = menu._anchor === anchor;
        menu.hidePopover();
        if (sameAnchor) return;
    }
    menu._anchor?.setAttribute('aria-expanded', 'false');
    menu._anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', menu.id);
    menu.setAttribute('aria-label', anchor.textContent.trim());
    menu.replaceChildren();
    for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        button.addEventListener('click', () => {
            menu.hidePopover();
            anchor.setAttribute('aria-expanded', 'false');
            action.run();
        });
        menu.appendChild(button);
    }
    menu.ontoggle = event => {
        if (event.newState === 'closed' && !menu.matches(':popover-open')) menu._anchor?.setAttribute('aria-expanded', 'false');
    };
    menu.onkeydown = event => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            menu.hidePopover();
            anchor.setAttribute('aria-expanded', 'false');
            anchor.focus();
        }
    };
    menu.showPopover();
    const rect = anchor.getBoundingClientRect(), gap = 2;
    const left = Math.max(0, Math.min(rect.left, window.innerWidth - menu.offsetWidth));
    // At the top edge (the in-game export button), use the available space below.
    const top = rect.top >= menu.offsetHeight + gap
        ? rect.top - menu.offsetHeight - gap : rect.bottom + gap;
    menu.style.left = left + 'px';
    menu.style.top = Math.max(0, Math.min(top, window.innerHeight - menu.offsetHeight)) + 'px';
    menu.firstElementChild?.focus();
}

function showExportOptions(anchor, download) {
    showMenuActions(anchor, [
        { label: 'Compressed', run: () => download(true) },
        { label: 'Uncompressed', run: () => download(false) }
    ]);
}
