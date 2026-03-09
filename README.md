# 🏟️ LIGHTSHOW — Deployment Guide

A real-time stadium lightshow system. Fans join via QR code, directors control effects from a web dashboard. Built on Node.js + Socket.IO.

---

## Project Structure

```
lightshow/
├── server/
│   └── index.js          ← WebSocket + REST server
├── public/
│   ├── fan.html           ← Fan-facing mobile page (served to audience)
│   └── director.html      ← Director control panel
├── package.json
├── .env.example           ← Copy to .env and fill in
└── .gitignore
```

---

## Local Development (Test on Your Machine)

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Edit .env — set your DIRECTOR_PASS
```

### 3. Start the server
```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 4. Open the pages
- **Director:** http://localhost:3000/director.html
- **Fan:**      http://localhost:3000/fan.html?showId=default

### 5. Test on a real phone (local network)
Find your computer's local IP (e.g. `192.168.1.42`):
```bash
# Mac/Linux
ipconfig getifaddr en0

# Windows
ipconfig
```
Then on your phone, open: `http://192.168.1.42:3000/fan.html?showId=default`

---

## 🚀 Deploy to Railway (Recommended — ~$5/month)

Railway is the easiest way to get a live server. Takes about 10 minutes.

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "Initial lightshow server"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/lightshow.git
git push -u origin main
```

### Step 2: Deploy on Railway
1. Go to **https://railway.app** → Sign up (free)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `lightshow` repository
4. Railway will detect Node.js and deploy automatically

### Step 3: Set Environment Variables
In Railway dashboard → your project → **Variables** tab:
```
PORT           = (Railway sets this automatically — do not set)
PUBLIC_URL     = https://YOUR-APP.up.railway.app
DIRECTOR_PASS  = YourSecurePassword123
MAX_FANS       = 50000
```

### Step 4: Get your live URL
Railway gives you a URL like: `https://lightshow-production.up.railway.app`

- **Director:** `https://lightshow-production.up.railway.app/director.html`
- **Fan:**      `https://lightshow-production.up.railway.app/fan.html?showId=default`

The QR code on the director page will update automatically to point to the fan URL.

---

## 🚀 Alternative: Deploy to Render (Also Free Tier)

1. Go to **https://render.com** → Sign up
2. Click **"New Web Service"** → Connect GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add the same environment variables as above
5. Deploy → get your `.onrender.com` URL

> ⚠️ Render's free tier spins down after 15 min of inactivity. Use Railway for live events.

---

## 📱 How Fans Join

1. Fan scans QR code on videoboard
2. Browser opens: `https://your-server.com/fan.html?showId=default`
3. Fan taps **"Join the Show"** → grants camera permission
4. Fan's phone connects to the server and waits
5. When director fires an effect, all fans react simultaneously

### URL Parameters for Fan Page
| Parameter | Description | Example |
|-----------|-------------|---------|
| `showId`  | Which show to join | `showId=game1` |
| `sector`  | Stadium section (for wave effect) | `sector=4` |

**Pro tip for wave effect:** Assign QR codes per stadium section and embed the sector number:
```
Section A: /fan.html?showId=game1&sector=0
Section B: /fan.html?showId=game1&sector=1
Section C: /fan.html?showId=game1&sector=2
...etc
```

---

## 🎮 Director Controls

### Login
- Go to `/director.html`
- Enter the **Show ID** (default: `default`) and **password** from your `.env`

### Effects
| Effect | Shortcut | Description |
|--------|----------|-------------|
| Flash | F | Single simultaneous burst |
| Strobe | S | Rapid strobe — configure speed & duration in params |
| Color Hold | H | Hold screens on color until next command |
| Wave | W | Rolling wave using stadium sections |
| Heartbeat | B | Double-thump pulse rhythm |
| Blackout | X | Kill all lights immediately |

### Sequence Builder
- **Right-click** any effect button to add it to the sequence queue
- **LOCAL RUN** — director fires each cue with a gap; good for rehearsal
- **SERVER SYNC** — sends entire sequence to server for tighter synchronization
- **LOOP** — repeat the sequence continuously

### Multiple Shows
Run separate shows simultaneously with different Show IDs:
- Director A: `/director.html` → Show ID: `court1`
- Director B: `/director.html` → Show ID: `court2`
- Fans scan QR for their respective show

---

## 🔧 Scaling for Large Events

For 10,000+ simultaneous fans, standard Railway/Render will handle it fine. For 50,000+:

### Use a Managed Redis Adapter (Socket.IO clustering)
```bash
npm install @socket.io/redis-adapter redis
```
Add to `server/index.js`:
```js
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient }  = require('redis');
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));
```
Then provision a Redis instance on Railway (free tier available).

### Latency
Socket.IO + WebSockets typically deliver commands in **50–150ms**. For tighter sync (e.g. music-synced beats), implement a clock-sync step:
1. Server sends a `sync` command with its timestamp
2. Client measures round-trip and computes offset
3. Commands include a `fireAt` timestamp; client fires at the exact moment

---

## 🔐 Security Checklist Before Going Live

- [ ] Change `DIRECTOR_PASS` to something strong (16+ chars)
- [ ] Set `PUBLIC_URL` to your actual HTTPS domain
- [ ] Tighten CORS in `server/index.js`: change `origin: '*'` to `origin: 'https://your-domain.com'`
- [ ] Consider rate-limiting the `/fan` namespace to prevent abuse

---

## 📞 Support

If you get stuck, the most common issues are:

**"Cannot connect" on fan page** → Check that `PUBLIC_URL` is set correctly in Railway env vars

**Flashlight not working on iPhone** → iOS Safari doesn't support the Torch API via web. The screen brightness flash still works. For full torch support on iOS, the page must be saved to the Home Screen (PWA).

**QR code shows localhost** → `PUBLIC_URL` env var hasn't been set yet on your server

**Effects fire on one tab but not another** → Make sure both pages use the same `showId` in their URL params
