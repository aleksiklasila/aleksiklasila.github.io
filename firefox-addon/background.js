'use strict';
// Saves recorded clips (WAV bytes from the content script) to Downloads.
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'saveClip') return undefined;
  const blob = new Blob([msg.data], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  return browser.downloads
    .download({ url, filename: 'stream-voice-leveler/' + msg.name, saveAs: false, conflictAction: 'uniquify' })
    .then((id) => {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { ok: true, id };
    })
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
});
