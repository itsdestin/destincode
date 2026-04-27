import WebSocket from 'ws';

const target = process.argv[2];
if (!target) { console.error('usage: node cdp-watch.mjs <ws-url>'); process.exit(1); }

const ws = new WebSocket(target);
let id = 0;
const send = (method, params = {}) => { ws.send(JSON.stringify({ id: ++id, method, params })); };

ws.on('open', () => {
  console.log('[connected]');
  send('Runtime.enable');
  send('Console.enable');
  send('Network.enable');
  // Patch the WebSocket send/receive globally so we can see bridge traffic
  send('Runtime.evaluate', {
    expression: `
      (function() {
        if (window.__bridgeTrace) return 'already patched';
        window.__bridgeTrace = true;
        const origWS = window.WebSocket;
        window.WebSocket = function(url, ...args) {
          console.log('[BRIDGE_NEW] url=' + url);
          const s = new origWS(url, ...args);
          const origSend = s.send.bind(s);
          s.send = function(data) {
            try { console.log('[BRIDGE_SEND] ' + (typeof data === 'string' ? data.slice(0, 500) : '<binary>')); } catch (e) {}
            return origSend(data);
          };
          s.addEventListener('message', (ev) => {
            try { console.log('[BRIDGE_RECV] ' + (typeof ev.data === 'string' ? ev.data.slice(0, 500) : '<binary>')); } catch (e) {}
          });
          s.addEventListener('open', () => console.log('[BRIDGE_OPEN] ' + url));
          s.addEventListener('error', (e) => console.log('[BRIDGE_ERR] ' + url));
          s.addEventListener('close', (e) => console.log('[BRIDGE_CLOSE] ' + url + ' code=' + e.code));
          return s;
        };
        // Copy static props
        for (const k of Object.keys(origWS)) try { window.WebSocket[k] = origWS[k]; } catch (e) {}
        window.WebSocket.prototype = origWS.prototype;
        return 'patched (will catch NEW WebSockets only)';
      })()
    `, returnByValue: true
  });
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Console.messageAdded') {
    const args = msg.params.args || [{value: msg.params.message?.text}];
    console.log('[CONSOLE]', args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const ex = msg.params.exceptionDetails;
    console.log('[EXCEPTION]', ex.text, ex.exception?.description || '', 'at', ex.url + ':' + ex.lineNumber);
  } else if (msg.method === 'Network.webSocketCreated') {
    console.log('[NET_WS_CREATED]', msg.params.url);
  } else if (msg.method === 'Network.webSocketFrameSent') {
    console.log('[NET_WS_SEND]', (msg.params.response.payloadData || '').slice(0, 300));
  } else if (msg.method === 'Network.webSocketFrameReceived') {
    console.log('[NET_WS_RECV]', (msg.params.response.payloadData || '').slice(0, 300));
  } else if (msg.method === 'Network.webSocketClosed') {
    console.log('[NET_WS_CLOSED]', msg.params.requestId);
  } else if (msg.id && msg.result?.result?.value) {
    console.log('[EVAL]', msg.result.result.value);
  } else if (msg.id && msg.error) {
    console.log('[CDP_ERR]', JSON.stringify(msg.error));
  }
});

ws.on('error', e => console.error('[ws error]', e.message));
ws.on('close', () => { console.log('[disconnected]'); process.exit(0); });
