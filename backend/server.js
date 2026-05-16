require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:5173",
    "https://lamaisonafta.cl",
    "http://lamaisonafta.cl",
  ],
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ─── Playlists por categoría ──────────────────────────────────────────────────
const PLAYLISTS = [
  { id: "3chHQ9n09g9gs6QvkWkl3O", name: "Jazz",           icon: "🎷", gradient: ["#0e2240","#1a3a5c"], accent: "#4a90c4" },
  { id: "0CdxyUJCNDWoEYnRQ3bA7m", name: "Bossa Nova",     icon: "🎸", gradient: ["#3d1f00","#6b3810"], accent: "#d4874a" },
  { id: "0YgY3toqJ3DLMGgFTE8bRY", name: "Pop Suave",      icon: "🎤", gradient: ["#2d0a38","#4e1660"], accent: "#c47ad4" },
  { id: "66UlFLeNXUqf8Kau6olQCd", name: "Acústico",       icon: "🪕", gradient: ["#1a2e0a","#2e5010"], accent: "#7dbf4a" },
  { id: "2XpIURbMf1wRprM1wxhTq9", name: "Lounge & Chill", icon: "🌙", gradient: ["#080e2a","#101e48"], accent: "#5a7ad4" },
  { id: "26fs3ZXB76x0Hk1SH4B6HL", name: "Retro",          icon: "📻", gradient: ["#2a1a00","#4a3008"], accent: "#d4a84a" },
  { id: "79dY6XMFfuCPoQdUNcVWsT", name: "Energy",         icon: "⚡", gradient: ["#2a0000","#500808"], accent: "#d44a4a" },
  { id: "5LfnafdRLXOJ0iHUFx8qxX", name: "Tropical",      icon: "🌴", gradient: ["#002a1a","#005030"], accent: "#4ad4a0" },
  { id: "54I71IeL3COBcBoIUfYMTX", name: "Pop for Kids",   icon: "✨", gradient: ["#1a0a30","#320f58"], accent: "#a07ad4" },
  { id: "3EtpM6cIXfJHWk5QWYWqeN", name: "Upbeat",         icon: "🎉", gradient: ["#2a1000","#502008"], accent: "#d4784a" },
];

// Caché individual por playlist (TTL 5 min)
const songCache = new Map(); // playlistId → { songs, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;

// ─── Token store ──────────────────────────────────────────────────────────────
let tokenStore = { access_token: null, refresh_token: null, expires_at: null };

async function getValidToken() {
  if (!tokenStore.access_token) {
    throw new Error("Spotify no autorizado. Ve a /admin/login");
  }
  if (Date.now() >= (tokenStore.expires_at || 0) - 60_000) {
    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");
    const { data } = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenStore.refresh_token }).toString(),
      { headers: { Authorization: `Basic ${authHeader}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    tokenStore.access_token = data.access_token;
    tokenStore.expires_at   = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) tokenStore.refresh_token = data.refresh_token;
    console.log("✅ Token refrescado");
  }
  return tokenStore.access_token;
}

// ─── Fetch songs de una playlist ──────────────────────────────────────────────
async function fetchPlaylistSongs(playlistId, force = false) {
  const cached = songCache.get(playlistId);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.songs;
  }
  const token = await getValidToken();
  const { data } = await axios.get(
    `https://api.spotify.com/v1/playlists/${playlistId}/items`,
    { headers: { Authorization: `Bearer ${token}` }, params: { limit: 100, market: "CL" } }
  );
  const songs = (data.items || [])
    .filter(i => (i.track || i.item)?.uri)
    .map(i => mapTrack(i.track || i.item));
  songCache.set(playlistId, { songs, fetchedAt: Date.now() });
  return songs;
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
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/admin/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>❌ ${error}</h2>`);
  try {
    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");
    const { data } = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: process.env.SPOTIFY_REDIRECT_URI }).toString(),
      { headers: { Authorization: `Basic ${authHeader}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    tokenStore = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 };
    console.log("✅ Spotify autorizado correctamente");
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0a04;color:#f5f0e8;">
      <h1 style="color:#d4af37">✅ ¡Autorización exitosa!</h1><p>Puedes cerrar esta ventana.</p></body></html>`);
  } catch (err) {
    res.status(500).send("<h2>❌ Error al obtener el token</h2>");
  }
});

app.get("/admin/status", (req, res) => {
  res.json({ authorized: !!tokenStore.access_token, expires_at: tokenStore.expires_at ? new Date(tokenStore.expires_at).toISOString() : null });
});

// ─── API: listado de categorías ───────────────────────────────────────────────
app.get("/api/playlists", (req, res) => {
  res.json({ playlists: PLAYLISTS.map(p => ({ id: p.id, name: p.name, icon: p.icon, gradient: p.gradient, accent: p.accent })) });
});

// ─── API: canciones de una categoría ─────────────────────────────────────────
app.get("/api/playlists/:id/songs", async (req, res) => {
  const playlist = PLAYLISTS.find(p => p.id === req.params.id);
  if (!playlist) return res.status(404).json({ error: "Categoría no encontrada" });
  try {
    const force = req.query.refresh === "1";
    const songs = await fetchPlaylistSongs(playlist.id, force);
    res.json({ songs, playlist: { id: playlist.id, name: playlist.name, icon: playlist.icon, gradient: playlist.gradient, accent: playlist.accent } });
  } catch (err) {
    console.error("Error playlist:", err.response?.data || err.message);
    res.status(500).json({ error: "No se pudo cargar la categoría" });
  }
});

// ─── API: búsqueda cruzada en todas las playlists ────────────────────────────
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.status(400).json({ error: "Escribe al menos 2 caracteres" });

  try {
    // Carga en paralelo todas las playlists (usa caché si está disponible)
    const results = await Promise.all(
      PLAYLISTS.map(async (pl) => {
        try {
          const songs = await fetchPlaylistSongs(pl.id);
          return songs
            .filter(s =>
              s.title.toLowerCase().includes(q) ||
              s.artist.toLowerCase().includes(q) ||
              s.album.toLowerCase().includes(q)
            )
            .map(s => ({ ...s, category: { id: pl.id, name: pl.name, icon: pl.icon, accent: pl.accent } }));
        } catch { return []; }
      })
    );

    // Aplanar y deduplicar por URI
    const seen = new Set();
    const songs = results.flat().filter(s => {
      if (seen.has(s.uri)) return false;
      seen.add(s.uri);
      return true;
    });

    res.json({ songs, query: q });
  } catch (err) {
    console.error("Error búsqueda:", err.message);
    res.status(500).json({ error: "Error al buscar" });
  }
});

// ─── API: now playing ─────────────────────────────────────────────────────────
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
      track: { ...mapTrack(data.item), duration_ms: data.item.duration_ms, progress_ms: data.progress_ms },
    });
  } catch { res.json({ playing: false }); }
});

// ─── API: cola ────────────────────────────────────────────────────────────────
app.get("/api/queue", async (req, res) => {
  try {
    const token = await getValidToken();
    const { data } = await axios.get("https://api.spotify.com/v1/me/player/queue", { headers: { Authorization: `Bearer ${token}` } });
    const queue = (data.queue || []).slice(0, 10).map(track => {
      const base = mapTrack(track);
      const tracked = queueTracker.get(track.uri);
      return { ...base, addedByMesa: tracked?.mesa || null };
    });
    res.json({ queue });
  } catch { res.json({ queue: [] }); }
});

// ─── Historial reciente ───────────────────────────────────────────────────────
let rpCache = { items: [], fetchedAt: 0 };

// Tracker: uri → { mesa, addedAt } para mostrar qué mesa agregó cada canción
const queueTracker = new Map();
function cleanTracker() {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000; // limpia entradas > 4 horas
  for (const [uri, entry] of queueTracker.entries()) {
    if (entry.addedAt < cutoff) queueTracker.delete(uri);
  }
}
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

// ─── Rate limit manual (solo cuenta adiciones exitosas) ───────────────────────
const mesaCounters = new Map();
const LIMIT_MAX = 2;
const LIMIT_WINDOW = 10 * 60 * 1000;

function checkLimit(mesa) {
  const key = `mesa-${mesa}`;
  const now  = Date.now();
  const entry = mesaCounters.get(key);
  if (!entry || now >= entry.resetAt) return { allowed: true };
  if (entry.count >= LIMIT_MAX) {
    return { allowed: false, minsLeft: Math.ceil((entry.resetAt - now) / 60000) };
  }
  return { allowed: true };
}

function commitLimit(mesa) {
  const key  = `mesa-${mesa}`;
  const now  = Date.now();
  const entry = mesaCounters.get(key);
  if (!entry || now >= entry.resetAt) {
    mesaCounters.set(key, { count: 1, resetAt: now + LIMIT_WINDOW });
  } else {
    entry.count += 1;
  }
}

// ─── API: agregar a la cola ───────────────────────────────────────────────────
app.post("/api/queue", async (req, res) => {
  const { uri, mesa } = req.body;
  if (!uri || !uri.startsWith("spotify:track:")) {
    return res.status(400).json({ error: "URI inválida" });
  }

  // 1. Verificar cupo (sin consumirlo)
  const limit = checkLimit(mesa || req.ip);
  if (!limit.allowed) {
    return res.status(429).json({
      error: `Límite alcanzado. Puedes agregar 2 canciones cada 10 minutos. Intenta en ${limit.minsLeft} min.`,
    });
  }

  try {
    // 2. Verificar historial 90 min (sin consumir cupo si falla)
    try {
      const recent = await getRecentlyPlayed();
      const cutoff = Date.now() - 90 * 60 * 1000;
      const wasPlayed = recent.some(i => i.track?.uri === uri && new Date(i.played_at).getTime() > cutoff);
      if (wasPlayed) {
        return res.status(409).json({ error: "Esta canción sonó hace menos de 90 minutos. ¡Elige otra!" });
      }
    } catch (e) { console.warn("No se pudo verificar historial:", e.message); }

    // 3. Agregar a Spotify
    const token = await getValidToken();
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      null,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // 4. Solo aquí se consume el cupo y se registra la mesa
    commitLimit(mesa || req.ip);
    if (mesa) { cleanTracker(); queueTracker.set(uri, { mesa, addedAt: Date.now() }); }
    rpCache.fetchedAt = 0;
    console.log(`🎵 Mesa ${mesa || "?"}: ${uri}`);
    res.json({ success: true });
  } catch (err) {
    const s = err.response?.status;
    if (s === 404) return res.status(503).json({ error: "No hay dispositivo reproduciendo en este momento." });
    if (s === 403) return res.status(403).json({ error: "Se requiere Spotify Premium." });
    res.status(500).json({ error: err.response?.data?.error?.message || "Error al agregar la canción" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎵 La Maison Music Server en http://localhost:${PORT}`);
  console.log(`📋 Autorizar Spotify: http://localhost:${PORT}/admin/login\n`);
});
