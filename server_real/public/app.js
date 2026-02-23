// public/app.js

// ===== SETTINGS =====
const CONNECTION_TIMEOUT = 15000; // 15s (เหมาะกับ ESP publish 10s)

// ===== Connection tracking (based on telemetry ts) =====
let lastTelemetryTs = null;
let hasFetchedOnce = false;
let lastRelayState = null;
let lastRelayStateTs = null;
let lastRelayStateSource = null;

// ===== API helpers =====
async function apiGet(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status}`);
  return r.json();
}

// ===== UI helpers =====
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setSummaryValue(id, text, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `summary-value ${state || ""}`.trim();
}

// ===== Connection UI =====
function updateConnectionStatus(connected, reason) {
  const pill = document.getElementById("statusPill");
  const text = pill?.querySelector(".status-text");
  if (!pill) return;

  pill.classList.remove("connected", "disconnected");

  if (connected) {
    pill.classList.add("connected");
    if (text) text.textContent = "ESP32 Connected";
  } else {
    pill.classList.add("disconnected");
    if (text) text.textContent = reason || "Disconnected";
  }
}

function updateConnectionFromTelemetryTs() {
  if (!hasFetchedOnce) {
    updateConnectionStatus(false, "Waiting for ESP32...");
    return;
  }
  if (!lastTelemetryTs) {
    updateConnectionStatus(false, "No telemetry yet");
    return;
  }

  const age = Date.now() - lastTelemetryTs;
  if (age <= CONNECTION_TIMEOUT) updateConnectionStatus(true);
  else updateConnectionStatus(false, `Stale ${Math.round(age / 1000)}s`);
}

// ===== Render latest =====
function renderLatest(row, relayStateValue) {
  const hasRelayState = relayStateValue === 0 || relayStateValue === 1;
  if (!row) {
    if (hasRelayState) {
      const relayOn = relayStateValue === 1;
      setSummaryValue("sumRelayValue", relayOn ? "ON" : "OFF", relayOn ? "ok" : "off");
    } else {
      setSummaryValue("sumRelayValue", "-", "off");
    }
    setSummaryValue("sumAutoValue", "-", "mid");
    setSummaryValue("sumWifiValue", "-", "off");
    return `<div class="empty">ยังไม่มีข้อมูล (รอ ESP32 publish telemetry)</div>`;
  }

  const dt = new Date(row.ts).toLocaleString();
  const relayOn = hasRelayState ? relayStateValue === 1 : !!row.relay;
  const autoOn = !!row.auto;
  const wifiOn = !!row.wifi;

  const pirNum = Number(row.pir ?? 0);
  const pirActive = pirNum === 1;

  const ldrNum = row.ldr == null ? null : Number(row.ldr);
  let ldrState = "warn";
  let ldrLabel = "MID";
  if (ldrNum != null && !Number.isNaN(ldrNum)) {
    if (ldrNum < 1500) { ldrState = "ok";  ldrLabel = "DARK"; }
    else if (ldrNum > 1900) { ldrState = "off"; ldrLabel = "BRIGHT"; }
  }

  setSummaryValue("sumRelayValue", relayOn ? "ON" : "OFF", relayOn ? "ok" : "off");
  setSummaryValue("sumAutoValue", autoOn ? "AUTO" : "MANUAL", autoOn ? "ok" : "mid");
  setSummaryValue("sumWifiValue", wifiOn ? "OK" : "DOWN", wifiOn ? "ok" : "off");

  const rssi = row.rssi ?? "-";

  return `
    <div class="status-grid">
      <div class="kv">
        <div class="k">เวลา</div>
        <div class="v">${escapeHtml(dt)}</div>
      </div>

      <div class="kv">
        <div class="k">PIR</div>
        <div class="v">
          <span class="pill ${pirActive ? "warn" : "ok"}">${pirActive ? "MOTION" : "IDLE"}</span>
          <span class="value-num">${pirNum}</span>
        </div>
      </div>

      <div class="kv">
        <div class="k">LDR</div>
        <div class="v">
          <span class="pill ${ldrState}">${ldrLabel}</span>
          <span class="value-num">${ldrNum ?? "-"}</span>
        </div>
      </div>

      <div class="kv">
        <div class="k">RSSI</div>
        <div class="v">${escapeHtml(rssi)}</div>
      </div>

      <div class="kv">
        <div class="k">Relay</div>
        <div class="v"><span class="pill ${relayOn ? "ok" : "off"}">${relayOn ? "ON" : "OFF"}</span></div>
      </div>

      <div class="kv">
        <div class="k">Auto</div>
        <div class="v"><span class="pill ${autoOn ? "ok" : "off"}">${autoOn ? "ON" : "OFF"}</span></div>
      </div>

      <div class="kv">
        <div class="k">WiFi</div>
        <div class="v"><span class="pill ${wifiOn ? "ok" : "warn"}">${wifiOn ? "OK" : "DOWN"}</span></div>
      </div>
    </div>
  `;
}

// ===== Chart =====
let chartInstance = null;
let lastChartDataHash = null; // เก็บ hash ของข้อมูลกราฟล่าสุด
let sittingChartInstance = null;
let lastSittingChartDataHash = null;

function generateDataHash(rows) {
  if (!rows || rows.length === 0) return "empty";
  // ใช้ timestamp ล่าสุด + จำนวน rows เป็น hash ง่าย ๆ
  const lastRow = rows[rows.length - 1];
  return `${lastRow.ts}-${rows.length}`;
}

function renderChart(rows) {
  if (!rows || rows.length === 0) return;

  const currentHash = generateDataHash(rows);
  
  // ถ้า hash เหมือนเดิม (ข้อมูลไม่เปลี่ยน) ก็ไม่ต้อง render
  if (currentHash === lastChartDataHash) {
    return;
  }
  
  lastChartDataHash = currentHash;

  const ordered = [...rows].reverse();
  const labels = ordered.map(r => new Date(r.ts).toLocaleTimeString("th-TH"));
  const pirData = ordered.map(r => r.pir ?? 0);
  const ldrData = ordered.map(r => r.ldr ?? 0);

  const ctx = document.getElementById("historyChart");
  if (!ctx) return;

  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "PIR (0/1)",
          data: pirData,
          borderColor: "#ef4444",
          backgroundColor: "rgba(239, 68, 68, 0.12)",
          borderWidth: 2.5,
          tension: 0.3,
          fill: true,
          pointBackgroundColor: "#ef4444",
          pointBorderColor: "#fff",
          pointBorderWidth: 1.5,
          pointRadius: 3,
        },
        {
          label: "LDR (0-4095)",
          data: ldrData,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.12)",
          borderWidth: 2.5,
          tension: 0.3,
          fill: true,
          yAxisID: "y1",
          pointBackgroundColor: "#2563eb",
          pointBorderColor: "#fff",
          pointBorderWidth: 1.5,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { 
            font: { size: 12, weight: "600" }, 
            padding: 16,
            color: "#0f172a",
            boxWidth: 12,
            boxHeight: 12,
          }
        },
        filler: { propagate: true },
      },
      scales: {
        x: {
          grid: { color: "rgba(15, 23, 42, 0.08)" },
          ticks: { color: "#475569", font: { size: 11 } },
        },
        y: {
          position: "left",
          suggestedMin: 0,
          suggestedMax: 1,
          grid: { color: "rgba(15, 23, 42, 0.08)" },
          ticks: { color: "#475569", font: { size: 11 } },
          title: { display: true, text: "PIR", color: "#0f172a", font: { size: 12, weight: "600" } },
        },
        y1: {
          position: "right",
          grid: { drawOnChartArea: false },
          ticks: { color: "#475569", font: { size: 11 } },
          title: { display: true, text: "LDR", color: "#0f172a", font: { size: 12, weight: "600" } },
        },
      },
    },
  });
}

// ===== Sitting Chart =====
async function renderSittingChart() {
  try {
    const data = await apiGet("/api/sitting/summary?days=7");
    if (!data.ok || !data.rows || data.rows.length === 0) {
      return;
    }

    const currentHash = `sitting-${data.rows.map(r => r.day).join(',')}`;
    if (currentHash === lastSittingChartDataHash) {
      return;
    }
    lastSittingChartDataHash = currentHash;

    const sortedRows = [...data.rows].reverse();
    const labels = sortedRows.map(row => row.day);
    const minutes = sortedRows.map(row => row.total_minutes);
    const sessions = sortedRows.map(row => row.sessions);

    const ctx = document.getElementById("sittingChart");
    if (!ctx) return;

    if (sittingChartInstance) {
      sittingChartInstance.destroy();
    }

    sittingChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "นาทีการนั่ง",
            data: minutes,
            backgroundColor: "rgba(75, 192, 192, 0.7)",
            borderColor: "rgba(75, 192, 192, 1)",
            borderWidth: 1,
            yAxisID: "y",
            borderRadius: 4
          },
          {
            label: "จำนวน Sessions",
            data: sessions,
            backgroundColor: "rgba(255, 159, 64, 0.7)",
            borderColor: "rgba(255, 159, 64, 1)",
            borderWidth: 1,
            yAxisID: "y1",
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            display: true,
            position: "top"
          }
        },
        scales: {
          y: {
            type: "linear",
            display: true,
            position: "left",
            title: {
              display: true,
              text: "นาที"
            }
          },
          y1: {
            type: "linear",
            display: true,
            position: "right",
            title: {
              display: true,
              text: "Sessions"
            },
            grid: {
              drawOnChartArea: false
            }
          }
        }
      }
    });
  } catch (err) {
    console.error("Sitting chart error:", err.message);
  }
}

// ===== Main refresh loop =====
async function refresh() {
  try {
    const latest = await apiGet("/api/latest");
    const row = latest.latest || null;
    const relayStateValue = latest.relayState?.value;

    // ✅ Update global state
    if (relayStateValue === 0 || relayStateValue === 1) {
      lastRelayState = relayStateValue;
      lastRelayStateTs = latest.relayState?.ts || Date.now();
      lastRelayStateSource = latest.relayState?.source || "server";
    } else if (row && typeof row.relay === 'number') {
      // ✅ Fallback: ใหม่ telemetry relay
      lastRelayState = row.relay;
      lastRelayStateTs = row.ts;
      lastRelayStateSource = "telemetry-relay";
    }

    hasFetchedOnce = true;
    console.log("[DEBUG] relay:", lastRelayState, "source:", lastRelayStateSource, "row.relay:", row?.relay, "relayStateValue:", relayStateValue);
    document.getElementById("status").innerHTML = renderLatest(row, lastRelayState);

    lastTelemetryTs = (row && typeof row.ts === "number") ? row.ts : null;

    const ev = await apiGet("/api/events");
    document.getElementById("events").textContent =
      ev.rows.slice(0, 12)
        .map(e => `${new Date(e.ts).toLocaleTimeString()}  ${e.type}  ${e.detail}`)
        .join("\n") || "-";


// ===== Sitting status + aggressive warning card =====
try {
  const seat = await apiGet("/api/seat/status");
  const seatPill = document.getElementById("seatPill");
  const seatText = document.getElementById("seatText");
  const seatDetail = document.getElementById("seatDetail");
  const sitWarnCard = document.getElementById("sitWarnCard");

  if (seatPill && seatText && seatDetail) {
    if (seat.seated) {
      seatPill.className = "pill warn";
      seatPill.textContent = "SEATED";
      seatText.textContent = "มีคนนั่งอยู่";
      
      // ✅ Show away time if no motion detected
      const sid = seat.sessionId ?? "-";
      if (seat.awayMs && seat.awayMs > 0) {
        // Still in session but no motion now
        seatDetail.textContent =
          `ลุกไปแล้ว ~${seat.awayMinutes} นาที (${seat.awaySeconds}s) — session ${sid}`;
      } else {
        seatDetail.textContent =
          `นั่งมาแล้ว ~${seat.sinceMinutes} นาที (session ${sid})`;
      }
    } else {
      seatPill.className = "pill ok";
      seatPill.textContent = "AWAY";
      seatText.textContent = "ไม่มีคนนั่งอยู่";
      seatDetail.textContent = "-";
    }
  }

  // การเตือนแบบแรง ๆ (โชว์บนเว็บ)
  if (sitWarnCard) {
    if (seat.seated && seat.sinceMinutes >= 60) {
      sitWarnCard.textContent =
        `🚨 หยุดนั่งเดี๋ยวนี้! คุณนั่งมา ${seat.sinceMinutes} นาทีแล้ว\n` +
        `ลุกขึ้นพักสายตา/ยืดเส้นทันที 2-3 นาที ก่อนปวดหลังเรื้อรัง`;
    } else if (seat.seated) {
      sitWarnCard.textContent =
        `กำลังนั่งอยู่ (${seat.sinceMinutes} นาที) — อย่าลืมพักสายตาทุก ๆ 60 นาที`;
    } else {
      sitWarnCard.textContent = "-";
    }
  }

  // รายการ sit_alert ล่าสุดจาก DB
  const alerts = await apiGet("/api/alerts/sit?limit=10");
  const box = document.getElementById("sitAlerts");
  if (box) {
    const rows = alerts.rows || [];
    box.textContent = rows.map(a => {
      let mins = null;
      try { mins = JSON.parse(a.detail)?.sit_minutes; } catch {}
      const mm = (mins != null) ? `${mins} นาที` : "นั่งนาน";
      return `${new Date(a.ts).toLocaleTimeString()}  🚨 ${mm}  (ลุกซะ!)`;
    }).join("\n") || "-";
  }
} catch (e2) {
  // ไม่ให้พังทั้งหน้า ถ้า endpoint ยังไม่พร้อม
  // console.log("seat/alerts error:", e2.message);
}

    const hist = await apiGet("/api/history?limit=30");
    document.getElementById("history").textContent =
      hist.rows.map(r => `${new Date(r.ts).toLocaleTimeString()} pir=${r.pir} ldr=${r.ldr} relay=${r.relay}`).join("\n") || "-";

    renderChart(hist.rows);
    renderSittingChart();

  } catch (err) {
    console.error("API error:", err);
    hasFetchedOnce = true;
    updateConnectionStatus(false, "API Error");
    return;
  }

  updateConnectionFromTelemetryTs();
}

// ===== Command sender =====
async function sendCmd(cmd) {
  try {
    const out = await apiPost("/api/cmd", { cmd });
    const cmdEl = document.getElementById("cmdResult");
    if (cmdEl) cmdEl.textContent = JSON.stringify(out, null, 2);
    const lcdEl = document.getElementById("lcdResult");
    if (lcdEl) lcdEl.textContent = JSON.stringify(out, null, 2);
  } catch (e) {
    const cmdEl = document.getElementById("cmdResult");
    if (cmdEl) cmdEl.textContent = `Error: ${e.message}`;
    const lcdEl = document.getElementById("lcdResult");
    if (lcdEl) lcdEl.textContent = `Error: ${e.message}`;
  }
  setTimeout(refresh, 700);
}

async function loadSittingPage(){
  const sum = await apiGet("/api/sitting/summary?days=7");
  const sessions = await apiGet("/api/sitting/sessions?limit=100");

  // render summary
  const box = document.getElementById("summaryBox");
  if(box){
    box.textContent = (sum.rows||[])
      .map(r=>`${r.day}  รวม ${r.total_minutes} นาที`)
      .join("\n");
  }

  // render table
  const tb = document.getElementById("sessionsTbody");
  if(tb){
    tb.innerHTML = (sessions.rows||[])
      .map(r=>`
        <tr>
          <td>${r.start_time}</td>
          <td>${r.end_time}</td>
          <td>${r.minutes}</td>
          <td>${r.session_id}</td>
        </tr>
      `).join("");
  }
}

// ===== Bind buttons (Relay/Auto) =====
document.getElementById("on").onclick = () => sendCmd("RELAY:ON");
document.getElementById("off").onclick = () => sendCmd("RELAY:OFF");
document.getElementById("autoOn").onclick = () => sendCmd("AUTO:ON");
document.getElementById("autoOff").onclick = () => sendCmd("AUTO:OFF");

// ===== LCD Modal Controls =====
function $(id) { return document.getElementById(id); }
function safeBind(id, handler) {
  const el = $(id);
  if (!el) return;
  el.onclick = handler;
}

const lcdModal = $("lcdModal");
const lcdModalBtn = $("lcdModalBtn");
const lcdModalClose = $("lcdModalClose");

function openModal(){
  if (!lcdModal) return;
  lcdModal.classList.add("show");
  // focus ไปที่ line2
  setTimeout(()=>{ $("lcdLine2")?.focus(); }, 50);
}
function closeModal(){
  if (!lcdModal) return;
  lcdModal.classList.remove("show");
}

if (lcdModalBtn) lcdModalBtn.onclick = openModal;
if (lcdModalClose) lcdModalClose.onclick = closeModal;

if (lcdModal) {
  lcdModal.onclick = (e) => {
    if (e.target === lcdModal) closeModal();
  };
}

// close with ESC
window.addEventListener("keydown", (e)=>{
  if (e.key === "Escape" && lcdModal?.classList.contains("show")) closeModal();
});

// counters (line2/line3)
const lcdLine2 = $("lcdLine2");
const lcdLine3 = $("lcdLine3");
const charCount2 = $("charCount2");
const charCount3 = $("charCount3");

function bindCounter(input, counter) {
  if (!input || !counter) return;
  const update = () => counter.textContent = input.value.length;
  input.addEventListener("input", update);
  update();
}
bindCounter(lcdLine2, charCount2);
bindCounter(lcdLine3, charCount3);

// Send standby message (edit only line2/line3)
function sendStandbyMsg() {
  const text2 = String(lcdLine2?.value || "").slice(0, 20);
  const text3 = String(lcdLine3?.value || "").slice(0, 20);
  sendCmd(`LCD:STANDBY:${text2}|${text3}`);
}

safeBind("lcdSend", () => sendStandbyMsg());
safeBind("lcdClear", () => sendCmd("LCD:CLEAR"));
safeBind("lcdStandbyOn", () => sendCmd("LCD:STANDBY:ON"));
safeBind("lcdStandbyOff", () => sendCmd("LCD:STANDBY:OFF"));
safeBind("lcdLiveSet", () => {
  const sec = Number($("lcdLiveSec")?.value || 10);
  sendCmd(`LCD:STABLESEC:${sec}`);
});

if (lcdLine2) {
  lcdLine2.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      lcdLine3?.focus();
    }
  });
}
if (lcdLine3) {
  lcdLine3.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendStandbyMsg();
    }
  });
}

if(location.pathname.includes("sitting")){
  loadSittingPage();
  setInterval(loadSittingPage,5000);
}

// ===== Init =====
updateConnectionStatus(false, "Waiting for ESP32...");
refresh();
setInterval(refresh, 2000);
setInterval(updateConnectionFromTelemetryTs, 1000);