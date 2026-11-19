const panel = `
  <h1 id="voice-title">Call Brain</h1>
  <p data-status role="status">Ready to connect</p>
  <p class="voice-meta"><span data-duration>00:00</span><span data-timings></span></p>
  <div class="voice-controls">
    <button type="button" data-start>Start call</button>
    <button type="button" data-mic disabled>Enable mic</button>
    <button type="button" data-browser hidden>Use browser recognition</button>
    <button type="button" data-interrupt disabled>Interrupt</button>
    <button type="button" data-end disabled>Hang up</button>
  </div>
  <label class="voice-option"><input type="checkbox" data-speak checked> Speak replies</label>
  <div class="voice-log" data-log role="log" aria-label="Conversation"></div>
  <p data-partial class="voice-meta"></p>
  <form class="voice-text">
    <label for="voice-question">Message Brain</label>
    <div><input id="voice-question" data-text maxlength="1000" enterkeyhint="send" disabled required><button disabled>Send</button></div>
  </form>
`;

function wavBase64(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, label] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) bytes.set(new TextEncoder().encode(label), offset);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.length - 44, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function mountVoice(root, { launch, getHeaders = () => ({}), getPreset = () => 'mtd' } = {}) {
  root.insertAdjacentHTML('beforeend', panel);
  const get = name => root.querySelector('[data-' + name + ']');
  const form = root.querySelector('form');
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let token, expires, started, pending, playback, mic, openingMic, connection, ready = false;
  let modes = [], history = [], preset = getPreset();

  const status = text => { get('status').textContent = text; };
  function controls() {
    get('start').disabled = Boolean(connection) || ready || Boolean(!token && launch === '');
    get('start').textContent = ready ? 'Call connected' : token ? 'Reconnect' : 'Start call';
    get('mic').disabled = !ready || !modes.length || Boolean(openingMic);
    get('mic').textContent = mic ? 'Mute mic' : openingMic ? 'Opening mic…' : 'Enable mic';
    get('browser').hidden = !(ready && Recognition && modes.includes('browser') && modes.some(mode => mode !== 'browser'));
    get('browser').disabled = Boolean(openingMic) || mic?.type === 'browser';
    get('end').disabled = !token && !connection;
    get('interrupt').disabled = !pending && !playback;
    get('text').disabled = form.querySelector('button').disabled = !ready;
  }
  function addLine(who, value) {
    const line = document.createElement('p');
    const name = document.createElement('strong');
    name.textContent = who + ' ';
    line.append(name, document.createTextNode(value));
    get('log').append(line);
    while (get('log').children.length > 40) get('log').firstChild.remove();
    get('log').scrollTop = get('log').scrollHeight;
  }
  function idle() {
    status(mic ? 'Listening' : 'Connected · mic off');
    controls();
  }
  async function request(action, data = {}, { headers, signal, keepalive = false } = {}) {
    const response = await fetch(action === 'turn' ? '/api/voice-turn' : '/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-lcp-voice': token } : {}), ...headers },
      body: JSON.stringify({ action, ...data }), signal, keepalive,
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'Call Brain unavailable.'), { status: response.status });
    return value;
  }
  function stopPlayback() {
    const current = playback;
    playback = null;
    current?.stop();
  }
  function interrupt(showStatus = true) {
    if (pending) {
      const { id, controller } = pending;
      pending = null;
      controller.abort();
      void request('cancel', { id }, { keepalive: true }).catch(() => {});
    }
    stopPlayback();
    if (showStatus && ready) idle();
    controls();
  }
  function stopMic() {
    const attempt = openingMic;
    openingMic = null;
    attempt?.stop?.();
    const current = mic;
    mic = null;
    current?.stop();
    get('partial').textContent = '';
    controls();
  }
  function disconnect(message, clearToken = false) {
    ready = false;
    interrupt(false);
    stopMic();
    if (clearToken) {
      token = null;
      history = [];
      get('log').replaceChildren();
    }
    status(message);
    controls();
  }
  function end() {
    connection?.abort();
    connection = null;
    if (token) void request('end', {}, { keepalive: true }).catch(() => {});
    disconnect(launch === '' ? 'Call ended. Run /call-lcp for a new link.' : 'Call ended.', true);
    history = [];
    get('log').replaceChildren();
    get('timings').textContent = '';
    get('duration').textContent = '00:00';
    started = null;
  }
  async function start() {
    if (connection || ready || (!token && launch === '')) return;
    const controller = new AbortController();
    connection = controller;
    status(token ? 'Reconnecting…' : 'Connecting…');
    controls();
    try {
      // Populate and unlock the local speech engine during the user gesture when available.
      window.speechSynthesis?.getVoices();
      const response = token ? await request('resume', {}, { signal: controller.signal })
        : await request('start', launch ? { launch } : {}, { headers: launch ? {} : await getHeaders(), signal: controller.signal });
      if (connection !== controller) return;
      if (response.token) {
        token = response.token;
        if (launch) launch = '';
        started = Date.now();
        preset = getPreset();
      }
      expires = response.expires;
      modes = response.stt;
      ready = true;
      idle();
    } catch (error) {
      if (connection === controller) {
        if (error.status === 401 && token) disconnect('Session expired. Start a new call.', true);
        else status(error.message || 'Connection failed.');
      }
    } finally {
      if (connection === controller) connection = null;
      controls();
    }
  }

  function speak(result, at) {
    if (!get('speak').checked) return idle();
    function finished(owner, message) {
      if (playback !== owner) return;
      playback = null;
      if (message) status(message);
      else idle();
      controls();
    }
    const startTime = () => {
      const { sttMs, mcpMs, reasoningMs, ttsMs } = result.timings;
      const timings = 'STT ' + sttMs + ' ms · Report ' + mcpMs + ' ms · Brain ' + reasoningMs + ' ms' +
        (ttsMs == null ? '' : ' · TTS ' + ttsMs + ' ms');
      get('timings').textContent = timings + ' · Playback ' + Math.round(performance.now() - at) + ' ms';
      status('Speaking');
    };
    function browserSpeech() {
      const engine = window.speechSynthesis;
      const voice = engine?.getVoices().find(item => item.localService && /^en([-_]|$)/i.test(item.lang));
      if (!voice) {
        status('Reply ready · local speech voice unavailable');
        controls();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(result.answer);
      utterance.voice = voice;
      const owner = { stop: () => engine.cancel() };
      playback = owner;
      utterance.onstart = () => { if (playback === owner) startTime(); };
      utterance.onend = () => finished(owner);
      utterance.onerror = () => finished(owner, 'Reply ready · playback unavailable');
      engine.speak(utterance);
      controls();
    }
    if (!result.audio) return browserSpeech();
    const samples = Uint8Array.from(atob(result.audio.base64), byte => byte.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([samples], { type: result.audio.type }));
    const audio = new Audio(url);
    const owner = { stop: () => { audio.pause(); URL.revokeObjectURL(url); } };
    playback = owner;
    audio.onplaying = () => { if (playback === owner) startTime(); };
    audio.onended = () => { owner.stop(); finished(owner); };
    const fallback = () => {
      if (playback !== owner) return;
      owner.stop();
      playback = null;
      browserSpeech();
    };
    audio.onerror = fallback;
    void audio.play().catch(fallback);
    controls();
  }

  async function send(input, at = performance.now()) {
    if (!ready) return;
    interrupt(false);
    const current = { id: crypto.randomUUID(), controller: new AbortController() };
    pending = current;
    if (input.text) addLine('You', input.text);
    status(input.audio ? 'Transcribing…' : 'Thinking…');
    get('timings').textContent = '';
    controls();
    try {
      const result = await request('turn', { id: current.id, ...input, history, preset, speak: get('speak').checked }, { signal: current.controller.signal });
      if (pending !== current) return;
      pending = null;
      if (!result.answer) return idle();
      if (!input.text) addLine('You', result.transcript);
      addLine('Brain', result.answer);
      preset = result.preset;
      history = [...history, { role: 'user', content: result.transcript }, { role: 'assistant', content: result.answer }].slice(-6);
      const { sttMs, mcpMs, reasoningMs, ttsMs } = result.timings;
      get('timings').textContent = 'STT ' + sttMs + ' ms · Report ' + mcpMs + ' ms · Brain ' + reasoningMs + ' ms' +
        (ttsMs == null ? '' : ' · TTS ' + ttsMs + ' ms');
      speak(result, at);
    } catch (error) {
      if (pending !== current) return;
      pending = null;
      if (error.status === 401) return disconnect(error.message, true);
      if (!error.status) return disconnect('Connection lost. Reconnect to continue.');
      status(error.message);
      controls();
    }
  }
  async function enableMic(forceBrowser = false) {
    if (!ready || openingMic) return;
    const server = modes.some(mode => mode !== 'browser');
    const browser = (forceBrowser || !server) && modes.includes('browser') && Recognition;
    if (!server && !browser) return status('Speech recognition is unavailable. You can type a message.');
    stopMic();
    const attempt = {};
    openingMic = attempt;
    status('Opening microphone…');
    controls();
    try {
      if (browser) {
        const recognition = new Recognition();
        recognition.lang = 'en-US';
        recognition.continuous = true;
        recognition.interimResults = true;
        const current = { type: 'browser', stop: () => { recognition.onend = null; recognition.abort(); } };
        recognition.onspeechstart = () => { if (mic === current) interrupt(); };
        recognition.onresult = event => {
          if (mic !== current) return;
          const final = [];
          const partial = [];
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            (result.isFinal ? final : partial).push(result[0].transcript);
          }
          get('partial').textContent = partial.join(' ');
          const text = final.join(' ').trim().slice(0, 1000);
          if (text) void send({ text });
        };
        recognition.onerror = event => {
          if (mic !== current || event.error === 'no-speech') return;
          stopMic();
          status('Browser recognition unavailable. You can type a message.');
        };
        recognition.onend = () => {
          if (mic !== current) return;
          try { recognition.start(); } catch { stopMic(); idle(); }
        };
        recognition.start();
        mic = current;
        return idle();
      }

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs HTTPS or localhost and a supported browser.');
      const context = new AudioContext();
      let stream;
      const stop = () => {
        stream?.getTracks().forEach(track => track.stop());
        if (context.state !== 'closed') void context.close().catch(() => {});
      };
      attempt.stop = stop;
      try {
        const resume = context.resume();
        void resume.catch(() => {});
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        if (openingMic !== attempt) return stop();
        await resume;
        if (!context.audioWorklet || context.sampleRate < 16000) throw new Error('This browser cannot process the microphone. Use text or browser recognition.');
        await context.audioWorklet.addModule('/voice-vad.js');
        if (openingMic !== attempt) return stop();
        const processor = new AudioWorkletNode(context, 'lcp-voice-capture');
        const source = context.createMediaStreamSource(stream);
        const current = { type: 'worklet', stop };
        source.connect(processor).connect(context.destination); // The worklet emits silent audio to the sink.
        processor.port.onmessage = ({ data }) => {
          if (mic !== current) return;
          if (data.type === 'onset') {
            interrupt(false);
            status('Hearing you…');
          } else if (data.type === 'utterance') {
            const endedAt = performance.now() - Math.max(0, context.currentTime - data.endedAt) * 1000;
            void send({ audio: wavBase64(data.samples) }, endedAt);
          }
        };
        for (const track of stream.getTracks()) track.onended = () => {
          if (mic !== current) return;
          stopMic();
          status('Microphone disconnected. Re-enable it or use text.');
        };
        mic = current;
        idle();
      } catch (error) {
        stop();
        throw error;
      }
    } catch (error) {
      if (openingMic === attempt) status(error.name === 'NotAllowedError' ? 'Microphone permission denied. Allow access or use text.' : error.message);
    } finally {
      if (openingMic === attempt) openingMic = null;
      controls();
    }
  }

  get('start').onclick = start;
  get('end').onclick = end;
  get('mic').onclick = () => {
    if (!mic) return void enableMic();
    stopMic();
    if (!pending && !playback) idle();
  };
  get('browser').onclick = () => void enableMic(true);
  get('interrupt').onclick = () => interrupt();
  get('speak').onchange = () => {
    if (!get('speak').checked && playback) {
      stopPlayback();
      idle();
    }
  };
  form.onsubmit = event => {
    event.preventDefault();
    const text = get('text').value.trim();
    if (!ready || !text) return;
    get('text').value = '';
    void send({ text });
  };
  const clock = setInterval(() => {
    if (!started) return;
    const seconds = Math.floor((Math.min(Date.now(), expires) - started) / 1000);
    get('duration').textContent = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
    if (token && Date.now() >= expires) disconnect(launch === '' ? 'Session expired. Run /call-lcp again.' : 'Session expired. Start a new call.', true);
  }, 500);
  window.addEventListener('offline', () => { if (ready) disconnect('Offline. Reconnect when your connection returns.'); });
  window.addEventListener('pagehide', end);
  root.addEventListener('close', end);
  controls();
  return { unavailable() { clearInterval(clock); status('Open a fresh link from /call-lcp.'); } };
}
