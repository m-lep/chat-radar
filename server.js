const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3010;

// ---------------------------------------------------------------- constantes

const DEFAULT_GRACE_SEC = 60;       // dispersion des souris au lancement (réglable par l'hôte)
const CAPTURE_DIST_M = 15;          // distance max pour déclarer une capture
const CAPTURE_COOLDOWN_MS = 45_000; // après échec (trop loin ou refus)
const CAPTURE_PENALTY_PTS = 20;     // le chat perd des points s'il s'est trompé
const PROMPT_TIMEOUT_MS = 25_000;   // la souris a 25 s pour répondre
const POS_FRESH_MS = 30_000;        // fraîcheur GPS exigée pour une capture
const PING_INTERVAL_MS = 25_000;    // scan du chat
const FAST_PING_MS = 10_000;        // scan pendant « radar rapide »
const NOISE_M = 20;                 // imprécision ajoutée aux blips du chat
const CONTACT_DIST_M = 50;          // bonus « contact radar » du chat
const CONTACT_COOLDOWN_MS = 120_000;
const RISK_DIST_M = 20;             // bonus de risque des souris
const SENSE_DIST_M = 40;            // portée du sixième sens
const SURVIVAL_BONUS = 30;
const ZONE_MIN_R = 40;              // rayon final de la zone rétrécissante
const ZONE_CHOICES = [0, 200, 300, 500, 800, 1200]; // 0 = désactivée
const CACHE_VALUE_PTS = 15;         // points par cache bonus ramassé
const CACHE_COLLECT_M = 20;         // distance de ramassage
const CACHE_TTL_MS = 4 * 60_000;    // un cache non ramassé disparaît
const CACHE_MAX = 2;                // caches simultanés max

// dur = durée d'effet en secondes (0 = instantané, non éditable) ;
// cost/dur/enabled sont copiés par partie et réglables par l'hôte
const POWERS = {
  cat: {
    net:      { cost: 8,  dur: 0,  enabled: true, target: false, label: 'Coup de filet', desc: 'Position précise des souris à moins de 150 m' },
    fastping: { cost: 10, dur: 60, enabled: true, target: false, label: 'Radar rapide',  desc: 'Scans toutes les 10 s' },
    ghost:    { cost: 15, dur: 60, enabled: true, target: false, label: 'Chat fantôme',  desc: 'Invisible sur le radar des souris' },
    ring:     { cost: 15, dur: 10, enabled: true, target: true,  label: 'Sonnerie',      desc: 'Fait sonner le téléphone d’une souris' },
    reveal:   { cost: 15, dur: 30, enabled: true, target: true,  label: 'Révélation',    desc: 'Une souris en temps réel précis' },
  },
  mouse: {
    team:       { cost: 8,  dur: 60, enabled: true, target: false, label: 'Entraide',      desc: 'Voir les autres souris' },
    sense:      { cost: 10, dur: 60, enabled: true, target: false, label: 'Sixième sens',  desc: 'Alerte quand le chat est à moins de 40 m' },
    jam:        { cost: 15, dur: 30, enabled: true, target: false, label: 'Brouillage',    desc: 'Le radar du chat est inutilisable' },
    decoy:      { cost: 15, dur: 45, enabled: true, target: false, label: 'Leurre',        desc: 'Pose une fausse position là où tu touches la carte' },
    invis:      { cost: 15, dur: 45, enabled: true, target: false, label: 'Invisibilité',  desc: 'Disparais du radar du chat' },
    fakefriend: { cost: 15, dur: 10, enabled: true, target: true,  label: 'Faux ami',      desc: 'Fais sonner fort une autre souris' },
  },
};

// ---------------------------------------------------------------- état

const games = new Map(); // code -> game

// copie des pouvoirs par partie, pour que l'hôte puisse ajuster les coûts
function defaultPowers() {
  return JSON.parse(JSON.stringify(POWERS));
}

function makeCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // sans I/L/O ambigus
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (games.has(code));
  return code;
}

function makeToken() {
  return crypto.randomBytes(9).toString('hex');
}

function distM(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function offsetPos(pos, dxM, dyM) {
  const lat = pos.lat + dyM / 111320;
  const lng = pos.lng + dxM / (111320 * Math.cos((pos.lat * Math.PI) / 180));
  return { lat, lng };
}

function noisy(pos, maxM) {
  const ang = Math.random() * 2 * Math.PI;
  const r = Math.random() * maxM;
  return offsetPos(pos, Math.cos(ang) * r, Math.sin(ang) * r);
}

function room(game) {
  return 'g:' + game.code;
}

function emitTo(player, event, payload) {
  if (player && player.socketId) io.to(player.socketId).emit(event, payload);
  else if (process.env.DEBUG) console.log('[emitTo] pas de socket pour', player && player.name, event);
}

function freeMice(game) {
  return [...game.players.values()].filter((p) => p.role === 'mouse' && !p.captured);
}

function cats(game) {
  return [...game.players.values()].filter((p) => p.role === 'cat');
}

// ---------------------------------------------------------------- journal

// aud : 'all' (tout le monde), 'cats' (tous les chats), ou un token de joueur
function logEvent(game, aud, msg) {
  const e = { t: Date.now(), aud, msg };
  game.log.push(e);
  if (game.log.length > 200) game.log.shift();
  const payload = { t: e.t, msg };
  if (aud === 'all') io.to(room(game)).emit('log', payload);
  else if (aud === 'cats') for (const c of cats(game)) emitTo(c, 'log', payload);
  else emitTo(game.players.get(aud), 'log', payload);
}

function logVisible(game, p) {
  return game.log
    .filter((e) => e.aud === 'all' || (e.aud === 'cats' && p.role === 'cat') || e.aud === p.token)
    .slice(-40)
    .map((e) => ({ t: e.t, msg: e.msg }));
}

function fxRemaining(p, t) {
  const out = {};
  for (const [k, v] of Object.entries(p.fx)) {
    if (k === 'decoy') {
      if (v && v.until > t) out.decoy = v.until - t;
    } else if (v > t) {
      out[k] = v - t;
    }
  }
  return out;
}

function youPayload(game, p, t) {
  return {
    token: p.token,
    name: p.name,
    role: p.role,
    captured: p.captured,
    points: p.points,
    fx: fxRemaining(p, t),
    cooldownMs: p.role === 'cat' ? Math.max(0, (p.captureCooldownUntil || 0) - t) : 0,
    lockMs: Math.max(0, (p.powerLockUntil || 0) - t),
    lockLabel: (p.powerLockUntil || 0) > t ? p.powerLockLabel : null,
  };
}

function lobbyPayload(game) {
  return {
    code: game.code,
    state: game.state,
    durationMin: game.durationMin,
    graceSec: game.graceSec,
    zoneCfg: game.zoneCfg,
    cachesEnabled: game.cachesEnabled,
    powers: game.powers,
    hostToken: game.hostToken,
    players: [...game.players.values()].map((p) => ({
      token: p.token,
      name: p.name,
      connected: p.connected,
      isCat: game.catTokens.has(p.token),
      isHost: p.token === game.hostToken,
    })),
  };
}

function snapshot(game, p) {
  const t = Date.now();
  return {
    state: game.state,
    code: game.code,
    lobby: lobbyPayload(game),
    you: youPayload(game, p, t),
    powers: game.powers[p.role] || game.powers.mouse,
    graceUntil: game.graceUntil,
    endsAt: game.endsAt,
    serverNow: t,
    catName: cats(game).map((c) => c.name).join(' & ') || null,
    mice: freeMice(game).map((m) => ({ token: m.token, name: m.name })),
    winner: game.winner || null,
    scores: game.state === 'ended' ? finalScores(game) : null,
    log: logVisible(game, p),
  };
}

function broadcastLobby(game) {
  io.to(room(game)).emit('lobby', lobbyPayload(game));
}

// ---------------------------------------------------------------- partie

function startGame(game) {
  const t = Date.now();
  game.state = 'playing';
  if (game.catTokens.size === 0) {
    const all = [...game.players.keys()];
    game.catTokens.add(all[Math.floor(Math.random() * all.length)]);
  }
  for (const p of game.players.values()) {
    p.role = game.catTokens.has(p.token) ? 'cat' : 'mouse';
    p.points = 0;
    p.captured = false;
    p.fx = {};
    p.lastContactAt = 0;
    p.powerLockUntil = 0;
    p.powerLockLabel = null;
    p.captureCooldownUntil = 0;
    p.wasOutside = false;
  }
  game.jamUntil = 0;
  game.caches = [];
  game.roadNodes = null;
  game.roadFetchState = null;
  game.log = [];
  game.pendingCaptures = new Map();
  game.startedAt = t;
  // le centre de la zone sera fixé sur la position du chat au premier tick
  // après la dispersion (le GPS n'est pas forcément prêt au lancement)
  game.zone = game.zoneCfg > 0 ? { startRadius: game.zoneCfg, lat: null, lng: null } : null;
  game.graceUntil = t + game.graceSec * 1000;
  game.endsAt = game.graceUntil + game.durationMin * 60_000;
  game.nextPingAt = game.graceUntil + 3_000;
  game.nextCacheAt = game.graceUntil + 30_000;
  game.secCount = 0;
  logEvent(game, 'all', `🏁 La chasse commence — ${cats(game).map((c) => c.name).join(' & ')} ${game.catTokens.size > 1 ? 'sont les chats' : 'est le chat'} !`);
  game.tick = setInterval(() => gameTick(game), 1000);
  for (const p of game.players.values()) {
    if (process.env.DEBUG)
      console.log('[started→]', p.name, p.socketId, 'live=', p.socketId ? io.sockets.sockets.has(p.socketId) : false);
    emitTo(p, 'started', snapshot(game, p));
  }
  // filet de sécurité : tout client qui aurait raté l'emit direct se resynchronise
  io.to(room(game)).emit('sync');
}

function finalScores(game) {
  return [...game.players.values()]
    .map((p) => ({ name: p.name, role: p.role, points: p.points, captured: p.captured }))
    .sort((a, b) => b.points - a.points);
}

function endGame(game, winner) {
  if (game.state !== 'playing') return;
  game.state = 'ended';
  game.winner = winner;
  clearInterval(game.tick);
  game.tick = null;
  for (const pc of game.pendingCaptures.values()) clearTimeout(pc.timer);
  game.pendingCaptures.clear();
  if (winner === 'mice') {
    for (const m of freeMice(game)) m.points += SURVIVAL_BONUS;
  }
  io.to(room(game)).emit('gameOver', {
    winner,
    catName: cats(game).map((c) => c.name).join(' & '),
    scores: finalScores(game),
  });
  setTimeout(() => games.delete(game.code), 10 * 60_000);
}

function gameTick(game) {
  const t = Date.now();
  if (game.state !== 'playing') return;
  game.lastActivity = t;

  if (t >= game.endsAt) return endGame(game, 'mice');

  const catList = cats(game);
  const mice = freeMice(game);
  if (mice.length === 0) return endGame(game, 'cat');
  if (t < game.graceUntil) return; // tout démarre après la dispersion

  game.secCount++;
  const scoring = game.secCount % 10 === 0;

  // ----- zone rétrécissante
  let zone = null;
  if (game.zone) {
    if (game.zone.lat == null) {
      const c0 = catList.find((c) => c.pos);
      if (c0) {
        game.zone.lat = c0.pos.lat;
        game.zone.lng = c0.pos.lng;
        io.to(room(game)).emit('toast', {
          msg: `⭕ Zone fixée : ${game.zone.startRadius} m autour du chat, elle rétrécit jusqu'à ${ZONE_MIN_R} m !`,
        });
        logEvent(game, 'all', `⭕ Zone de jeu fixée (${game.zone.startRadius} m, rétrécit jusqu'à ${ZONE_MIN_R} m)`);
      }
    }
    if (game.zone.lat != null) {
      const span = Math.max(1, game.endsAt - game.graceUntil);
      const prog = Math.min(1, Math.max(0, (t - game.graceUntil) / span));
      const r = Math.max(
        ZONE_MIN_R,
        Math.round(game.zone.startRadius - (game.zone.startRadius - ZONE_MIN_R) * prog)
      );
      zone = { lat: game.zone.lat, lng: game.zone.lng, r };
    }
  }
  const isOutside = (p) =>
    !!(zone && p.pos && distM({ lat: zone.lat, lng: zone.lng }, p.pos) > zone.r);

  // chat le plus proche d'une souris (il peut y en avoir plusieurs)
  const nearestCat = (m) => {
    let best = null;
    let bestD = Infinity;
    for (const c of catList) {
      const d = distM(c.pos, m.pos);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return { nc: best, d: bestD };
  };

  // ----- points
  if (scoring) for (const c of catList) c.points += 1;
  for (const m of mice) {
    const { nc, d } = nearestCat(m);
    const out = isOutside(m);
    if (scoring && !out) {
      // hors zone : on ne gagne rien
      m.points += 1;
      if (d <= RISK_DIST_M) m.points += 3; // frisson : un chat est tout près
    }
    if (nc && d <= CONTACT_DIST_M && t - m.lastContactAt > CONTACT_COOLDOWN_MS) {
      m.lastContactAt = t;
      nc.points += 15;
      emitTo(nc, 'toast', { msg: 'Contact radar : une souris à moins de 50 m (+15 pts)' });
      logEvent(game, 'cats', `📡 Contact radar (${nc.name}) : une souris à moins de 50 m (+15 pts)`);
    }
    if (out !== !!m.wasOutside) {
      m.wasOutside = out;
      logEvent(game, m.token, out ? '⛔ Sortie de zone — visible et 0 point' : '✅ Retour dans la zone');
    }
  }

  // ----- caches bonus
  if (game.cachesEnabled) tickCaches(game, t, zone, catList);
  const cachesPayload = game.caches.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng }));

  // ----- radar des souris + spectateurs (toutes les 4 s)
  if (game.secCount % 4 === 0) {
    const visibleCats = catList
      .filter((c) => c.pos && !((c.fx.ghost || 0) > t))
      .map((c) => ({ name: c.name, lat: c.pos.lat, lng: c.pos.lng, ts: c.posTs }));
    const anyGhost = catList.some((c) => (c.fx.ghost || 0) > t);
    for (const m of mice) {
      const { d } = nearestCat(m);
      emitTo(m, 'mouseRadar', {
        cats: visibleCats,
        ghost: anyGhost,
        zone,
        caches: cachesPayload,
        outside: isOutside(m),
        senseNear: (m.fx.sense || 0) > t && m.pos ? d <= SENSE_DIST_M : false,
        mates:
          (m.fx.team || 0) > t
            ? mice
                .filter((o) => o !== m && o.pos)
                .map((o) => ({ name: o.name, lat: o.pos.lat, lng: o.pos.lng }))
            : null,
        you: youPayload(game, m, t),
        serverNow: t,
      });
    }
    const everyone = [...game.players.values()]
      .filter((p) => p.pos && !p.captured)
      .map((p) => ({ name: p.name, isCat: p.role === 'cat', lat: p.pos.lat, lng: p.pos.lng }));
    for (const s of [...game.players.values()].filter((p) => p.captured)) {
      emitTo(s, 'spectate', { players: everyone, zone, caches: cachesPayload, you: youPayload(game, s, t), serverNow: t });
    }
    for (const c of catList) {
      emitTo(c, 'youUpdate', {
        you: youPayload(game, c, t),
        zone,
        caches: cachesPayload,
        mice: mice.map((m) => ({ token: m.token, name: m.name })),
        serverNow: t,
      });
    }
  }

  // ----- révélation en quasi temps réel (toutes les 2 s)
  if (game.secCount % 2 === 0) {
    const revealed = mice.filter((m) => (m.fx.reveal || 0) > t && m.pos);
    if (revealed.length) {
      const blips = revealed.map((m) => ({ name: m.name, lat: m.pos.lat, lng: m.pos.lng }));
      for (const c of catList) emitTo(c, 'reveal', { blips });
    }
  }

  // ----- scan périodique des chats (partagé : mêmes blips pour tous)
  if (t >= game.nextPingAt) {
    const interval = catList.some((c) => (c.fx.fastping || 0) > t)
      ? FAST_PING_MS
      : PING_INTERVAL_MS;
    game.nextPingAt = t + interval;
    if (game.jamUntil > t) {
      for (const c of catList) emitTo(c, 'catPing', { jammed: true, at: t, nextIn: interval });
    } else {
      // blips anonymes : savoir QUI est où, c'est le rôle des pouvoirs
      // (Révélation, Coup de filet) — on n'envoie même pas les noms au client
      const blips = [];
      for (const m of mice) {
        const out = isOutside(m);
        // hors zone : toujours visible, l'invisibilité et le leurre ne protègent plus
        if (!out && (m.fx.invis || 0) > t) continue;
        if (!out && m.fx.decoy && m.fx.decoy.until > t) {
          // même bruit que les vrais blips : un leurre immobile au pixel près se trahirait
          const p = noisy({ lat: m.fx.decoy.lat, lng: m.fx.decoy.lng }, NOISE_M);
          blips.push({ lat: p.lat, lng: p.lng });
        } else if (m.pos) {
          // on garde la dernière position connue même si le GPS est périmé :
          // verrouiller son téléphone ne doit pas faire disparaître du radar
          const p = noisy(m.pos, NOISE_M);
          blips.push({ lat: p.lat, lng: p.lng });
        }
      }
      for (const c of catList) emitTo(c, 'catPing', { blips, at: t, nextIn: interval });
    }
  }
}

// ---------------------------------------------------------------- caches bonus

function cacheCenter(game, zone, catList) {
  if (zone) return { lat: zone.lat, lng: zone.lng, r: Math.max(zone.r, 120) };
  const c0 = catList.find((c) => c.pos);
  return c0 ? { lat: c0.pos.lat, lng: c0.pos.lng, r: 400 } : null;
}

// récupère une fois par partie les points des rues alentour (OpenStreetMap),
// pour faire apparaître les caches sur de vraies rues et pas dans les immeubles
async function fetchRoadNodes(game, ctr) {
  game.roadFetchState = 'pending';
  try {
    const radius = Math.max(600, Math.round(ctr.r * 1.3));
    const q = `[out:json][timeout:10];way(around:${radius},${ctr.lat},${ctr.lng})["highway"~"^(residential|living_street|pedestrian|footway|path|unclassified|tertiary|secondary|primary|service|cycleway|track)$"];node(w);out skel 500;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    const data = await res.json();
    const nodes = (data.elements || [])
      .filter((e) => e.type === 'node')
      .map((e) => ({ lat: e.lat, lng: e.lon }));
    if (nodes.length) game.roadNodes = nodes;
    game.roadFetchState = 'done';
    if (process.env.DEBUG) console.log('[roads]', game.code, nodes.length, 'nœuds');
  } catch (e) {
    game.roadFetchState = 'failed'; // repli : points aléatoires
  }
}

function pickCachePos(game, ctr) {
  const inside = (p) => distM(p, ctr) <= ctr.r * 0.85;
  // pas de cache-cadeau : jamais à moins de 60 m d'un joueur en jeu
  const players = [...game.players.values()].filter((p) => !p.captured && p.pos);
  const farFromPlayers = (p) => players.every((pl) => distM(pl.pos, p) > 60);
  if (game.roadNodes && game.roadNodes.length) {
    const candidates = game.roadNodes.filter((p) => inside(p) && farFromPlayers(p));
    if (candidates.length) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  for (let i = 0; i < 10; i++) {
    const ang = Math.random() * 2 * Math.PI;
    const r = (0.25 + Math.random() * 0.6) * ctr.r;
    const p = offsetPos(ctr, Math.cos(ang) * r, Math.sin(ang) * r);
    if (farFromPlayers(p)) return p;
  }
  return null; // trop serré : on retentera au prochain créneau
}

function tickCaches(game, t, zone, catList) {
  game.caches = game.caches.filter((c) => c.expiresAt > t);

  // ramassage : premier joueur libre (chat ou souris) à moins de 20 m, GPS frais
  for (const cache of [...game.caches]) {
    const taker = [...game.players.values()].find(
      (p) => !p.captured && p.pos && t - p.posTs < 30_000 && distM(p.pos, cache) <= CACHE_COLLECT_M
    );
    if (taker) {
      taker.points += CACHE_VALUE_PTS;
      game.caches = game.caches.filter((c) => c.id !== cache.id);
      io.to(room(game)).emit('toast', { msg: `💰 ${taker.name} a ramassé un cache (+${CACHE_VALUE_PTS} pts) !` });
      logEvent(game, 'all', `💰 ${taker.name} a ramassé un cache (+${CACHE_VALUE_PTS} pts)`);
    }
  }

  const ctr = cacheCenter(game, zone, catList);
  if (!ctr) return;
  if (!game.roadFetchState) fetchRoadNodes(game, ctr);
  if (t >= game.nextCacheAt && game.caches.length < CACHE_MAX) {
    const pos = pickCachePos(game, ctr);
    if (pos) {
      game.caches.push({ id: game.cacheSeq++, lat: pos.lat, lng: pos.lng, expiresAt: t + CACHE_TTL_MS });
      io.to(room(game)).emit('toast', { msg: '💰 Un cache bonus vient d’apparaître sur la carte !' });
      logEvent(game, 'all', '💰 Un cache bonus est apparu sur la carte');
    }
    game.nextCacheAt = t + 75_000 + Math.random() * 75_000;
  }
}

function resolveCapture(game, mouseToken, accepted, why) {
  const pc = game.pendingCaptures.get(mouseToken);
  if (!pc) return;
  clearTimeout(pc.timer);
  game.pendingCaptures.delete(mouseToken);
  const t = Date.now();
  const cat = game.players.get(pc.catToken);
  const m = game.players.get(mouseToken);
  if (!m || !cat) return;
  if (accepted) {
    m.captured = true;
    cat.points += 40;
    io.to(room(game)).emit('captured', {
      name: m.name,
      remaining: freeMice(game).length,
    });
    logEvent(game, 'all', `🎯 ${m.name} a été capturé·e par ${cat.name} (+40 pts)`);
    emitTo(m, 'youCaptured', {});
    if (freeMice(game).length === 0) endGame(game, 'cat');
  } else {
    cat.captureCooldownUntil = t + CAPTURE_COOLDOWN_MS;
    // contesté = le chat s'est trompé → pénalité (pas de pénalité sur simple absence de réponse)
    if (why === 'refuse') cat.points = Math.max(0, cat.points - CAPTURE_PENALTY_PTS);
    emitTo(cat, 'captureResult', {
      ok: false,
      reason: why, // 'refuse' | 'timeout'
      name: m.name,
      cooldownMs: CAPTURE_COOLDOWN_MS,
    });
    logEvent(
      game,
      'cats',
      why === 'refuse'
        ? `❌ ${m.name} a contesté la capture de ${cat.name} (−${CAPTURE_PENALTY_PTS} pts)`
        : `⌛ ${m.name} n'a pas répondu à la capture de ${cat.name}`
    );
    emitTo(m, 'toast', { msg: 'Capture refusée, la partie continue.' });
  }
}

// ---------------------------------------------------------------- sockets

function ctx(socket) {
  const { code, token } = socket.data;
  const game = games.get(code);
  const player = game && game.players.get(token);
  return { game, player };
}

io.on('connection', (socket) => {
  socket.on('create', ({ name }, cb) => {
    // un client modifié qui omet l'ack ferait crasher le process sans ce garde
    if (typeof cb !== 'function') cb = () => {};
    name = String(name || '').trim().slice(0, 16);
    if (!name) return cb({ ok: false, error: 'Il te faut un pseudo.' });
    const code = makeCode();
    const token = makeToken();
    const game = {
      code,
      state: 'lobby',
      hostToken: token,
      catTokens: new Set(),
      durationMin: 30,
      graceSec: DEFAULT_GRACE_SEC,
      zoneCfg: 0,
      zone: null,
      cachesEnabled: true,
      caches: [],
      nextCacheAt: 0,
      cacheSeq: 1,
      roadNodes: null,
      roadFetchState: null,
      jamUntil: 0,
      log: [],
      powers: defaultPowers(),
      players: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      tick: null,
      pendingCaptures: new Map(), // mouseToken -> {catToken, timer}
      winner: null,
    };
    game.players.set(token, newPlayer(token, name, socket.id));
    games.set(code, game);
    socket.data = { code, token };
    socket.join(room(game));
    cb({ ok: true, code, token, snapshot: snapshot(game, game.players.get(token)) });
  });

  socket.on('join', ({ code, name }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 16);
    const game = games.get(code);
    if (!game) return cb({ ok: false, error: 'Partie introuvable. Vérifie le code.' });
    if (game.state !== 'lobby')
      return cb({ ok: false, error: 'La partie a déjà commencé.' });
    if (!name) return cb({ ok: false, error: 'Il te faut un pseudo.' });
    if (game.players.size >= 20) return cb({ ok: false, error: 'Partie pleine (20 max).' });
    let finalName = name;
    let i = 2;
    while ([...game.players.values()].some((p) => p.name === finalName)) {
      finalName = `${name}${i++}`;
    }
    const token = makeToken();
    game.players.set(token, newPlayer(token, finalName, socket.id));
    game.lastActivity = Date.now();
    socket.data = { code, token };
    socket.join(room(game));
    broadcastLobby(game);
    cb({ ok: true, code, token, snapshot: snapshot(game, game.players.get(token)) });
  });

  socket.on('rejoin', ({ code, token }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const game = games.get(String(code || '').toUpperCase());
    const player = game && game.players.get(token);
    if (!game || !player) return cb({ ok: false, error: 'Session expirée.' });
    player.socketId = socket.id;
    player.connected = true;
    socket.data = { code: game.code, token };
    socket.join(room(game));
    game.lastActivity = Date.now();
    broadcastLobby(game);
    cb({ ok: true, code: game.code, token, snapshot: snapshot(game, player) });
  });

  socket.on('leave', () => {
    const { game, player } = ctx(socket);
    if (!game || !player || game.state !== 'lobby') return;
    game.players.delete(player.token);
    socket.leave(room(game));
    socket.data = {};
    if (game.players.size === 0) {
      games.delete(game.code);
      return;
    }
    if (game.hostToken === player.token) {
      game.hostToken = [...game.players.keys()][0];
    }
    game.catTokens.delete(player.token);
    broadcastLobby(game);
  });

  socket.on('setCat', ({ target }) => {
    const { game, player } = ctx(socket);
    if (!game || !player || game.state !== 'lobby') return;
    if (player.token !== game.hostToken) return;
    if (!game.players.has(target)) return;
    // toggle : on peut désigner PLUSIEURS chats (mode multi-chats)
    if (game.catTokens.has(target)) game.catTokens.delete(target);
    else game.catTokens.add(target);
    broadcastLobby(game);
  });

  socket.on('setCaches', ({ on }) => {
    const { game, player } = ctx(socket);
    if (!game || !player || game.state !== 'lobby') return;
    if (player.token !== game.hostToken) return;
    game.cachesEnabled = !!on;
    broadcastLobby(game);
  });

  socket.on('setDuration', ({ min }) => {
    const { game, player } = ctx(socket);
    if (!game || !player || game.state !== 'lobby') return;
    if (player.token !== game.hostToken) return;
    if (![10, 15, 20, 30, 45, 60].includes(min)) return;
    game.durationMin = min;
    broadcastLobby(game);
  });

  socket.on('setGrace', ({ sec }) => {
    const { game, player } = ctx(socket);
    if (!game || !player || game.state !== 'lobby') return;
    if (player.token !== game.hostToken) return;
    if (typeof sec !== 'number' || !Number.isInteger(sec)) return;
    game.graceSec = Math.max(0, Math.min(300, sec));
    broadcastLobby(game);
  });

  socket.on('setZone', ({ radius }) => {
    const { game, player } = ctx(socket);
    if (!game || !player || game.state !== 'lobby') return;
    if (player.token !== game.hostToken) return;
    if (!ZONE_CHOICES.includes(radius)) return;
    game.zoneCfg = radius;
    broadcastLobby(game);
  });

  socket.on('setPowerCfg', ({ role, id, cost, dur, enabled }) => {
    const { game, player } = ctx(socket);
    if (!game || !player || game.state !== 'lobby') return;
    if (player.token !== game.hostToken) return;
    // Object.hasOwn : empêche d'atteindre les propriétés héritées (toString…)
    if (role !== 'cat' && role !== 'mouse') return;
    if (typeof id !== 'string' || !Object.hasOwn(game.powers[role], id)) return;
    const def = game.powers[role][id];
    if (Number.isInteger(cost)) def.cost = Math.max(0, Math.min(500, cost));
    if (Number.isInteger(dur) && def.dur > 0) def.dur = Math.max(5, Math.min(600, dur));
    if (typeof enabled === 'boolean') def.enabled = enabled;
    broadcastLobby(game);
  });

  socket.on('start', (cb) => {
    const { game, player } = ctx(socket);
    if (process.env.DEBUG)
      console.log('[start]', socket.id, 'data=', socket.data, 'game=', game && game.state, 'player=', player && player.name);
    if (!game || !player || game.state !== 'lobby') return cb && cb({ ok: false });
    if (player.token !== game.hostToken)
      return cb && cb({ ok: false, error: 'Seul l’hôte peut lancer.' });
    if (game.players.size < 2)
      return cb && cb({ ok: false, error: 'Il faut au moins 2 joueurs.' });
    game.catTokens = new Set([...game.catTokens].filter((tk) => game.players.has(tk)));
    if (game.catTokens.size >= game.players.size)
      return cb && cb({ ok: false, error: 'Il faut au moins une souris !' });
    startGame(game);
    cb && cb({ ok: true });
  });

  socket.on('pos', ({ lat, lng, acc }) => {
    const { game, player } = ctx(socket);
    if (!game || !player) return;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    player.pos = { lat, lng };
    player.posTs = Date.now();
    player.acc = typeof acc === 'number' ? Math.min(acc, 200) : null;
  });

  socket.on('declare', ({ target }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const { game, player } = ctx(socket);
    const t = Date.now();
    if (!game || !player || game.state !== 'playing') return cb({ ok: false });
    if (player.role !== 'cat') return cb({ ok: false });
    if (t < game.graceUntil) return cb({ ok: false, error: 'Attends la fin de la dispersion.' });
    if ([...game.pendingCaptures.values()].some((pc) => pc.catToken === player.token))
      return cb({ ok: false, error: 'Ta capture précédente attend encore une réponse.' });
    if (t < (player.captureCooldownUntil || 0))
      return cb({
        ok: false,
        error: 'Radar de capture en recharge.',
        cooldownMs: player.captureCooldownUntil - t,
      });
    const m = game.players.get(target);
    if (!m || m.role !== 'mouse' || m.captured) return cb({ ok: false });
    if (game.pendingCaptures.has(m.token))
      return cb({ ok: false, error: `${m.name} répond déjà à une autre capture.` });
    if (!m.connected)
      return cb({ ok: false, error: `${m.name} est déconnecté·e, impossible de valider.` });
    if (!player.pos || t - player.posTs > POS_FRESH_MS)
      return cb({ ok: false, error: 'Ton GPS n’est pas à jour.' });
    if (!m.pos || t - m.posTs > POS_FRESH_MS)
      return cb({ ok: false, error: `Le GPS de ${m.name} n’est pas à jour.` });

    const d = distM(player.pos, m.pos);
    const slack = Math.min(10, ((player.acc || 0) + (m.acc || 0)) / 2);
    if (d > CAPTURE_DIST_M + slack) {
      player.captureCooldownUntil = t + CAPTURE_COOLDOWN_MS;
      player.points = Math.max(0, player.points - CAPTURE_PENALTY_PTS);
      logEvent(game, 'cats', `📍 ${player.name} a déclaré trop loin de ${m.name} (−${CAPTURE_PENALTY_PTS} pts)`);
      return cb({
        ok: false,
        error: `Trop loin de ${m.name}. −${CAPTURE_PENALTY_PTS} pts, recharge 45 s.`,
        cooldownMs: CAPTURE_COOLDOWN_MS,
      });
    }
    game.pendingCaptures.set(m.token, {
      catToken: player.token,
      timer: setTimeout(() => resolveCapture(game, m.token, false, 'timeout'), PROMPT_TIMEOUT_MS),
    });
    emitTo(m, 'capturePrompt', { catName: player.name, timeoutMs: PROMPT_TIMEOUT_MS });
    cb({ ok: true, pending: true, name: m.name });
  });

  socket.on('captureAnswer', ({ accept }) => {
    const { game, player } = ctx(socket);
    if (!game || !player) return;
    if (!game.pendingCaptures.has(player.token)) return;
    resolveCapture(game, player.token, !!accept, accept ? 'accept' : 'refuse');
  });

  socket.on('power', ({ id, target, pos }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const { game, player } = ctx(socket);
    const t = Date.now();
    if (!game || !player || game.state !== 'playing') return cb({ ok: false });
    if (player.captured) return cb({ ok: false });
    if (t < game.graceUntil)
      return cb({ ok: false, error: 'Pas encore — dispersion en cours.' });
    const defs = game.powers[player.role];
    if (!defs || typeof id !== 'string' || !Object.hasOwn(defs, id))
      return cb({ ok: false });
    const def = defs[id];
    if (def.enabled === false)
      return cb({ ok: false, error: 'Pouvoir désactivé par l’hôte.' });
    if (player.points < def.cost)
      return cb({ ok: false, error: `Pas assez de points (${def.cost} requis).` });
    // un seul pouvoir à durée en cours à la fois : lisibilité avant tout
    if (def.dur > 0 && (player.powerLockUntil || 0) > t)
      return cb({
        ok: false,
        error: `${player.powerLockLabel} est encore actif (${Math.ceil((player.powerLockUntil - t) / 1000)} s). Un seul pouvoir à la fois !`,
      });

    let extra = {};

    if (player.role === 'cat') {
      if (id === 'ring' || id === 'reveal') {
        const m = game.players.get(target);
        if (!m || m.role !== 'mouse' || m.captured)
          return cb({ ok: false, error: 'Cible invalide.' });
        if (id === 'ring') {
          if (!m.connected) return cb({ ok: false, error: `${m.name} est déconnecté·e.` });
          emitTo(m, 'ring', { sec: def.dur || 10 });
          logEvent(game, m.token, '📢 Ton téléphone a été fait sonner');
          extra = { msg: `Le téléphone de ${m.name} sonne !` };
        } else {
          m.fx.reveal = t + def.dur * 1000;
          emitTo(m, 'toast', { msg: `🔍 Le chat t’a révélé·e : position précise visible ${def.dur} s !` });
          logEvent(game, m.token, `🔍 Révélé·e par ${player.name} (${def.dur} s)`);
          extra = { msg: `${m.name} est révélé·e pendant ${def.dur} s.` };
        }
      } else if (id === 'ghost') {
        player.fx.ghost = t + def.dur * 1000;
      } else if (id === 'fastping') {
        player.fx.fastping = t + def.dur * 1000;
        game.nextPingAt = Math.min(game.nextPingAt, t + 2000);
      } else if (id === 'net') {
        if (!player.pos) return cb({ ok: false, error: 'Ton GPS n’est pas prêt.' });
        const hits = freeMice(game)
          .filter((m) => m.pos && distM(player.pos, m.pos) <= 150)
          .map((m) => ({ name: m.name, lat: m.pos.lat, lng: m.pos.lng }));
        extra = { hits, msg: hits.length ? `${hits.length} souris dans le filet !` : 'Aucune souris à moins de 150 m.' };
      }
    } else {
      if (id === 'sense') player.fx.sense = t + def.dur * 1000;
      else if (id === 'team') player.fx.team = t + def.dur * 1000;
      else if (id === 'invis') player.fx.invis = t + def.dur * 1000;
      else if (id === 'jam') {
        // brouille le radar partagé de TOUS les chats
        game.jamUntil = t + def.dur * 1000;
        for (const c of cats(game)) emitTo(c, 'jamStart', { until: game.jamUntil });
        logEvent(game, 'cats', `⚡ Radar brouillé par une souris (${def.dur} s)`);
      } else if (id === 'fakefriend') {
        const m = game.players.get(target);
        if (!m || m.role !== 'mouse' || m.captured || m.token === player.token)
          return cb({ ok: false, error: 'Cible invalide.' });
        if (!m.connected) return cb({ ok: false, error: `${m.name} est déconnecté·e.` });
        emitTo(m, 'ring', { sec: def.dur || 10 });
        logEvent(game, m.token, '📢 Ton téléphone a été fait sonner');
        extra = { msg: `Le téléphone de ${m.name} sonne… le chat va l’adorer 😈` };
      } else if (id === 'decoy') {
        if (!player.pos) return cb({ ok: false, error: 'Ton GPS n’est pas prêt.' });
        if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number')
          return cb({ ok: false, error: 'Touche la carte pour placer ton leurre.' });
        if (Math.abs(pos.lat) > 90 || Math.abs(pos.lng) > 180)
          return cb({ ok: false, error: 'Position invalide.' });
        if (distM(player.pos, pos) > 1000)
          return cb({ ok: false, error: 'Trop loin de toi (1 km max).' });
        player.fx.decoy = { until: t + def.dur * 1000, lat: pos.lat, lng: pos.lng };
        extra = { msg: `Leurre posé pour ${def.dur} s.` };
      }
    }

    player.points -= def.cost;
    if (def.dur > 0) {
      player.powerLockUntil = t + def.dur * 1000;
      player.powerLockLabel = def.label;
    }
    logEvent(game, player.token, `⚡ Tu as utilisé ${def.label} (−${def.cost} pts)`);
    cb({ ok: true, you: youPayload(game, player, t), ...extra });
  });

  socket.on('disconnect', () => {
    const { game, player } = ctx(socket);
    if (!game || !player) return;
    player.connected = false;
    player.socketId = null;
    if (game.state === 'lobby') broadcastLobby(game);
  });
});

function newPlayer(token, name, socketId) {
  return {
    token,
    name,
    socketId,
    connected: true,
    role: 'mouse',
    pos: null,
    posTs: 0,
    acc: null,
    points: 0,
    captured: false,
    fx: {},
    lastContactAt: 0,
  };
}

// nettoyage des parties abandonnées
setInterval(() => {
  const t = Date.now();
  for (const [code, game] of games) {
    const anyConnected = [...game.players.values()].some((p) => p.connected);
    if (!anyConnected && t - game.lastActivity > 60 * 60_000) {
      if (game.tick) clearInterval(game.tick);
      games.delete(code);
    }
  }
}, 5 * 60_000);

server.listen(PORT, () => {
  console.log(`Chat Radar en écoute sur http://localhost:${PORT}`);
});
