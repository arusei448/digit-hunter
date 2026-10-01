const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 360,
    layout: {
        background: { color: '#1a1d24' },
        textColor: '#8892a0',
    },
    grid: {
        vertLines: { color: '#232730' },
        horzLines: { color: '#232730' },
    },
    timeScale: { timeVisible: true, secondsVisible: true },
    rightPriceScale: { borderColor: '#2a2e37' },
});

const lineSeries = chart.addLineSeries({ color: '#4a9eff', lineWidth: 2 });

let allTicks = [];
let maxTicks = 200;
const digitCounts = new Array(10).fill(0);
const DIGIT_COLORS = ['d0','d1','d2','d3','d4','d5','d6','d7','d8','d9'];
let lastReceivedAt = 0;

function trimToWindow() { while (allTicks.length > maxTicks) allTicks.shift(); }

function recomputeDigitCounts() {
    for (let i = 0; i < 10; i++) digitCounts[i] = 0;
    for (const t of allTicks) if (t.digit >= 0 && t.digit <= 9) digitCounts[t.digit]++;
}

function renderDigits() {
    const container = document.getElementById('digits');
    container.innerHTML = '';
    const total = allTicks.length;
    const latestDigit = total > 0 ? allTicks[total - 1].digit : null;

    let hotDigit = null, coldDigit = null;
    if (total > 0) {
        let maxCount = -1, minCount = Infinity;
        for (let i = 0; i < 10; i++) {
            if (digitCounts[i] > maxCount) { maxCount = digitCounts[i]; hotDigit = i; }
            if (digitCounts[i] < minCount) { minCount = digitCounts[i]; coldDigit = i; }
        }
    }

    for (let d = 0; d < 10; d++) {
        const div = document.createElement('div');
        div.className = 'digit-circle';
        if (d === latestDigit) div.classList.add('latest');
        else if (d === hotDigit && total > 5) div.classList.add('hot');
        else if (d === coldDigit && total > 5) div.classList.add('cold');
        const pct = total > 0 ? ((digitCounts[d] / total) * 100).toFixed(1) : '0.0';
        div.innerHTML = `<span>${d}</span><span class="digit-percent">${pct}%</span>`;
        container.appendChild(div);
    }

    document.getElementById('total-ticks').textContent = total;
    document.getElementById('latest-digit').textContent = latestDigit !== null ? latestDigit : '--';
    document.getElementById('hot-digit').textContent = hotDigit !== null ? hotDigit : '--';
    document.getElementById('cold-digit').textContent = coldDigit !== null ? coldDigit : '--';
}

function renderHistory() {
    const container = document.getElementById('history');
    container.innerHTML = '';
    const recent = allTicks.slice(-30).reverse();
    for (const t of recent) {
        const pill = document.createElement('div');
        pill.className = `history-pill ${DIGIT_COLORS[t.digit] || ''}`;
        pill.textContent = t.digit;
        container.appendChild(pill);
    }
}

function rebuildChart() {
    lineSeries.setData(allTicks.map(t => ({ time: t.timestamp, value: t.quote })));
}

// Timeframe buttons
document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        maxTicks = parseInt(btn.dataset.tf);
        trimToWindow();
        recomputeDigitCounts();
        renderDigits();
        renderHistory();
        rebuildChart();
    });
});

// Market selector
document.getElementById('market-select').addEventListener('change', async (e) => {
    const symbol = e.target.value;
    await fetch(`/switch?symbol=${symbol}`);
    allTicks = [];
    digitCounts.fill(0);
    lineSeries.setData([]);
    renderDigits();
    renderHistory();
    rebuildChart();
    document.getElementById('market-name').textContent = e.target.options[e.target.selectedIndex].text;
});

// Freshness indicator
setInterval(() => {
    if (!lastReceivedAt) return;
    const age = Date.now() - lastReceivedAt;
    const dot = document.getElementById('live-dot');
    const status = document.getElementById('stream-status');
    if (age > 5000) {
        dot.classList.add('stale');
        status.textContent = 'Stale';
    } else {
        dot.classList.remove('stale');
        status.textContent = 'Live';
    }
    document.getElementById('last-update').textContent = `${(age / 1000).toFixed(1)}s ago`;
}, 1000);

// SSE
const eventSource = new EventSource('/stream');

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const { quote, digit, timestamp, trend } = data;
    lastReceivedAt = Date.now();

    const priceEl = document.getElementById('price');
    const arrowEl = document.getElementById('price-arrow');
    priceEl.textContent = parseFloat(quote).toFixed(2);

    priceEl.classList.remove('up', 'down');
    arrowEl.classList.remove('up', 'down');
    if (trend === 'up') { priceEl.classList.add('up'); arrowEl.classList.add('up'); arrowEl.textContent = '▲'; }
    else if (trend === 'down') { priceEl.classList.add('down'); arrowEl.classList.add('down'); arrowEl.textContent = '▼'; }
    else arrowEl.textContent = '—';

    allTicks.push({ quote: parseFloat(quote), digit, timestamp, trend });
    trimToWindow();
    recomputeDigitCounts();
    lineSeries.update({ time: timestamp, value: parseFloat(quote) });
    renderDigits();
    renderHistory();
};

// Resize
window.addEventListener('resize', () => chart.applyOptions({ width: chartContainer.clientWidth }));

// Initial
renderDigits();
renderHistory();