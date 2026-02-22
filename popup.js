// Simple popup controller

let isActive = false;

// UI Elements
const powerBtn = document.getElementById('powerBtn');
const powerText = document.getElementById('powerText');
const statusEl = document.getElementById('status');

const satLevelSlider = document.getElementById('satLevel');
const kneeWidthSlider = document.getElementById('kneeWidth');
const outputGainSlider = document.getElementById('outputGain');
const lookaheadSlider = document.getElementById('lookahead');
const minRecoverySlider = document.getElementById('minRecovery');
const autoGainCheckbox = document.getElementById('autoGain');

const metersEl = document.getElementById('meters');

const meterEls = {
  inL:  { bar: document.getElementById('inBarL'),  peak: document.getElementById('inPeakL'),  db: document.getElementById('inDbL') },
  inR:  { bar: document.getElementById('inBarR'),  peak: document.getElementById('inPeakR'),  db: document.getElementById('inDbR') },
  outL: { bar: document.getElementById('outBarL'), peak: document.getElementById('outPeakL'), db: document.getElementById('outDbL') },
  outR: { bar: document.getElementById('outBarR'), peak: document.getElementById('outPeakR'), db: document.getElementById('outDbR') }
};

let meterRafId = null;

const peakState = {
  inL:  { value: -Infinity, time: 0 },
  inR:  { value: -Infinity, time: 0 },
  outL: { value: -Infinity, time: 0 },
  outR: { value: -Infinity, time: 0 }
};
const PEAK_HOLD_MS = 200;

// Bar hold state — instant rise, hold, then smooth decay
const barState = {
  inL:  { value: -Infinity, time: 0 },
  inR:  { value: -Infinity, time: 0 },
  outL: { value: -Infinity, time: 0 },
  outR: { value: -Infinity, time: 0 }
};
const BAR_HOLD_MS = 80;
const BAR_DECAY_DB_PER_SEC = 120;

const satValueEl = document.getElementById('satValue');
const kneeValueEl = document.getElementById('kneeValue');
const gainValueEl = document.getElementById('gainValue');
const lookValueEl = document.getElementById('lookValue');
const recValueEl = document.getElementById('recValue');

// Transfer plot
const plotCanvas = document.getElementById('plotCanvas');
const pCtx = plotCanvas.getContext('2d');
let plotW = 0, plotH = 0;

const P_IN  = { MIN: -80, MAX: 0 };
const P_OUT = { MIN: -80, MAX: 0 };
const P_PAD = { L: 26, R: 10, T: 10, B: 14 };

let lastLevels = null;

function initPlot() {
  const dpr = window.devicePixelRatio || 1;
  const rect = plotCanvas.getBoundingClientRect();
  plotCanvas.width = rect.width * dpr;
  plotCanvas.height = rect.height * dpr;
  pCtx.scale(dpr, dpr);
  plotW = rect.width;
  plotH = rect.height;
}

function pX(db) {
  return P_PAD.L + ((db - P_IN.MIN) / (P_IN.MAX - P_IN.MIN)) * (plotW - P_PAD.L - P_PAD.R);
}
function pY(db) {
  return P_PAD.T + ((P_OUT.MAX - db) / (P_OUT.MAX - P_OUT.MIN)) * (plotH - P_PAD.T - P_PAD.B);
}

function transferOut(inDb) {
  const sat = parseFloat(satLevelSlider.value);
  const knee = parseFloat(kneeWidthSlider.value);
  const gain = parseFloat(outputGainSlider.value);
  let out;
  if (knee <= 0 || inDb < sat - knee / 2) {
    out = (inDb < sat) ? inDb : sat;
  } else if (inDb > sat + knee / 2) {
    out = sat;
  } else {
    const x = inDb - (sat - knee / 2);
    out = inDb - (x * x) / (2 * knee);
  }
  return Math.min(out + gain, 0);
}

function drawPlot(levels) {
  const w = plotW, h = plotH;
  if (!w || !h) return;

  pCtx.clearRect(0, 0, w, h);

  // Plot area bounds
  const areaL = P_PAD.L, areaT = P_PAD.T;
  const areaR = w - P_PAD.R, areaB = h - P_PAD.B;

  // Grid
  pCtx.lineWidth = 1;
  pCtx.font = '9px Courier New';
  pCtx.textBaseline = 'middle';

  for (let db = P_IN.MIN; db <= P_IN.MAX; db += 10) {
    const x = Math.round(pX(db)) + 0.5;
    pCtx.strokeStyle = (db === 0) ? '#334155' : '#1a2235';
    pCtx.beginPath(); pCtx.moveTo(x, areaT); pCtx.lineTo(x, areaB); pCtx.stroke();
    // X label
    if (db % 20 === 0) {
      pCtx.fillStyle = '#475569';
      pCtx.textAlign = 'center';
      pCtx.fillText(db, x, areaB + 10);
    }
  }

  for (let db = P_OUT.MIN; db <= P_OUT.MAX; db += 10) {
    const y = Math.round(pY(db)) + 0.5;
    pCtx.strokeStyle = (db === 0) ? '#334155' : '#1a2235';
    pCtx.beginPath(); pCtx.moveTo(areaL, y); pCtx.lineTo(areaR, y); pCtx.stroke();
    // Y label
    if (db % 20 === 0) {
      pCtx.fillStyle = '#475569';
      pCtx.textAlign = 'right';
      pCtx.fillText(db, areaL - 3, y);
    }
  }

  // Axis labels
  pCtx.fillStyle = '#475569';
  pCtx.font = 'italic 8px sans-serif';
  pCtx.textAlign = 'center';
  pCtx.textBaseline = 'middle';
  pCtx.fillText('input', (pX(-20) + pX(0)) / 2, areaB + 10);
  pCtx.textAlign = 'right';
  pCtx.fillText('out', areaL - 3, (pY(-20) + pY(0)) / 2);

  // Clip to plot area for curves and dots
  pCtx.save();
  pCtx.beginPath();
  const cm = 3; // clip margin for dots/lines at edges
  pCtx.rect(areaL - cm, areaT - cm, areaR - areaL + cm * 2, areaB - areaT + cm);
  pCtx.clip();

  // Unity reference line (dashed)
  pCtx.strokeStyle = '#1e3a2a';
  pCtx.lineWidth = 1;
  pCtx.setLineDash([3, 3]);
  pCtx.beginPath();
  pCtx.moveTo(pX(-80), pY(-80));
  pCtx.lineTo(pX(0), pY(0));
  pCtx.stroke();
  pCtx.setLineDash([]);

  // Transfer curve
  pCtx.strokeStyle = '#3b82f6';
  pCtx.lineWidth = 1;
  pCtx.beginPath();
  for (let inDb = P_IN.MIN; inDb <= P_IN.MAX; inDb += 0.5) {
    const x = pX(inDb);
    const y = pY(transferOut(inDb));
    if (inDb === P_IN.MIN) pCtx.moveTo(x, y);
    else pCtx.lineTo(x, y);
  }
  pCtx.stroke();

  // L and R dots — follow the transfer curve
  if (levels) {
    drawDot(levels.inL, transferOut(levels.inL), '#10b981');
    drawDot(levels.inR, transferOut(levels.inR), '#f59e0b');
  }

  pCtx.restore();
}

function drawDot(inDb, outDb, color) {
  if (inDb <= -80 && outDb <= -80) return;
  const x = pX(Math.max(P_IN.MIN, Math.min(P_IN.MAX, inDb)));
  const y = pY(Math.max(P_OUT.MIN, Math.min(P_OUT.MAX, outDb)));
  pCtx.fillStyle = color;
  pCtx.beginPath();
  pCtx.arc(x, y, 2, 0, Math.PI * 2);
  pCtx.fill();
  // White border
  pCtx.strokeStyle = '#ffffff44';
  pCtx.lineWidth = 1;
  pCtx.stroke();
}

// Persist slider values
function saveSettings() {
  const params = {
    saturationLevel: parseFloat(satLevelSlider.value),
    kneeWidth: parseFloat(kneeWidthSlider.value),
    outputGain: parseFloat(outputGainSlider.value),
    lookahead: parseFloat(lookaheadSlider.value),
    minRecovery: parseInt(minRecoverySlider.value)
  };
  chrome.storage.local.set({
    ...params,
    autoGain: autoGainCheckbox.checked,
    limiterParams: params
  });
}

function applySettings(s) {
  if (s.saturationLevel !== undefined) {
    satLevelSlider.value = s.saturationLevel;
    satValueEl.textContent = `${parseFloat(s.saturationLevel).toFixed(1)} dB`;
  }
  if (s.kneeWidth !== undefined) {
    kneeWidthSlider.value = s.kneeWidth;
    kneeValueEl.textContent = `${parseFloat(s.kneeWidth).toFixed(1)} dB`;
  }
  if (s.outputGain !== undefined) {
    outputGainSlider.value = s.outputGain;
    gainValueEl.textContent = `+${parseFloat(s.outputGain).toFixed(1)} dB`;
  }
  if (s.lookahead !== undefined) {
    lookaheadSlider.value = s.lookahead;
    lookValueEl.textContent = `${parseFloat(s.lookahead).toFixed(1)} ms`;
  }
  if (s.minRecovery !== undefined) {
    minRecoverySlider.value = s.minRecovery;
    recValueEl.textContent = `${parseInt(s.minRecovery)} ms`;
  }
}

// Get current tab
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Inject the processor script into the page
async function injectProcessor() {
  const tab = await getCurrentTab();
  
  try {
    // Inject the audio processor
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['processor.js'],
      world: 'MAIN'
    });
    
    return true;
  } catch (err) {
    console.error('Error injecting script:', err);
    return false;
  }
}

// Send message to content script
async function sendToPage(message) {
  const tab = await getCurrentTab();
  
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    return response;
  } catch (err) {
    console.error('Error sending message:', err);
    return { error: err.message };
  }
}

// Level meter helpers
function dbToMeterPercent(db) {
  // Map -80 dB .. 0 dB to 0% .. 100%
  const clamped = Math.max(-80, Math.min(0, db));
  return ((clamped + 80) / 80) * 100;
}

function formatDb(db) {
  if (db <= -80) return '-\u221EdB';
  return db.toFixed(1) + 'dB';
}

function updatePeak(state, currentDb, now, dt) {
  if (currentDb >= state.value) {
    state.value = currentDb;
    state.time = now;
  } else if (now - state.time > PEAK_HOLD_MS) {
    // Smooth decay after hold (same rate as bar), never below current
    state.value = Math.max(currentDb, state.value - BAR_DECAY_DB_PER_SEC * dt);
  }
  return state.value;
}

function updateBar(state, currentDb, now, dt) {
  if (currentDb >= state.value) {
    // Instant rise
    state.value = currentDb;
    state.time = now;
  } else if (now - state.time > BAR_HOLD_MS) {
    // Smooth decay after hold
    state.value = Math.max(currentDb, state.value - BAR_DECAY_DB_PER_SEC * dt);
  }
  // During hold: keep state.value unchanged
  return state.value;
}

function updateMeter(key, levelDb, now, dt) {
  const el = meterEls[key];

  const barDb = updateBar(barState[key], levelDb, now, dt);
  el.bar.style.width = dbToMeterPercent(barDb) + '%';

  const peakDb = updatePeak(peakState[key], levelDb, now, dt);
  el.peak.style.left = dbToMeterPercent(peakDb) + '%';
  el.db.textContent = formatDb(peakDb);

  if (peakDb > 0) {
    el.db.style.color = '#ef4444';
  } else {
    el.db.style.color = '';
  }
}

function resetMeter(key) {
  const el = meterEls[key];
  el.bar.style.width = '0%';
  el.peak.style.left = '0%';
  el.db.textContent = '-\u221EdB';
  el.db.style.color = '';
  peakState[key].value = -Infinity;
  barState[key].value = -Infinity;
  barState[key].time = 0;
}

function startMeterPolling() {
  for (const k in peakState) peakState[k].value = -Infinity;
  for (const k in barState) { barState[k].value = -Infinity; barState[k].time = 0; }
  let lastPollTime = performance.now();

  async function poll() {
    if (!isActive) return;
    const resp = await sendToPage({ action: 'getLevels' });
    if (resp && !resp.error) {
      const now = performance.now();
      const dt = (now - lastPollTime) / 1000;
      lastPollTime = now;
      updateMeter('inL', resp.inL, now, dt);
      updateMeter('inR', resp.inR, now, dt);
      updateMeter('outL', resp.outL, now, dt);
      updateMeter('outR', resp.outR, now, dt);
      lastLevels = resp;
      drawPlot(resp);
    }
    if (isActive) {
      meterRafId = requestAnimationFrame(poll);
    }
  }

  meterRafId = requestAnimationFrame(poll);
}

function stopMeterPolling() {
  if (meterRafId) {
    cancelAnimationFrame(meterRafId);
    meterRafId = null;
  }
  for (const k in meterEls) resetMeter(k);
  lastLevels = null;
  drawPlot(null);
}

// Power button
powerBtn.addEventListener('click', async () => {
  if (!isActive) {
    await activateLimiter();
  } else {
    await deactivateLimiter();
  }
});

async function activateLimiter() {
  statusEl.textContent = 'Injecting processor...';
  statusEl.className = 'status-inactive';
  
  // Inject the processor
  const injected = await injectProcessor();
  
  if (!injected) {
    statusEl.textContent = 'Error: Could not inject processor';
    statusEl.className = 'status-error';
    return;
  }
  
  // Wait a bit for injection
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Start processing
  const params = {
    saturationLevel: parseFloat(satLevelSlider.value),
    kneeWidth: parseFloat(kneeWidthSlider.value),
    outputGain: parseFloat(outputGainSlider.value),
    lookahead: parseFloat(lookaheadSlider.value),
    minRecovery: parseInt(minRecoverySlider.value)
  };
  
  const response = await sendToPage({
    action: 'start',
    params: params
  });
  
  if (response && response.success) {
    isActive = true;
    powerBtn.classList.remove('inactive');
    powerBtn.classList.add('active');
    powerText.textContent = 'Active';
    statusEl.textContent = 'Processing audio ✓';
    statusEl.className = 'status-active';
    chrome.storage.local.set({ limiterActive: true, limiterParams: params });
    startMeterPolling();
  } else {
    statusEl.textContent = response?.error || 'Failed to start. Make sure page has audio!';
    statusEl.className = 'status-error';
  }
}

async function deactivateLimiter() {
  await sendToPage({ action: 'stop' });

  isActive = false;
  chrome.storage.local.set({ limiterActive: false });
  stopMeterPolling();
  powerBtn.classList.remove('active');
  powerBtn.classList.add('inactive');
  powerText.textContent = 'Activate';
  statusEl.textContent = 'Limiter stopped';
  statusEl.className = 'status-inactive';
}

// Mouse wheel on sliders — snap to whole increments
const wheelSteps = {
  satLevel: 1,
  kneeWidth: 1,
  outputGain: 1,
  lookahead: 1,
  minRecovery: 10
};

document.querySelectorAll('input[type="range"]').forEach(slider => {
  slider.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = wheelSteps[slider.id] || 1;
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const cur = parseFloat(slider.value);
    // Snap to next whole step in scroll direction
    // e.g. 1.9 up→2, 2 up→3, 1.9 down→1, 1 down→0
    const rounded = Math.round(cur / step) * step;
    let newVal;
    if (e.deltaY < 0) {
      newVal = (rounded > cur + 0.001) ? rounded : rounded + step;
    } else {
      newVal = (rounded < cur - 0.001) ? rounded : rounded - step;
    }
    slider.value = Math.min(max, Math.max(min, newVal));
    slider.dispatchEvent(new Event('input'));
  }, { passive: false });
});

// Slider events - send params to page in real-time
satLevelSlider.addEventListener('input', (e) => {
  const value = parseFloat(e.target.value);
  satValueEl.textContent = `${value.toFixed(1)} dB`;
  if (autoGainCheckbox.checked) {
    const gain = Math.abs(value);
    outputGainSlider.value = gain;
    gainValueEl.textContent = `+${gain.toFixed(1)} dB`;
    if (isActive) {
      sendToPage({ action: 'updateParam', param: 'outputGain', value: gain });
    }
  }
  saveSettings();
  drawPlot(lastLevels);
  if (isActive) {
    sendToPage({ action: 'updateParam', param: 'saturationLevel', value });
  }
});

kneeWidthSlider.addEventListener('input', (e) => {
  const value = parseFloat(e.target.value);
  kneeValueEl.textContent = `${value.toFixed(1)} dB`;
  saveSettings();
  drawPlot(lastLevels);
  if (isActive) {
    sendToPage({ action: 'updateParam', param: 'kneeWidth', value });
  }
});

autoGainCheckbox.addEventListener('change', () => {
  if (autoGainCheckbox.checked) {
    const gain = Math.abs(parseFloat(satLevelSlider.value));
    outputGainSlider.value = gain;
    gainValueEl.textContent = `+${gain.toFixed(1)} dB`;
    if (isActive) {
      sendToPage({ action: 'updateParam', param: 'outputGain', value: gain });
    }
  }
  outputGainSlider.classList.toggle('thumb-muted', autoGainCheckbox.checked);
  saveSettings();
  drawPlot(lastLevels);
});

outputGainSlider.addEventListener('input', (e) => {
  if (autoGainCheckbox.checked) {
    autoGainCheckbox.checked = false;
    outputGainSlider.classList.remove('thumb-muted');
    saveSettings();
  }
  const value = parseFloat(e.target.value);
  gainValueEl.textContent = `+${value.toFixed(1)} dB`;
  saveSettings();
  drawPlot(lastLevels);
  if (isActive) {
    sendToPage({ action: 'updateParam', param: 'outputGain', value });
  }
});

lookaheadSlider.addEventListener('input', (e) => {
  const value = parseFloat(e.target.value);
  lookValueEl.textContent = `${value.toFixed(1)} ms`;
  saveSettings();
  if (isActive) {
    sendToPage({ action: 'updateParam', param: 'lookahead', value });
  }
});

minRecoverySlider.addEventListener('input', (e) => {
  const value = parseInt(e.target.value);
  recValueEl.textContent = `${value} ms`;
  saveSettings();
  if (isActive) {
    sendToPage({ action: 'updateParam', param: 'minRecovery', value });
  }
});

// Build dB scale: tick lines between L/R, numbers between INPUT/OUTPUT
function buildMeterScale() {
  // Tick lines between L and R channels
  document.querySelectorAll('[data-ticks]').forEach(track => {
    for (let db = -80; db <= 0; db += 10) {
      const pct = ((db + 80) / 80) * 100;
      const tick = document.createElement('div');
      tick.className = 'meter-tick';
      tick.style.left = pct + '%';
      track.appendChild(tick);
    }
  });

  // Number labels between INPUT and OUTPUT
  const scaleEl = document.getElementById('meterScale');
  for (let db = -80; db <= 0; db += 10) {
    const pct = ((db + 80) / 80) * 100;
    const label = document.createElement('span');
    label.className = 'meter-scale-label';
    label.style.left = pct + '%';
    label.textContent = db;
    scaleEl.appendChild(label);
  }
}

function addSliderTicks(slider, interval, majorInterval) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const range = max - min;
  const container = document.createElement('div');
  container.className = 'slider-ticks';
  const start = Math.ceil(min / interval) * interval;
  for (let v = start; v <= max + interval * 0.001; v += interval) {
    const pct = ((v - min) / range) * 100;
    const tick = document.createElement('div');
    tick.className = 'slider-tick';
    if (majorInterval && Math.abs(Math.round(v / majorInterval) * majorInterval - v) < 0.01) {
      tick.classList.add('slider-tick-major');
    }
    tick.style.left = pct + '%';
    container.appendChild(tick);
  }
  slider.after(container);
}

function buildSliderTicks() {
  addSliderTicks(satLevelSlider, 1, 10);
  addSliderTicks(kneeWidthSlider, 1);
  addSliderTicks(outputGainSlider, 1, 10);
  addSliderTicks(lookaheadSlider, 1);
  addSliderTicks(minRecoverySlider, 100);
}

// Restore settings and check active state on load
window.addEventListener('load', async () => {
  const stored = await chrome.storage.local.get(['saturationLevel', 'kneeWidth', 'outputGain', 'lookahead', 'minRecovery', 'autoGain', 'limiterActive']);
  applySettings(stored);
  if (stored.autoGain !== undefined) autoGainCheckbox.checked = stored.autoGain;
  outputGainSlider.classList.toggle('thumb-muted', autoGainCheckbox.checked);

  buildMeterScale();
  buildSliderTicks();
  initPlot();
  drawPlot(null);

  // Check if limiter is actually running on the current tab
  const response = await sendToPage({ action: 'status' });

  if (response && response.active) {
    isActive = true;
    powerBtn.classList.remove('inactive');
    powerBtn.classList.add('active');
    powerText.textContent = 'Active';
    statusEl.textContent = 'Processing audio ✓';
    statusEl.className = 'status-active';
    startMeterPolling();
  } else if (stored.limiterActive) {
    // Limiter is globally active but not yet running on this tab — show armed state
    powerBtn.classList.remove('inactive');
    powerBtn.classList.add('active');
    powerText.textContent = 'Active';
    statusEl.textContent = 'Active — waiting for audio';
    statusEl.className = 'status-active';
  }
});