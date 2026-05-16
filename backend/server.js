require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:5173",
    "https://lamaisonafta.cl",
    "http://lamaisonafta.cl",
  ]
}));

// ─── Helper ───────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

function mapTrack(track) {
  return {
    id:       track.id,
    uri:      track.uri,
    title:    track.name,
    artist:   (track.artists || []).map(a => a.name).join(", "),
    album:    track.album?.name || "",
    cover:    track.album?.images?.[0]?.url || null,
    duration: formatDuration(track.duration_ms),
  };
}

// ─── Rate limiting: 2 canciones por mesa cada 10 minutos ─────────────────────
const queueLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 2,
  keyGenerator: (req) => `mesa-${req.body?.mesa || req.ip}`,
  message: { error: "Límite alcanzado. Solo puedes agregar 2 canciones cada 10 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Token store ──────────────────────────────────────────────────────────────
let tokenStore = { access_token: null, refresh_token: null, expires_at: null };

async function getValidToken() {
  if (!tokenStore.access_token) {
    throw new Error("El restaurante aún no ha autorizado Spotify. Ve a /admin/login");
  }
  if (tokenStore.expires_at && Date.now() >= tokenStore.expires_at - 60_000) {
    const params = new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: tokenStore.refresh_token,
    });
    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");
    const { data } = await axios.post(
      "https://accounts.spotify.com/api/token",
      params.toString(),
      { headers: { Authorization: `Basic ${authHeader}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    tokenStore.access_token = data.access_token;
    tokenStore.expires_at   = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) tokenStore.refresh_token = data.refresh_token;
    console.log("✅ Token refrescado");
  }
  return tokenStore.access_token;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────
app.get("/admin/login", (req, res) => {
  const scopes = [
    "user-modify-playback-state",
    "user-read-playback-state",
    "user-read-currently-playing",
    "playlist-read-private",
    "playlist-read-collaborative",
    "user-read-recently-played",
  ].join(" ");
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     process.env.SPOTIFY_CLIENT_ID,
    scope:         scopes,
    redirect_uri:  process.env.SPOTIFY_REDIRECT_URI,
    state:         "lamaison-auth",
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/admin/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>❌ Error: ${error}</h2>`);
  try {
    const params = new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    });
    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");
    const { data } = await axios.post(
      "https://accounts.spotify.com/api/token",
      params.toString(),
      { headers: { Authorization: `Basic ${authHeader}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    tokenStore.access_token  = data.access_token;
    tokenStore.refresh_token = data.refresh_token;
    tokenStore.expires_at    = Date.now() + data.expires_in * 1000;
    console.log("✅ Spotify autorizado correctamente");
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0a04;color:#f5f0e8;">
        <h1 style="color:#d4af37">✅ ¡Autorización exitosa!</h1>
        <p>La Maison ahora está conectada a Spotify.</p>
        <p style="color:#6b5a3a;font-size:14px">Puedes cerrar esta ventana.</p>
      </body></html>
    `);
  } catch (err) {
    console.error("Error callback:", err.response?.data || err.message);
    res.status(500).send("<h2>❌ Error al obtener el token</h2>");
  }
});

app.get("/admin/status", (req, res) => {
  res.json({
    authorized: !!tokenStore.access_token,
    expires_at: tokenStore.expires_at ? new Date(tokenStore.expires_at).toISOString() : null,
  });
});

// ─── Playlist (menú musical) ──────────────────────────────────────────────────
const PLAYLIST_ID = process.env.PLAYLIST_ID || "4VOxHyvj0xiNQanK5TnCgP";
let menuCache = { songs: [], fetchedAt: 0 };
const MENU_TTL = 5 * 60 * 1000; // auto-refresca cada 5 min

async function fetchPlaylist() {
  if (Date.now() - menuCache.fetchedAt < MENU_TTL && menuCache.songs.length > 0) {
    return menuCache.songs;
  }
  const token = await getValidToken();
  const { data } = await axios.get(
    `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/items`,
    { headers: { Authorization: `Bearer ${token}` }, params: { limit: 50, market: "CL" } }
  );
  const songs = (data.items || [])
    .filter(i => (i.track || i.item)?.uri)
    .map(i => mapTrack(i.track || i.item));
  menuCache = { songs, fetchedAt: Date.now() };
  return songs;
}

app.get("/api/menu", async (req, res) => {
  try {
    res.json({ songs: await fetchPlaylist() });
  } catch (err) {
    console.error("Error playlist:", err.response?.data || err.message);
    res.status(500).json({ error: "No se pudo leer la playlist" });
  }
});

app.get("/api/menu/refresh", async (req, res) => {
  menuCache.fetchedAt = 0;
  try {
    res.json({ songs: await fetchPlaylist(), refreshed: true });
  } catch (err) {
    res.status(500).json({ error: "Error al refrescar" });
  }
});

// ─── Now playing ──────────────────────────────────────────────────────────────
app.get("/api/now-playing", async (req, res) => {
  try {
    const token = await getValidToken();
    const { data, status } = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (status === 204 || !data?.item) return res.json({ playing: false });
    res.json({
      playing: data.is_playing,
      track: {
        ...mapTrack(data.item),
        duration_ms: data.item.duration_ms,
        progress_ms: data.progress_ms,
      },
    });
  } catch (err) {
    res.json({ playing: false });
  }
});

// ─── Cola de reproducción (próximas canciones) ────────────────────────────────
app.get("/api/queue", async (req, res) => {
  try {
    const token = await getValidToken();
    const { data } = await axios.get(
      "https://api.spotify.com/v1/me/player/queue",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const queue = (data.queue || []).slice(0, 10).map(mapTrack);
    res.json({ queue });
  } catch (err) {
    console.error("Error queue:", err.response?.data || err.message);
    res.json({ queue: [] });
  }
});

// ─── Historial reciente (caché 5 min) ─────────────────────────────────────────
let rpCache = { items: [], fetchedAt: 0 };

async function getRecentlyPlayed() {
  if (Date.now() - rpCache.fetchedAt < 5 * 60 * 1000) return rpCache.items;
  const token = await getValidToken();
  const { data } = await axios.get(
    "https://api.spotify.com/v1/me/player/recently-played",
    { headers: { Authorization: `Bearer ${token}` }, params: { limit: 50 } }
  );
  rpCache = { items: data.items || [], fetchedAt: Date.now() };
  return rpCache.items;
}

// ─── Agregar a la cola ────────────────────────────────────────────────────────
app.post("/api/queue", queueLimiter, async (req, res) => {
  const { uri, mesa } = req.body;
  if (!uri || !uri.startsWith("spotify:track:")) {
    return res.status(400).json({ error: "URI inválida" });
  }

  try {
    // Verificar si fue reproducida en los últimos 90 minutos
    try {
      const recent = await getRecentlyPlayed();
      const cutoff = Date.now() - 90 * 60 * 1000;
      const wasPlayed = recent.some(
        item => item.track?.uri === uri && new Date(item.played_at).getTime() > cutoff
      );
      if (wasPlayed) {
        return res.status(409).json({
          error: "Esta canción sonó hace menos de 90 minutos. ¡Elige otra!",
        });
      }
    } catch (rpErr) {
      console.warn("No se pudo verificar historial:", rpErr.message);
      // No bloqueamos si falla la verificación
    }

    const token = await getValidToken();
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      null,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    rpCache.fetchedAt = 0; // invalidar caché de historial
    console.log(`🎵 Mesa ${mesa || "?"}: ${uri}`);
    res.json({ success: true });
  } catch (err) {
    const s = err.response?.status;
    if (s === 404) return res.status(503).json({ error: "No hay ningún dispositivo reproduciendo en este momento." });
    if (s === 403) return res.status(403).json({ error: "Se requiere Spotify Premium." });
    if (err.response?.data) return res.status(500).json({ error: err.response.data.error?.message || "Error al agregar" });
    res.status(500).json({ error: err.message || "Error al agregar la canción" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎵 La Maison Music Server en http://localhost:${PORT}`);
  console.log(`📋 Autorizar Spotify: http://localhost:${PORT}/admin/login\n`);
});
