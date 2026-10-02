const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MARKETS = {
    '1HZ10V': 'Volatility 100 (1s) Index',
    '1HZ25V': 'Volatility 25 (1s) Index',
    '1HZ50V': 'Volatility 50 (1s) Index',
    '1HZ75V': 'Volatility 75 (1s) Index',
    '1HZ100V': 'Volatility 100 (1s) Index',
    'R_10': 'Volatility 10 Index',
    'R_25': 'Volatility 25 Index',
    'R_50': 'Volatility 50 Index',
    'R_75': 'Volatility 75 Index',
    'R_100': 'Volatility 100 Index'
};

let currentSymbol = '1HZ10V';
let latestTick = null;
let previousQuote = null;
let historicalTicks = [];
let historyResolvers = [];

// Two separate SSE client pools:
// - sseClients: dashboard page (needs quote + digit)
// - directionClients: rise/fall page (needs quote + trend)
const sseClients = new Set();
const directionClients = new Set();

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const PORT = process.env.PORT || 3000;

function fetchHistory(symbol) {
    return new Promise((resolve) => {
        historyResolvers.push(resolve);
        ws.send(JSON.stringify({
            ticks_history: symbol,
            end: 'latest',
            start: 0,
            style: 'ticks',
            count: 1000
        }));
    });
}

const server = http.createServer(async (req, res) => {

    // ----- SSE: main dashboard (tick + digit) -----
    if (req.url === '/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        if (latestTick) {
            res.write(`data: ${JSON.stringify(latestTick)}\n\n`);
        }

        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // ----- SSE: rise/fall direction stream -----
    if (req.url === '/stream/direction') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        if (latestTick) {
            res.write(`data: ${JSON.stringify({
                quote: latestTick.quote,
                trend: latestTick.trend,
                timestamp: latestTick.timestamp,
                symbol: latestTick.symbol
            })}\n\n`);
        }

        directionClients.add(res);
        req.on('close', () => directionClients.delete(res));
        return;
    }

    // ----- Switch market -----
    if (req.url.startsWith('/switch')) {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const newSymbol = url.searchParams.get('symbol');
        if (newSymbol && MARKETS[newSymbol]) {
            currentSymbol = newSymbol;
            previousQuote = null;
            latestTick = null;
            historicalTicks = [];

            ws.send(JSON.stringify({ forget_all: 'ticks' }));

            const ticks = await fetchHistory(newSymbol);
            historicalTicks = ticks;

            ws.send(JSON.stringify({ ticks: newSymbol, subscribe: 1 }));
            console.log('Switched to:', newSymbol, 'with', ticks.length, 'history ticks');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ symbol: currentSymbol, historyCount: historicalTicks.length }));
        return;
    }

    // ----- History for main dashboard -----
    if (req.url === '/history') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ history: historicalTicks, symbol: currentSymbol }));
        return;
    }

    // ----- History for rise/fall page -----
    if (req.url.startsWith('/history/direction')) {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const count = parseInt(url.searchParams.get('count')) || 100;
        // Build trend info from historical ticks (consecutive quotes)
        const ticks = historicalTicks.slice(-count);
        const enriched = [];
        for (let i = 1; i < ticks.length; i++) {
            const prev = ticks[i - 1].quote;
            const cur = ticks[i].quote;
            const trend = cur > prev ? 'up' : cur < prev ? 'down' : 'flat';
            enriched.push({
                quote: cur,
                trend,
                timestamp: ticks[i].timestamp,
                symbol: currentSymbol
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ticks: enriched, symbol: currentSymbol }));
        return;
    }

    // ----- Market list -----
    if (req.url === '/markets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ markets: MARKETS, current: currentSymbol }));
        return;
    }

    // ----- Serve static files -----
    if (req.url === '/risefall') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(path.join(__dirname, 'site', 'risefall.html')));
        return;
    }
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'site', filePath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath);
        const types = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css'
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(data);
    });
});

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('Connected to Deriv public gateway');
    fetchHistory(currentSymbol).then(ticks => {
        historicalTicks = ticks;
        console.log(`Loaded ${ticks.length} initial ticks for ${currentSymbol}`);
    });
    ws.send(JSON.stringify({ ticks: currentSymbol, subscribe: 1 }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.msg_type === 'history' && msg.history && msg.history.prices) {
        const ticks = msg.history.prices.map((price, i) => ({
            quote: price,
            digit: parseInt(price.toString().slice(-1)),
            timestamp: msg.history.times[i],
            trend: 'flat'
        }));
        while (historyResolvers.length > 0) {
            const resolve = historyResolvers.shift();
            resolve(ticks);
        }
        return;
    }

    if (msg.tick && msg.tick.quote) {
        const quote = msg.tick.quote;
        const trend = previousQuote === null
            ? 'flat'
            : quote > previousQuote ? 'up'
            : quote < previousQuote ? 'down'
            : 'flat';
        previousQuote = quote;

        latestTick = {
            quote: quote,
            digit: parseInt(quote.toString().slice(-1)),
            timestamp: msg.tick.epoch || Math.floor(Date.now() / 1000),
            trend: trend,
            symbol: currentSymbol,
            receivedAt: Date.now()
        };

        // Push to main dashboard clients
        const payload = `data: ${JSON.stringify(latestTick)}\n\n`;
        for (const client of sseClients) {
            client.write(payload);
        }

        // Push to rise/fall clients (smaller payload)
        const directionPayload = `data: ${JSON.stringify({
            quote: quote,
            trend: trend,
            timestamp: latestTick.timestamp,
            symbol: currentSymbol
        })}\n\n`;
        for (const client of directionClients) {
            client.write(directionPayload);
        }
    }
});

ws.on('error', (err) => console.log('WS Error:', err.message));
ws.on('close', () => console.log('WS closed'));

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));