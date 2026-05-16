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

// ─── Rate limiting (protección contra abuso) ──────────────────────────────────
const queueLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos
  max: 5,                    // máx 5 canciones por mesa cada 10 min
  keyGenerator: (req) => req.query.mesa || req.ip,
  message: { error: "Límite alcanzado. Espera unos minutos antes de agregar más canciones." },
});

// ─── Token store en memoria (persiste mientras el server corre) ───────────────
let tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: null,
};

// ─── Helper: obtener token válido (refresca si expiró) ───────────────────────
async function getValidToken() {
  if (!tokenStore.access_token) {
    throw new Error("El restaurante aún no ha autorizado Spotify. Ve a /admin/login");
  }

  const now = Date.now();
  if (tokenStore.expires_at && now >= tokenStore.expires_at - 60_000) {
    // Token expirado → refrescar
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenStore.refresh_token,
    });

    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");

    const { data } = await axios.post(
      "https://accounts.spotify.com/api/token",
      params.toString(),
      {
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    tokenStore.access_token = data.access_token;
    tokenStore.expires_at = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) tokenStore.refresh_token = data.refresh_token;

    console.log("✅ Token de Spotify refrescado");
  }

  return tokenStore.access_token;
}

// ─── RUTAS DE ADMINISTRADOR ───────────────────────────────────────────────────

// GET /admin/login → redirige al dueño del restaurante a Spotify OAuth
app.get("/admin/login", (req, res) => {
  const scopes = [
    "user-modify-playback-state",
    "user-read-playback-state",
    "user-read-currently-playing",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    state: "lamaison-auth",
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// GET /admin/callback → Spotify redirige aquí después de autorizar
app.get("/admin/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<h2>❌ Error: ${error}</h2><p>El usuario no autorizó la aplicación.</p>`);
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    });

    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");

    const { data } = await axios.post(
      "https://accounts.spotify.com/api/token",
      params.toString(),
      {
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    tokenStore.access_token = data.access_token;
    tokenStore.refresh_token = data.refresh_token;
    tokenStore.expires_at = Date.now() + data.expires_in * 1000;

    console.log("✅ Spotify autorizado correctamente");

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0a04;color:#f5f0e8;">
          <h1 style="color:#d4af37">✅ ¡Autorización exitosa!</h1>
          <p>La Maison ahora está conectada a Spotify.</p>
          <p style="color:#6b5a3a;font-size:14px">Puedes cerrar esta ventana.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Error en callback:", err.response?.data || err.message);
    res.status(500).send("<h2>❌ Error al obtener el token de Spotify</h2>");
  }
});

// GET /admin/status → verifica si hay token activo
app.get("/admin/status", (req, res) => {
  res.json({
    authorized: !!tokenStore.access_token,
    expires_at: tokenStore.expires_at
      ? new Date(tokenStore.expires_at).toISOString()
      : null,
  });
});

// ─── RUTAS PÚBLICAS (usadas por los clientes del restaurante) ─────────────────

// GET /api/search?q=cancion → busca en Spotify
app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: "Ingresa al menos 2 caracteres para buscar" });
  }

  try {
    const token = await getValidToken();
    const { data } = await axios.get("https://api.spotify.com/v1/search", {
      headers: { Authorization: `Bearer ${token}` },
      params: { q, type: "track", limit: 10, market: "CL" },
    });

    const tracks = data.tracks.items.map((track) => ({
      id: track.id,
      uri: track.uri,
      title: track.name,
      artist: track.artists.map((a) => a.name).join(", "),
      album: track.album.name,
      duration: formatDuration(track.duration_ms),
      cover: track.album.images?.[0]?.url || null,
      preview_url: track.preview_url,
    }));

    res.json({ tracks });
  } catch (err) {
    console.error("Error en búsqueda:", err.response?.data || err.message);
    res.status(500).json({ error: "Error al buscar canciones" });
  }
});

// POST /api/queue → agrega una canción a la cola de Spotify
app.post("/api/queue", queueLimiter, async (req, res) => {
  const { uri, mesa } = req.body;

  if (!uri || !uri.startsWith("spotify:track:")) {
    return res.status(400).json({ error: "URI de canción inválida" });
  }

  try {
    const token = await getValidToken();
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      null,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log(`🎵 Canción agregada desde Mesa ${mesa || "??"}: ${uri}`);
    res.json({ success: true, message: "Canción agregada a la cola" });
  } catch (err) {
    const status = err.response?.status;
    const spotifyError = err.response?.data?.error?.message;

    if (status === 404) {
      return res.status(503).json({
        error: "No hay ningún dispositivo reproduciendo música en este momento.",
      });
    }
    if (status === 403) {
      return res.status(403).json({
        error: "Se requiere Spotify Premium para agregar canciones a la cola.",
      });
    }

    console.error("Error al agregar a cola:", spotifyError || err.message);
    res.status(500).json({ error: spotifyError || "Error al agregar la canción" });
  }
});

// GET /api/now-playing → qué está sonando actualmente
app.get("/api/now-playing", async (req, res) => {
  try {
    const token = await getValidToken();
    const { data, status } = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (status === 204 || !data || !data.item) {
      return res.json({ playing: false });
    }

    const track = data.item;
    res.json({
      playing: data.is_playing,
      track: {
        id: track.id,
        title: track.name,
        artist: track.artists.map((a) => a.name).join(", "),
        album: track.album.name,
        cover: track.album.images?.[0]?.url || null,
        duration_ms: track.duration_ms,
        progress_ms: data.progress_ms,
      },
    });
  } catch (err) {
    if (err.message.includes("no ha autorizado")) {
      return res.status(401).json({ playing: false, error: err.message });
    }
    console.error("Error en now-playing:", err.response?.data || err.message);
    res.status(500).json({ playing: false, error: "Error al obtener la canción actual" });
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎵 La Maison Music Server corriendo en http://localhost:${PORT}`);
  console.log(`📋 Para autorizar Spotify, abre: http://localhost:${PORT}/admin/login\n`);
});
