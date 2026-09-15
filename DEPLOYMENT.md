# Matter-Born Cloud Deployment Guide (Render & Railway)

This guide walks you through deploying the Matter-Born online multiplayer server to **Render** or **Railway** so multiple mobile phones can play together over public 4G/5G mobile data and separate Wi-Fi networks anywhere in the world.

---

## 🌐 How Cross-Network Mobile Multiplayer Works

```
📱 Mobile Phone A (5G / Mobile Data)
         │
         ▼ (WSS / HTTPS)
 ☁️ Online Multiplayer Server (Render / Railway)
   - Dynamic PORT (process.env.PORT)
   - WebSocket Server at /ws/multiplayer
   - Health check at /health
   - Server-authoritative rooms, movement & combat
         ▲
         │ (WSS / HTTPS)
📱 Mobile Phone B (Home Wi-Fi or Different Network)
```

1. **Phone A** taps **Create Room** -> receives room code (e.g. `MATE-4819`).
2. **Phone B** taps **Join Room** -> inputs `MATE-4819`.
3. Both mobile devices connect to `wss://YOUR-SERVER/ws/multiplayer` over the Internet.
4. Server validates positions, movements, attacks, damage calculations, and health changes in real time.

---

## ☁️ Deployment Option 1: Render

Render provides free or paid Node.js web services with native WebSocket and HTTPS support.

### Steps:
1. Push this repository to **GitHub** or **GitLab**.
2. Log into [Render Dashboard](https://dashboard.render.com/).
3. Click **New +** -> **Web Service**.
4. Connect your repository.
5. Configure the service:
   - **Name**: `matter-born-server`
   - **Environment**: `Node`
   - **Region**: Choose closest to your players (e.g., Oregon / Frankfurt / Singapore)
   - **Branch**: `main`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
6. Add Environment Variables in the **Environment** tab:
   - `NODE_ENV`: `production`
   - `CORS_ORIGIN`: `*`
   - `GEMINI_API_KEY`: *(Your Google Gemini API key if using AI creature generation)*
7. Click **Deploy Web Service**.
8. Once deployed, Render will provide a public URL like:
   `https://matter-born-server.onrender.com`

---

## 🚂 Deployment Option 2: Railway

Railway offers fast one-click deployments and automatic SSL for REST and WebSockets.

### Steps:
1. Log into [Railway Dashboard](https://railway.app/).
2. Click **New Project** -> **Deploy from GitHub repo**.
3. Select your `Matter-Born` repository.
4. Railway will automatically detect [`railway.json`](file:///c:/Users/Admin/Desktop/Matter-Born-main/Matter-Born-main/railway.json).
5. In **Variables**, add:
   - `NODE_ENV`: `production`
   - `CORS_ORIGIN`: `*`
   - `GEMINI_API_KEY`: *(Your Google Gemini API key)*
6. In **Settings** -> **Networking**, click **Generate Domain**.
7. Railway will generate a public URL like:
   `https://matter-born-production.up.railway.app`

---

## 📱 Mobile App Configuration

Once your server is deployed:
1. In the Matter-Born mobile app, tap the **Server Status** / **Wi-Fi LAN Server** modal.
2. Select your preset or enter your public server URL:
   - Render: `https://YOUR-APP.onrender.com`
   - Railway: `https://YOUR-APP.up.railway.app`
3. Tap **Save & Connect**.
4. The status indicator will turn **GREEN** (`Server Connected (WSS Active)`).

> Note: When connecting to an `https://` URL, the client automatically establishes secure WebSockets using `wss://YOUR-HOST/ws/multiplayer`.
