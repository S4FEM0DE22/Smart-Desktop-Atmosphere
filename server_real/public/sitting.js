// sitting.js - Load sitting sessions and summary

let chartInstance = null;

async function apiGet(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

async function loadSummary() {
  try {
    const data = await apiGet("/api/sitting/summary?days=7");
    if (!data.ok || !data.rows) {
      document.getElementById("summaryBox").textContent = "ไม่มีข้อมูล";
      return;
    }

    let html = data.rows
      .map(row => {
        return `${row.day}: ${row.total_minutes} นาที (${row.sessions} sessions)`;
      })
      .join("\n") || "ไม่มีข้อมูล";

    document.getElementById("summaryBox").textContent = html;
  } catch (err) {
    document.getElementById("summaryBox").textContent = `Error: ${err.message}`;
  }
}

async function loadChart() {
  try {
    const data = await apiGet("/api/sitting/summary?days=7");
    if (!data.ok || !data.rows || data.rows.length === 0) {
      console.log("No data for chart");
      return;
    }

    // Sort by date (ascending, so newest is on right)
    const sortedRows = [...data.rows].reverse();

    const labels = sortedRows.map(row => row.day);
    const minutes = sortedRows.map(row => row.total_minutes);
    const sessions = sortedRows.map(row => row.sessions);

    const ctx = document.getElementById("sittingChart");
    if (!ctx) return;

    // Destroy previous chart if it exists
    if (chartInstance) {
      chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
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
    console.error("Chart error:", err.message);
  }
}

async function loadSessions() {
  try {
    const data = await apiGet("/api/sitting/sessions?limit=100");
    if (!data.ok || !data.rows) {
      document.getElementById("sessionsTbody").innerHTML = `<tr><td colspan="4">ไม่มีข้อมูล</td></tr>`;
      return;
    }

    const html = data.rows
      .map(row => {
        const startTime = new Date(row.ts_start).toLocaleString("th-TH");
        const endTime = new Date(row.ts_end).toLocaleString("th-TH");
        return `
          <tr>
            <td style="padding:8px;">${startTime}</td>
            <td style="padding:8px;">${endTime}</td>
            <td style="text-align:right; padding:8px;">${row.minutes}</td>
            <td style="text-align:right; padding:8px;">${row.session_id}</td>
          </tr>
        `;
      })
      .join("");

    document.getElementById("sessionsTbody").innerHTML = html;
  } catch (err) {
    document.getElementById("sessionsTbody").innerHTML = `<tr><td colspan="4">Error: ${err.message}</td></tr>`;
  }
}

// Load on page load
window.addEventListener("DOMContentLoaded", () => {
  loadChart();
  loadSummary();
  loadSessions();
  // Refresh every 5 seconds
  setInterval(() => {
    loadChart();
    loadSummary();
    loadSessions();
  }, 5000);
});
