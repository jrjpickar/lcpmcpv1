import { frames } from './animation-frame.mjs';
import { topicFor } from './topic-rules.mjs';

const TAU = Math.PI * 2;
const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const pitchCos = Math.cos(.35), pitchSin = Math.sin(.35);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

function geometry(density) {
  let seed = 7409;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 4294967296;
  const shellSizes = [Math.round(density * .63), Math.round(density * .14)];
  shellSizes.push(density - shellSizes[0] - shellSizes[1]);
  const shells = [1, 1.15, .55].map((radius, index) => {
    const points = [], starts = [], ends = [], pads = [];
    for (let i = 0; i < shellSizes[index]; i++) {
      let lat = 10 + Math.floor(random() * 52), lon = Math.floor(random() * 144), heading = Math.floor(random() * 8);
      const steps = 8 + Math.floor(random() * 27);
      starts.push(points.length / 3);
      for (let step = 0; step <= steps; step++) {
        const a = lat * Math.PI / 72 - Math.PI / 2, b = lon * TAU / 144;
        points.push(radius * Math.cos(a) * Math.cos(b), radius * Math.sin(a), radius * Math.cos(a) * Math.sin(b));
        if (random() < .25) heading = (heading + (random() < .5 ? 1 : 7)) % 8;
        const [dx, dy] = directions[heading];
        lat = Math.min(70, Math.max(2, lat + dy)); lon += dx;
      }
      ends.push(points.length / 3);
      pads.push(points.length / 3 - 1);
    }
    return { radius, points, starts, ends, pads, reverse: index === 2 };
  });
  function ring(shell, radius, tilt, offset, from = 0, arc = TAU) {
    shell.starts.push(shell.points.length / 3);
    const segments = Math.ceil(arc * 10);
    for (let i = 0; i <= segments; i++) {
      const angle = from + arc * i / segments, y = radius * Math.sin(angle);
      shell.points.push(radius * Math.cos(angle), offset + y * Math.sin(tilt), y * Math.cos(tilt));
    }
    shell.ends.push(shell.points.length / 3);
  }
  for (const offset of [-.034, 0, .034]) ring(shells[0], 1, .16, offset);
  ring(shells[0], 1.22, -.19, 0);
  ring(shells[2], .62, -.56, 0);
  for (let i = 0; i < 4; i++) ring(shells[1], 1.15, .48, 0, i * TAU / 4, .83);
  return shells.map(shell => ({
    ...shell, points: Float32Array.from(shell.points), projected: new Float32Array(shell.points.length),
  }));
}

export function frontHit(points, x, y) {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i], dx = x - p.x, dy = y - p.y;
    if (dx * dx + dy * dy <= p.hitRadius * p.hitRadius) return p;
  }
  return null;
}

export function mountTopics(container, openChat, renderChat, readDiagnostics) {
  const canvas = element('canvas', 'jarvis-circuit');
  canvas.setAttribute('aria-hidden', 'true');
  const badge = element('span', 'jarvis-core-state', 'JARVIS / idle');
  const mirror = element('div', 'jarvis-topic-mirror');
  mirror.setAttribute('aria-label', 'Chat topics');
  const menu = element('section', 'jarvis-topic-menu');
  menu.hidden = true;
  menu.setAttribute('aria-label', 'Topic chats');
  const title = element('h2');
  const closeButton = element('button', '', 'Close');
  closeButton.type = 'button';
  const header = element('header');
  header.append(title, closeButton);
  const chats = element('ul');
  const refreshButton = element('button', '', 'Refresh');
  refreshButton.type = 'button';
  refreshButton.hidden = true;
  menu.append(header, refreshButton, chats);
  container.append(canvas, badge, mirror, menu);
  const ctx = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const voice = document.querySelector('#voice-panel');
  const topics = new Map();
  const diagnosticsButton = element('button', '', 'System Diagnostics');
  diagnosticsButton.type = 'button';
  diagnosticsButton.setAttribute('aria-expanded', 'false');
  mirror.append(diagnosticsButton);
  const diagnostic = {
    label: 'System Diagnostics', caption: 'SYSTEM DIAGNOSTICS', entries: [],
    button: diagnosticsButton, started: performance.now(), growing: true,
  };
  diagnosticsButton.onclick = () => open(diagnostic);
  const modelState = data => !data?.configured ? 'unknown'
    : data.retryAt ? (data.active === data.backup ? 'degraded' : 'checking')
    : data.active === data.primary ? 'operational' : 'unknown';
  const stateColors = { operational: '#65ee95', degraded: '#ffd261', checking: '#68adff', unknown: '#9ba9bc' };
  let diagnosticData, diagnosticError, diagnosticRequest, diagnosticTimer;
  const refreshDiagnostics = () => {
    if (diagnosticRequest || document.hidden || !visible) return;
    diagnosticRequest = readDiagnostics().then(data => {
      diagnosticData = data; diagnosticError = null;
    }, () => {
      diagnosticData = null;
      diagnosticError = 'Diagnostics unavailable. Select Refresh to retry.';
    }).finally(() => {
      diagnosticRequest = null;
      if (selected === diagnostic) renderMenu();
    });
  };
  function scheduleDiagnostics() {
    clearInterval(diagnosticTimer);
    if (!document.hidden && visible && selected === diagnostic) {
      refreshDiagnostics();
      diagnosticTimer = setInterval(refreshDiagnostics, 15000);
    }
  }
  refreshButton.onclick = refreshDiagnostics;
  let points = [], selected = null, frame = 0, visible = false, busy = false, thinkingUntil = 0;
  let voiceState = 'idle', state = 'idle', last = 0, orbit = 0, yaw = 0, inner = 0, ripple = 0;
  let width = 0, height = 0, density, shells, palette, glow, pendingThread = null;

  function refreshPalette() {
    const style = getComputedStyle(container);
    const hue = Number(style.getPropertyValue('--jarvis-hue').trim() || 208);
    const requested = Math.round(Number(style.getPropertyValue('--jarvis-density').trim() || 180));
    const next = Math.min(320, Math.max(1, requested || 180));
    if (density !== next) { density = next; shells = geometry(next); }
    const blue = (light, alpha = 1) => 'hsla(' + (Number.isFinite(hue) ? hue : 208) + ', 100%, ' + light + '%, ' + alpha + ')';
    palette = [blue(59, .055), blue(65, .22), blue(64, .12), blue(75, .72), blue(80), blue(61, .6), blue(61, .23), blue(95, .55)];
    if (ctx && width && height) {
      const x = width / 2, y = height / 2;
      glow = ctx.createRadialGradient(x, y, 0, x, y, Math.min(width, height) * .29);
      glow.addColorStop(0, blue(59, .38));
      glow.addColorStop(.55, blue(51, .12));
      glow.addColorStop(1, blue(51, 0));
    }
  }

  function resize() {
    const { width: w, height: h } = canvas.getBoundingClientRect();
    if (w > 0 && h > 0 && (w !== width || h !== height)) {
      width = w; height = h;
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    refreshPalette();
    schedule();
  }

  function schedule() {
    if (ctx && visible && !document.hidden && width && !frame) frame = frames.request(draw);
  }

  function pause() {
    frames.cancel(frame); frame = 0; last = 0;
  }

  function paintCore(now) {
    const front = new Path2D(), back = new Path2D();
    const x = width / 2, y = height / 2, size = Math.min(width, height) * .235;
    for (const shell of shells) {
      const angle = shell.reverse ? inner : yaw, c = Math.cos(angle), s = Math.sin(angle);
      const { points: vertices, projected, starts, ends, pads } = shell;
      for (let i = 0; i < vertices.length; i += 3) {
        const z = vertices[i + 2] * c - vertices[i] * s;
        const depth = vertices[i + 1] * pitchSin + z * pitchCos;
        const perspective = size * 3.8 / (3.8 - depth);
        projected[i] = x + (vertices[i] * c + vertices[i + 2] * s) * perspective;
        projected[i + 1] = y + (vertices[i + 1] * pitchCos - z * pitchSin) * perspective;
        projected[i + 2] = depth;
      }
      for (let trace = 0; trace < starts.length; trace++) {
        let current;
        for (let i = (starts[trace] + 1) * 3; i < ends[trace] * 3; i += 3) {
          const path = projected[i + 2] + projected[i - 1] >= 0 ? front : back;
          if (path !== current) path.moveTo(projected[i - 3], projected[i - 2]);
          path.lineTo(projected[i], projected[i + 1]);
          current = path;
        }
      }
      for (const pad of pads) {
        const i = pad * 3, path = projected[i + 2] >= 0 ? front : back;
        path.moveTo(projected[i] + 1.3, projected[i + 1]);
        path.arc(projected[i], projected[i + 1], 1.3, 0, TAU);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = state === 'idle' ? .65 : 1;
    ctx.fillStyle = glow;
    ctx.fillRect(x - size * 1.4, y - size * 1.4, size * 2.8, size * 2.8);
    for (const [path, index] of [[back, 0], [front, 2]]) {
      ctx.lineWidth = 3; ctx.strokeStyle = palette[index]; ctx.stroke(path);
      ctx.lineWidth = 1; ctx.strokeStyle = palette[index + 1]; ctx.stroke(path);
    }
    ctx.globalAlpha = state === 'thinking' ? .42 + .35 * Math.sin(now * (motion.matches ? .005 : .02)) : .44;
    ctx.strokeStyle = palette[4]; ctx.beginPath();
    for (let i = -2; i <= 2; i++) {
      const reach = size * (1.53 - Math.abs(i) * .18);
      ctx.moveTo(x - reach, y + reach * .43 + i * 2);
      ctx.lineTo(x + reach, y - reach * .43 + i * 2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (state === 'speaking' && !motion.matches) {
      ctx.beginPath(); ctx.arc(x, y, size * (.2 + 1.4 * ripple), 0, TAU);
      ctx.globalAlpha = .55 * (1 - ripple); ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function paintTopic(p) {
    ctx.globalAlpha = p.depth < 0 ? .58 : 1;
    ctx.strokeStyle = p === diagnostic ? stateColors[modelState(diagnosticData)] : palette[4]; ctx.lineWidth = 1;
    ctx.fillStyle = palette[6]; ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, Math.max(1, Math.abs(Math.sin(orbit + p.angle)) * p.r), p.r, -.33, 0, TAU);
    ctx.ellipse(p.x, p.y, p.r, Math.max(1, p.r * .43), orbit + p.angle, 0, TAU);
    ctx.stroke();
    if (p === selected) {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 4 + 2 * Math.sin(orbit * 12), 0, TAU);
      ctx.strokeStyle = palette[5]; ctx.stroke();
    }
    ctx.fillStyle = palette[4]; ctx.fillText(p.caption, p.x, p.y + p.r + 13, width * .4);
    ctx.globalAlpha = 1;
  }

  function draw(now) {
    frame = 0;
    if (!visible || document.hidden) return;
    const delta = last ? Math.min(.05, (now - last) / 1000) : 0;
    last = now;
    const dt = delta * (motion.matches ? .25 : 1);
    const next = voiceState !== 'idle' ? voiceState : busy || now < thinkingUntil ? 'thinking' : 'idle';
    if (next !== state) { state = next; badge.textContent = 'JARVIS / ' + state; }
    yaw += dt * ({ idle: .15, listening: .25, thinking: .7, speaking: .3 }[state]);
    inner -= dt * (state === 'thinking' ? 1.4 : .31);
    orbit += dt * .37;
    ripple = state === 'speaking' ? (ripple + dt * 1.4) % 1 : 0;
    ctx.clearRect(0, 0, width, height);
    ctx.textAlign = 'center'; ctx.font = '11px monospace';
    for (const p of points) {
      if (p !== selected || p.frozen === undefined) p.frozen = orbit + p.angle;
      const angle = p.frozen, u = Math.cos(angle), v = Math.sin(angle);
      p.depth = v;
      p.x = width * (.5 + .34 * u + .045 * v);
      p.y = height * (.5 + .27 * v - .09 * u);
      const age = Math.max(0, (now - p.started) * (motion.matches ? .25 : 1));
      const birth = p.growing ? Math.min(1, .12 + age / 370) : 1;
      const bump = p.growing ? 0 : .28 * Math.sin(Math.PI * Math.min(1, age / 420));
      p.r = Math.max(3, (p === diagnostic ? 17 : 9 + Math.min(15, Math.sqrt(p.entries.length) * 3)) * (1 + .17 * v) * (birth + bump));
      p.hitRadius = Math.max(22, p.r + 5);
    }
    points.sort((a, b) => a.depth - b.depth);
    for (const p of points) if (p.depth < 0) paintTopic(p);
    paintCore(now);
    for (const p of points) if (p.depth >= 0) paintTopic(p);
    schedule();
  }

  function close(restore = true) {
    if (!selected) return;
    const previous = selected;
    selected = null;
    previous.button.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    scheduleDiagnostics();
    if (restore && previous.button.isConnected) previous.button.focus();
  }

  function renderMenu() {
    if (!selected) return;
    refreshButton.hidden = selected !== diagnostic;
    if (selected === diagnostic) {
      title.textContent = diagnostic.label;
      const data = diagnosticData;
      if (!data) {
        chats.replaceChildren(element('li', '', diagnosticError || 'Checking saved diagnostics'));
        return;
      }
      const rows = data.configured ? [
        'Primary model · ' + data.primary,
        'Backup model · ' + data.backup,
        data.active ? 'Last successful model · ' + data.active : 'Waiting for a successful model request',
        data.lastFailure && (data.lastFailure.status ? 'HTTP ' + data.lastFailure.status : 'Connection failure') + ' · ' + new Date(data.lastFailure.at).toLocaleString(),
        data.retryAt && 'Primary retry after ' + new Date(data.retryAt).toLocaleString(),
      ] : ['Groq model status is available in an authorized Studio session with Groq configured.'];
      chats.replaceChildren(...rows.filter(Boolean).map(text => element('li', '', text)));
      return;
    }
    title.textContent = selected.label + ' (' + selected.entries.length + ')';
    const focused = chats.contains(document.activeElement) ? document.activeElement : null;
    const id = focused?.closest('li')?.dataset.thread;
    const position = focused ? [...focused.closest('li').querySelectorAll('button')].indexOf(focused) : -1;
    const entries = [...selected.entries].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    chats.replaceChildren(...entries.map(entry => {
      const row = renderChat(entry, () => {
        thinkingUntil = performance.now() + 1200;
        close(false);
        openChat(entry.id);
      });
      row.dataset.thread = entry.id;
      return row;
    }));
    if (id) ([...chats.children].find(row => row.dataset.thread === id)?.querySelectorAll('button')[position] || closeButton).focus();
  }

  function open(p) {
    if (selected === p) return;
    close(false);
    selected = p;
    p.button.setAttribute('aria-expanded', 'true');
    renderMenu();
    menu.hidden = false;
    closeButton.focus();
    scheduleDiagnostics();
  }

  canvas.onclick = event => {
    const bounds = canvas.getBoundingClientRect();
    const point = frontHit(points, event.clientX - bounds.left, event.clientY - bounds.top);
    if (point) open(point); else close();
  };
  closeButton.onclick = () => close();
  container.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected) { event.preventDefault(); close(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause(); else schedule();
    scheduleDiagnostics();
  });
  new ResizeObserver(resize).observe(canvas);
  new MutationObserver(refreshPalette).observe(container, { attributes: true, attributeFilter: ['class', 'style'] });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) schedule(); else pause();
    scheduleDiagnostics();
  }).observe(canvas);
  if (voice) {
    const syncVoice = () => {
      const text = voice.querySelector('[data-status]')?.textContent || '';
      voiceState = /^(Listening|Hearing you)/.test(text) ? 'listening'
        : /^(Thinking|Transcribing)/.test(text) ? 'thinking' : text === 'Speaking' ? 'speaking' : 'idle';
    };
    new MutationObserver(syncVoice).observe(voice, { childList: true, characterData: true, subtree: true });
    syncVoice();
  }
  refreshPalette();

  return {
    setBusy(value) { busy = value; if (!value && selected === diagnostic) refreshDiagnostics(); },
    classified(id) { pendingThread = id; thinkingUntil = performance.now() + 1400; },
    close,
    update(threads) {
      const groups = new Map();
      for (const entry of threads) {
        const label = entry.topic || topicFor(entry.title);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(entry);
      }
      for (const [label, p] of topics) {
        if (groups.has(label)) continue;
        if (p === selected) close(false);
        p.button.remove(); topics.delete(label);
      }
      let index = 0;
      for (const [label, entries] of groups) {
        let p = topics.get(label);
        const classified = entries.some(entry => entry.id === pendingThread);
        if (!p) {
          const button = element('button');
          button.type = 'button'; button.setAttribute('aria-expanded', 'false');
          p = { label, button, growing: true, started: classified ? thinkingUntil : performance.now() };
          button.onclick = () => open(p);
          mirror.append(button); topics.set(label, p);
        } else if (classified) {
          p.growing = false; p.started = thinkingUntil;
        }
        if (classified) pendingThread = null;
        p.entries = entries; p.caption = label + ' ' + entries.length;
        p.button.textContent = p.caption;
        p.angle = TAU * index++ / (groups.size + 1);
      }
      diagnostic.angle = TAU * index / (groups.size + 1);
      points = [...topics.values(), diagnostic];
      renderMenu();
      schedule();
    },
  };
}
