/* Chat Radar — client */
'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);

const SIM = new URLSearchParams(location.search).has('sim');
const RADAR_RANGE_M = 250;

// ------------------------------------------------------------------ état

const S = {
  screen: 'home',
  code: null,
  token: null,
  you: null, // {token,name,role,captured,points,fx,cooldownMs}
  youRxAt: 0,
  lobby: null,
  powers: null,
  graceUntil: 0,
  endsAt: 0,
  skew: 0, // serverNow - Date.now()
  catName: null,
  mice: [], // [{token,name}] souris libres (pour la capture / ciblage)
  pendingTarget: null,
};

const R = {
  // radar souris
  cat: null, // {lat,lng,ts,rxAt}
  ghost: false,
  senseNear: false,
  mates: null,
  // radar chat
  blips: [],
  blipsAt: 0,
  blipsInterval: 25000,
  nextPingAt: 0,
  jammedUntil: 0,
  reveal: [],
  revealRxAt: 0,
  netHits: [],
  netAt: 0,
  // spectateur
  spectators: [],
  // zone rétrécissante
  zone: null, // {lat,lng,r}
  outside: false,
  sweep: 0,
};

let myPos = null; // {lat,lng,acc}
let heading = null; // cap boussole en degrés (0 = nord, sens horaire)
let posTimer = null;
let watchId = null;
let wakeLock = null;
let audioCtx = null;
let vibTimer = null;

function now() { return Date.now() + S.skew; }

// ------------------------------------------------------------------ écrans

function show(screen) {
  S.screen = screen;
  for (const s of ['home', 'lobby', 'game', 'end']) {
    $('screen-' + s).hidden = s !== screen;
  }
}

// sessionStorage d'abord (propre à chaque onglet — permet de tester à
// plusieurs onglets sur un même navigateur), localStorage en secours
// (survit à la fermeture de l'onglet sur téléphone).
function saveSession() {
  const s = JSON.stringify({ code: S.code, token: S.token });
  try { sessionStorage.setItem('cr_session', s); } catch (e) { /* privé */ }
  localStorage.setItem('cr_session', s);
}
function loadSession() {
  try {
    return sessionStorage.getItem('cr_session') || localStorage.getItem('cr_session');
  } catch (e) {
    return localStorage.getItem('cr_session');
  }
}
function clearSession() {
  try { sessionStorage.removeItem('cr_session'); } catch (e) { /* privé */ }
  localStorage.removeItem('cr_session');
  S.code = null;
  S.token = null;
}

function toast(msg, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ------------------------------------------------------------------ modale

function closeModal() {
  $('modal').hidden = true;
  $('modalList').innerHTML = '';
  $('modalBtns').innerHTML = '';
}

function openModal({ title, text, list, buttons }) {
  $('modalTitle').textContent = title || '';
  $('modalText').textContent = text || '';
  const listEl = $('modalList');
  const btnsEl = $('modalBtns');
  listEl.innerHTML = '';
  btnsEl.innerHTML = '';
  (list || []).forEach((item) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = item.label;
    b.onclick = () => item.onClick();
    listEl.appendChild(b);
  });
  (buttons || []).forEach((btn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (btn.style || '');
    b.textContent = btn.label;
    b.onclick = () => btn.onClick();
    btnsEl.appendChild(b);
  });
  $('modal').hidden = false;
}

// ------------------------------------------------------------------ audio / vibration

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // iOS passe aussi par l'état « interrupted » (appel, Siri, autre app…) :
    // on relance dès que l'état n'est pas « running », pas seulement « suspended »
    if (audioCtx.state !== 'running') audioCtx.resume();
  } catch (e) { /* pas grave */ }
}

// chaque toucher re-débloque l'audio : c'est LA parade aux sons qui se coupent
// en cours de partie (le contexte re-suspendu ne peut souvent être relancé
// que depuis un vrai geste utilisateur)
for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
  document.addEventListener(ev, unlockAudio, { passive: true });
}

// un bip strident de ~0,45 s, programmé « maintenant » — appelé en boucle par
// playSiren pour que le son reprenne dès que le contexte audio redevient actif
// (l'ancienne version programmait les 10 s d'un coup : si le contexte était
// suspendu à cet instant, toute la sirène restait muette)
let sirenStep = 0;
function sirenBeep() {
  unlockAudio();
  if (!audioCtx) return;
  try {
    if (audioCtx.state !== 'running') {
      audioCtx.resume();
      return; // le prochain bip (450 ms plus tard) sonnera si le resume a pris
    }
    const t0 = audioCtx.currentTime + 0.02;
    const freq = sirenStep++ % 2 ? 700 : 950;
    for (const detune of [0, 6]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(1.0, t0);
      gain.gain.setValueAtTime(0.0001, t0 + 0.42);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.45);
    }
  } catch (e) { /* pas grave */ }
}

let sirenTimer = null;
function playSiren(sec) {
  if (sirenTimer) clearInterval(sirenTimer);
  const until = Date.now() + sec * 1000;
  sirenBeep();
  sirenTimer = setInterval(() => {
    if (Date.now() >= until) {
      clearInterval(sirenTimer);
      sirenTimer = null;
      return;
    }
    sirenBeep();
  }, 450);
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// bip court du sixième sens (audible aussi sur iPhone, où la vibration n'existe pas)
function playPing() {
  unlockAudio();
  if (!audioCtx) return;
  try {
    if (audioCtx.state !== 'running') {
      audioCtx.resume();
      return;
    }
    const t0 = audioCtx.currentTime + 0.02;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t0);
    osc.frequency.setValueAtTime(900, t0 + 0.12);
    g.gain.setValueAtTime(0.6, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  } catch (e) { /* pas grave */ }
}

// ------------------------------------------------------------------ GPS

function startPosition() {
  stopPosition();
  if (SIM) {
    if (!myPos) {
      // point de départ fictif (jardin du Luxembourg) + dispersion aléatoire
      const base = { lat: 48.8462, lng: 2.3372 };
      const ang = Math.random() * 2 * Math.PI;
      const r = Math.random() * 150;
      myPos = {
        lat: base.lat + (Math.sin(ang) * r) / 111320,
        lng: base.lng + (Math.cos(ang) * r) / (111320 * Math.cos((base.lat * Math.PI) / 180)),
        acc: 5,
      };
    }
    $('gpsWarn').hidden = true;
  } else if ('geolocation' in navigator) {
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        $('gpsWarn').hidden = true;
      },
      (err) => {
        $('gpsWarn').textContent =
          err.code === 1
            ? '⚠️ Autorise la géolocalisation pour jouer (réglages du navigateur).'
            : '⚠️ Signal GPS introuvable…';
        $('gpsWarn').hidden = false;
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  } else {
    $('gpsWarn').textContent = '⚠️ Pas de géolocalisation sur cet appareil.';
    $('gpsWarn').hidden = false;
  }
  posTimer = setInterval(() => {
    if (myPos && S.token) socket.emit('pos', myPos);
  }, 2000);
}

function stopPosition() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (posTimer) { clearInterval(posTimer); posTimer = null; }
}

// ------------------------------------------------------------------ boussole

function handleOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iOS
  else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha; // Android
  if (h !== null && !Number.isNaN(h)) heading = (h + 360) % 360;
}

let compassAttached = false;

function attachCompass() {
  if (compassAttached) return;
  compassAttached = true;
  window.addEventListener('deviceorientationabsolute', handleOrientation, true);
  window.addEventListener('deviceorientation', handleOrientation, true);
}

function requestCompass(onDone) {
  if (!window.isSecureContext) return onDone('insecure');
  if (!window.DeviceOrientationEvent) return onDone('unavailable');
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS : ce clic déclenche la popup système
    // « chat-radar souhaite accéder aux mouvements et à l'orientation »
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === 'granted') attachCompass();
        onDone(state === 'granted' ? 'ok' : 'denied');
      })
      .catch(() => onDone('error'));
  } else {
    // Android : pas de popup requise — on valide seulement si des données arrivent
    attachCompass();
    const t0 = Date.now();
    const check = setInterval(() => {
      if (heading !== null) {
        clearInterval(check);
        onDone('ok');
      } else if (Date.now() - t0 > 3000) {
        clearInterval(check);
        onDone('nodata');
      }
    }, 250);
  }
}

function startCompass() {
  if (SIM || compassAttached) return;
  if (
    window.DeviceOrientationEvent &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
  ) {
    // iOS sans autorisation donnée au lobby → bouton de secours en jeu
    $('compassBtn').hidden = false;
  } else {
    attachCompass();
  }
}

$('compassBtn').onclick = () => {
  requestCompass((res) => {
    if (res === 'ok') $('compassBtn').hidden = true;
  });
};

// ------------------------------------------------------------------ permissions (lobby)

let geoGranted = false;
let compassGranted = false;

function refreshPermUI() {
  const g = $('geoPermBtn');
  const c = $('compassPermBtn');
  g.textContent = geoGranted ? '📍 Position autorisée ✅' : '📍 Autoriser la position';
  g.classList.toggle('granted', geoGranted);
  g.disabled = geoGranted;
  c.textContent = compassGranted ? '🧭 Boussole active ✅' : '🧭 Activer la boussole';
  c.classList.toggle('granted', compassGranted);
  c.disabled = compassGranted;
}

$('geoPermBtn').onclick = () => {
  unlockAudio();
  $('permHint').textContent = '';
  if (SIM) {
    geoGranted = true;
    return refreshPermUI();
  }
  if (!window.isSecureContext) {
    $('permHint').textContent =
      '⚠️ La position exige HTTPS. Ouvre le site via l’URL Render ou localtunnel (https://…), pas via http://une-adresse-IP.';
    return;
  }
  if (!('geolocation' in navigator)) {
    $('permHint').textContent = 'Pas de géolocalisation sur cet appareil.';
    return;
  }
  // ce clic déclenche la popup système de géolocalisation
  navigator.geolocation.getCurrentPosition(
    (p) => {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      geoGranted = true;
      refreshPermUI();
    },
    (err) => {
      $('permHint').textContent =
        err.code === 1
          ? 'Position refusée. iPhone : Réglages → Safari (ou ton navigateur) → Position → Autoriser. Android : icône 🔒 dans la barre d’adresse → Autorisations → Position. Puis réessaie.'
          : 'Signal GPS introuvable — réessaie, idéalement en extérieur.';
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
  );
};

$('compassPermBtn').onclick = () => {
  unlockAudio();
  $('permHint').textContent = '';
  if (SIM) {
    compassGranted = true;
    return refreshPermUI();
  }
  requestCompass((res) => {
    if (res === 'ok') {
      compassGranted = true;
      refreshPermUI();
    } else if (res === 'nodata') {
      // activée mais pas de capteur (ordinateur par ex.) : pas bloquant
      compassGranted = true;
      refreshPermUI();
      $('permHint').textContent =
        'Boussole activée, mais cet appareil n’envoie pas de données d’orientation (normal sur ordinateur).';
    } else if (res === 'denied') {
      $('permHint').textContent =
        'Boussole refusée. Recharge la page : la popup « accéder aux mouvements et à l’orientation » sera reproposée.';
    } else if (res === 'insecure') {
      $('permHint').textContent =
        '⚠️ La boussole exige HTTPS. Ouvre le site via l’URL Render ou localtunnel (https://…), pas via http://une-adresse-IP.';
    } else if (res === 'unavailable') {
      $('permHint').textContent = 'Boussole non disponible sur cet appareil.';
    } else {
      $('permHint').textContent = 'Impossible de demander la boussole. Recharge la page et réessaie.';
    }
  });
};

$('testAlertBtn').onclick = () => {
  unlockAudio();
  playSiren(2);
  const vibOk = !!navigator.vibrate;
  vibrate([400, 100, 400]);
  $('permHint').textContent = vibOk
    ? 'Tu dois entendre une sirène et sentir une vibration. Rien entendu ? Monte le volume et coupe le mode silencieux.'
    : 'Tu dois entendre une sirène (pas de vibration possible sur iPhone). Rien entendu ? Monte le volume et coupe le mode silencieux.';
};

// si la position est déjà autorisée (partie précédente), on l'affiche direct
if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((st) => {
      if (st.state === 'granted') {
        geoGranted = true;
        refreshPermUI();
      }
    })
    .catch(() => {});
}
refreshPermUI();

async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* refusé : on affiche juste le conseil */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    unlockAudio(); // l'audio est souvent suspendu au retour sur la page
    if (S.screen === 'game') keepAwake();
  }
});

// ------------------------------------------------------------------ snapshot / routage

function applySnapshot(snap) {
  S.you = snap.you;
  S.youRxAt = Date.now();
  S.lobby = snap.lobby;
  S.powers = snap.powers;
  S.graceUntil = snap.graceUntil || 0;
  S.endsAt = snap.endsAt || 0;
  S.skew = (snap.serverNow || Date.now()) - Date.now();
  S.catName = snap.catName;
  S.mice = snap.mice || [];

  if (snap.state === 'lobby') {
    renderLobby();
    show('lobby');
  } else if (snap.state === 'playing') {
    enterGame();
  } else if (snap.state === 'ended') {
    showEnd({ winner: snap.winner, catName: snap.catName, scores: snap.scores || [] });
  }
}

function enterGame() {
  show('game');
  setPlacingDecoy(false);
  initMap();
  setTimeout(() => map && map.invalidateSize(), 60);
  startPosition();
  startCompass();
  keepAwake();
  renderGameChrome();
  rebuildDynamic();
}

// ------------------------------------------------------------------ accueil

$('nameInput').value = localStorage.getItem('cr_name') || '';
$('simHint').hidden = !SIM;

$('createBtn').onclick = () => {
  unlockAudio();
  const name = $('nameInput').value.trim();
  if (!name) return ($('homeError').textContent = 'Choisis un pseudo d’abord.');
  localStorage.setItem('cr_name', name);
  socket.emit('create', { name }, (res) => {
    if (!res.ok) return ($('homeError').textContent = res.error || 'Erreur.');
    S.code = res.code;
    S.token = res.token;
    saveSession();
    applySnapshot(res.snapshot);
  });
};

$('joinBtn').onclick = () => {
  unlockAudio();
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return ($('homeError').textContent = 'Choisis un pseudo d’abord.');
  if (code.length !== 4) return ($('homeError').textContent = 'Le code fait 4 lettres.');
  localStorage.setItem('cr_name', name);
  socket.emit('join', { code, name }, (res) => {
    if (!res.ok) return ($('homeError').textContent = res.error || 'Erreur.');
    S.code = res.code;
    S.token = res.token;
    saveSession();
    applySnapshot(res.snapshot);
  });
};

$('homeBtn').onclick = () => {
  clearSession();
  location.reload();
};

// ------------------------------------------------------------------ lobby

function renderLobby() {
  const lb = S.lobby;
  if (!lb) return;
  $('lobbyCode').textContent = lb.code;
  const isHost = lb.hostToken === S.token;
  $('hostControls').hidden = !isHost;
  $('hostStart').hidden = !isHost;
  $('waitHost').hidden = isHost;
  $('catHint').hidden = !isHost;
  $('durationSel').value = String(lb.durationMin);
  $('graceSel').value = String(lb.graceSec);
  $('zoneSel').value = String(lb.zoneCfg || 0);
  $('costsToggle').hidden = false;
  $('settingsSummary').hidden = isHost;
  if (!isHost) {
    $('settingsSummary').textContent =
      `Réglages de l’hôte : chasse de ${lb.durationMin} min · ` +
      (lb.graceSec ? `${lb.graceSec} s de dispersion` : 'départ immédiat') +
      (lb.zoneCfg ? ` · zone rétrécissante de ${lb.zoneCfg} m` : '');
  }
  renderCosts();

  const ul = $('playerList');
  ul.innerHTML = '';
  for (const p of lb.players) {
    const li = document.createElement('li');
    li.className =
      (p.connected ? '' : 'offline ') + (p.isCat ? 'isCat ' : '') + (isHost ? 'selectable' : '');
    li.innerHTML = `<span>${p.isCat ? '🐱' : '🐭'}</span><span>${escapeHtml(p.name)}</span>`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [p.isHost ? 'hôte' : '', p.isCat ? 'CHAT' : '', p.connected ? '' : 'hors ligne']
      .filter(Boolean)
      .join(' · ');
    li.appendChild(tag);
    if (isHost) li.onclick = () => socket.emit('setCat', { target: p.token });
    ul.appendChild(li);
  }
}

$('durationSel').onchange = () =>
  socket.emit('setDuration', { min: parseInt($('durationSel').value, 10) });

$('graceSel').onchange = () =>
  socket.emit('setGrace', { sec: parseInt($('graceSel').value, 10) });

$('zoneSel').onchange = () =>
  socket.emit('setZone', { radius: parseInt($('zoneSel').value, 10) });

$('costsToggle').onclick = () => {
  const p = $('costsPanel');
  p.hidden = !p.hidden;
  $('costsToggle').textContent = p.hidden ? '⚙️ Prix des pouvoirs' : '⚙️ Masquer les prix';
  renderCosts();
};

// éditeur des pouvoirs : actif / prix / durée (saisie pour l'hôte, lecture pour les autres)
function renderCosts() {
  const lb = S.lobby;
  const panel = $('costsPanel');
  if (!lb || !lb.powers || panel.hidden) return;
  // ne pas reconstruire pendant que l'hôte tape dans un champ
  if (panel.contains(document.activeElement)) return;
  const isHost = lb.hostToken === S.token;
  panel.innerHTML = '';
  const groups = [
    ['cat', '🐱 Pouvoirs du chat'],
    ['mouse', '🐭 Pouvoirs des souris'],
  ];
  for (const [role, title] of groups) {
    const h = document.createElement('p');
    h.className = 'grpTitle';
    h.textContent = title;
    panel.appendChild(h);
    const legend = document.createElement('div');
    legend.className = 'costRow costLegend';
    legend.innerHTML =
      '<span class="cname"></span><span class="chead">actif</span><span class="chead">points</span><span class="chead">durée s</span>';
    panel.appendChild(legend);
    for (const [id, def] of Object.entries(lb.powers[role])) {
      const row = document.createElement('div');
      row.className = 'costRow' + (def.enabled === false ? ' off' : '');
      const name = document.createElement('span');
      name.className = 'cname';
      name.textContent = def.label;
      name.title = def.desc;
      row.appendChild(name);

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = def.enabled !== false;
      check.disabled = !isHost;
      check.onchange = () =>
        socket.emit('setPowerCfg', { role, id, enabled: check.checked });
      row.appendChild(check);

      const costIn = document.createElement('input');
      costIn.type = 'number';
      costIn.min = '0';
      costIn.max = '500';
      costIn.step = '5';
      costIn.inputMode = 'numeric';
      costIn.value = def.cost;
      costIn.disabled = !isHost;
      costIn.onchange = () => {
        const cost = Math.max(0, Math.min(500, parseInt(costIn.value, 10) || 0));
        costIn.value = cost;
        socket.emit('setPowerCfg', { role, id, cost });
      };
      row.appendChild(costIn);

      if (def.dur > 0) {
        const durIn = document.createElement('input');
        durIn.type = 'number';
        durIn.min = '5';
        durIn.max = '600';
        durIn.step = '5';
        durIn.inputMode = 'numeric';
        durIn.value = def.dur;
        durIn.disabled = !isHost;
        durIn.onchange = () => {
          const dur = Math.max(5, Math.min(600, parseInt(durIn.value, 10) || 5));
          durIn.value = dur;
          socket.emit('setPowerCfg', { role, id, dur });
        };
        row.appendChild(durIn);
      } else {
        const dash = document.createElement('span');
        dash.className = 'cdash';
        dash.textContent = '—';
        row.appendChild(dash);
      }
      panel.appendChild(row);
    }
  }
}

$('startBtn').onclick = () => {
  unlockAudio();
  socket.emit('start', (res) => {
    if (res && !res.ok) $('lobbyError').textContent = res.error || 'Impossible de lancer.';
  });
};

$('leaveBtn').onclick = () => {
  socket.emit('leave');
  clearSession();
  location.reload();
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ jeu : chrome (badge, pouvoirs, capture)

function renderGameChrome() {
  const you = S.you;
  if (!you) return;
  const isCat = you.role === 'cat';
  $('roleBadge').textContent = you.captured
    ? '👻 Spectateur'
    : isCat
      ? '🐱 Tu es le CHAT'
      : '🐭 Souris';
  $('captureBtn').hidden = !isCat || you.captured;
  renderPowers();
}

function renderPowers() {
  const row = $('powersRow');
  row.innerHTML = '';
  if (!S.powers || !S.you || S.you.captured) return;
  for (const [id, def] of Object.entries(S.powers)) {
    if (def.enabled === false) continue; // désactivé par l'hôte
    const b = document.createElement('button');
    b.className = 'powerBtn';
    b.dataset.power = id;
    b.dataset.cost = def.cost;
    b.dataset.label = def.label;
    const desc = def.dur > 0 ? `${def.desc} (${def.dur} s)` : def.desc;
    b.innerHTML = `<span class="pname">${def.label}</span><span class="pcost">${def.cost} pts</span><span class="pdesc">${desc}</span>`;
    b.onclick = () => buyPower(id, def);
    row.appendChild(b);
  }
  refreshPowerButtons();
}

let prevLockLabel = null;

function refreshPowerButtons() {
  const pts = currentPoints();
  const elapsed = Date.now() - S.youRxAt;
  const lockLeft = Math.max(0, (S.you?.lockMs || 0) - elapsed);
  const lockLabel = lockLeft > 0 ? S.you?.lockLabel : null;

  document.querySelectorAll('.powerBtn').forEach((b) => {
    const isActive = lockLabel && b.dataset.label === lockLabel;
    b.classList.toggle('activePower', !!isActive);
    const costEl = b.querySelector('.pcost');
    if (costEl) {
      costEl.textContent = isActive
        ? `⏳ actif ${Math.ceil(lockLeft / 1000)} s`
        : `${b.dataset.cost} pts`;
    }
    b.disabled =
      lockLeft > 0 || pts < parseInt(b.dataset.cost, 10) || now() < S.graceUntil;
  });

  // alerte claire quand l'effet se termine
  if (!lockLabel && prevLockLabel) {
    toast(`✅ ${prevLockLabel} terminé — pouvoirs disponibles.`);
    prevLockLabel = null;
  } else if (lockLabel) {
    prevLockLabel = lockLabel;
  }
}

function currentPoints() {
  return S.you ? S.you.points : 0;
}

function buyPower(id, def) {
  unlockAudio();
  if (id === 'decoy') {
    // placement manuel : on n'achète qu'au moment où la carte est touchée
    setPlacingDecoy(!placingDecoy);
    if (!placingDecoy) toast('Placement du leurre annulé.');
    return;
  }
  if (def.target) {
    pickMouse(`${def.label} — choisis ta cible`, (target) => sendPower(id, target));
  } else {
    sendPower(id, null);
  }
}

function sendPower(id, target) {
  socket.emit('power', { id, target }, (res) => {
    if (!res.ok) return toast(res.error || 'Impossible.');
    S.you = res.you;
    S.youRxAt = Date.now();
    if (res.msg) toast(res.msg);
    if (res.hits) {
      R.netHits = res.hits;
      R.netAt = Date.now();
      rebuildDynamic();
    }
    refreshPowerButtons();
  });
}

function pickMouse(title, onPick) {
  const list = S.mice
    .filter((m) => m.token !== S.token)
    .map((m) => ({
      label: '🐭 ' + m.name,
      onClick: () => { closeModal(); onPick(m.token); },
    }));
  if (!list.length) return toast('Aucune souris libre.');
  openModal({
    title,
    list,
    buttons: [{ label: 'Annuler', style: 'ghost', onClick: closeModal }],
  });
}

// ----- capture côté chat

$('captureBtn').onclick = () => {
  unlockAudio();
  pickMouse('Qui as-tu vu ?', (target) => {
    const m = S.mice.find((x) => x.token === target);
    openModal({
      title: `Déclarer avoir vu ${m ? m.name : '?'} ?`,
      text: 'Si tu te trompes (trop loin ou capture contestée) : −20 pts et recharge 45 s.',
      buttons: [
        { label: 'Annuler', style: 'ghost', onClick: closeModal },
        {
          label: 'Je l’ai vu !',
          style: 'danger',
          onClick: () => {
            closeModal();
            socket.emit('declare', { target }, (res) => {
              if (!res.ok) {
                toast(res.error || 'Échec.');
                if (res.cooldownMs && S.you) {
                  S.you.cooldownMs = res.cooldownMs;
                  S.youRxAt = Date.now();
                }
                return;
              }
              openModal({
                title: `En attente de ${res.name}…`,
                text: 'La souris confirme ou conteste la capture.',
                buttons: [],
              });
            });
          },
        },
      ],
    });
  });
};

socket.on('captureResult', ({ reason, name, cooldownMs }) => {
  closeModal();
  if (S.you) { S.you.cooldownMs = cooldownMs; S.youRxAt = Date.now(); }
  toast(
    reason === 'timeout'
      ? `${name} n’a pas répondu. Recharge 45 s.`
      : `${name} conteste la capture. −20 pts, recharge 45 s.`
  );
});

// ----- capture côté souris

socket.on('capturePrompt', ({ catName, timeoutMs }) => {
  unlockAudio();
  vibrate([300, 100, 300]);
  let remaining = Math.round(timeoutMs / 1000);
  openModal({
    title: `🐱 ${catName} déclare t’avoir vu !`,
    text: `Réponds dans les ${remaining} s.`,
    buttons: [
      {
        label: 'Il m’a eu 😿',
        style: 'danger',
        onClick: () => { closeModal(); socket.emit('captureAnswer', { accept: true }); },
      },
      {
        label: 'Non, je conteste',
        style: '',
        onClick: () => { closeModal(); socket.emit('captureAnswer', { accept: false }); },
      },
    ],
  });
  const iv = setInterval(() => {
    remaining--;
    if (remaining <= 0 || $('modal').hidden) return clearInterval(iv);
    $('modalText').textContent = `Réponds dans les ${remaining} s.`;
  }, 1000);
});

socket.on('captured', ({ name, remaining }) => {
  closeModal();
  toast(`🎯 ${name} a été capturé·e ! ${remaining} souris restante${remaining > 1 ? 's' : ''}.`);
  S.mice = S.mice.filter((m) => m.name !== name);
});

socket.on('youCaptured', () => {
  if (S.you) S.you.captured = true;
  renderGameChrome();
  rebuildDynamic();
  toast('Tu es maintenant spectateur : tu vois tout le monde sur la carte.');
});

// ------------------------------------------------------------------ événements radar

socket.on('mouseRadar', (d) => {
  if (d.cat) R.cat = { ...d.cat, rxAt: Date.now() };
  else if (!d.ghost) R.cat = null;
  R.ghost = d.ghost;
  R.mates = d.mates;
  R.senseNear = d.senseNear;
  // mise à jour immédiate (événementielle) : ne dépend pas de la boucle UI,
  // que le navigateur peut geler en arrière-plan
  $('senseBanner').hidden = !(d.senseNear && d.you && !d.you.captured);
  if (d.senseNear) {
    // alerte répétée à chaque tick radar (4 s) tant que le chat est à moins de 40 m
    vibrate([300, 100, 300]);
    playPing();
  }
  // zone rétrécissante
  R.zone = d.zone || null;
  const wasOut = R.outside;
  R.outside = !!d.outside;
  $('zoneBanner').hidden = !(R.outside && d.you && !d.you.captured);
  if (R.outside && !wasOut) {
    vibrate([500, 150, 500]);
    playPing();
    toast('⛔ Tu es hors zone : visible du chat et plus aucun point !');
  }
  S.you = d.you;
  S.youRxAt = Date.now();
  S.skew = d.serverNow - Date.now();
  refreshPowerButtons();
  rebuildDynamic();
});

socket.on('youUpdate', (d) => {
  S.you = d.you;
  S.youRxAt = Date.now();
  if (d.mice) S.mice = d.mice;
  if ('zone' in d) R.zone = d.zone || null;
  S.skew = d.serverNow - Date.now();
  refreshPowerButtons();
});

socket.on('catPing', (d) => {
  R.blipsInterval = d.nextIn;
  R.nextPingAt = Date.now() + d.nextIn;
  if (d.jammed) return; // on garde les anciens blips, le brouillage s'affiche par-dessus
  R.blips = d.blips || [];
  R.blipsAt = Date.now();
  vibrate(80);
  rebuildDynamic();
});

socket.on('jamStart', ({ until }) => {
  R.jammedUntil = until - S.skew; // en temps local
  toast('⚡ Ton radar est brouillé !');
});

socket.on('reveal', (d) => {
  R.reveal = d.blips || [];
  R.revealRxAt = Date.now();
  rebuildDynamic();
});

socket.on('spectate', (d) => {
  R.spectators = d.players || [];
  if ('zone' in d) R.zone = d.zone || null;
  S.you = d.you;
  S.youRxAt = Date.now();
  rebuildDynamic();
});

let ringUntil = 0;
socket.on('ring', ({ sec }) => {
  unlockAudio();
  playSiren(sec);
  ringUntil = Date.now() + sec * 1000;
  $('ringOverlay').hidden = false;
  if (vibTimer) clearInterval(vibTimer);
  vibrate([400, 100, 400]);
  vibTimer = setInterval(() => vibrate([400, 100, 400]), 1000);
  setTimeout(() => {
    // ne pas couper une 2e sonnerie arrivée entre-temps
    if (Date.now() < ringUntil - 100) return;
    $('ringOverlay').hidden = true;
    if (vibTimer) {
      clearInterval(vibTimer);
      vibTimer = null;
    }
  }, sec * 1000);
});

socket.on('toast', ({ msg }) => toast(msg));

socket.on('lobby', (lb) => {
  S.lobby = lb;
  if (S.screen === 'lobby') renderLobby();
});

socket.on('started', (snap) => {
  closeModal();
  myDecoy = null;
  R.zone = null;
  R.outside = false;
  $('zoneBanner').hidden = true;
  applySnapshot(snap);
  const graceS = Math.max(0, Math.round((snap.graceUntil - snap.serverNow) / 1000));
  toast(
    snap.you.role === 'cat'
      ? graceS
        ? 'Tu es le CHAT ! Radar actif après la dispersion.'
        : 'Tu es le CHAT ! La chasse commence tout de suite !'
      : graceS
        ? `FUIS ! Le chat arrive dans ${graceS} s.`
        : 'FUIS ! Le chat est déjà en chasse !'
  );
});

socket.on('gameOver', (d) => showEnd(d));

socket.on('sync', () => {
  if (!S.code || !S.token) return;
  socket.emit('rejoin', { code: S.code, token: S.token }, (res) => {
    if (res.ok && res.snapshot.state === 'playing' && S.screen !== 'game') {
      applySnapshot(res.snapshot);
    }
  });
});

socket.on('connect', () => {
  const saved = loadSession();
  if (!saved) return;
  const { code, token } = JSON.parse(saved);
  if (!code || !token) return;
  socket.emit('rejoin', { code, token }, (res) => {
    if (!res.ok) {
      clearSession();
      if (S.screen !== 'home') location.reload();
      return;
    }
    S.code = res.code;
    S.token = res.token;
    applySnapshot(res.snapshot);
  });
});

// ------------------------------------------------------------------ fin de partie

function showEnd({ winner, catName, scores }) {
  closeModal();
  stopPosition();
  $('endTitle').textContent =
    winner === 'cat' ? '🐱 Victoire du chat !' : '🐭 Victoire des souris !';
  $('endSub').textContent =
    winner === 'cat'
      ? `${catName || 'Le chat'} a attrapé tout le monde.`
      : 'Le temps est écoulé, des souris ont survécu.';
  const rows = (scores || [])
    .map(
      (s) =>
        `<tr><td>${s.role === 'cat' ? '🐱' : s.captured ? '👻' : '🐭'} ${escapeHtml(s.name)}</td><td>${s.points} pts</td></tr>`
    )
    .join('');
  $('scoreTable').innerHTML = `<tr><th>Joueur</th><th>Score</th></tr>${rows}`;
  show('end');
}

// ------------------------------------------------------------------ carte Leaflet

let map = null;
let meMarker = null;
let coneMarker = null;
let accCircle = null;
let zoneCircle = null;
let dynLayer = null;
let follow = true;
let catBlipRefs = []; // marqueurs du dernier scan, pour le fondu

function blipIcon(cls, emoji, name) {
  const label = name ? `${emoji} ${escapeHtml(name)}` : emoji;
  return L.divIcon({
    className: 'blipWrap',
    html: `<div class="blip ${cls}"><div class="blipDot"></div><div class="blipName">${label}</div></div>`,
    iconSize: [0, 0],
  });
}

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  map.setView([48.8566, 2.3522], 16);
  dynLayer = L.layerGroup().addTo(map);
  map.on('dragstart', () => {
    follow = false;
    $('recenterBtn').hidden = false;
  });
  map.on('click', (e) => {
    if (placingDecoy) {
      placeDecoy(e.latlng);
      return;
    }
    if (SIM) {
      myPos = { lat: e.latlng.lat, lng: e.latlng.lng, acc: 5 };
      if (S.token) socket.emit('pos', myPos);
    }
  });
}

// ----- leurre : placement manuel sur la carte
let placingDecoy = false;
let myDecoy = null; // {lat,lng,until} pour l'afficher sur ma propre carte

function setPlacingDecoy(on) {
  placingDecoy = on;
  $('decoyBanner').hidden = !on;
}

function placeDecoy(latlng) {
  setPlacingDecoy(false);
  socket.emit('power', { id: 'decoy', pos: { lat: latlng.lat, lng: latlng.lng } }, (res) => {
    if (!res.ok) return toast(res.error || 'Impossible.');
    S.you = res.you;
    S.youRxAt = Date.now();
    myDecoy = {
      lat: latlng.lat,
      lng: latlng.lng,
      until: Date.now() + (res.you.fx.decoy || 45000),
    };
    if (res.msg) toast(res.msg);
    refreshPowerButtons();
    rebuildDynamic();
  });
}

$('recenterBtn').onclick = () => {
  follow = true;
  $('recenterBtn').hidden = true;
  if (map && myPos) map.setView([myPos.lat, myPos.lng], 17);
};

function distClient(a, b) {
  if (!a || !b) return Infinity;
  const R6 = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R6 * Math.asin(Math.sqrt(h));
}

// reconstruit les marqueurs des autres joueurs à partir de l'état R
function rebuildDynamic() {
  if (!map || !dynLayer) return;
  dynLayer.clearLayers();
  catBlipRefs = [];
  const you = S.you || {};
  const t = Date.now();

  if (you.captured) {
    for (const p of R.spectators) {
      dynLayer.addLayer(
        L.marker([p.lat, p.lng], {
          icon: blipIcon(p.isCat ? 'cat' : 'mouse', p.isCat ? '🐱' : '🐭', p.name),
          interactive: false,
        })
      );
    }
    return;
  }

  if (you.role === 'cat') {
    for (const b of R.blips) {
      // blips anonymes : le serveur n'envoie plus les noms sur le scan normal
      const m = L.marker([b.lat, b.lng], {
        icon: blipIcon('mouse', '🐭', null),
        interactive: false,
      });
      dynLayer.addLayer(m);
      catBlipRefs.push(m);
    }
    if (t - R.revealRxAt < 4000) {
      for (const b of R.reveal) {
        dynLayer.addLayer(
          L.marker([b.lat, b.lng], { icon: blipIcon('reveal', '🔍', b.name), interactive: false })
        );
      }
    }
    if (t - R.netAt < 30000) {
      for (const b of R.netHits) {
        dynLayer.addLayer(
          L.marker([b.lat, b.lng], { icon: blipIcon('reveal', '🕸', b.name), interactive: false })
        );
      }
    }
  } else {
    if (!R.ghost && R.cat) {
      dynLayer.addLayer(
        L.marker([R.cat.lat, R.cat.lng], {
          icon: blipIcon('cat', '🐱', S.catName || 'chat'),
          interactive: false,
        })
      );
    }
    if (R.mates) {
      for (const m of R.mates) {
        dynLayer.addLayer(
          L.marker([m.lat, m.lng], { icon: blipIcon('mate', '🐭', m.name), interactive: false })
        );
      }
    }
    // mon propre leurre, pour savoir où le chat me croit
    if (myDecoy && myDecoy.until > t) {
      dynLayer.addLayer(
        L.marker([myDecoy.lat, myDecoy.lng], {
          icon: blipIcon('mouse', '🪤', 'ton leurre'),
          interactive: false,
        })
      );
    }
  }
}

// mise à jour continue : ma position, le cône boussole, les fondus, le statut
function updateMapLoop() {
  if (!map || S.screen !== 'game') return;
  const t = Date.now();
  const you = S.you || {};

  if (myPos) {
    const ll = [myPos.lat, myPos.lng];
    if (!meMarker) {
      coneMarker = L.marker(ll, {
        icon: L.divIcon({ className: 'blipWrap', html: '<div class="cone" id="coneEl"></div>', iconSize: [0, 0] }),
        interactive: false,
      }).addTo(map);
      meMarker = L.marker(ll, {
        icon: L.divIcon({ className: 'blipWrap', html: '<div class="meDot"></div>', iconSize: [0, 0] }),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(map);
      accCircle = L.circle(ll, {
        radius: myPos.acc || 10,
        color: '#2f6df6', weight: 1, opacity: 0.3, fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
      map.setView(ll, 17);
    } else {
      meMarker.setLatLng(ll);
      coneMarker.setLatLng(ll);
      accCircle.setLatLng(ll);
      accCircle.setRadius(myPos.acc || 10);
    }
    if (follow) map.panTo(ll, { animate: false });
    const coneEl = document.getElementById('coneEl');
    if (coneEl) {
      coneEl.style.display = heading === null ? 'none' : '';
      if (heading !== null) {
        coneEl.style.transform = `translate(-50%,-50%) rotate(${heading}deg)`;
      }
    }
  }

  // zone rétrécissante
  if (R.zone) {
    if (!zoneCircle) {
      zoneCircle = L.circle([R.zone.lat, R.zone.lng], {
        radius: R.zone.r,
        color: '#6d28d9', weight: 2.5, dashArray: '8 8',
        fillColor: '#6d28d9', fillOpacity: 0.05,
        interactive: false,
      }).addTo(map);
    } else {
      zoneCircle.setLatLng([R.zone.lat, R.zone.lng]);
      zoneCircle.setRadius(R.zone.r);
    }
  } else if (zoneCircle) {
    map.removeLayer(zoneCircle);
    zoneCircle = null;
  }

  // fondu des blips du chat entre deux scans
  if (you.role === 'cat' && catBlipRefs.length && R.blipsAt) {
    const alpha = Math.max(0.35, 1 - (t - R.blipsAt) / R.blipsInterval);
    for (const m of catBlipRefs) m.setOpacity(alpha);
  }

  // brouillage
  const jammed = you.role === 'cat' && !you.captured && t < R.jammedUntil;
  $('jamOverlay').hidden = !jammed;

  // bannière sixième sens
  $('senseBanner').hidden = !(R.senseNear && you.role === 'mouse' && !you.captured);

  // ligne de statut
  if (!myPos) {
    statusLine('En attente du signal GPS…');
  } else if (you.captured) {
    statusLine('Mode spectateur — tu vois tout le monde.');
  } else if (you.role === 'cat') {
    if (jammed) {
      statusLine('⚡ Radar brouillé…');
    } else {
      const nextIn = Math.max(0, Math.ceil((R.nextPingAt - t) / 1000));
      statusLine(
        R.blipsAt
          ? `Dernier scan il y a ${Math.round((t - R.blipsAt) / 1000)} s · prochain dans ${nextIn} s`
          : `Premier scan dans ${nextIn} s`
      );
    }
  } else {
    if (R.ghost) {
      statusLine('👻 Le chat a disparu du radar…');
    } else if (R.cat) {
      const d = Math.round(distClient(myPos, R.cat));
      const age = Math.round((t - R.cat.rxAt) / 1000);
      statusLine(`Chat à ~${d} m · signal d’il y a ${age} s${R.senseNear ? ' · 🔔 TOUT PRÈS' : ''}`);
    } else {
      statusLine('En attente du signal du chat…');
    }
  }
}

let lastStatus = '';
function statusLine(s) {
  if (s !== lastStatus) {
    lastStatus = s;
    $('gameStatus').textContent = s;
  }
}

// ------------------------------------------------------------------ boucle UI (timer, chips, cooldown)

setInterval(() => {
  if (S.screen !== 'game') return;
  const t = now();
  const you = S.you || {};

  // timer
  if (S.endsAt) {
    const left = Math.max(0, S.endsAt - t);
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $('timerBox').textContent = `${m}:${String(s).padStart(2, '0')}`;
  }
  $('pointsBox').textContent = `${you.points ?? 0} pts`;

  // dispersion
  const inGrace = t < S.graceUntil;
  $('graceOverlay').hidden = !inGrace;
  if (inGrace) {
    const left = Math.ceil((S.graceUntil - t) / 1000);
    $('graceText').textContent =
      you.role === 'cat' ? '🐱 Les souris se dispersent…' : '🐭 FUIS ! Le chat arrive dans';
    $('graceCount').textContent = `${left} s`;
  }

  // chips d'effets actifs
  const elapsed = Date.now() - S.youRxAt;
  const chips = [];
  const FX_LABELS = {
    ghost: 'Chat fantôme', fastping: 'Radar rapide', reveal: 'Révélé !',
    sense: 'Sixième sens', team: 'Entraide', decoy: 'Leurre', invis: 'Invisible', jam: 'Brouillé',
  };
  for (const [k, ms] of Object.entries(you.fx || {})) {
    const left = Math.ceil((ms - elapsed) / 1000);
    if (left > 0) chips.push(`${FX_LABELS[k] || k} ${left}s`);
  }
  if (R.zone) chips.push(`⭕ Zone ${R.zone.r} m`);
  $('fxRow').innerHTML = chips.map((c) => `<span class="fxChip">${c}</span>`).join('');

  // bouton capture (cooldown)
  if (you.role === 'cat' && !you.captured) {
    const cdLeft = Math.ceil(((you.cooldownMs || 0) - elapsed) / 1000);
    if (cdLeft > 0) {
      $('captureBtn').disabled = true;
      $('captureBtn').textContent = `🎯 Recharge… ${cdLeft} s`;
    } else if (t < S.graceUntil) {
      $('captureBtn').disabled = true;
      $('captureBtn').textContent = '🎯 J’ai vu une souris';
    } else {
      $('captureBtn').disabled = false;
      $('captureBtn').textContent = '🎯 J’ai vu une souris';
    }
  }

  refreshPowerButtons();
  updateMapLoop();
}, 500);

$('codeInput').addEventListener('input', () => {
  $('codeInput').value = $('codeInput').value.toUpperCase();
});
