/**
 * LIGHTSHOW SERVER
 * Real-time stadium lightshow controller using Socket.IO
 *
 * Architecture:
 *   - Directors connect to /director namespace (password protected)
 *   - Fans connect to /fan namespace (public)
 *   - Each "show" is a room. Multiple shows can run simultaneously.
 *   - Server relays commands from directors → all fans in that show room
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const cors       = require('cors');
const QRCode     = require('qrcode');

// ─────────────────────────────────────────────
//  CONFIG  (override with environment variables)
// ─────────────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const DIRECTOR_PASS  = process.env.DIRECTOR_PASS  || 'stadium2024';
const PUBLIC_URL     = process.env.PUBLIC_URL      || `http://localhost:${PORT}`;
const MAX_FANS       = parseInt(process.env.MAX_FANS || '50000');

// ─────────────────────────────────────────────
//  EXPRESS + HTTP SERVER
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─────────────────────────────────────────────
//  SOCKET.IO
// ─────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',   // tighten this to your domain in production
    methods: ['GET', 'POST']
  },
  // Tune for low-latency: disable compression for small messages
  perMessageDeflate: false,
  httpCompression:   false,
});

// ─────────────────────────────────────────────
//  SHOW STATE
// ─────────────────────────────────────────────
const shows = new Map();  // showId → ShowState

function getOrCreateShow(showId) {
  if (!shows.has(showId)) {
    shows.set(showId, {
      id:          showId,
      status:      'standby',   // standby | live | ended
      startedAt:   null,
      fans:        new Map(),   // socketId → { joinedAt, userAgent, device }
      directors:   new Set(),   // socketIds
      peakFans:    0,
      commandLog:  [],          // last 50 commands
      currentEffect: null,
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
  };
}

// Broadcast updated stats to all directors in a show
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

  // Reject if too many fans
  if (show.fans.size >= MAX_FANS) {
    socket.emit('error', { code: 'CAPACITY', message: 'Show is at capacity' });
    socket.disconnect();
    return;
  }

  // Register fan
  show.fans.set(socket.id, {
    joinedAt:  Date.now(),
    userAgent: socket.handshake.headers['user-agent'] || '',
    device:    socket.handshake.query.device || 'unknown',
    sector:    socket.handshake.query.sector || '0',  // stadium section (for waves)
  });
  if (show.fans.size > show.peakFans) show.peakFans = show.fans.size;

  socket.join(`fans:${showId}`);

  // Send current show state to the newly connected fan
  socket.emit('show_state', {
    status:        show.status,
    currentEffect: show.currentEffect,
  });

  console.log(`[FAN]  +1 joined show "${showId}" | Total: ${show.fans.size}`);
  broadcastStats(show);

  socket.on('disconnect', () => {
    show.fans.delete(socket.id);
    console.log(`[FAN]  -1 left show "${showId}"  | Total: ${show.fans.size}`);
    broadcastStats(show);
  });
});

// ─────────────────────────────────────────────
//  DIRECTOR NAMESPACE  /director
// ─────────────────────────────────────────────
const directorNS = io.of('/director');

// Auth middleware
directorNS.use((socket, next) => {
  const pass = socket.handshake.auth.password;
  if (pass !== DIRECTOR_PASS) {
    return next(new Error('UNAUTHORIZED'));
  }
  next();
});

directorNS.on('connection', (socket) => {
  const showId = socket.handshake.query.showId || 'default';
  const show   = getOrCreateShow(showId);

  show.directors.add(socket.id);
  socket.join(`directors:${showId}`);

  console.log(`[DIR]  Director connected to show "${showId}"`);

  // Send current state
  socket.emit('show_state', showStats(show));

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
    show.status        = 'standby';
    show.currentEffect = null;
    io.of('/fan').to(`fans:${showId}`).emit('command', { type: 'SHOW_END' });
    logCommand(show, 'SHOW_END', {});
    broadcastStats(show);
    console.log(`[SHOW] "${showId}" ended`);
  });

  // ── EFFECT COMMANDS ──
  // Director sends: { type, color, duration, interval, ... }
  socket.on('fire_effect', (cmd) => {
    if (!cmd || !cmd.type) return;

    // Sanitize
    const safe = sanitizeCommand(cmd);
    show.currentEffect = safe.type;

    // For WAVE: attach per-fan sector delays
    if (safe.type === 'WAVE') {
      // Emit to each fan with their sector-based delay
      show.fans.forEach((fanData, fanSocketId) => {
        const sector = parseInt(fanData.sector) || 0;
        const delay  = sector * (safe.sectorDelay || 80); // ms per sector
        fanNS.to(fanSocketId).emit('command', { ...safe, delay });
      });
    } else {
      io.of('/fan').to(`fans:${showId}`).emit('command', safe);
    }

    logCommand(show, safe.type, safe);
    broadcastStats(show);
  });

  // ── SEQUENCE (director sends pre-timed sequence) ──
  socket.on('run_sequence', async (sequence) => {
    if (!Array.isArray(sequence)) return;
    console.log(`[SEQ]  Running sequence of ${sequence.length} cues`);
    // Server-side sequencing ensures all fans are perfectly synced
    for (const cue of sequence) {
      const safe = sanitizeCommand(cue);
      const gap  = cue.gap || 1500;
      io.of('/fan').to(`fans:${showId}`).emit('command', safe);
      logCommand(show, safe.type, safe);
      broadcastStats(show);
      await sleep(gap);
    }
  });

  socket.on('disconnect', () => {
    show.directors.delete(socket.id);
    console.log(`[DIR]  Director disconnected from show "${showId}"`);
  });
});

// ─────────────────────────────────────────────
//  REST ENDPOINTS
// ─────────────────────────────────────────────

// Health check (used by Railway / Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', shows: shows.size, uptime: process.uptime() });
});

// Generate QR code for a show's fan page
app.get('/api/qr/:showId', async (req, res) => {
  try {
    const fanUrl = `${PUBLIC_URL}/fan?showId=${req.params.showId}`;
    const qr     = await QRCode.toDataURL(fanUrl, {
      width:  300,
      margin: 2,
      color:  { dark: '#000000', light: '#ffffff' }
    });
    res.json({ url: fanUrl, qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Show stats API
app.get('/api/show/:showId', (req, res) => {
  const show = shows.get(req.params.showId);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  res.json(showStats(show));
});

// List all shows
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
    duration:    clamp(cmd.duration,   50,  30000),
    interval:    clamp(cmd.interval,   40,  2000),
    sectorDelay: clamp(cmd.sectorDelay, 0,  500),
    delay:       clamp(cmd.delay,       0,  10000),
    t:           Date.now(),   // server timestamp for client-side sync
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
server.listen(PORT, () => {
  console.log(`\n🏟️  LIGHTSHOW SERVER RUNNING`);
  console.log(`   Local:      http://localhost:${PORT}`);
  console.log(`   Public URL: ${PUBLIC_URL}`);
  console.log(`   Director:   ${PUBLIC_URL}/director`);
  console.log(`   Fan page:   ${PUBLIC_URL}/fan`);
  console.log(`   Password:   ${DIRECTOR_PASS}\n`);
});
