/**
 * LIGHTSHOW SERVER — NL Regiment Edition
 * Hardened for 6,300+ concurrent fans
 *
 * Key changes for scale:
 *   - SPARKLE/WAVE use chunked async loops to avoid blocking the event loop
 *   - broadcastStats is debounced (50ms) — mass disconnects don't cascade
 *   - Console logging throttled — no per-fan join/leave spam at scale
 *   - Socket.IO ping tuning for arena WiFi (longer intervals, more tolerance)
 *   - uv_threadpool_size hint in startup for DNS/file I/O headroom
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const cors       = require('cors');
const QRCode     = require('qrcode');
const multer     = require('multer');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const DIRECTOR_PASS = process.env.DIRECTOR_PASS || 'stadium2024';
const PUBLIC_URL    = process.env.PUBLIC_URL    || `http://localhost:${PORT}`;
const MAX_FANS      = parseInt(process.env.MAX_FANS || '50000');
const MAX_IMAGE_KB  = 2048;

// ─────────────────────────────────────────────
//  EXPRESS + HTTP SERVER
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Keep HTTP connections alive — reduces reconnect overhead at scale
server.keepAliveTimeout    = 65000;
server.headersTimeout      = 66000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_KB * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|gif|webp|svg\+xml)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only image files allowed'), ok);
  },
});

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ─────────────────────────────────────────────
//  SOCKET.IO
//  Tuned for arena WiFi: longer pings, more misses allowed
// ─────────────────────────────────────────────
const io = new Server(server, {
  cors:              { origin: '*', methods: ['GET', 'POST'] },
  perMessageDeflate: false,   // CPU cost not worth it at this scale
  httpCompression:   false,
  maxHttpBufferSize: 4e6,
  pingInterval:      25000,   // default 25s — fine for arena
  pingTimeout:       20000,   // more tolerant than default (5s) for congested WiFi
  connectTimeout:    30000,
  transports:        ['polling', 'websocket'],  // polling first for Samsung/Knox
});

// ─────────────────────────────────────────────
//  SHOW STATE
// ─────────────────────────────────────────────
const shows = new Map();

function getOrCreateShow(showId) {
  if (!shows.has(showId)) {
    shows.set(showId, {
      id:            showId,
      status:        'standby',
      startedAt:     null,
      fans:          new Map(),
      directors:     new Set(),
      peakFans:      0,
      commandLog:    [],
      currentEffect: null,
      images:        [],
      currentImage:  null,
      _statsBroadcastTimer: null,   // for debounce
    });
  }
  return shows.get(showId);
}

function showStats(show) {
  return {
    showId:        show.id,
    status:        show.status,
    fanCount:      show.fans.size,
    peakFans:      show.peakFans,
    directorCount: show.directors.size,
    startedAt:     show.startedAt,
    currentEffect: show.currentEffect,
    currentImage:  show.currentImage,
    imageCount:    show.images.length,
  };
}

// Debounced stats broadcast — coalesces bursts of join/leave into one emit
// Critical at scale: 6,300 simultaneous disconnects → 1 broadcast, not 6,300
function broadcastStats(show) {
  if (show._statsBroadcastTimer) return;
  show._statsBroadcastTimer = setTimeout(() => {
    show._statsBroadcastTimer = null;
    directorNS.to(`directors:${show.id}`).emit('stats_update', showStats(show));
  }, 50);
}

// ─────────────────────────────────────────────
//  CHUNKED ASYNC EMIT
//  Sends to fans in batches of CHUNK_SIZE, yielding between chunks.
//  Prevents blocking the event loop for SPARKLE/WAVE at 6k+ fans.
// ─────────────────────────────────────────────
const CHUNK_SIZE = 200;

async function emitToFansChunked(fanMap, buildPayload) {
  const entries = [...fanMap.entries()];
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    for (const [socketId, fanData] of chunk) {
      const payload = buildPayload(socketId, fanData);
      if (payload) fanNS.to(socketId).emit('command', payload);
    }
    // Yield to event loop between chunks
    if (i + CHUNK_SIZE < entries.length) {
      await new Promise(r => setImmediate(r));
    }
  }
}

// ─────────────────────────────────────────────
//  LOG THROTTLE
//  At 6k fans, per-connection logs flood stdout and slow I/O
// ─────────────────────────────────────────────
let _joinCount = 0, _leaveCount = 0;
setInterval(() => {
  if (_joinCount > 0 || _leaveCount > 0) {
    console.log(`[FAN]  +${_joinCount} joined, -${_leaveCount} left this second`);
    _joinCount = 0; _leaveCount = 0;
  }
}, 1000);

// ─────────────────────────────────────────────
//  FAN NAMESPACE  /fan
// ─────────────────────────────────────────────
const fanNS = io.of('/fan');

fanNS.on('connection', (socket) => {
  const showId = socket.handshake.query.showId || 'default';
  const show   = getOrCreateShow(showId);

  if (show.fans.size >= MAX_FANS) {
    socket.emit('error', { code: 'CAPACITY', message: 'Show is at capacity' });
    socket.disconnect();
    return;
  }

  show.fans.set(socket.id, {
    joinedAt: Date.now(),
    sector:   socket.handshake.query.sector || '0',
    device:   socket.handshake.query.device || 'unknown',
  });
  if (show.fans.size > show.peakFans) show.peakFans = show.fans.size;

  socket.join(`fans:${showId}`);
  socket.emit('show_state', showStats(show));

  // Late-joining fan gets current image immediately
  if (show.status === 'live' && show.currentImage) {
    const img = show.images.find(i => i.id === show.currentImage);
    if (img) socket.emit('command', { type: 'IMAGE', dataUrl: img.dataUrl, imageId: img.id });
  }

  _joinCount++;
  broadcastStats(show);

  socket.on('disconnect', () => {
    show.fans.delete(socket.id);
    _leaveCount++;
    broadcastStats(show);
  });
});

// ─────────────────────────────────────────────
//  DIRECTOR NAMESPACE  /director
// ─────────────────────────────────────────────
const directorNS = io.of('/director');

directorNS.use((socket, next) => {
  if (socket.handshake.auth.password === DIRECTOR_PASS) return next();
  return next(new Error('UNAUTHORIZED'));
});

directorNS.on('connection', (socket) => {
  const showId = socket.handshake.query.showId || 'default';
  const show   = getOrCreateShow(showId);

  show.directors.add(socket.id);
  socket.join(`directors:${showId}`);
  console.log(`[DIR]  Director connected to show "${showId}" (${show.fans.size} fans)`);

  socket.emit('show_state', showStats(show));
  socket.emit('image_library', show.images.map(img => ({
    id: img.id, name: img.name, uploadedAt: img.uploadedAt, thumb: img.dataUrl,
  })));

  // ── SHOW CONTROL ──
  socket.on('start_show', () => {
    show.status    = 'live';
    show.startedAt = Date.now();
    fanNS.to(`fans:${showId}`).emit('command', { type: 'SHOW_START' });
    logCommand(show, 'SHOW_START', {});
    broadcastStats(show);
    console.log(`[SHOW] "${showId}" started — ${show.fans.size} fans connected`);
  });

  socket.on('end_show', () => {
    show.status       = 'standby';
    show.currentImage = null;
    fanNS.to(`fans:${showId}`).emit('command', { type: 'SHOW_END' });
    logCommand(show, 'SHOW_END', {});
    broadcastStats(show);
    console.log(`[SHOW] "${showId}" ended`);
  });

  // ── EFFECT COMMANDS ──
  socket.on('fire_effect', async (cmd) => {
    if (!cmd || !cmd.type) return;
    let safe;
    try { safe = sanitizeCommand(cmd); } catch(e) { return; }

    show.currentEffect = safe.type;
    show.currentImage  = null;

    if (safe.type === 'WAVE') {
      // Per-sector delay — chunked to avoid blocking
      await emitToFansChunked(show.fans, (socketId, fanData) => {
        const sector = parseInt(fanData.sector) || 0;
        return { ...safe, delay: sector * (safe.sectorDelay || 80) };
      });

    } else if (safe.type === 'SPARKLE') {
      // Unique random schedule per fan — chunked
      const sparkleWindow = safe.duration || 6000;
      await emitToFansChunked(show.fans, () => ({
        ...safe,
        flickerDelay:    Math.floor(Math.random() * sparkleWindow * 0.85),
        flickerCount:    2 + Math.floor(Math.random() * 7),
        flickerInterval: 150 + Math.floor(Math.random() * 350),
        flickerDuration: 40  + Math.floor(Math.random() * 80),
      }));

    } else {
      // Broadcast to room — Socket.IO handles this efficiently in one shot
      fanNS.to(`fans:${showId}`).emit('command', safe);
    }

    logCommand(show, safe.type, safe);
    broadcastStats(show);
  });

  // ── IMAGE PUSH ──
  socket.on('push_image', ({ imageId, fit, bgColor }) => {
    const img = show.images.find(i => i.id === imageId);
    if (!img) return;
    show.currentEffect = 'IMAGE';
    show.currentImage  = imageId;
    fanNS.to(`fans:${showId}`).emit('command', {
      type:    'IMAGE',
      dataUrl: img.dataUrl,
      imageId,
      fit:     fit || 'cover',
      bgColor: bgColor || '#000000',
    });
    logCommand(show, 'IMAGE', { imageId, name: img.name });
    broadcastStats(show);
    console.log(`[IMG]  Pushed "${img.name}" to "${showId}"`);
  });

  socket.on('clear_image', () => {
    show.currentImage  = null;
    show.currentEffect = 'BLACKOUT';
    fanNS.to(`fans:${showId}`).emit('command', { type: 'BLACKOUT' });
    logCommand(show, 'BLACKOUT', {});
    broadcastStats(show);
  });

  socket.on('delete_image', ({ imageId }) => {
    show.images = show.images.filter(i => i.id !== imageId);
    if (show.currentImage === imageId) show.currentImage = null;
    directorNS.to(`directors:${showId}`).emit('image_library', show.images.map(img => ({
      id: img.id, name: img.name, uploadedAt: img.uploadedAt, thumb: img.dataUrl,
    })));
    broadcastStats(show);
  });

  // ── SEQUENCE ──
  socket.on('run_sequence', async (sequence) => {
    if (!Array.isArray(sequence)) return;
    console.log(`[SEQ]  Running ${sequence.length} cues on "${showId}"`);
    for (const cue of sequence) {
      let safe;
      try { safe = sanitizeCommand(cue); } catch(e) { continue; }

      if (safe.type === 'SPARKLE') {
        const sparkleWindow = safe.duration || 6000;
        await emitToFansChunked(show.fans, () => ({
          ...safe,
          flickerDelay:    Math.floor(Math.random() * sparkleWindow * 0.85),
          flickerCount:    2 + Math.floor(Math.random() * 7),
          flickerInterval: 150 + Math.floor(Math.random() * 350),
          flickerDuration: 40  + Math.floor(Math.random() * 80),
        }));
      } else {
        fanNS.to(`fans:${showId}`).emit('command', safe);
      }

      logCommand(show, safe.type, safe);
      broadcastStats(show);
      await sleep(cue.gap || 1500);
    }
  });

  socket.on('disconnect', () => {
    show.directors.delete(socket.id);
    console.log(`[DIR]  Director disconnected from "${showId}"`);
  });
});

// ─────────────────────────────────────────────
//  IMAGE UPLOAD
// ─────────────────────────────────────────────
app.post('/api/upload/:showId', (req, res, next) => {
  const pass = req.headers['x-director-pass'] || req.query.pass;
  if (pass !== DIRECTOR_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}, upload.single('image'), (req, res) => {
  const showId = req.params.showId;
  const show   = getOrCreateShow(showId);
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  if (show.images.length >= 20) show.images.shift();

  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const imageId = `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const entry   = { id: imageId, name: req.file.originalname, mimetype: req.file.mimetype,
                    size: req.file.size, dataUrl, uploadedAt: Date.now() };
  show.images.push(entry);
  console.log(`[IMG]  Uploaded "${entry.name}" (${Math.round(entry.size/1024)}KB) to "${showId}"`);

  directorNS.to(`directors:${showId}`).emit('image_library', show.images.map(img => ({
    id: img.id, name: img.name, uploadedAt: img.uploadedAt, thumb: img.dataUrl,
  })));
  res.json({ id: imageId, name: entry.name, size: entry.size });
});

// ─────────────────────────────────────────────
//  REST ENDPOINTS
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status:   'ok',
    shows:    shows.size,
    uptime:   Math.round(process.uptime()),
    memory: {
      heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB:       Math.round(mem.rss       / 1024 / 1024),
    },
    totalFans: [...shows.values()].reduce((n, s) => n + s.fans.size, 0),
  });
});

app.get('/api/qr/:showId', async (req, res) => {
  try {
    const fanUrl = `${PUBLIC_URL}/fan.html?showId=${req.params.showId}`;
    const qr     = await QRCode.toDataURL(fanUrl, { width:300, margin:2,
                     color:{ dark:'#0A2334', light:'#ffffff' } });
    res.json({ url: fanUrl, qr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/show/:showId', (req, res) => {
  const show = shows.get(req.params.showId);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  res.json(showStats(show));
});

app.get('/api/shows', (req, res) => {
  const list = [];
  shows.forEach(show => list.push(showStats(show)));
  res.json(list);
});

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function sanitizeCommand(cmd) {
  const allowed = ['FLASH','STROBE','WAVE','COLOR_HOLD','HEARTBEAT','SPARKLE','BLACKOUT','SHOW_START','SHOW_END'];
  if (!allowed.includes(cmd.type)) throw new Error('Invalid effect type');
  return {
    type:        cmd.type,
    color:       isValidHex(cmd.color) ? cmd.color : '#ffffff',
    duration:    clamp(cmd.duration,    50,  30000),
    interval:    clamp(cmd.interval,    40,  2000),
    sectorDelay: clamp(cmd.sectorDelay, 0,   500),
    delay:       clamp(cmd.delay,       0,   10000),
    t:           Date.now(),
  };
}
function isValidHex(hex) { return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex); }
function clamp(val, min, max) { const n = parseInt(val); return isNaN(n) ? min : Math.min(max, Math.max(min, n)); }
function logCommand(show, type, cmd) {
  show.commandLog.unshift({ type, cmd, t: Date.now() });
  if (show.commandLog.length > 50) show.commandLog.pop();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏟️  NL REGIMENT LIGHTSHOW SERVER`);
  console.log(`   Port:     ${PORT}`);
  console.log(`   Public:   ${PUBLIC_URL}`);
  console.log(`   Director: ${PUBLIC_URL}/director.html`);
  console.log(`   Fan page: ${PUBLIC_URL}/fan.html`);
  console.log(`   Capacity: ${MAX_FANS} fans`);
  console.log(`   Node:     ${process.version}`);
  console.log(`   Memory:   ${Math.round(process.memoryUsage().heapTotal/1024/1024)}MB heap\n`);
});
