// Audio processor - injected into web pages (MAIN world)
// Handles both <audio>/<video> elements and Web Audio API contexts.
// Uses AudioWorkletNode for sample-accurate limiting.

(function() {
  if (window.__audioLimiterProcessor) return;
  window.__audioLimiterProcessor = true;

  const interceptor = window.__audioLimiterInterceptor;
  const origConnect = interceptor ? interceptor.origConnect : AudioNode.prototype.connect;
  const workletUrl = document.documentElement.dataset.audioLimiterWorkletUrl;

  console.log('Adaptive Audio Limiter injected');

  let isActive = false;
  let audioContext = null; // Our own context for media elements
  let processedElements = new Map(); // MediaElement -> processorData
  let processedContexts = new Map(); // AudioContext -> processorData

  let params = {
    saturationLevel: -8,
    kneeWidth: 6,
    outputGain: 8,
    lookahead: 1.5,
    minRecovery: 150
  };

  // Connect using the original (unpatched) connect to avoid interceptor tracking
  function safeConnect(source, target, output, input) {
    if (output !== undefined && input !== undefined) {
      return origConnect.call(source, target, output, input);
    } else if (output !== undefined) {
      return origConnect.call(source, target, output);
    }
    return origConnect.call(source, target);
  }

  // Track which contexts have already loaded the worklet module
  const workletLoadedContexts = new WeakSet();

  // Try multiple strategies to load the worklet module (CSP varies by page)
  async function loadWorkletModule(ctx) {
    if (workletLoadedContexts.has(ctx)) return;

    // Strategy 1: direct extension URL
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      workletLoadedContexts.add(ctx);
      return;
    } catch (e) { /* blocked by CSP, try fallback */ }

    // Strategy 2: blob URL from fetched source (bypasses strict CSP)
    const resp = await fetch(workletUrl);
    const code = await resp.text();
    const blob = new Blob([code], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    workletLoadedContexts.add(ctx);
  }

  // Create a limiter processing chain in the given AudioContext
  async function createLimiterChain(ctx) {
    await loadWorkletModule(ctx);

    const inputAnalyser = ctx.createAnalyser();
    inputAnalyser.fftSize = 2048;
    inputAnalyser.smoothingTimeConstant = 0.3;

    const limiterNode = new AudioWorkletNode(ctx, 'limiter-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });

    // Send current params to worklet
    limiterNode.port.postMessage({
      type: 'params',
      saturationLevel: params.saturationLevel,
      kneeWidth: params.kneeWidth,
      outputGain: params.outputGain,
      lookaheadMs: params.lookahead,
      minRecovery: params.minRecovery
    });

    // Level data updated by worklet messages
    const levelData = {
      inL: -100, inR: -100,
      outL: -100, outR: -100
    };

    limiterNode.port.onmessage = (e) => {
      if (e.data.type === 'levels') {
        levelData.inL = e.data.inL;
        levelData.inR = e.data.inR;
        levelData.outL = e.data.outL;
        levelData.outR = e.data.outR;
      }
    };

    safeConnect(inputAnalyser, limiterNode);
    safeConnect(limiterNode, ctx.destination);

    return {
      ctx,
      inputAnalyser,
      limiterNode,
      levelData
    };
  }

  // --- Media element processing (for pages with <audio>/<video>) ---

  let lastError = null;
  const mediaSourceCache = new Map(); // MediaElement -> MediaElementSourceNode

  async function processMediaElement(mediaElement) {
    if (processedElements.has(mediaElement)) return;

    try {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 48000
        });
      }

      // Reuse cached source node (createMediaElementSource can only be called once per element)
      let source = mediaSourceCache.get(mediaElement);
      if (!source) {
        source = audioContext.createMediaElementSource(mediaElement);
        mediaSourceCache.set(mediaElement, source);
      }

      const data = await createLimiterChain(audioContext);
      source.disconnect();
      safeConnect(source, data.inputAnalyser);
      data.source = source;

      processedElements.set(mediaElement, data);
      startProcessingLoop(data);
    } catch (err) {
      lastError = err.message;
    }
  }

  async function processAllMedia() {
    const elements = document.querySelectorAll('audio, video');
    for (const el of elements) {
      await processMediaElement(el);
    }
    return elements.length;
  }

  // --- Web Audio context processing (for pages using Web Audio API) ---

  async function processWebAudioContext(ctx) {
    if (processedContexts.has(ctx)) return false;
    if (ctx === audioContext) return false; // Don't process our own context

    const connections = interceptor.connections.get(ctx);
    if (!connections || connections.length === 0) return false;

    try {
      const data = await createLimiterChain(ctx);
      data.originalConnections = [];

      // Reroute all nodes from destination to our inputAnalyser
      for (const conn of [...connections]) {
        try { conn.node.disconnect(ctx.destination); } catch(e) {}
        safeConnect(conn.node, data.inputAnalyser, conn.output, conn.input);
        data.originalConnections.push(conn);
      }

      processedContexts.set(ctx, data);
      startProcessingLoop(data);
      console.log('Processing Web Audio context');
      return true;
    } catch (err) {
      console.error('Error processing Web Audio context:', err);
      return false;
    }
  }

  async function processAllWebAudio() {
    if (!interceptor) return 0;
    let count = 0;
    for (const ctx of interceptor.contexts) {
      if (await processWebAudioContext(ctx)) count++;
    }
    return count;
  }

  function restoreWebAudioContext(ctx) {
    const data = processedContexts.get(ctx);
    if (!data) return;

    // Tell worklet to stop
    data.limiterNode.port.postMessage({ type: 'destroy' });

    // Reconnect original nodes to destination
    for (const conn of data.originalConnections) {
      try { conn.node.disconnect(data.inputAnalyser); } catch(e) {}
      try { safeConnect(conn.node, ctx.destination, conn.output, conn.input); } catch(e) {}
    }

    // Disconnect our chain from destination
    try { data.limiterNode.disconnect(); } catch(e) {}

    processedContexts.delete(ctx);
  }

  // --- Spectral analysis loop (main thread, rAF) ---
  // Only does FFT analysis and sends spectral data to the worklet.

  function startProcessingLoop(processorData) {
    const { inputAnalyser, limiterNode } = processorData;

    const bufferLength = inputAnalyser.frequencyBinCount;
    const timeData = new Float32Array(bufferLength);
    const freqData = new Uint8Array(bufferLength);

    function process() {
      if (!isActive) return;

      try {
        inputAnalyser.getFloatTimeDomainData(timeData);
        inputAnalyser.getByteFrequencyData(freqData);

        // RMS
        let sumSquares = 0;
        for (let i = 0; i < bufferLength; i++) {
          sumSquares += timeData[i] * timeData[i];
        }
        const rms = Math.sqrt(sumSquares / bufferLength);

        // Spectral centroid
        let weightedSum = 0;
        let totalMag = 0;
        for (let i = 0; i < freqData.length; i++) {
          const mag = freqData[i] / 255;
          const freq = (i * processorData.ctx.sampleRate) / (2 * freqData.length);
          weightedSum += freq * mag;
          totalMag += mag;
        }
        const centroid = totalMag > 0 ? weightedSum / totalMag : 0;

        // Low frequency energy (0-200 Hz)
        let lowEnergy = 0;
        const lowBins = Math.floor((200 * freqData.length) / (processorData.ctx.sampleRate / 2));
        for (let i = 0; i < Math.min(lowBins, freqData.length); i++) {
          lowEnergy += freqData[i] / 255;
        }
        lowEnergy /= Math.max(lowBins, 1);

        // Send spectral data to worklet
        limiterNode.port.postMessage({
          type: 'spectral',
          centroid,
          lowEnergy,
          rms
        });
      } catch (err) {
        console.error('Spectral analysis error:', err);
      }

      requestAnimationFrame(process);
    }

    process();
  }

  // --- Activate / deactivate ---

  async function activate() {
    // Resume our context if suspended (Chrome autoplay policy)
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }

    await processAllMedia();
    await processAllWebAudio();

    const totalCount = processedElements.size + processedContexts.size;
    if (totalCount === 0) {
      return { success: false, error: lastError || 'No audio sources found on this page' };
    }

    isActive = true;

    // Restart processing loops
    processedElements.forEach(data => startProcessingLoop(data));
    processedContexts.forEach(data => startProcessingLoop(data));

    // Hook interceptor so new connections while active get routed through our chain
    if (interceptor) {
      interceptor.onNewDestinationConnection = (node, ctx, output, input) => {
        const data = processedContexts.get(ctx);
        if (data) {
          safeConnect(node, data.inputAnalyser, output, input);
          data.originalConnections.push({ node, output, input });
        } else {
          safeConnect(node, ctx.destination, output, input);
        }
      };
    }

    return { success: true, message: `Processing ${totalCount} audio source(s)` };
  }

  function deactivate() {
    isActive = false;

    // Unhook interceptor
    if (interceptor) {
      interceptor.onNewDestinationConnection = null;
    }

    // Media element chains — disconnect worklet, reconnect source → destination
    processedElements.forEach(data => {
      data.limiterNode.port.postMessage({ type: 'destroy' });
      try { data.source.disconnect(data.inputAnalyser); } catch(e) {}
      try { data.limiterNode.disconnect(); } catch(e) {}
      try { data.inputAnalyser.disconnect(); } catch(e) {}
      // Reconnect source directly to destination for continued playback
      safeConnect(data.source, data.ctx.destination);
    });
    processedElements.clear();

    // Restore Web Audio contexts
    for (const [ctx] of processedContexts) {
      restoreWebAudioContext(ctx);
    }

    return { success: true };
  }

  // --- Message handling via postMessage (from bridge.js) ---

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'audioLimiter_toPage') return;

    const { id, payload: message } = event.data;

    // Handle async actions
    const respond = (response) => {
      window.postMessage({
        type: 'audioLimiter_fromPage',
        id: id,
        payload: response
      }, '*');
    };

    if (message.action === 'start') {
      if (message.params) {
        params = { ...params, ...message.params };
      }
      activate().then(respond).catch(err => {
        console.error('[Limiter] activate error:', err);
        respond({ success: false, error: err.message });
      });
      return;
    }

    if (message.action === 'stop') {
      respond(deactivate());
      return;
    }

    if (message.action === 'updateParam') {
      if (message.param && message.value !== undefined) {
        params[message.param] = message.value;

        // Forward to all worklet nodes
        const paramMsg = { type: 'params' };
        if (message.param === 'lookahead') paramMsg.lookaheadMs = message.value;
        else if (message.param === 'saturationLevel') paramMsg.saturationLevel = message.value;
        else if (message.param === 'kneeWidth') paramMsg.kneeWidth = message.value;
        else if (message.param === 'outputGain') paramMsg.outputGain = message.value;
        else if (message.param === 'minRecovery') paramMsg.minRecovery = message.value;

        const allData = [...processedElements.values(), ...processedContexts.values()];
        for (const data of allData) {
          data.limiterNode.port.postMessage(paramMsg);
        }

        respond({ success: true });
        return;
      }
    }

    if (message.action === 'getLevels') {
      let inL = -100, inR = -100, outL = -100, outR = -100;
      const allData = [...processedElements.values(), ...processedContexts.values()];
      for (const data of allData) {
        if (data.levelData.inL > inL) inL = data.levelData.inL;
        if (data.levelData.inR > inR) inR = data.levelData.inR;
        if (data.levelData.outL > outL) outL = data.levelData.outL;
        if (data.levelData.outR > outR) outR = data.levelData.outR;
      }
      respond({ inL, inR, outL, outR });
      return;
    }

    if (message.action === 'status') {
      respond({
        active: isActive,
        elementCount: processedElements.size + processedContexts.size
      });
      return;
    }

    respond(undefined);
  });

  // Auto-detect new media elements
  const observer = new MutationObserver((mutations) => {
    if (!isActive) return;
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') {
          processMediaElement(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('audio, video').forEach(el => processMediaElement(el));
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  console.log('Audio limiter ready');
})();
