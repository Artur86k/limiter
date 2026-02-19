// Runs at document_start in MAIN world, before page JavaScript.
// Patches AudioContext to track all created contexts and connections to destination.
(function() {
  if (window.__audioLimiterInterceptor) return;

  const data = {
    contexts: [],
    connections: new Map(), // AudioContext -> [{ node, output, input }]
    origConnect: AudioNode.prototype.connect,
    // Called by processor.js when limiter is active and a new node connects to destination
    onNewDestinationConnection: null
  };
  window.__audioLimiterInterceptor = data;

  // Patch AudioContext constructors to track every context the page creates
  ['AudioContext', 'webkitAudioContext'].forEach(name => {
    const Orig = window[name];
    if (!Orig) return;
    const Patched = function(...args) {
      const ctx = new Orig(...args);
      data.contexts.push(ctx);
      data.connections.set(ctx, []);
      return ctx;
    };
    Patched.prototype = Orig.prototype;
    Object.setPrototypeOf(Patched, Orig);
    window[name] = Patched;
  });

  // Patch connect to track which nodes connect to AudioDestinationNode
  AudioNode.prototype.connect = function(target, ...args) {
    if (target instanceof AudioDestinationNode) {
      const ctx = target.context;
      if (!data.connections.has(ctx)) {
        data.connections.set(ctx, []);
        data.contexts.push(ctx);
      }
      data.connections.get(ctx).push({ node: this, output: args[0], input: args[1] });

      if (data.onNewDestinationConnection) {
        // Limiter is active — route through processing chain, skip real destination
        data.onNewDestinationConnection(this, ctx, args[0], args[1]);
        return target;
      }
    }
    return data.origConnect.call(this, target, ...args);
  };
})();
