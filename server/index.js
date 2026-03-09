/**
 * LIGHTSHOW SERVER — NL Regiment Edition
 *
 * New in this version:
 *   - SPARKLE: staggered per-fan torch delays for organic twinkling effect
 *   - IMAGE: director can upload images, server pushes data URL to all fans
 *   - Images stored in memory (no disk needed), capped at 20 per show
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
const MAX_IMAGE_KB  = 2048;  // 2 MB max per uploaded image

// ─────────────────────────────────────────────
//  EXPRESS + HTTP SERVER
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Multer: store uploads in memory as Buffer, 2 MB limit
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
// ─────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  perMessageDeflate: false,
  httpCompression:   false,
  maxHttpBufferSize: 4e6,  // 4 MB — needed for image data URL relay
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
      fans:          new Map(),   // socketId → { joinedAt, sector, device }
      directors:     new Set(),
      peakFans:      0,
      commandLog:    [],
      currentEffect: null,
      images:        [],          // [{ id, name, dataUrl, uploadedAt }]
      currentImage:  null,        // id of image currently displayed (or null)
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

function broadcastStats(show) {
  io.to(`directors:${show.id}`).emit('stats_update', showStats(show));
}

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
    joinedAt:  Date.now(),
    sector:    socket.handshake.query.sector || '0',
    device:    socket.handshake.query.device || 'unknown',
  });
  if (show.fans.size > show.peakFans) show.peakFans = show.fans.size;

  socket.join(`fans:${showId}`);
  socket.emit('show_state', showStats(show));

  // If a show is live and an image is currently displayed, send it immediately
  if (show.status === 'live' && show.currentImage) {
    const img = show.images.find(i => i.id === show.currentImage);
    if (img) socket.emit('command', { type: 'IMAGE', dataUrl: img.dataUrl, imageId: img.id });
  }

  broadcastStats(show);
  console.log(`[FAN]  +1 fan on "${showId}" (total: ${show.fans.size})`);

  socket.on('disconnect', () => {
    show.fans.delete(socket.id);
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
  console.log(`[DIR]  Director connected to show "${showId}"`);

  socket.emit('show_state', showStats(show));

  // Send image library to director on connect
  socket.emit('image_library', show.images.map(img => ({
    id:         img.id,
    name:       img.name,
    uploadedAt: img.uploadedAt,
    thumb:      img.dataUrl,  // director gets full data; fans only get it on push
  })));

  // ── SHOW CONTROL ──
  socket.on('start_show', () => {
    show.status    = 'live';
    show.startedAt = Date.now();
    io.of('/fan').to(`fans:${showId}`).emit('command', { type: 'SHOW_START' });
    logCommand(show, 'SHOW_START', {});
    broadcastStats(show);
    console.log(`[SHOW] "${showId}" started`);
  });

  socket.on('end_show', () => {
    show.status       = 'standby';
    show.currentImage = null;
    io.of('/fan').to(`fans:${showId}`).emit('command', { type: 'SHOW_END' });
    logCommand(show, 'SHOW_END', {});
    broadcastStats(show);
    console.log(`[SHOW] "${showId}" ended`);
  });

  // ── EFFECT COMMANDS ──
  socket.on('fire_effect', (cmd) => {
    if (!cmd || !cmd.type) return;
    let safe;
    try { safe = sanitizeCommand(cmd); } catch(e) { return; }

    show.currentEffect = safe.type;
    show.currentImage  = null;  // clear image when effect fires

    if (safe.type === 'WAVE') {
      // Per-fan sector delay
      show.fans.forEach((fanData, fanSocketId) => {
        const sector = parseInt(fanData.sector) || 0;
        const delay  = sector * (safe.sectorDelay || 80);
        fanNS.to(fanSocketId).emit('command', { ...safe, delay });
      });

    } else if (safe.type === 'SPARKLE') {
      // ── STAGGERED SPARKLE ──
      // Each fan gets a unique random torch schedule:
      //   - flickerDelay:    when their first flicker starts (0–sparkleWindow ms)
      //   - flickerCount:    how many times their torch fires (2–8)
      //   - flickerInterval: ms between their own flickers (150–500ms)
      //   - flickerDuration: how long each torch-on lasts (40–120ms)
      // This creates organic, crowd-wide twinkling rather than one sync burst.
      const sparkleWindow = safe.duration || 6000;

      show.fans.forEach((fanData, fanSocketId) => {
        const flickerDelay    = Math.floor(Math.random() * sparkleWindow * 0.85);
        const flickerCount    = 2 + Math.floor(Math.random() * 7);    // 2–8 flickers
        const flickerInterval = 150 + Math.floor(Math.random() * 350); // 150–500ms apart
        const flickerDuration = 40  + Math.floor(Math.random() * 80);  // 40–120ms on

        fanNS.to(fanSocketId).emit('command', {
          ...safe,
          flickerDelay,
          flickerCount,
          flickerInterval,
          flickerDuration,
        });
      });

    } else {
      io.of('/fan').to(`fans:${showId}`).emit('command', safe);
    }

    logCommand(show, safe.type, safe);
    broadcastStats(show);
  });

  // ── IMAGE PUSH ──
  // Director sends: { imageId } to push an already-uploaded image to all fans
  socket.on('push_image', ({ imageId, fit, bgColor }) => {
    const img = show.images.find(i => i.id === imageId);
    if (!img) return;
    show.currentEffect = 'IMAGE';
    show.currentImage  = imageId;
    io.of('/fan').to(`fans:${showId}`).emit('command', {
      type:     'IMAGE',
      dataUrl:  img.dataUrl,
      imageId,
      fit:      fit || 'cover',     // cover | contain | fill
      bgColor:  bgColor || '#000000',
    });
    logCommand(show, 'IMAGE', { imageId, name: img.name });
    broadcastStats(show);
    console.log(`[IMG]  Pushed "${img.name}" to "${showId}"`);
  });

  // ── IMAGE CLEAR ──
  socket.on('clear_image', () => {
    show.currentImage  = null;
    show.currentEffect = 'BLACKOUT';
    io.of('/fan').to(`fans:${showId}`).emit('command', { type: 'BLACKOUT' });
    logCommand(show, 'BLACKOUT', {});
    broadcastStats(show);
  });

  // ── DELETE IMAGE from library ──
  socket.on('delete_image', ({ imageId }) => {
    show.images = show.images.filter(i => i.id !== imageId);
    if (show.currentImage === imageId) show.currentImage = null;
    // Notify all directors of updated library
    io.to(`directors:${showId}`).emit('image_library', show.images.map(img => ({
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
      const gap = cue.gap || 1500;

      if (safe.type === 'SPARKLE') {
        const sparkleWindow = safe.duration || 6000;
        show.fans.forEach((fanData, fanSocketId) => {
          fanNS.to(fanSocketId).emit('command', {
            ...safe,
            flickerDelay:    Math.floor(Math.random() * sparkleWindow * 0.85),
            flickerCount:    2 + Math.floor(Math.random() * 7),
            flickerInterval: 150 + Math.floor(Math.random() * 350),
            flickerDuration: 40  + Math.floor(Math.random() * 80),
          });
        });
      } else {
        io.of('/fan').to(`fans:${showId}`).emit('command', safe);
      }

      logCommand(show, safe.type, safe);
      broadcastStats(show);
      await sleep(gap);
    }
  });

  socket.on('disconnect', () => {
    show.directors.delete(socket.id);
    console.log(`[DIR]  Director disconnected from "${showId}"`);
  });
});

// ─────────────────────────────────────────────
//  IMAGE UPLOAD REST ENDPOINT
//  POST /api/upload/:showId
//  Multipart form: field "image"
// ─────────────────────────────────────────────
app.post('/api/upload/:showId', (req, res, next) => {
  // Verify director password in Authorization header or query
  const pass = req.headers['x-director-pass'] || req.query.pass;
  if (pass !== DIRECTOR_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}, upload.single('image'), (req, res) => {
  const showId = req.params.showId;
  const show   = getOrCreateShow(showId);

  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  // Cap library at 20 images per show (remove oldest)
  if (show.images.length >= 20) show.images.shift();

  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const imageId = `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

  const entry = {
    id:         imageId,
    name:       req.file.originalname,
    mimetype:   req.file.mimetype,
    size:       req.file.size,
    dataUrl,
    uploadedAt: Date.now(),
  };

  show.images.push(entry);
  console.log(`[IMG]  Uploaded "${entry.name}" (${Math.round(entry.size/1024)}KB) to "${showId}"`);

  // Notify all connected directors of updated library
  io.to(`directors:${showId}`).emit('image_library', show.images.map(img => ({
    id: img.id, name: img.name, uploadedAt: img.uploadedAt, thumb: img.dataUrl,
  })));

  res.json({ id: imageId, name: entry.name, size: entry.size });
});

// ─────────────────────────────────────────────
//  REST ENDPOINTS
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', shows: shows.size, uptime: process.uptime() });
});

app.get('/api/qr/:showId', async (req, res) => {
  try {
    const fanUrl = `${PUBLIC_URL}/fan.html?showId=${req.params.showId}`;
    const qr     = await QRCode.toDataURL(fanUrl, {
      width: 300, margin: 2,
      color: { dark: '#0A2334', light: '#ffffff' }
    });
    res.json({ url: fanUrl, qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

function isValidHex(hex) {
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex);
}

function clamp(val, min, max) {
  const n = parseInt(val);
  return isNaN(n) ? min : Math.min(max, Math.max(min, n));
}

function logCommand(show, type, cmd) {
  show.commandLog.unshift({ type, cmd, t: Date.now() });
  if (show.commandLog.length > 50) show.commandLog.pop();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏟️  NL REGIMENT LIGHTSHOW SERVER`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Public:   ${PUBLIC_URL}`);
  console.log(`   Director: ${PUBLIC_URL}/director.html`);
  console.log(`   Fan page: ${PUBLIC_URL}/fan.html`);
  console.log(`   Password: ${DIRECTOR_PASS}\n`);
});
