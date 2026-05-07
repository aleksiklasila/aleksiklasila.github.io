// INIT
// ============================================================
window.addEventListener('load', () => {
    if (!ensureRenderContextsInitialized()) return;
    invalidateStaticLayerCache();
    refreshBackgroundTickMode();
    syncRenderModeUi();

    initInput();
    initBuildTabs();
    requestBuildMenuRefresh();
    loadOrCreateLocalIdentity();
    initLobbySettingsCarousel();

    // Auto-join if URL has ?game=xxx
    let params = new URLSearchParams(window.location.search);
    let gameId = params.get('game');
    if (gameId) {
        joinGame(gameId);
    }
});
