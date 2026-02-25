// server.js
const path = require("path");
const express = require("express");
const mqtt = require("mqtt");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ====== CONFIG ======
const MQTT_HOST = "mqtt://broker.hivemq.com:1883";

const DEVICE_ID = "ESP32-SDA-WOKWI"; // เปลี่ยนเป็น ID ของอุปกรณ์คุณ (ต้องตรงกับที่ ESP32 ใช้ publish)
const TOPIC_TELEMETRY   = `smartdesk/${DEVICE_ID}/telemetry`;
const TOPIC_CMD         = `smartdesk/${DEVICE_ID}/cmd`;
const TOPIC_LCD_STANDBY = `smartdesk/${DEVICE_ID}/lcd/standby`; // ✅ retained state topic
const TOPIC_RELAY_STATE = `smartdesk/${DEVICE_ID}/relay/state`; // ✅ retained relay state topic

// ====== SIMPLE ADMIN KEY ======
const ADMIN_KEY = process.env.ADMIN_KEY || "1234"; // เปลี่ยนค่านี้ใน production และตั้งเป็นตัวแปรแวดล้อม ADMIN_KEY เพื่อความปลอดภัย
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "Forbidden" });
  next();
}

// ====== SIMPLE RATE LIMITER (in-memory) ======
const rateLimitStore = new Map(); // { ip: { count, timestamp } }

function simpleRateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!rateLimitStore.has(ip)) {
      rateLimitStore.set(ip, { count: 1, timestamp: now });
      return next();
    }
    
    const record = rateLimitStore.get(ip);
    
    // Reset if window expired
    if (now - record.timestamp > windowMs) {
      rateLimitStore.set(ip, { count: 1, timestamp: now });
      return next();
    }
    
    // Within window - check limit
    if (record.count >= maxRequests) {
      return res.status(429).json({ ok: false, error: "Too many requests, please try again later." });
    }
    
    record.count++;
    next();
  };
}

function cmdRateLimit(maxRequests, windowMs) {
  const cmdStore = new Map(); // { adminKey or ip: { count, timestamp } }
  
  return (req, res, next) => {
    const key = req.headers["x-admin-key"] || req.ip;
    const now = Date.now();
    
    if (!cmdStore.has(key)) {
      cmdStore.set(key, { count: 1, timestamp: now });
      return next();
    }
    
    const record = cmdStore.get(key);
    
    // Reset if window expired
    if (now - record.timestamp > windowMs) {
      cmdStore.set(key, { count: 1, timestamp: now });
      return next();
    }
    
    // Within window - check limit
    if (record.count >= maxRequests) {
      return res.status(429).json({ ok: false, error: "Too many commands, please slow down." });
    }
    
    record.count++;
    next();
  };
}

const generalLimiter = simpleRateLimit(100, 30000); // 100 requests per 30 seconds
const cmdLimiter = cmdRateLimit(20, 30000);         // 20 commands per 30 seconds

// Apply general limiter to all /api routes
app.use("/api/", generalLimiter);

// ====== DB ======
const db = new Database("data.db");

db.exec(`
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  pir INTEGER NOT NULL,
  ldr INTEGER NOT NULL,
  relay INTEGER NOT NULL,
  auto INTEGER NOT NULL,
  wifi INTEGER NOT NULL,
  rssi INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lcd_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  line2 TEXT NOT NULL,
  line3 TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sitting_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_start INTEGER NOT NULL,
  ts_end INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  session_id INTEGER NOT NULL
);
`);

const insertTelemetry = db.prepare(`
  INSERT INTO telemetry (ts, pir, ldr, relay, auto, wifi, rssi)
  VALUES (@ts, @pir, @ldr, @relay, @auto, @wifi, @rssi)
`);

const insertEvent = db.prepare(`
  INSERT INTO events (ts, type, detail) VALUES (?, ?, ?)
`);

const insertLcdMsg = db.prepare(`
  INSERT INTO lcd_messages (ts, line2, line3, source)
  VALUES (?, ?, ?, ?)
`);

const insertSitting = db.prepare(`
  INSERT INTO sitting_sessions (ts_start, ts_end, duration_ms, session_id)
  VALUES (?, ?, ?, ?)
`);

const getLatest = db.prepare(`SELECT * FROM telemetry ORDER BY ts DESC LIMIT 1`);

const getHistory = db.prepare(`
  SELECT * FROM telemetry
  WHERE ts >= ?
  ORDER BY ts DESC
  LIMIT ?
`);

// ====== MQTT client ======
const m = mqtt.connect(MQTT_HOST, {
  clientId: `WEB-DASH-${Math.random().toString(16).slice(2)}`,
  clean: true,
  reconnectPeriod: 2000,
});

m.on("connect", () => {
  console.log("[MQTT] connected");
  m.subscribe(TOPIC_TELEMETRY, (err) => {
    if (err) console.error("subscribe error", err);
    else console.log("[MQTT] subscribed:", TOPIC_TELEMETRY);
  });

  m.subscribe(TOPIC_RELAY_STATE, (err) => {
    if (err) console.error("subscribe error", err);
    else console.log("[MQTT] subscribed:", TOPIC_RELAY_STATE);
  });
});

m.on("reconnect", () => console.log("[MQTT] reconnecting..."));
m.on("error", (e) => console.log("[MQTT] error:", e.message));

let lastRelay = null;
let lastRelayState = null;
let lastRelayStateTs = null;
let lastRelayStateSource = null;
// ====== Sitting runtime state (for web status) ======
let seatSeated = false;
let seatSessionId = null;
let seatStartTs = null;     // server time (Date.now)
let seatLastEventTs = null;
let seatLastPir = 0;        // ✅ Latest PIR value from telemetry
let seatLastMotionTs = null; // ✅ Timestamp (Date.now) of last PIR=1
let seatSitMs = 0;          // ✅ sit duration in current session (from ESP)
let seatAwayMs = 0;         // ✅ away/no-motion duration (from ESP)
let seatLeaveConfirmMs = 0; // ✅ leave confirm threshold (from ESP)


// best-effort restore from DB (server restart)
try {
  const lastSeatEvent = db.prepare(`
    SELECT * FROM events
    WHERE type IN ('session_start','session_end')
    ORDER BY ts DESC
    LIMIT 1
  `).get();
  if (lastSeatEvent && lastSeatEvent.type === 'session_start') {
    seatSeated = true;
    seatStartTs = lastSeatEvent.ts;
    try {
      const d = JSON.parse(lastSeatEvent.detail);
      seatSessionId = Number(d.session_id ?? 0) || null;
    } catch {}
  }
} catch {}

m.on("message", (topic, payload) => {
  if (topic === TOPIC_RELAY_STATE) {
    const raw = payload.toString().trim();
    let next = null;
    let ts = Date.now();

    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "number") next = parsed ? 1 : 0;
      else if (typeof parsed === "string") next = /^(1|on|true)$/i.test(parsed) ? 1 : 0;
      else if (parsed && typeof parsed === "object") {
        if (typeof parsed.relay !== "undefined") next = Number(parsed.relay) ? 1 : 0;
        if (typeof parsed.ts === "number") ts = parsed.ts;
      }
    } catch {
      if (/^(1|on|true)$/i.test(raw)) next = 1;
      else if (/^(0|off|false)$/i.test(raw)) next = 0;
    }

    if (next !== null) {
      lastRelayState = next;
      lastRelayStateTs = ts;
      lastRelayStateSource = "relay-state";
      insertEvent.run(Date.now(), "RELAY_ACK", `relay=${next}`);
    }
    return;
  }

  if (topic !== TOPIC_TELEMETRY) return;

  try {
    const obj = JSON.parse(payload.toString());

    // ✅ 1) Event message (จาก ESP32) -> เก็บลง events + อัปเดตสถานะการนั่ง
    if (obj && typeof obj === "object" && typeof obj.type === "string") {
      const type = obj.type;
      const detail = JSON.stringify(obj);

      insertEvent.run(Date.now(), type, detail);

      seatLastEventTs = Date.now();

      if (type === "session_start") {
        seatSeated = true;
        seatSessionId = Number(obj.session_id ?? 0) || null;
        seatStartTs = Date.now();
      }

      if (type === "session_end") {
        const dur = Number(obj.duration_ms ?? 0) || 0;
        const sid = Number(obj.session_id ?? 0) || 0;

        if (seatStartTs && dur > 0) {
          insertSitting.run(seatStartTs, Date.now(), dur, sid);
        }

        seatSeated = false;
        seatSessionId = null;
        seatStartTs = null;
      }

      return;
    }

    // ✅ 2) Telemetry เดิม -> เก็บลง telemetry ตามปกติ
    const row = {
      ts: Date.now(),
      pir: Number(obj.pir ?? 0),
      ldr: Number(obj.ldr ?? 0),
      relay: Number(obj.relay ?? 0),
      auto: Number(obj.auto ?? 1),
      wifi: Number(obj.wifi ?? 1),
      rssi: Number(obj.rssi ?? -999),
    };

    insertTelemetry.run(row);

    // ✅ Seat timing from ESP (keeps web time aligned with ESP millis)
    if (obj && typeof obj === "object" && obj.seat && typeof obj.seat === "object") {
      const s = obj.seat;
      if (typeof s.seated !== "undefined") seatSeated = !!Number(s.seated);
      if (typeof s.session_id !== "undefined") seatSessionId = Number(s.session_id) || seatSessionId;
      if (typeof s.sit_ms !== "undefined") seatSitMs = Math.max(0, Number(s.sit_ms) || 0);
      if (typeof s.away_ms !== "undefined") seatAwayMs = Math.max(0, Number(s.away_ms) || 0);
      if (typeof s.leave_confirm_ms !== "undefined") seatLeaveConfirmMs = Math.max(0, Number(s.leave_confirm_ms) || 0);

      // When ESP says not seated, clear timers (UI should show AWAY)
      if (!seatSeated) {
        seatSitMs = 0;
        seatAwayMs = 0;
      }
    }

    // ✅ Track PIR state for "awayMs" calculation
    seatLastPir = row.pir;
    if (row.pir === 1) {
      seatLastMotionTs = row.ts; // Record last motion timestamp
      seatAwayMs = 0; // Reset away time when motion detected
    }

    if (lastRelay === null) lastRelay = row.relay;
    if (row.relay !== lastRelay) {
      insertEvent.run(Date.now(), "RELAY_CHANGE", `relay=${row.relay}`);
      lastRelay = row.relay;
    }

    // ✅ ALWAYS update relay state from telemetry (fixes state stuck bug)
    lastRelayState = row.relay;
    lastRelayStateTs = row.ts;
    lastRelayStateSource = "telemetry";
  } catch (e) {
    console.log("[MQTT] bad JSON:", e.message);
  }
});

// ====== COMMAND VALIDATION ======
function isValidCmd(cmd) {
  if (typeof cmd !== "string") return { ok: false, error: "cmd must be string" };
  const c = cmd.trim();
  if (!c) return { ok: false, error: "empty cmd" };

  const allowedExact = new Set([
    "RELAY:ON",
    "RELAY:OFF",
    "AUTO:ON",
    "AUTO:OFF",
    "LCD:CLEAR",
    "LCD:STANDBY:ON",
    "LCD:STANDBY:OFF",
  ]);

  if (allowedExact.has(c)) return { ok: true, cmd: c };

  // LCD:STANDBY:<line2>|<line3>
  if (c.startsWith("LCD:STANDBY:")) {
    const data = c.slice("LCD:STANDBY:".length);
    const clipped = data.slice(0, 120);
    return { ok: true, cmd: "LCD:STANDBY:" + clipped };
  }

  // LCD:STABLESEC:<2-60>
  if (c.startsWith("LCD:STABLESEC:")) {
    const n = Number(c.slice("LCD:STABLESEC:".length));
    if (!Number.isFinite(n)) return { ok: false, error: "STABLESEC must be number" };
    const sec = Math.max(2, Math.min(60, Math.floor(n)));
    return { ok: true, cmd: `LCD:STABLESEC:${sec}` };
  }

  return { ok: false, error: "Invalid cmd" };
}

// ====== API ======
app.get("/api/latest", (req, res) => {
  const row = getLatest.get() || null;
  
  // ✅ ถ้า relay state topic ยังไม่มี ให้ใช้ telemetry relay แทน
  let relayValue = lastRelayState;
  let relaySource = lastRelayStateSource;
  
  if (relayValue === null && row) {
    relayValue = row.relay ?? null;
    relaySource = "telemetry-fallback";
  }
  
  res.json({
    deviceId: DEVICE_ID,
    latest: row,
    relayState: {
      value: relayValue,
      ts: lastRelayStateTs || (row ? row.ts : null),
      source: relaySource,
    },
  });
});

app.get("/api/relay/state", (req, res) => {
  res.json({
    deviceId: DEVICE_ID,
    relay: lastRelayState,
    ts: lastRelayStateTs,
    source: lastRelayStateSource,
  });
});

app.get("/api/history", (req, res) => {
  const limit = Math.min(2000, Math.max(10, Number(req.query.limit ?? 200)));

  let rows;
  if (req.query.minutes !== undefined) {
    const minutes = Math.max(1, Number(req.query.minutes));
    const since = Date.now() - minutes * 60 * 1000;
    rows = getHistory.all(since, limit);
  } else {
    rows = db.prepare(`
      SELECT * FROM telemetry
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit);
  }

  res.json({ deviceId: DEVICE_ID, rows });
});


// ====== SITTING STATUS / ALERTS ======
app.get("/api/seat/status", (req, res) => {
  const now = Date.now();

  // ✅ Prefer ESP-provided timing (aligned with ESP millis). Fallback to server time if missing.
  const espSinceMs = (seatSeated && Number.isFinite(seatSitMs) && seatSitMs > 0) ? seatSitMs : null;
  const sinceMs = (espSinceMs != null) ? espSinceMs : ((seatSeated && seatStartTs) ? (now - seatStartTs) : 0);

  
    // ✅ Prefer ESP-provided away time; fallback to server calc (based on last PIR=1 telemetry)
  const espAwayMs = (seatSeated && Number.isFinite(seatAwayMs) && seatAwayMs > 0) ? seatAwayMs : null;

  // Fallback: If still in session but PIR=0 now -> calculate time away
  const awayMs = (espAwayMs != null)
    ? espAwayMs
    : ((seatSeated && seatLastPir === 0 && seatLastMotionTs) ? Math.max(0, now - seatLastMotionTs) : 0);
res.json({
    ok: true,
    deviceId: DEVICE_ID,
    seated: seatSeated,
    sessionId: seatSessionId,
    tsStart: seatStartTs,
    tsNow: now,
    sinceMs,
    sinceMinutes: Math.floor(sinceMs / 60000),
    lastEventTs: seatLastEventTs,
    // ✅ Timing from ESP (if available)
    sitMs: espSinceMs != null ? espSinceMs : sinceMs,
    leaveConfirmMs: seatLeaveConfirmMs,

    // ✅ Away time fields
    lastPir: seatLastPir,
    lastMotionTs: seatLastMotionTs,
    awayMs,
    awayMinutes: Math.floor(awayMs / 60000),
    awaySeconds: Math.floor(awayMs / 1000),
  });
});

app.get("/api/alerts/sit", (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE type = 'sit_alert'
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit);
  res.json({ ok: true, rows });
});

app.get("/api/events", (req, res) => {
  const rows = db.prepare(`SELECT * FROM events ORDER BY ts DESC LIMIT 100`).all();
  res.json({ rows });
});

// ✅ ดูข้อความล่าสุดจาก DB (ไว้โชว์ใน lcd_log)
app.get("/api/lcd/latest", (req, res) => {
  const row = db.prepare(`SELECT * FROM lcd_messages ORDER BY ts DESC LIMIT 1`).get() || null;
  res.json({ ok: true, latest: row });
});

app.get("/api/lcd/history", (req, res) => {
  const rows = db.prepare(`SELECT * FROM lcd_messages ORDER BY ts DESC LIMIT 50`).all();
  res.json({ ok: true, rows });
});

// ✅ ส่งคำสั่งไป ESP32 ผ่าน MQTT + log + retained standby state
app.post("/api/cmd", cmdLimiter, (req, res) => {
  const { cmd } = req.body || {};
  const v = isValidCmd(cmd);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const finalCmd = v.cmd;

  // 1) ส่งคำสั่งปกติไปที่ cmd topic
  m.publish(TOPIC_CMD, finalCmd, { qos: 0, retain: false }, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });

    insertEvent.run(Date.now(), "CMD_SENT", finalCmd);

    // 2) ถ้าเป็นคำสั่งตั้ง Standby message → เก็บ DB + publish retained state
    if (finalCmd.startsWith("LCD:STANDBY:")) {
      const data = finalCmd.slice("LCD:STANDBY:".length);
      const sep = data.indexOf("|");

      let line2 = "";
      let line3 = "";

      if (sep >= 0) {
        line2 = data.slice(0, sep).trim();
        line3 = data.slice(sep + 1).trim();
      } else {
        line2 = data.trim();
        line3 = "";
      }

      // จำกัด 20 ตัว/บรรทัด (LCD 20x4)
      line2 = line2.slice(0, 20);
      line3 = line3.slice(0, 20);

      // ✅ DB log
      insertLcdMsg.run(Date.now(), line2, line3, "web");
      insertEvent.run(Date.now(), "LCD_STANDBY_SET", `line2="${line2}" line3="${line3}"`);

      // ✅ MQTT retain state (ให้ ESP ที่รีสตาร์ทมาใหม่ได้ข้อความล่าสุดทันที)
      const retainedPayload = JSON.stringify({
        ts: Date.now(),
        line2,
        line3,
        source: "retained",
      });

      m.publish(TOPIC_LCD_STANDBY, retainedPayload, { qos: 0, retain: true }, (e2) => {
        if (e2) console.log("[MQTT] retain publish error:", e2.message);
        else console.log("[MQTT] retained standby updated:", TOPIC_LCD_STANDBY);
      });
    }

    res.json({ ok: true, topic: TOPIC_CMD, cmd: finalCmd, retainedTopic: TOPIC_LCD_STANDBY });
  });
});

// ====== TABLE VIEW API ======
app.get("/api/table", (req, res) => {
  const rows = db.prepare(`
    SELECT 
      id,
      ts,
      datetime(ts/1000,'unixepoch','localtime') as time,
      pir,
      ldr,
      relay,
      auto,
      wifi,
      rssi
    FROM telemetry
    ORDER BY ts DESC
    LIMIT 50
  `).all();

  res.json({ ok: true, rows });
});

app.get("/api/telemetry", (req, res) => {
  const rows = db.prepare(`
    SELECT id, ts, pir, ldr, relay, auto, wifi, rssi
    FROM telemetry
    ORDER BY ts DESC
    LIMIT 50
  `).all();
  res.json({ ok: true, rows });
});

app.delete("/api/telemetry/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:"Bad id" });

  const info = db.prepare(`DELETE FROM telemetry WHERE id=?`).run(id);
  insertEvent.run(Date.now(), "TELEMETRY_DELETE", `id=${id}, changes=${info.changes}`);
  res.json({ ok: true, deleted: info.changes });
});

app.put("/api/telemetry/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:"Bad id" });

  const cur = db.prepare(`SELECT * FROM telemetry WHERE id=?`).get(id);
  if (!cur) return res.status(404).json({ ok:false, error:"Not found" });

  const next = {
    ts:    Number.isFinite(req.body.ts)    ? req.body.ts    : cur.ts,
    pir:   Number.isFinite(req.body.pir)   ? req.body.pir   : cur.pir,
    ldr:   Number.isFinite(req.body.ldr)   ? req.body.ldr   : cur.ldr,
    relay: Number.isFinite(req.body.relay) ? req.body.relay : cur.relay,
    auto:  Number.isFinite(req.body.auto)  ? req.body.auto  : cur.auto,
    wifi:  Number.isFinite(req.body.wifi)  ? req.body.wifi  : cur.wifi,
    rssi:  Number.isFinite(req.body.rssi)  ? req.body.rssi  : cur.rssi,
  };

  db.prepare(`
    UPDATE telemetry
    SET ts=?, pir=?, ldr=?, relay=?, auto=?, wifi=?, rssi=?
    WHERE id=?
  `).run(next.ts, next.pir, next.ldr, next.relay, next.auto, next.wifi, next.rssi, id);

  insertEvent.run(Date.now(), "TELEMETRY_UPDATE", `id=${id} -> ${JSON.stringify(next)}`);
  res.json({ ok: true, id, next });
});
// ====== SITTING API ======
app.get("/api/sitting/sessions", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));

  const rows = db.prepare(`
    SELECT
      id,
      ts_start,
      ts_end,
      duration_ms,
      session_id,
      datetime(ts_start/1000,'unixepoch','localtime') as start_time,
      datetime(ts_end/1000,'unixepoch','localtime') as end_time,
      round(duration_ms/60000.0, 1) as minutes
    FROM sitting_sessions
    ORDER BY ts_end DESC
    LIMIT ?
  `).all(limit);

  res.json({ ok: true, rows });
});

// สรุปเวลานั่งรายวัน (ย้อนหลัง N วัน)
app.get("/api/sitting/summary", (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7)));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT
      date(ts_end/1000,'unixepoch','localtime') as day,
      round(sum(duration_ms)/60000.0, 1) as total_minutes,
      count(*) as sessions
    FROM sitting_sessions
    WHERE ts_end >= ?
    GROUP BY day
    ORDER BY day DESC
  `).all(since);

  res.json({ ok: true, rows });
});

app.listen(3000, () => console.log("Dashboard running on http://localhost:3000"));