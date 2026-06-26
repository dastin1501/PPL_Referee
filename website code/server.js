const express = require("express");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const compression = require("compression");
const cors = require("cors");
const helmet = require("helmet");
// Always load backend/.env regardless of current working directory
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { Storage } = require("@google-cloud/storage");

const authRoutes = require("./routes/authRoutes");
const rankingRoutes = require("./routes/rankings");
const superAdminRoutes = require("./routes/superadmin");
const volunteerRoutes = require("./routes/volunteers");
const analyticsRoutes = require("./routes/analytics");
const coachRoutes = require("./routes/coaches");
const organizerRoutes = require("./routes/organizers");
const clubAdminRoutes = require("./routes/clubAdmins");
const clubsRoutes = require("./routes/clubs");
const feedbackRoutes = require("./routes/feedbacks");
const logRoutes = require("./routes/logs");
const userRoutes = require("./routes/users");
const postRoutes = require("./routes/posts");
const reportRoutes = require("./routes/reports");
const profileRoutes = require("./routes/profiles");
const tournamentRoutes = require("./routes/tournaments");
const events2Routes = require("./routes/events2");
const verificationRoutes = require("./routes/verifications");
const forgotPasswordRoutes = require("./routes/forgotPassword");
const NotificationRoutes = require("./routes/notifications");
const uploadRoutes = require("./routes/upload");
const shareRoutes = require("./routes/share");
const sponsorRoutes = require("./routes/sponsors");
const testRoutes = require("./routes/test");
const luzonTeamRegistrationRoutes = require("./routes/luzonTeamRegistration");
const luzonSinglesDoublesRegistrationRoutes = require("./routes/luzonSinglesDoublesRegistration");
const openLuzonPlayersRegistrationRoutes = require("./routes/openLuzonPlayersRegistration");
const geoRoutes = require("./routes/geo");
const fileRoutes = require("./routes/files");
const badgesRoutes = require("./routes/badges");
const refereeRoutes = require("./routes/referees");
const refereeAdminRoutes = require("./routes/refereeAdmins");
const vendorAdminRoutes = require("./routes/vendorAdmins");
const googleAuthRoutes = require("./routes/googleAuth");
const emailRoutes = require("./routes/email");
const paymentsRoutes = require("./routes/payments");
const petitionsRoutes = require("./routes/petitions");
const supportChatRoutes = require("./routes/supportChat");
const shopRoutes = require("./routes/shop");
const duprService = require("./services/duprService");
const bracketQueue = require("./services/bracketQueue");
const { runShopNormalization } = require("./services/shopNormalization");
const rateLimit = require("express-rate-limit");
const { trafficMetricsMiddleware } = require("./middleware/trafficMetrics");
const { httpCacheControl } = require("./middleware/httpCacheControl");

const app = express();
const http = require("http");
const server = http.createServer(app);
app.set('trust proxy', 1);
const User = require("./models/User");

try {
  if (!global.__pplPerfMetrics) {
    global.__pplPerfMetrics = {
      startedAt: new Date().toISOString(),
      buildMarker: null,
      dbOps: new Map(),
    };
  }
} catch (_) {}

// Simple build marker to confirm which backend code is running (helps avoid port 5000 old-process confusion)
const BUILD_MARKER = "referee-note-sync-v1-2026-06-24";
console.log("✅ Backend build:", BUILD_MARKER);
try { if (global.__pplPerfMetrics) global.__pplPerfMetrics.buildMarker = BUILD_MARKER; } catch (_) {}

try {
  const perf = global.__pplPerfMetrics;
  const SLOW_DB_MS = parseInt(process.env.SLOW_DB_MS || "250", 10);
  const MAX_DB_OP_ROWS = parseInt(process.env.DB_METRICS_MAX_ROWS || "2000", 10);
  const recordDb = (row) => {
    try {
      const key = String(row?.key || "");
      if (!key) return;
      const current = perf.dbOps.get(key) || {
        key,
        count: 0,
        slowCount: 0,
        avgMs: 0,
        maxMs: 0,
        lastSeenAt: null,
      };
      current.count += 1;
      const ms = Number(row?.ms || 0);
      current.avgMs = ((current.avgMs * (current.count - 1)) + ms) / current.count;
      current.maxMs = Math.max(current.maxMs, ms);
      if (ms >= SLOW_DB_MS) current.slowCount += 1;
      current.lastSeenAt = new Date().toISOString();
      perf.dbOps.set(key, current);
      if (perf.dbOps.size > MAX_DB_OP_ROWS) {
        const firstKey = perf.dbOps.keys().next().value;
        if (firstKey) perf.dbOps.delete(firstKey);
      }
    } catch (_) {}
  };

  if (!mongoose.Query.prototype.__pplTimedExec) {
    mongoose.Query.prototype.__pplTimedExec = true;
    const origExec = mongoose.Query.prototype.exec;
    mongoose.Query.prototype.exec = async function (...args) {
      const start = process.hrtime.bigint();
      try {
        return await origExec.apply(this, args);
      } finally {
        try {
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          const model = this?.model?.modelName || "Unknown";
          const op = this?.op || "query";
          recordDb({ key: `${model}.${op}`, ms });
        } catch (_) {}
      }
    };
  }
  if (mongoose.Aggregate && mongoose.Aggregate.prototype && !mongoose.Aggregate.prototype.__pplTimedExec) {
    mongoose.Aggregate.prototype.__pplTimedExec = true;
    const origAggExec = mongoose.Aggregate.prototype.exec;
    mongoose.Aggregate.prototype.exec = async function (...args) {
      const start = process.hrtime.bigint();
      try {
        return await origAggExec.apply(this, args);
      } finally {
        try {
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          const model = this?._model?.modelName || "Unknown";
          recordDb({ key: `${model}.aggregate`, ms });
        } catch (_) {}
      }
    };
  }
} catch (_) {}

// CSP for dev (unsafe-eval allowed)
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "script-src 'self' 'unsafe-eval'");
  next();
});

// Middleware


// Enable gzip compression to reduce outbound bandwidth.
app.use(
  compression({
    threshold: 1024,
    level: 6,
  }),
);
// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  referrerPolicy: { policy: "no-referrer" },
  hsts: process.env.NODE_ENV === "production" ? { maxAge: 15552000, includeSubDomains: true, preload: false } : false,
}));
// Optional host guard
app.use((req, res, next) => {
  try {
    const raw = String(process.env.ALLOWED_HOSTS || "").trim();
    if (!raw) return next();
    const allowed = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    const host = String(req.headers.host || "").toLowerCase();
    if (!host || allowed.includes(host)) return next();
    return res.status(403).json({ message: "Host not allowed" });
  } catch (_) { return next(); }
});
// Optional IP blacklist
app.use((req, res, next) => {
  try {
    const raw = String(process.env.BLACKLIST_IPS || "").trim();
    if (!raw) return next();
    const blocked = raw.split(",").map((h) => h.trim()).filter(Boolean);
    const ip = (req.ip || req.connection?.remoteAddress || "").replace(/^::ffff:/, "");
    if (blocked.includes(ip)) return res.status(403).json({ message: "IP blocked" });
    return next();
  } catch (_) { return next(); }
});

// Lightweight request timing to surface slow endpoints (optional via ENV)
app.use((req, res, next) => {
  const enableTiming = String(process.env.ENABLE_REQUEST_TIMING || "").trim() === "1";
  if (!enableTiming) return next();
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1e6;
      const thresholdMs = parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS || "500", 10);
      if (process.env.NODE_ENV !== "production" || ms >= thresholdMs) {
        console.log(`⏱️ ${req.method} ${req.originalUrl} -> ${ms.toFixed(1)}ms (${res.statusCode})`);
      }
      res.setHeader("X-Response-Time-ms", ms.toFixed(1));
    } catch (_) {}
  });
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = process.env.NODE_ENV === "production"
        ? [
            "https://philippine-pickleball-league.vercel.app",
            "https://www.phpickleballleague.com",
            "https://phpickleballleague.com",
            "http://localhost:5173", // Add localhost for local testing
            "http://localhost:5174",
            "http://localhost:58256"
          ]
        : ["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"];

      if (!origin) return callback(null, true);

      const isLocalPattern = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
      if (allowedOrigins.includes(origin) || isLocalPattern) {
        callback(null, true);
      } else {
        console.log(`CORS Error: Origin "${origin}" is not allowed. Allowed origins:`, allowedOrigins);
        callback(new Error("CORS policy: This origin is not allowed"));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Include Cache-Control and Pragma to avoid CORS errors raised by some clients
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Requested-With", "Expires", "X-Request-Id"],
    credentials: true,
  })
);

// Ensure preflight requests are handled
app.options("*", cors({
  origin: (origin, callback) => {
    const allowedOrigins = process.env.NODE_ENV === "production"
      ? [
          "https://philippine-pickleball-league.vercel.app",
          "https://www.phpickleballleague.com",
          "https://phpickleballleague.com",
          "http://localhost:5173", // Add localhost for local testing
          "http://localhost:5174",
          "http://localhost:58256"
        ]
      : ["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"];

    if (!origin) return callback(null, true);

    const isLocalPattern = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (allowedOrigins.includes(origin) || isLocalPattern) {
      callback(null, true);
    } else {
      console.log(`CORS Error: Origin "${origin}" is not allowed. Allowed origins:`, allowedOrigins);
      callback(new Error("CORS policy: This origin is not allowed"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Requested-With", "Expires", "X-Request-Id"],
  credentials: true,
}));


// Important: Also parse JSON after cors
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Global request limiter to curb abusive scraping/polling.
const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please retry shortly." },
  skip: (req) => {
    const url = String(req.originalUrl || "");
    if (url.startsWith("/api/health")) return true;
    if (url.startsWith("/api/logs")) return true;
    if (url.startsWith("/api/files/thumbnail")) return true;
    if (url.startsWith("/api/files/signed-url")) return true;
    return false;
  },
});
app.use("/api", globalApiLimiter);

// Traffic instrumentation and baseline cache headers.
app.use(trafficMetricsMiddleware);
app.use(httpCacheControl);

// Debug middleware to log requests (development only)
if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    console.log(`🔹 ${req.method} ${req.url}`);
    next();
  });
}

// Connect to MongoDB Atlas
const Post = require("./models/Post");

function buildMongoUri() {
  try {
    const direct = String(process.env.MONGO_URI || "").trim();
    if (direct) return direct;
    const host = String(process.env.MONGO_HOST || "").trim();
    const port = String(process.env.MONGO_PORT || "27017").trim();
    const db = String(process.env.MONGO_DB || "").trim();
    const user = String(process.env.MONGO_USER || "").trim();
    const pass = String(process.env.MONGO_PASS || "").trim();
    if (host && db && user && pass) {
      const authSrc = String(process.env.MONGO_AUTH_SOURCE || "admin").trim();
      return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}?authSource=${encodeURIComponent(authSrc)}`;
    }
    // Development fallback only (no auth). Never used in production.
    if (process.env.NODE_ENV !== "production") {
      return "mongodb://127.0.0.1:27017/ppl";
    }
    throw new Error("Missing MongoDB credentials (MONGO_URI or MONGO_HOST/MONGO_PORT/MONGO_DB/MONGO_USER/MONGO_PASS)");
  } catch (e) {
    throw e;
  }
}

// Debug: log mongo target (hostname only; no credentials)
try {
  const built = buildMongoUri();
  const normalized = String(built || "");
  const isSrv = /^mongodb\+srv:\/\//i.test(normalized);
  const host = normalized
    .replace(/^mongodb(\+srv)?:\/\//i, "")
    .replace(/^[^@]*@/, "")
    .split("/")[0]
    .split(":")[0];
  const dbName = String(process.env.MONGO_DB || "").trim();
  console.log(
    `🔌 Mongo target: ${isSrv ? "mongodb+srv" : "mongodb"}://${host || "(unknown host)"}` +
      (dbName ? ` db=${dbName}` : "")
  );
} catch (e) {
  console.warn("🔌 Mongo target debug failed:", e && (e.message || String(e)));
}

const mongoOptions = {
  dbName: (String(process.env.MONGO_DB || "").trim() || undefined),
  maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE || "10", 10),
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4,
};

async function connectMongo(uri) {
  await mongoose.connect(uri, mongoOptions);
  try {
    const dbName = mongoose?.connection?.name ? String(mongoose.connection.name) : "";
    console.log("MongoDB connected!" + (dbName ? ` db=${dbName}` : ""));
  } catch {
    console.log("MongoDB connected!");
  }
  duprService.startScheduler();
  try { duprService.startTokenRefresher(); } catch (_) {}
  try { bracketQueue.startWorker(); } catch (_) {}
}

function readMongoUriNoSrvFromEnvFile() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return "";
    const raw = fs.readFileSync(envPath, "utf8");
    const match = raw.match(/^[ \t]*#?[ \t]*MONGO_URI_NOSRV[ \t]*=[ \t]*("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\r\n#]+).*$/m);
    if (!match) return "";
    let value = String(match[1] || "").trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return String(value || "").trim();
  } catch {
    return "";
  }
}

function getMongoDbNameFromUri(uri) {
  try {
    const raw = String(uri || "").trim();
    if (!raw) return "";
    const withoutProto = raw.replace(/^mongodb(\+srv)?:\/\//i, "");
    const withoutAuth = withoutProto.replace(/^[^@/]*@/, "");
    const slash = withoutAuth.indexOf("/");
    if (slash < 0) return "";
    const afterSlash = withoutAuth.slice(slash + 1);
    const db = afterSlash.split("?")[0] || "";
    return String(db).trim();
  } catch {
    return "";
  }
}

function removeMongoDbNameFromUri(uri) {
  try {
    const raw = String(uri || "").trim();
    if (!raw) return raw;
    const withoutProto = raw.replace(/^mongodb(\+srv)?:\/\//i, "");
    const withoutAuth = withoutProto.replace(/^[^@/]*@/, "");
    const slash = withoutAuth.indexOf("/");
    if (slash < 0) return raw;
    const prefixLen = raw.length - withoutAuth.length;
    const cutAt = prefixLen + slash;
    const q = raw.indexOf("?", cutAt);
    if (q >= 0) return `${raw.slice(0, cutAt)}/${raw.slice(q)}`;
    return raw.slice(0, cutAt);
  } catch {
    return String(uri || "");
  }
}

function replaceMongoDbNameInUri(uri, dbName) {
  try {
    const raw = String(uri || "").trim();
    const db = String(dbName || "").trim();
    if (!raw || !db) return raw;
    const noDb = removeMongoDbNameFromUri(raw);
    const q = noDb.indexOf("?");
    if (q >= 0) return `${noDb.slice(0, q)}/${encodeURIComponent(db)}${noDb.slice(q)}`;
    return `${noDb}/${encodeURIComponent(db)}`;
  } catch {
    return String(uri || "");
  }
}

(async () => {
  const primaryUri = buildMongoUri();
  try {
    await connectMongo(primaryUri);
  } catch (err) {
    let noSrvUri = String(process.env.MONGO_URI_NOSRV || "").trim();
    if (!noSrvUri) noSrvUri = readMongoUriNoSrvFromEnvFile();
    if (
      noSrvUri &&
      /^mongodb\+srv:/i.test(primaryUri) &&
      !/^mongodb\+srv:/i.test(noSrvUri)
    ) {
      console.warn("MongoDB primary connection error:", err);
      console.log("Attempting MongoDB fallback connection using MONGO_URI_NOSRV");
      try {
        const desiredDb = mongoOptions.dbName || getMongoDbNameFromUri(primaryUri);
        const normalizedNoSrvUri = desiredDb
          ? replaceMongoDbNameInUri(noSrvUri, desiredDb)
          : removeMongoDbNameFromUri(noSrvUri);
        await connectMongo(normalizedNoSrvUri);
        console.log("MongoDB connected using MONGO_URI_NOSRV");
      } catch (fallbackErr) {
        console.error("MongoDB fallback connection error:", fallbackErr);
      }
    } else {
      console.error("MongoDB connection error:", err);
    }
  }
})();

mongoose.connection.on("open", async () => {
  try {
    await Post.collection.createIndex({ status: 1, createdAt: -1 });
    await Post.collection.createIndex({ author: 1, createdAt: -1 });
    await Post.collection.createIndex({ createdAt: -1 });
    console.log("✅ Post indexes ensured");
  } catch (err) {
    console.warn("⚠️ Failed to ensure Post indexes:", err && (err.message || err));
  }
  try {
    const result = await runShopNormalization();
    console.log(
      "✅ Shop data normalized:",
      `items ${result.itemResult.updated}/${result.itemResult.scanned},`,
      `orders ${result.orderResult.updated}/${result.orderResult.scanned}`
    );
  } catch (err) {
    console.warn("⚠️ Failed to normalize shop data:", err && (err.message || err));
  }
});

// Test routes first
app.get("/debug-simple", (req, res) => {
  console.log("🔹 Debug route hit!");
  res.json({
    message: "Debug route working",
    expressVersion: require("express/package.json").version,
    timestamp: new Date().toISOString(),
  });
});

app.get("/test-basic", (req, res) => {
  console.log("🔹 Basic test route hit!");
  res.send("Basic route working");
});

// Avatar proxy for web (avoids GCS CORS and private object access issues)
const gcs = new Storage();
const AVATAR_BUCKET = process.env.GCS_BUCKET_NAME || "ppl-uploads";
app.get("/api/files/avatars/:file", async (req, res) => {
  try {
    const raw = String(req.params.file || "");
    const fileName = raw.replace(/[\\\/]/g, "").trim();
    if (!fileName) return res.status(400).json({ message: "Missing file" });
    const file = gcs.bucket(AVATAR_BUCKET).file(`avatars/${fileName}`);
    let exists = false;
    try {
      const [gcsExists] = await file.exists();
      exists = !!gcsExists;
    } catch (_) {
      exists = false;
    }
    if (exists) {
      let contentType = "image/jpeg";
      let etag = null;
      try {
        const [meta] = await file.getMetadata();
        if (meta && meta.contentType) contentType = meta.contentType;
        if (meta && meta.etag) etag = String(meta.etag);
      } catch (_) {}
      if (etag) {
        const inm = String(req.headers["if-none-match"] || "").trim();
        if (inm && inm === etag) {
          res.setHeader("ETag", etag);
          res.setHeader("Cache-Control", "public, max-age=2592000, stale-while-revalidate=604800");
          return res.status(304).end();
        }
      }
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=2592000, stale-while-revalidate=604800");
      if (etag) res.setHeader("ETag", etag);
      res.setHeader("Access-Control-Allow-Origin", "*");
      const stream = file.createReadStream();
      stream.on("error", (err) => {
        console.warn("avatar stream error:", err?.message || err);
        if (!res.headersSent) res.status(404).json({ message: "Avatar not found" });
      });
      stream.pipe(res);
      return;
    }
    const localPath = path.join(__dirname, "uploads", "avatars", fileName);
    if (fs.existsSync(localPath)) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=2592000, stale-while-revalidate=604800");
      res.setHeader("Access-Control-Allow-Origin", "*");
      const stream = fs.createReadStream(localPath);
      stream.on("error", (err) => {
        console.warn("avatar local stream error:", err?.message || err);
        if (!res.headersSent) res.status(404).json({ message: "Avatar not found" });
      });
      stream.pipe(res);
      return;
    }
    return res.status(404).json({ message: "Avatar not found" });
  } catch (err) {
    console.warn("avatar proxy error:", err?.message || err);
    return res.status(404).json({ message: "Avatar not found" });
  }
});

// API Routes

console.log("🔹 Registering routes...");
app.use("/api/auth", authRoutes);
app.use("/api/rankings", rankingRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/superadmin", superAdminRoutes);
app.use("/api/volunteers", volunteerRoutes);
app.use("/api/coaches", coachRoutes);
app.use("/api/organizers", organizerRoutes);
app.use("/api/clubadmins", clubAdminRoutes);
app.use("/api/clubs", clubsRoutes);
console.log("🔹 Registering feedbacks route...");
app.use("/api/feedbacks", feedbackRoutes);
console.log("🔹 Feedbacks route registered");
app.use("/api/logs", logRoutes);
console.log("🔹 Registering users route...");
app.use("/api/users", userRoutes);
console.log("🔹 Users route registered");
app.use("/api/posts", postRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/profiles", profileRoutes);
app.use("/api/badges", badgesRoutes);
app.use("/api/tournaments", tournamentRoutes);
app.use("/api/events2", events2Routes);
app.use("/api/verifications", verificationRoutes);
app.use("/api/forgotPassword", forgotPasswordRoutes);
app.use("/api/notifications", NotificationRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/sponsors", sponsorRoutes);
app.use("/api/luzon-2026-team-registration", luzonTeamRegistrationRoutes);
app.use("/api/luzon-2026-singles-doubles-registration", luzonSinglesDoublesRegistrationRoutes);
app.use("/api/open-luzon-2026-players-registration", openLuzonPlayersRegistrationRoutes);
app.use("/api/geo", geoRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/referees", refereeRoutes);
app.use("/api/referee-admins", refereeAdminRoutes);
app.use("/api/vendor-admins", vendorAdminRoutes);
app.use("/api/google", googleAuthRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/petitions", petitionsRoutes);
app.use("/api/support-chat", supportChatRoutes);
app.use("/api/shop", shopRoutes);
app.use("/uploads", express.static("uploads", { maxAge: 31536000000, immutable: true }));
app.use("/api/test", testRoutes);
// Serve project asset images for OG previews (e.g., /assets/brittany_cover.jpg)
app.use(
  "/assets",
  express.static(path.join(__dirname, "..", "assets"))
);
// Link preview routes (Open Graph HTML)
app.use("/share", shareRoutes);

// Diagnostics route (registered after core routes to avoid noise)
const diagnosticsRoutes = require("./routes/diagnostics");
app.use("/api/diagnostics", diagnosticsRoutes);

// Lightweight health check (no DB dependency)
app.get("/api/health", (req, res) => {
  try {
    res.json({ status: "ok", timestamp: new Date().toISOString(), build: BUILD_MARKER });
  } catch (_) {
    res.status(200).json({ status: "ok" });
  }
});

// Default route
app.get("/", (req, res) => res.send("Pickleball backend is running"));

// Generic DUPR webhooks (future: match.updated, match.verified, rating.updated)
app.post("/api/webhooks/dupr", express.json(), async (req, res) => {
  try {
    const event = req.body || {};
    const topic = String(event.topic || event.type || "").trim();
    const payload = event.payload || event.data || {};
    console.log("DUPR webhook (generic) received:", {
      topic,
      keys: Object.keys(payload || {}),
    });
    // TODO: handle state transitions when DUPR confirms updates/verification
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
});

// DUPR webhook endpoint (LOGIN event)
app.post("/api/dupr/webhook", express.json(), async (req, res) => {
  try {
    const event = req.body || {};
    const topic = event.topic || event.type || "";
    const payload = event.payload || event.data || {};
    console.log("DUPR webhook received:", { topic, keys: Object.keys(payload || {}) });
    const duprId =
      String(payload.duprId || payload.userId || payload.id || "").trim();
    const singles =
      typeof payload.singles === "number"
        ? payload.singles
        : typeof payload.ratings?.singles === "number"
        ? payload.ratings.singles
        : null;
    const doubles =
      typeof payload.doubles === "number"
        ? payload.doubles
        : typeof payload.ratings?.doubles === "number"
        ? payload.ratings.doubles
        : null;
    if (duprId) {
      try {
        const user = await User.findOne({ duprId });
        if (user) {
          if (!user.dupr) user.dupr = {};
          user.dupr.duprId = duprId;
          user.dupr.singlesRating = singles !== null ? singles : null;
          user.dupr.doublesRating = doubles !== null ? doubles : null;
          user.dupr.updatedAt = new Date();
          await user.save();
        }
      } catch (_) {}
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("DUPR webhook error:", err);
    return res.status(500).json({ ok: false });
  }
});

// Subscribe to DUPR webhook on startup if configured
async function subscribeToDuprWebhook() {
  try {
    // Only auto-subscribe when explicitly enabled (prevents noisy startup failures in dev).
    const enabled = String(process.env.DUPR_WEBHOOK_AUTOSUBSCRIBE || "").trim() === "1";
    if (!enabled) return;

    const clean = (s) => String(s || "").trim().replace(/^"+|"+$/g, "");
    const decodeClientKeyFromXAuth = (rawXAuth) => {
      try {
        const x = clean(rawXAuth);
        if (!x) return "";
        const decoded = Buffer.from(x, "base64").toString("utf8");
        const parts = decoded.split(":");
        return clean(parts[0]);
      } catch (_) {
        return "";
      }
    };

    // IMPORTANT: webhook subscription is an API call; use the API host by default.
    const url = clean(process.env.DUPR_WEBHOOK_SUBSCRIBE_URL) || "https://api.uat.dupr.gg/api/v1.0/webhook";
    const clientId = clean(process.env.DUPR_CLIENT_KEY) || clean(process.env.DUPR_CLIENT_ID) || decodeClientKeyFromXAuth(process.env.DUPR_X_AUTH) || "";
    const webhookUrl = clean(process.env.DUPR_WEBHOOK_URL) || "https://phpickleballleague.com/api/dupr/webhook";
    if (!clientId || !url || !webhookUrl) {
      console.log("DUPR webhook subscription skipped (missing config).");
      return;
    }
    const headers = { "Content-Type": "application/json" };
    let bearer = clean(process.env.DUPR_PARTNER_TOKEN);
    if (!bearer) {
      try {
        // Use a token minted for the same host as the webhook URL (avoids issuer/host mismatches)
        bearer = await duprService.getAccessToken(url);
      } catch (e) {
        console.warn("DUPR webhook subscription skipped (token unavailable):", e?.response?.data || e?.message || String(e));
        return;
      }
    }
    if (bearer) {
      headers["Authorization"] = `Bearer ${bearer}`;
    }
    const apiKey = clean(process.env.DUPR_API_KEY) || clean(process.env.DUPR_CLIENT_KEY) || decodeClientKeyFromXAuth(process.env.DUPR_X_AUTH) || "";
    if (apiKey) headers["x-api-key"] = String(apiKey);
    const topics = String(process.env.DUPR_WEBHOOK_TOPICS || "RATING")
      .split(",")
      .map((t) => String(t || "").trim().toUpperCase())
      .filter(Boolean);
    const payload = { clientId, webhookUrl, topics: topics.length ? topics : ["RATING"] };
    const axios = require("axios");
    const resp = await axios.post(url, payload, { headers, timeout: 20000 });
    console.log("DUPR webhook subscribed:", resp.status);
  } catch (err) {
    console.warn("DUPR webhook subscribe failed:", err?.response?.data || err.message);
  }
}

const PORT = parseInt(process.env.PORT || "5000", 10);
let io = null;
try {
  const { Server } = require("socket.io");
  io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] } });
} catch (_) {}
global.io = io;
global.emitTournamentEvent = function (tid, evt, payload) {
  try {
    if (global.io) global.io.to(`tournament:${tid}`).emit(evt, payload);
  } catch (_) {}
};
if (io) {
  io.on("connection", (socket) => {
    try { socket.data.joinCount = 0; } catch (_) {}
    let lastReset = Date.now();
    socket.on("tournament:join", (tid) => {
      try {
        const ip = (socket.handshake.address || "").replace(/^::ffff:/, "");
        const now = Date.now();
        if (now - lastReset > 60000) { lastReset = now; socket.data.joinCount = 0; }
        socket.data.joinCount = (socket.data.joinCount || 0) + 1;
        if (socket.data.joinCount > 30) return; // soft drop flood
        socket.join(`tournament:${tid}`);
      } catch (_) {}
    });
    socket.on("tournament:leave", (tid) => {
      try { socket.leave(`tournament:${tid}`); } catch (_) {}
    });
  });
}
const memLogEnabled = String(process.env.MEMORY_LOG || "").trim() === "1";
const memInterval = parseInt(process.env.MEMORY_LOG_INTERVAL_MS || "60000", 10);
if (memLogEnabled && Number.isFinite(memInterval) && memInterval > 0) {
  setInterval(() => {
    try {
      const m = process.memoryUsage();
      const rss = Math.round(m.rss / (1024 * 1024));
      const heap = Math.round(m.heapUsed / (1024 * 1024));
      const ext = Math.round(m.external / (1024 * 1024));
      console.log(`mem rss=${rss}MB heap=${heap}MB ext=${ext}MB`);
    } catch (_) {}
  }, memInterval);
}
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  subscribeToDuprWebhook();
});
