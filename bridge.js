// Content script (ISOLATED world) — bridges chrome.runtime messages to page world.

// Expose worklet URL to MAIN world via DOM attribute (CSP-safe, no inline script needed)
document.documentElement.dataset.audioLimiterWorkletUrl = chrome.runtime.getURL('limiter-worklet.js');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const id = Math.random().toString(36).slice(2) + Date.now();

  window.postMessage({ type: 'audioLimiter_toPage', id, payload: message }, '*');

  let settled = false;
  function onResponse(event) {
    if (event.source !== window) return;
    if (event.data?.type === 'audioLimiter_fromPage' && event.data.id === id) {
      window.removeEventListener('message', onResponse);
      settled = true;
      sendResponse(event.data.payload);
    }
  }
  window.addEventListener('message', onResponse);

  // Timeout — if processor.js isn't loaded, respond with error
  setTimeout(() => {
    if (!settled) {
      window.removeEventListener('message', onResponse);
      sendResponse({ error: 'no processor' });
    }
  }, 1000);

  return true; // async sendResponse
});
