// Background service worker — auto-activates limiter on page load when state is active.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  const { limiterActive, limiterParams } = await chrome.storage.local.get(['limiterActive', 'limiterParams']);
  if (!limiterActive) return;

  try {
    // Inject processor.js into the page (MAIN world)
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['processor.js'],
      world: 'MAIN'
    });

    // Small delay for processor to initialize
    await new Promise(r => setTimeout(r, 150));

    // Send start command with saved params via the bridge content script
    const params = limiterParams || {
      saturationLevel: -8,
      kneeWidth: 6,
      outputGain: 8,
      lookahead: 1.5,
      minRecovery: 150
    };

    await chrome.tabs.sendMessage(tabId, {
      action: 'start',
      params
    });
  } catch (err) {
    // Tab may not support scripting (e.g. new tab page) — ignore
    console.log('Auto-activate skipped for tab', tabId, err.message);
  }
});
