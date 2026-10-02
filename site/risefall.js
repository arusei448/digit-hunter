// State
let allTicks = [];       // { quote, trend, timestamp }
let windowSize = 50;     // default analysis window
let currentSymbol = '1HZ100V';
let lastReceivedAt = 0;

// DOM
const priceEl = document.getElementById('price');
const digitBadge = document.getElementById('digit-badge');
const netChangeEl = document.getElementById('net-change');
const changePctEl = document.getElementById('change-pct');
const directionEl = document.getElementById('direction');
const riseBar = document.getElementById('rise-bar');
const fallBar = document.getElementById('fall-bar');
const riseCounts = document.getElementById('rise-counts');
const fallCounts = document.getElementById('fall-counts');
const riseNote = document.getElementById('rise-note');
const fallNote = document.getElementById('fall-note');
const streamBars = document.getElementById('stream-bars');

// ---------- Rendering ----------
function renderStream() {
    const recent = allTicks.slice(-40);
    streamBars.innerHTML = '';
    for (const t of recent) {
        const bar = document.createElement('div');
        bar.className = `stream-bar ${t.trend === 'up' ? 'rise' : 'fall'}`;
        bar.style.height = t.trend === 'up' ? '100%' : '40%';
        streamBars.appendChild(bar);
    }
}

function renderStats() {
    const window = allTicks.slice(-windowSize);
    const total = window.length;
    if (total === 0) return;

    const first = window[0].quote;
    const last = window[total - 1].quote;
    const net = last - first;
    const pct = (net / first) * 100;

    netChangeEl.textContent = (net >= 0 ? '+' : '') + net.toFixed(5);
    netChangeEl.className = 'stat-value ' + (net >= 0 ? 'green' : 'red');

    changePctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(4) + '%';
    changePctEl.className = 'stat-value ' + (pct >= 0 ? 'green' : 'red');

    let up = 0, down = 0;
    for (const t of window) {
        if (t.trend === 'up') up++;
        else if (t.trend === 'down') down++;
    }
    const dir = up > down ? 'RISING' : down > up ? 'FALLING' : 'FLAT';
    directionEl.textContent = dir;
    directionEl.className = 'stat-value ' + (dir === 'RISING' ? 'green' : dir === 'FALLING' ? 'red' : 'blue');

    const upPct = total > 0 ? (up / total) * 100 : 0;
    const downPct = total > 0 ? (down / total) * 100 : 0;

    riseBar.style.width = upPct + '%';
    fallBar.style.width = downPct + '%';
    riseCounts.textContent = `${up} / ${total} (${upPct.toFixed(0)}%)`;
    fallCounts.textContent = `${down} / ${total} (${downPct.toFixed(0)}%)`;

    if (upPct >= 65) riseNote.textContent = `Bullish momentum detected. ${upPct.toFixed(0)}% up ticks.`;
    else riseNote.textContent = `Insufficient bullish momentum. Wait for 65%+ up ticks.`;

    if (downPct >= 65) fallNote.textContent = `Bearish momentum detected. ${downPct.toFixed(0)}% down ticks.`;
    else fallNote.textContent = `Insufficient bearish momentum. Wait for 65%+ down ticks.`;
}

function renderAll() {
    renderStats();
    renderStream();
}

// ---------- Window buttons ----------
document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        windowSize = parseInt(btn.dataset.tf);
        renderAll();
    });
});

// ---------- Market switching ----------
document.getElementById('market-select').addEventListener('change', async (e) => {
    currentSymbol = e.target.value;
    allTicks = [];

    await fetch(`/switch?symbol=${currentSymbol}`);

    const res = await fetch(`/history/direction?count=${windowSize}`);
    const data = await res.json();
    allTicks = data.ticks || [];

    renderAll();
});

// ---------- Initial load ----------
async function init() {
    const res = await fetch(`/history/direction?count=${windowSize}`);
    const data = await res.json();
    allTicks = data.ticks || [];
    renderAll();
}

init();

// ---------- Live SSE stream ----------
const eventSource = new EventSource('/stream/direction');

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const { quote, trend, timestamp } = data;

    lastReceivedAt = Date.now();

    // Display full-precision quote (matches Deriv's digit logic)
    const quoteStr = quote.toString();
    priceEl.textContent = quoteStr;
    const lastDigit = parseInt(quoteStr.slice(-1));
    digitBadge.textContent = lastDigit;

    allTicks.push({ quote: parseFloat(quote), trend, timestamp });
    if (allTicks.length > 1000) allTicks.shift();

    renderAll();
};