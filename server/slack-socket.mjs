// Slack Socket Mode for the VM (ported from A2Z server/slack-socket.mjs). The VM has no public ingress, so it opens an outbound
// WebSocket to Slack instead of receiving Events API posts. Uses Node's built-in WebSocket (Node 22), no ws dependency.
// Enable with SLACK_APP_TOKEN (xapp-..., connections:write) and Socket Mode on in the Slack app. Then remove the Events API URL
// in Slack so Netlify and the VM do not both answer.
import { createSlackWorker, slackApi } from '../netlify/functions/lib/slack.mjs';

export function startSlackSocket({ env, openStore, jarvis, memory, execute, WebSocketImpl = globalThis.WebSocket, log = console.log }) {
  const token = env.SLACK_APP_TOKEN?.trim();
  if (!token || !WebSocketImpl) return { stop: () => {}, status: () => 'off' };
  const worker = createSlackWorker({ env, openStore, ...(jarvis && { jarvis }), ...(memory && { memory }), ...(execute && { execute }) });
  const seen = new Set();
  let stopped = false, socket = null, reconnect = null, heartbeat = null, working = 0, delay = 1000, state = 'connecting';

  function retry() {
    if (stopped || reconnect) return;
    state = 'reconnecting';
    reconnect = setTimeout(() => { reconnect = null; void connect(); }, delay);
    delay = Math.min(60000, delay * 2);
  }

  async function connect() {
    try {
      const { url } = await slackApi(token, 'apps.connections.open', {});
      const endpoint = new URL(url);
      if (endpoint.protocol !== 'wss:' || !endpoint.hostname.endsWith('.slack.com')) throw new Error('Invalid Slack endpoint');
      if (stopped) return;
      const current = socket = new WebSocketImpl(endpoint.href);
      const resetHeartbeat = () => { clearTimeout(heartbeat); heartbeat = setTimeout(() => current.close(), 90000); };
      current.addEventListener('open', () => { state = 'connected'; resetHeartbeat(); });
      current.addEventListener('message', message => {
        resetHeartbeat();
        let envelope;
        try { envelope = JSON.parse(typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8')); } catch { return; }
        if (envelope.type === 'hello') { delay = 1000; return; }
        if (envelope.type === 'disconnect') { current.close(); return; }
        if (typeof envelope.envelope_id !== 'string') return;
        const eventId = envelope.payload?.event_id;
        const event = envelope.payload?.event;
        if (envelope.type !== 'events_api' || !event || seen.has(eventId)) { current.send(JSON.stringify({ envelope_id: envelope.envelope_id })); return; }
        if (working >= 4) return; // Leave it unacknowledged so Slack retries later.
        current.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (eventId) { seen.add(eventId); if (seen.size > 500) seen.delete(seen.values().next().value); }
        working++;
        void Promise.resolve().then(() => worker(event)).catch(() => log('Slack event processing failed.')).finally(() => { working--; });
      });
      current.addEventListener('error', () => { try { current.close(); } catch { /* already closed */ } });
      current.addEventListener('close', () => { clearTimeout(heartbeat); if (socket === current) socket = null; retry(); });
    } catch {
      log('Slack Socket Mode connection failed.');
      retry();
    }
  }

  void connect();
  return {
    status: () => state,
    stop() { stopped = true; state = 'off'; clearTimeout(reconnect); clearTimeout(heartbeat); try { socket?.close(); } catch { /* ignore */ } },
  };
}
