// LCP Brain: a clickable 3D city built with Three.js. Sandbox only for now.
// The Brain (Groq core) sits in the middle. Each structure is one part of the business and
// its size, lights and motion come from the model passed to mount()/update().
// Built into public/brain3d.js by scripts/build-brain.mjs (esbuild, IIFE, global LcpBrain).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const C = {
  ground: 0x1d2944, plate: 0x1c2740, road: 0x2c3a58, line: 0x3a4a6a, edge: 0x111a2c,
  blue: 0x3987e5, orange: 0xd95926, aqua: 0x199e70, yellow: 0xc98500, magenta: 0xd55181, green: 0x0ca30c, violet: 0x9085e9, red: 0xe66767,
  wall: 0xdfe6f2, wall2: 0xc4cfe0, roofDark: 0x2a3550, glass: 0x9fc3ff, tree: 0x1f8a63, trunk: 0x6b4f3a, warn: 0xfab219,
};
const STATUS = { ok: C.green, warn: C.warn, down: C.red, off: 0x5b667d };

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...o });
const box = (w, h, d, m) => { const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); g.castShadow = true; g.receiveShadow = true; return g; };
const cyl = (rt, rb, h, m, seg = 24) => { const g = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); g.castShadow = true; g.receiveShadow = true; return g; };
const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };
// Triangular prism along z (gable roofs). apex = 0.5 centers the peak; 0 gives a sawtooth.
function prism(w, h, d, m, apex = 0.5) {
  const sh = new THREE.Shape(); sh.moveTo(-w / 2, 0); sh.lineTo(w / 2, 0); sh.lineTo(-w / 2 + w * apex, h); sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: false }); geo.translate(0, 0, -d / 2);
  const o = new THREE.Mesh(geo, m); o.castShadow = true; o.receiveShadow = true; return o;
}
const logScale = (v, k) => Math.log10(1 + Math.max(0, v || 0) / k);
const money = v => v == null ? '-' : (Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? '$' + Math.round(v / 1000) + 'k' : '$' + Math.round(v).toLocaleString('en-US'));
const num = v => v == null ? '-' : Math.round(v).toLocaleString('en-US');
const pct = v => v == null ? '-' : (Math.round(v * 1000) / 10) + '%';

// Layout on the ground plate (x, z). The Brain is at the origin.
const SPOTS = {
  calls: [-13, -9], sms: [0, -14], leads: [13, -9], automations: [-14, 6], revenue: [13, 7], health: [-5, 14.5], twilio: [6, 14.5],
};

let S = null; // the mounted scene state
const HOME = new THREE.Vector3(-2, 2.6, -2); // default look-at: a little toward the back so tall buildings fit
const now = () => (performance.now() - S.t0) / 1000;

export function mount(container, model, opts = {}) {
  unmount();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  container.style.position = 'relative';
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block'; renderer.domElement.style.outline = 'none';

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  camera.position.set(42, 40, 42);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
  controls.minPolarAngle = 0.55; controls.maxPolarAngle = 1.12; controls.minZoom = 0.7; controls.maxZoom = 3.2;
  controls.target.copy(HOME);

  scene.add(new THREE.HemisphereLight(0xdde8ff, 0x1a2440, 1.9));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  sun.position.set(-18, 34, 14); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 });
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const labels = document.createElement('div');
  labels.className = 'b3-labels';
  container.appendChild(labels);
  const panel = document.createElement('div');
  panel.className = 'b3-panel';
  container.appendChild(panel);
  const reset = document.createElement('button');
  reset.className = 'b3-reset'; reset.type = 'button'; reset.textContent = 'Reset view';
  container.appendChild(reset);

  S = { container, renderer, scene, camera, controls, labels, panel, reset, opts, city: null, clickables: [], labelList: [], anim: [], hovered: null, selected: null,
    raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), t0: performance.now(), focus: null, frame: 0 };

  buildStatic(scene);
  update(model);
  resize();

  const ro = new ResizeObserver(resize); ro.observe(container); S.ro = ro;
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerleave', () => setHover(null));
  renderer.domElement.addEventListener('pointerdown', e => { S.down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', onClick);
  reset.onclick = () => { select(null); flyTo(HOME.clone(), 1); };
  loop();
  return { update, unmount };
}

export function unmount() {
  if (!S) return;
  cancelAnimationFrame(S.frame); S.ro?.disconnect();
  S.scene.traverse(o => { o.geometry?.dispose?.(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
  S.renderer.dispose(); S.renderer.domElement.remove(); S.labels.remove(); S.panel.remove(); S.reset.remove();
  S = null;
}

function resize() {
  if (!S) return;
  const w = S.container.clientWidth || 800, h = S.container.clientHeight || 600, aspect = w / h;
  const view = Math.max(30, 36 / aspect); // world units visible vertically; narrow screens fit the width
  Object.assign(S.camera, { left: -view * aspect / 2, right: view * aspect / 2, top: view / 2, bottom: -view / 2 });
  S.camera.updateProjectionMatrix();
  S.renderer.setSize(w, h, false);
  S.renderer.domElement.style.width = w + 'px'; S.renderer.domElement.style.height = h + 'px';
}

// ---------------- static scenery: ground, roads, trees ----------------
function buildStatic(scene) {
  const g = new THREE.Group();
  const slab = box(46, 1.6, 46, mat(C.edge)); slab.position.y = -0.8; g.add(slab);
  const plate = box(44.6, 0.2, 44.6, mat(C.ground, { roughness: 0.95 })); plate.position.y = 0.1; plate.castShadow = false; g.add(plate);
  // roads from each structure to the Brain
  const roadM = mat(C.road, { roughness: 0.9 }), lineM = mat(C.line, { roughness: 0.6 });
  Object.values(SPOTS).forEach(([x, z]) => {
    const len = Math.hypot(x, z) - 3.2, ang = Math.atan2(x, z);
    const road = box(1.6, 0.06, len, roadM); road.castShadow = false;
    road.position.set(x / 2 + Math.sin(ang) * 1.6 / 2, 0.23, z / 2 + Math.cos(ang) * 1.6 / 2); road.rotation.y = ang; g.add(road);
    for (let i = 0.6; i < len - 0.5; i += 1.4) { const d = box(0.12, 0.02, 0.6, lineM); d.castShadow = false; const t = (i - len / 2); d.position.set(road.position.x + Math.sin(ang) * t, 0.27, road.position.z + Math.cos(ang) * t); d.rotation.y = ang; g.add(d); }
  });
  // ring road around the Brain
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 5, 48), roadM); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.22; ring.receiveShadow = true; g.add(ring);
  // trees along the edge
  const treeM = mat(C.tree, { flatShading: true }), trunkM = mat(C.trunk);
  const spots = [];
  for (let i = -20; i <= 20; i += 3.2) spots.push([i, -20.5], [i, 20.5], [-20.5, i], [20.5, i]);
  [[-6, -6], [6, -5.5], [-7, 4.5], [7.5, 4], [-1.5, 8], [3.5, -8.5], [-17, -2], [17.5, -1.5], [0, 19]].forEach(p => spots.push(p));
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  spots.forEach(([x, z]) => {
    if (rnd() < 0.25) return;
    const s = 0.6 + rnd() * 0.5, t = new THREE.Group();
    t.add(at(cyl(0.12 * s, 0.15 * s, 0.6 * s, trunkM, 6), 0, 0.3 * s, 0));
    t.add(at(new THREE.Mesh(new THREE.ConeGeometry(0.7 * s, 1.5 * s, 7), treeM), 0, 1.25 * s, 0));
    t.children[1].castShadow = true;
    t.position.set(x + (rnd() - 0.5), 0.2, z + (rnd() - 0.5)); g.add(t);
  });
  scene.add(g);
}

// ---------------- dynamic city (rebuilt on update) ----------------
export function update(model) {
  if (!S) return;
  if (S.city) { S.scene.remove(S.city); S.city.traverse(o => { o.geometry?.dispose?.(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); }); }
  S.labels.innerHTML = ''; S.clickables = []; S.labelList = []; S.anim = []; S.hovered = null;
  S.model = model;
  const city = new THREE.Group(); S.city = city;
  brain(city, model); calls(city, model); sms(city, model); leads(city, model); automations(city, model); revenue(city, model); health(city, model); if (model.twilio?.balance != null || ['down','warn'].includes(model.twilio?.status)) twilio(city, model);
  flows(city, model);
  S.scene.add(city);
  if (S.selected) { const k = S.selected; S.selected = null; select(k); }
}

function structure(city, key, x, z) {
  const g = new THREE.Group(); g.position.set(x, 0.2, z); g.userData.key = key; city.add(g); S.clickables.push(g); return g;
}
function label(key, anchor, title, value) {
  const el = document.createElement('div');
  el.className = 'b3-label'; el.dataset.key = key;
  el.innerHTML = `<b>${title}</b><span>${value}</span>`;
  el.onclick = () => select(key);
  S.labels.appendChild(el);
  S.labelList.push({ el, anchor, key });
}
function pad(g, w, d, color = 0x222d45) { const p = box(w, 0.12, d, mat(color, { roughness: 0.9 })); p.position.y = 0.06; p.castShadow = false; g.add(p); return p; }

function brain(city, m) {
  const g = structure(city, 'brain', 0, 0);
  g.add(at(cyl(2.9, 3.2, 0.5, mat(0x24314d)), 0, 0.25, 0));
  g.add(at(cyl(2.3, 2.6, 0.5, mat(0x2b3a5c)), 0, 0.75, 0));
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.75, 3), mat(0x2a63b8, { emissive: C.blue, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.2, flatShading: true }));
  core.position.y = 3.1; core.castShadow = true; g.add(core);
  const wire = new THREE.Mesh(new THREE.IcosahedronGeometry(2.05, 2), new THREE.MeshBasicMaterial({ color: 0x86b6ef, wireframe: true, transparent: true, opacity: 0.35 }));
  wire.position.y = 3.1; g.add(wire);
  const glow = new THREE.PointLight(0x5598e7, 30, 14, 2); glow.position.y = 3.1; g.add(glow);
  // one orbiting node per insight
  const n = Math.max(3, Math.min(8, (m.insights || []).length));
  const orbit = new THREE.Group(); orbit.position.y = 3.1; g.add(orbit);
  for (let i = 0; i < n; i++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), new THREE.MeshBasicMaterial({ color: [0x86b6ef, 0x9085e9, 0x7ee2b8][i % 3] })); const a = (i / n) * Math.PI * 2; s.position.set(Math.cos(a) * 2.7, Math.sin(a * 2) * 0.5, Math.sin(a) * 2.7); orbit.add(s); }
  S.anim.push(t => { core.rotation.y = t * 0.25; wire.rotation.y = -t * 0.15; wire.rotation.x = Math.sin(t * 0.3) * 0.2; orbit.rotation.y = t * 0.6; const p = 0.45 + Math.sin(t * 2.2) * 0.2; core.material.emissiveIntensity = p * (g.userData.boost || 1); glow.intensity = 22 + p * 30; });
  label('brain', new THREE.Vector3(0, 5.8, 0), 'LCP Brain', m.groq ? 'Groq connected' : (m.insights || []).length + ' insights');
}

function calls(city, m) {
  const [x, z] = SPOTS.calls, g = structure(city, 'calls', x, z), c = m.calls || {};
  pad(g, 5.4, 5.4);
  const h = 3 + 2.4 * logScale(c.dials, 40);
  const body = at(box(3, h, 3, mat(0x2c4f86)), 0, h / 2 + 0.12, 0); g.add(body);
  g.add(at(box(3.3, 0.3, 3.3, mat(0x22406e)), 0, h + 0.27, 0));
  // Lit windows show the share of calls longer than 60 seconds.
  const floors = Math.max(3, Math.floor(h / 0.75)), per = 3, lit = Math.round((c.rate || 0) * floors * per * 4);
  const winOn = mat(0xffd27a, { emissive: 0xffc04d, emissiveIntensity: 0.9 }), winOff = mat(0x1a2c4a, { roughness: 0.3, metalness: 0.4 });
  let k = 0;
  for (let f = 0; f < floors; f++) for (let side = 0; side < 4; side++) for (let i = 0; i < per; i++) {
    const on = ((k * 7919) % (floors * per * 4)) < lit; k++;
    const w = box(0.5, 0.42, 0.04, on ? winOn : winOff); w.castShadow = false;
    const off = (i - 1) * 0.85, y = 0.75 + f * 0.75;
    if (y > h - 0.2) continue;
    const a = side * Math.PI / 2; w.position.set(Math.sin(a) * 1.52 + Math.cos(a) * off, y, Math.cos(a) * 1.52 - Math.sin(a) * off); w.rotation.y = a; g.add(w);
  }
  const mast = at(cyl(0.05, 0.08, 2.2, mat(0x9aa7bd)), 0, h + 1.5, 0); g.add(mast);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff5050 })); beacon.position.y = h + 2.65; g.add(beacon);
  S.anim.push(t => { beacon.visible = Math.sin(t * 5) > -0.2; });
  label('calls', new THREE.Vector3(x, h + 3.3, z), 'Calls', c.dials == null ? 'Unavailable' : num(c.dials) + ' outbound');
}

function sms(city, m) {
  const [x, z] = SPOTS.sms, g = structure(city, 'sms', x, z), s = m.sms || {};
  pad(g, 5, 4.2);
  g.add(at(box(3, 1.6, 2.2, mat(C.wall)), -0.4, 0.92, 0));
  const roof = prism(2.6, 0.9, 3.3, mat(C.magenta, { flatShading: true })); roof.rotation.y = Math.PI / 2; roof.position.set(-0.4, 1.72, 0); g.add(roof);
  g.add(at(box(0.7, 1, 0.06, mat(0x7a2f4a)), -0.4, 0.62, 1.12));
  const mh = 3 + 2.2 * logScale(s.sent, 60);
  g.add(at(cyl(0.07, 0.16, mh, mat(0xb8c3d6), 8), 1.7, mh / 2 + 0.12, 0));
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff8fb8 })); dish.position.set(1.7, mh + 0.2, 0); g.add(dish);
  // signal rings: speed follows texts sent
  const rings = [0, 1, 2].map(i => { const r = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.035, 8, 40), new THREE.MeshBasicMaterial({ color: 0xff8fb8, transparent: true })); r.rotation.x = Math.PI / 2; r.position.set(1.7, mh + 0.2, 0); g.add(r); return r; });
  const speed = 0.35 + Math.min(1.2, logScale(s.sent, 200));
  S.anim.push(t => rings.forEach((r, i) => { const p = ((t * speed + i / 3) % 1); r.scale.setScalar(1 + p * 3.2); r.material.opacity = 0.8 * (1 - p); }));
  label('sms', new THREE.Vector3(x + 1.7, mh + 1.2, z), 'SMS', s.sent == null ? 'Unavailable' : num(s.sent) + ' sent · ' + num(s.delivered) + ' delivered');
}

function leads(city, m) {
  const [x, z] = SPOTS.leads, g = structure(city, 'leads', x, z), l = m.leads || {};
  pad(g, 8.2, 6.2, 0x1f3b2e);
  const cities = (l.cities || []).slice(0, 8), max = Math.max(1, ...cities.map(c => c.count));
  const roofCols = [C.violet, C.orange, C.aqua, C.yellow, C.magenta, C.blue, C.red, C.green];
  cities.forEach((c, i) => {
    const hx = (i % 4) * 1.95 - 2.9, hz = Math.floor(i / 4) * 2.7 - 1.3, hh = 0.7 + 2.3 * (c.count / max);
    const house = new THREE.Group(); house.position.set(hx, 0.12, hz);
    house.add(at(box(1.3, hh, 1.3, mat(i % 2 ? C.wall : C.wall2)), 0, hh / 2, 0));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.08, 0.8, 4), mat(roofCols[i % roofCols.length], { flatShading: true })); roof.rotation.y = Math.PI / 4; roof.position.y = hh + 0.4; roof.castShadow = true; house.add(roof);
    house.add(at(box(0.32, 0.5, 0.04, mat(0x5a4636)), 0, 0.25, 0.66));
    g.add(house);
  });
  label('leads', new THREE.Vector3(x, 5.4, z), 'Leads', l.total == null ? 'Unavailable' : num(l.total) + ' opps' + (cities[0] ? ' · top ' + cities[0].key : ''));
}

function gear(r, teeth, m) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.22, 24), m));
  for (let i = 0; i < teeth; i++) { const t = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, r * 0.5), m); const a = (i / teeth) * Math.PI * 2; t.position.set(Math.sin(a) * r, 0, Math.cos(a) * r); t.rotation.y = a; g.add(t); }
  g.children.forEach(c => { c.castShadow = true; });
  return g;
}
function automations(city, m) {
  const [x, z] = SPOTS.automations, g = structure(city, 'automations', x, z), a = m.automations || {};
  pad(g, 6.4, 5.6);
  g.add(at(box(4.4, 1.8, 3, mat(0xc9d3e3)), 0, 1.02, 0));
  for (let i = 0; i < 3; i++) { const saw = prism(1.46, 0.85, 3, mat(C.orange, { flatShading: true }), 0); saw.position.set(-1.46 + i * 1.46, 1.92, 0); g.add(saw); }
  const chimney = at(cyl(0.3, 0.38, 2.6, mat(0x8a94a8)), 1.6, 3.2, -0.9); g.add(chimney);
  const gM = mat(C.yellow, { metalness: 0.6, roughness: 0.35 });
  const g1 = gear(0.7, 10, gM); g1.rotation.x = Math.PI / 2; g1.position.set(-0.8, 1.2, 1.62); g.add(g1);
  const g2 = gear(0.45, 8, gM); g2.rotation.x = Math.PI / 2; g2.position.set(0.35, 1.45, 1.62); g.add(g2);
  // conveyor of boxes = contacts moving through workflows
  g.add(at(box(0.6, 0.12, 2.4, mat(0x3b4660)), 2.75, 0.3, 0.3));
  const parcels = [0, 1, 2, 3].map(() => { const p = box(0.36, 0.3, 0.36, mat(C.violet)); g.add(p); return p; });
  // smoke rate = enrollments, red beacon if anything failed
  const puffs = Array.from({ length: 8 }, () => { const p = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 10), new THREE.MeshStandardMaterial({ color: 0xcfd6e3, transparent: true, roughness: 1 })); g.add(p); return p; });
  const rate = 0.25 + Math.min(1, logScale(a.entered, 150));
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshBasicMaterial({ color: a.failed ? 0xff5050 : 0x3ddc84 })); beacon.position.set(-2, 2.35, -1.2); g.add(beacon);
  S.anim.push(t => {
    g1.rotation.y = t * rate * 1.6; g2.rotation.y = -t * rate * 2.5;
    parcels.forEach((p, i) => { const q = (t * rate * 0.5 + i / 4) % 1; p.position.set(2.75, 0.52, -0.9 + q * 2.4); });
    puffs.forEach((p, i) => { const q = (t * rate * 0.45 + i / puffs.length) % 1; p.position.set(1.6 + Math.sin(i + t) * 0.25 * q, 4.6 + q * 3, -0.9 - q * 0.8); p.scale.setScalar(0.6 + q * 1.4); p.material.opacity = 0.65 * (1 - q); });
    if (a.failed) beacon.visible = Math.sin(t * 6) > 0;
  });
  label('automations', new THREE.Vector3(x, 6.4, z), 'Automations', num(a.entered) + ' enrolled · ' + pct(a.completion));
}

function revenue(city, m) {
  const [x, z] = SPOTS.revenue, g = structure(city, 'revenue', x, z), r = m.revenue || {};
  pad(g, 7, 5.6);
  g.add(at(box(4.2, 0.3, 3, mat(C.wall2)), -0.9, 0.27, 0));
  g.add(at(box(3.8, 0.25, 2.7, mat(C.wall)), -0.9, 0.55, 0));
  for (let i = 0; i < 5; i++) g.add(at(cyl(0.15, 0.17, 1.8, mat(C.wall)), -2.5 + i * 0.8, 1.57, 1.05));
  g.add(at(box(3.6, 1.8, 1.8, mat(0xd2dae7)), -0.9, 1.57, -0.2));
  g.add(at(box(4, 0.25, 2.9, mat(C.wall)), -0.9, 2.6, 0));
  const ped = prism(4, 0.8, 2.9, mat(C.yellow, { flatShading: true })); ped.position.set(-0.9, 2.72, 0); g.add(ped);
  // coin stacks: received, pending (glass), net
  if (r.fees == null) { label('revenue', new THREE.Vector3(x, 5.6, z), 'Revenue', 'Unavailable'); return; }
  const coinM = mat(0xf2b632, { metalness: 0.75, roughness: 0.3, emissive: 0x3a2600, emissiveIntensity: 0.4 });
  const pendM = mat(0xf2b632, { transparent: true, opacity: 0.28, metalness: 0.5 });
  const scale = Math.max(r.fees || 0, r.pending || 0, Math.abs(r.net || 0), 1);
  [[r.fees, coinM, 1.9, -0.6], [r.pending, pendM, 2.75, 0.4], [Math.max(0, r.net || 0), coinM, 1.9, 1.4]].forEach(([v, m2, cx, cz]) => {
    const coins = Math.max(1, Math.round(16 * (v || 0) / scale));
    for (let i = 0; i < coins; i++) { const c = cyl(0.42, 0.42, 0.14, m2, 20); c.position.set(cx + (i % 2) * 0.03, 0.2 + i * 0.16, cz); g.add(c); }
  });
  const drop = cyl(0.42, 0.42, 0.14, coinM, 20); g.add(drop);
  const topY = 0.2 + Math.max(1, Math.round(16 * (r.fees || 0) / scale)) * 0.16;
  S.anim.push(t => { const q = (t * 0.5) % 1; drop.position.set(1.9, topY + 3 * (1 - q * q), -0.6); drop.rotation.x = t * 3; drop.visible = q < 0.97; });
  label('revenue', new THREE.Vector3(x, 5.6, z), 'Revenue', r.fees == null ? 'Unavailable' : money(r.fees) + ' received · net ' + money(r.net));
}

function health(city, m) {
  const [x, z] = SPOTS.health, g = structure(city, 'health', x, z), h = m.health || {};
  pad(g, 6.6, 4.4);
  g.add(at(box(2.2, 2.4, 2.2, mat(0x34425f)), -2, 1.32, 0));
  g.add(at(cyl(0.9, 1.1, 0.5, mat(0x2b3650)), -2, 2.77, 0));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.85, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(C.glass, { transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0.3 })); dome.position.set(-2, 3, 0); g.add(dome);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.06, 8, 32), new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true })); ring.rotation.x = Math.PI / 2; ring.position.set(-2, 3.2, 0); g.add(ring);
  const src = (h.sources || []).slice(0, 6);
  const worst = src.some(s => s.status === 'down') ? 'down' : src.some(s => s.status === 'warn' || s.status === 'off') ? 'warn' : 'ok';
  ring.material.color.setHex(STATUS[worst]);
  src.forEach((s, i) => {
    const px = 0.1 + (i % 3) * 1.1, pz = i < 3 ? -0.8 : 0.9;
    g.add(at(cyl(0.14, 0.2, 1.6, mat(0x9aa7bd), 8), px, 0.92, pz));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), new THREE.MeshStandardMaterial({ color: STATUS[s.status] || STATUS.off, emissive: STATUS[s.status] || STATUS.off, emissiveIntensity: 1.2 }));
    bulb.position.set(px, 1.95, pz); g.add(bulb);
    S.anim.push(t => { bulb.material.emissiveIntensity = s.status === 'ok' ? 0.9 + Math.sin(t * 2 + i) * 0.25 : 0.4 + Math.abs(Math.sin(t * 4)) * 1.2; });
  });
  S.anim.push(t => { const q = (t * 0.6) % 1; ring.scale.setScalar(1 + q * 2); ring.material.opacity = 1 - q; });
  const okN = src.filter(s => s.status === 'ok').length;
  label('health', new THREE.Vector3(x - 1, 5, z), 'System health', okN + ' of ' + src.length + ' healthy');
}

function balanceLabel(tw) {
  if (tw.balance == null) return 'Unavailable';
  const currency = tw.currency || 'USD';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(tw.balance);
}

function twilio(city, m) {
  const [x, z] = SPOTS.twilio, g = structure(city, 'twilio', x, z), tw = m.twilio || {};
  pad(g, 4.6, 4.4);
  const cap = tw.capacity || Math.max(500, (tw.balance || 0) * 1.4), f = Math.max(0.04, Math.min(1, (tw.balance || 0) / cap));
  const color = tw.balance == null ? STATUS.off : (tw.balance || 0) < (tw.low || 100) ? C.red : (tw.balance || 0) < (tw.low || 100) * 2 ? C.warn : C.aqua;
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; g.add(at(cyl(0.08, 0.1, 1.2, mat(0x7d889c), 6), Math.sin(a) * 1.1, 0.7, Math.cos(a) * 1.1)); }
  g.add(at(cyl(1.45, 1.45, 0.16, mat(0x55617a)), 0, 1.32, 0));
  const H = 3.2;
  const fill = cyl(1.22, 1.22, H, mat(color, { emissive: color, emissiveIntensity: 0.35, roughness: 0.3 }), 32);
  fill.scale.y = f; fill.position.y = 1.4 + (H * f) / 2; g.add(fill);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, H, 32, 1, true), new THREE.MeshStandardMaterial({ color: C.glass, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.2, side: THREE.DoubleSide }));
  glass.position.y = 1.4 + H / 2; g.add(glass);
  g.add(at(cyl(1.45, 1.4, 0.22, mat(0x55617a)), 0, 1.4 + H + 0.1, 0));
  for (let i = 1; i < 4; i++) { const tick = new THREE.Mesh(new THREE.TorusGeometry(1.36, 0.025, 6, 40), new THREE.MeshBasicMaterial({ color: 0x8fa0bd, transparent: true, opacity: 0.6 })); tick.rotation.x = Math.PI / 2; tick.position.y = 1.4 + H * i / 4; g.add(tick); }
  S.anim.push(t => { fill.material.emissiveIntensity = 0.3 + Math.sin(t * 1.5) * 0.08; });
  const days = tw.burnPerDay ? Math.floor(tw.balance / tw.burnPerDay) : null;
  label('twilio', new THREE.Vector3(x, 6.2, z), 'Twilio balance', balanceLabel(tw) + (days != null ? ' · ' + days + ' days left' : ''));
}

// Data flowing from every structure into the Brain. More activity = more packets.
function flows(city, m) {
  const vol = { calls: m.calls?.dials, sms: m.sms?.sent, leads: m.leads?.total * 20, automations: m.automations?.entered * 3, revenue: m.revenue?.deals * 200, health: 400, twilio: m.twilio?.balance };
  const geo = new THREE.SphereGeometry(0.13, 10, 10);
  Object.entries(SPOTS).forEach(([k, [x, z]]) => {
    if (!vol[k]) return;
    const n = Math.max(2, Math.min(9, Math.round(2 + 2 * logScale(vol[k], 80))));
    const colr = { calls: 0x5598e7, sms: 0xff8fb8, leads: 0xb3a9ff, automations: 0xffc04d, revenue: 0xffd27a, health: 0x7ee2b8, twilio: 0x7ee2b8 }[k];
    const len = Math.hypot(x, z), ux = -x / len, uz = -z / len, start = 3.2, end = len - 3.3;
    const dots = Array.from({ length: n }, () => { const d = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colr })); city.add(d); return d; });
    const off = 0.32, px = -uz * off, pz = ux * off;
    S.anim.push(t => dots.forEach((d, i) => { const q = (t * 0.18 + i / n) % 1, dist = start + q * (end - start); d.position.set(x + ux * dist + px, 0.42, z + uz * dist + pz); d.scale.setScalar(q > 0.92 ? (1 - q) * 12 : 1); }));
  });
}

// ---------------- interaction ----------------
function pick(e) {
  const r = S.renderer.domElement.getBoundingClientRect();
  S.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  S.raycaster.setFromCamera(S.pointer, S.camera);
  const hit = S.raycaster.intersectObjects(S.clickables, true)[0];
  if (!hit) return null;
  let o = hit.object; while (o && !o.userData.key) o = o.parent;
  return o ? o.userData.key : null;
}
function onMove(e) { setHover(pick(e)); }
function onClick(e) {
  if (S.down && Math.hypot(e.clientX - S.down[0], e.clientY - S.down[1]) > 6) return; // a drag, not a click
  select(pick(e));
}
function groupOf(key) { return S.clickables.find(g => g.userData.key === key); }
function setBoost(key, v) {
  const g = groupOf(key); if (!g) return;
  g.userData.boost = v;
  g.traverse(o => { if (o.isMesh && o.material && 'emissive' in o.material && !o.userData.keepEmissive) { if (o.userData.baseEm == null) { o.userData.baseEm = o.material.emissiveIntensity; o.userData.baseEmColor = o.material.emissive.getHex(); } if (v > 1) { if (!o.userData.baseEmColor) o.material.emissive.setHex(0x223355); o.material.emissiveIntensity = Math.max(o.userData.baseEm, 0.6) * 1.1; } else { o.material.emissive.setHex(o.userData.baseEmColor); o.material.emissiveIntensity = o.userData.baseEm; } } });
}
function setHover(key) {
  if (S.hovered === key) return;
  if (S.hovered && S.hovered !== S.selected) setBoost(S.hovered, 1);
  S.hovered = key;
  if (key) setBoost(key, 1.6);
  S.renderer.domElement.style.cursor = key ? 'pointer' : 'grab';
  S.labelList.forEach(l => l.el.classList.toggle('hot', l.key === key || l.key === S.selected));
}
function flyTo(target, zoom) { S.focus = { target, zoom, t0: now(), from: S.controls.target.clone(), fromZoom: S.camera.zoom }; }
function select(key) {
  if (S.selected && S.selected !== key) setBoost(S.selected, 1);
  S.selected = key;
  S.labelList.forEach(l => l.el.classList.toggle('hot', l.key === key));
  if (!key) { S.panel.classList.remove('on'); return; }
  setBoost(key, 1.6);
  const g = groupOf(key);
  if (g) flyTo(new THREE.Vector3(g.position.x * 0.6, 1.5, g.position.z * 0.6), key === 'brain' ? 1.35 : 1.6);
  const info = describe(key, S.model);
  S.panel.innerHTML = `<button class="b3-x" type="button" aria-label="Close">×</button><div class="b3-k">${info.kicker}</div><h3>${info.title}</h3>`
    + `<div class="b3-rows">${info.rows.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('')}</div>`
    + (info.list ? `<ul>${info.list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '')
    + (info.note ? `<p>${info.note}</p>` : '')
    + (info.view ? `<button class="b3-go" type="button">Open ${info.viewLabel}</button>` : '');
  S.panel.classList.add('on');
  S.panel.querySelector('.b3-x').onclick = () => select(null);
  const go = S.panel.querySelector('.b3-go'); if (go) go.onclick = () => S.opts.onNavigate && S.opts.onNavigate(info.view);
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function describe(key, m) {
  const c = m.calls || {}, s = m.sms || {}, l = m.leads || {}, a = m.automations || {}, r = m.revenue || {}, h = m.health || {}, t = m.twilio || {};
  switch (key) {
    case 'brain': return { kicker: 'The core', title: 'LCP Brain', rows: [['Insights', num((m.insights || []).length)], ['Groq', esc(m.groqStatus || (m.groq ? 'Configured' : 'Rule-based'))]], list: (m.insights || []).slice(0, 4), view: 'sales', viewLabel: 'Sales' };
    case 'calls': return { kicker: 'Dialer tower', title: 'Calls', rows: [['Outbound calls', num(c.dials)], ['Calls over 60 seconds', num(c.conversations)], ['Share over 60 seconds', pct(c.rate)]], view: 'sales', viewLabel: 'Sales' };
    case 'sms': return { kicker: 'Post office', title: 'SMS', rows: [['Outbound SMS sent', num(s.sent)], ['Delivered', num(s.delivered)]], view: 'sales', viewLabel: 'Sales' };
    case 'leads': return { kicker: 'Neighborhood', title: 'Leads', rows: [['Opportunities', num(l.total)], ['Pipeline value', money(l.value)], ['Median touches', l.medianTouches ?? '-'], ['Top city', esc((l.cities || [])[0]?.key || '-')]], list: (l.cities || []).slice(0, 5).map(c => c.key + ': ' + num(c.count) + ' opps'), note: 'One house per city. Height follows opportunities created there.', view: 'sales', viewLabel: 'Sales' };
    case 'automations': return { kicker: 'Factory', title: 'Automations', rows: [['Workflows', num(a.workflows)], ['Contacts enrolled', num(a.entered)], ['Finished', pct(a.completion)], ['Skipped / failed', num(a.skipped) + ' / ' + num(a.failed)]], note: 'Gears and smoke speed follow enrollments. The beacon blinks red when a step failed.', view: 'workflows', viewLabel: 'Workflows' };
    case 'revenue': return { kicker: 'Bank', title: 'Revenue', rows: [['Fees received', money(r.fees)], ['Net', money(r.net)], ['Fees pending', money(r.pending)], ['Deals paid', num(r.deals)], ['EMD at risk', money(r.emd)]], note: 'Coin stacks: received, pending (glass), net.', view: 'accounting', viewLabel: 'Accounting' };
    case 'health': return { kicker: 'Control room', title: 'System health', rows: (h.sources || []).map(x => [esc(x.name), `<i class="b3-dot" style="background:#${(STATUS[x.status] || STATUS.off).toString(16).padStart(6, '0')}"></i>${esc(x.detail)}`]), note: 'Status reflects the latest data available to Brain.' };
    case 'twilio': {
      const rows = [['Balance', balanceLabel(t)]];
      if (t.checkedAt) rows.push(['Checked', esc(new Date(t.checkedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })) + ' PT']);
      if (t.burnPerDay != null) rows.push(['Spend per day', money(t.burnPerDay)]);
      return { kicker: 'Water tower', title: 'Twilio balance', rows, note: esc(t.detail || 'Sample balance') };
    }
    default: return { kicker: '', title: key, rows: [] };
  }
}

// ---------------- render loop ----------------
const v3 = new THREE.Vector3();
function loop() {
  if (!S) return;
  S.frame = requestAnimationFrame(loop);
  if (document.hidden || !S.container.offsetParent) return; // tab hidden: skip work
  const t = now();
  if (S.focus) {
    const q = Math.min(1, (t - S.focus.t0) / 0.9), e = 1 - Math.pow(1 - q, 3);
    S.controls.target.lerpVectors(S.focus.from, S.focus.target, e);
    S.camera.zoom = S.focus.fromZoom + (S.focus.zoom - S.focus.fromZoom) * e; S.camera.updateProjectionMatrix();
    if (q >= 1) S.focus = null;
  }
  S.controls.update();
  for (const f of S.anim) f(t);
  S.renderer.render(S.scene, S.camera);
  const w = S.container.clientWidth, h = S.container.clientHeight;
  for (const l of S.labelList) {
    v3.copy(l.anchor).project(S.camera);
    const x = (v3.x + 1) / 2 * w, y = (1 - v3.y) / 2 * h;
    l.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    l.el.style.display = x < -40 || x > w + 40 || y < -20 || y > h + 40 ? 'none' : '';
  }
}

if (typeof window !== 'undefined') window.LcpBrain = { mount, update, unmount, version: '1.0.0' };
