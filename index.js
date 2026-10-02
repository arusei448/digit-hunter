const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MARKETS = {
    '1HZ10V': 'Volatility 10 (1s) Index',
    '1HZ25V': 'Volatility 25 (1s) Index',
    '1HZ50V': 'Volatility 50 (1s) Index',
    '1HZ75V': 'Volatility 75 (1s) Index',
    '1HZ100V': 'Volatility 100 (1s) Index',
    R_10: 'Volatility 10 Index',
    R_25: 'Volatility 25 Index',
    R_50: 'Volatility 50 Index',
    R_75: 'Volatility 75 Index',
    R_100: 'Volatility 100 Index',
};

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const PORT = Number(process.env.PORT) || 5000;
const HISTORY_LIMIT = 1000;
const HISTORY_TIMEOUT_MS = 12000;

let currentSymbol = '1HZ10V';
let connectedSymbol = null;
let latestTick = null;
let previousQuote = null;
let historicalTicks = [];
let historyLoaded = false;
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let nextRequestId = 1;
let marketOperationQueue = Promise.resolve();
let shuttingDown = false;

const pendingHistory = new Map();
const socketOpenWaiters = new Set();
const historyWaiters = new Set();
const sseClients = new Set();
const directionClients = new Set();
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};
const STATIC_FILES = new Map([
    ['/', 'index.html'],
    ['/risefall', 'risefall.html'],
    ['/app.js', 'app.js'],
    ['/risefall.js', 'risefall.js'],
]);

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

function digitFromRawQuote(quote) {
    const digit = Number.parseInt(String(quote).slice(-1), 10);
    return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : null;
}

function numericQuote(quote) {
    const value = Number(quote);
    return Number.isFinite(value) ? value : null;
}

function preserveQuotePrecision(quote, pipSize) {
    const token = String(quote);
    const precision = Number(pipSize);
    const match = token.match(/^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
    if (!match || !Number.isInteger(precision) || precision < 0 || precision > 12) return token;

    const [, sign, integerPart, fractionalPart = '', exponentText = '0'] = match;
    const digits = `${integerPart}${fractionalPart}`;
    const decimalIndex = integerPart.length + Number(exponentText);
    let whole;
    let fraction;
    if (decimalIndex <= 0) {
        whole = '0';
        fraction = `${'0'.repeat(-decimalIndex)}${digits}`;
    } else if (decimalIndex >= digits.length) {
        whole = `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
        fraction = '';
    } else {
        whole = digits.slice(0, decimalIndex);
        fraction = digits.slice(decimalIndex);
    }

    whole = whole.replace(/^0+(?=\d)/, '');
    fraction = fraction.padEnd(precision, '0');
    return `${sign}${whole}${precision > 0 || fraction ? `.${fraction}` : ''}`;
}

function rawJsonValue(token) {
    try {
        return JSON.parse(token);
    } catch {
        return token;
    }
}

function extractRawTickQuote(rawMessage, parsedQuote) {
    const tickObject = rawMessage.match(/"tick"\s*:\s*\{([\s\S]*?)\}/);
    if (tickObject) {
        const quoteField = tickObject[1].match(
            /"quote"\s*:\s*("(?:\\.|[^"\\])*"|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/
        );
        if (quoteField) {
            return quoteField[1].startsWith('"')
                ? String(rawJsonValue(quoteField[1]))
                : quoteField[1];
        }
    }
    return String(parsedQuote);
}

function extractRawHistoryQuotes(rawMessage, parsedPrices) {
    const pricesArray = rawMessage.match(/"prices"\s*:\s*\[([\s\S]*?)\]/);
    if (!pricesArray) return parsedPrices.map(String);

    const tokens = [];
    const numberOrString = /("(?:\\.|[^"\\])*"|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g;
    let match;
    while ((match = numberOrString.exec(pricesArray[1])) !== null) {
        tokens.push(match[1].startsWith('"')
            ? String(rawJsonValue(match[1]))
            : match[1]);
    }
    return tokens.length === parsedPrices.length ? tokens : parsedPrices.map(String);
}

function historyFromMessage(msg, rawMessage, symbol) {
    const prices = msg.history.prices;
    const times = msg.history.times || [];
    const rawPrices = extractRawHistoryQuotes(rawMessage, prices);
    let lastQuote = null;

    return prices.map((price, index) => {
        const quote = preserveQuotePrecision(rawPrices[index] ?? String(price), msg.pip_size);
        const value = numericQuote(quote);
        const trend = lastQuote === null
            ? 'flat'
            : value > lastQuote ? 'up'
                : value < lastQuote ? 'down' : 'flat';
        lastQuote = value;

        return {
            quote,
            digit: digitFromRawQuote(quote),
            timestamp: Number(times[index]) || 0,
            trend,
            symbol,
        };
    }).filter((tick) => tick.digit !== null);
}

function installHistory(symbol, ticks) {
    currentSymbol = symbol;
    historicalTicks = ticks.slice(-HISTORY_LIMIT);
    historyLoaded = true;
    const lastTick = historicalTicks.at(-1) || null;
    latestTick = lastTick;
    previousQuote = lastTick ? numericQuote(lastTick.quote) : null;
    for (const waiter of [...historyWaiters]) waiter.resolve();
}

function waitForHistory(timeoutMs = 15000) {
    if (historyLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const waiter = {
            resolve() {
                clearTimeout(timer);
                historyWaiters.delete(waiter);
                resolve();
            },
        };
        const timer = setTimeout(() => {
            historyWaiters.delete(waiter);
            reject(new Error('Timed out waiting for initial market history'));
        }, timeoutMs);
        historyWaiters.add(waiter);
    });
}

function writeToClients(clients, payload) {
    const message = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
        if (client.destroyed || client.writableEnded) {
            clients.delete(client);
            continue;
        }
        try {
            client.write(message);
        } catch {
            clients.delete(client);
        }
    }
}

function sendToSocket(socket, payload) {
    if (!socket || socket !== ws || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Deriv connection is not available');
    }
    socket.send(JSON.stringify(payload));
}

function waitForSocketOpen(timeoutMs = 30000) {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
    if (shuttingDown) return Promise.reject(new Error('Server is shutting down'));

    return new Promise((resolve, reject) => {
        const waiter = {
            resolve(socket) {
                clearTimeout(timer);
                socketOpenWaiters.delete(waiter);
                resolve(socket);
            },
            reject(error) {
                clearTimeout(timer);
                socketOpenWaiters.delete(waiter);
                reject(error);
            },
        };
        const timer = setTimeout(() => {
            waiter.reject(new Error('Timed out waiting for the Deriv connection'));
        }, timeoutMs);
        socketOpenWaiters.add(waiter);
    });
}

function requestHistory(symbol, socket) {
    const reqId = nextRequestId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingHistory.delete(reqId);
            reject(new Error(`Timed out loading history for ${symbol}`));
        }, HISTORY_TIMEOUT_MS);

        pendingHistory.set(reqId, { socket, symbol, resolve, reject, timer });
        try {
            sendToSocket(socket, {
                ticks_history: symbol,
                end: 'latest',
                start: 0,
                style: 'ticks',
                count: HISTORY_LIMIT,
                req_id: reqId,
            });
        } catch (error) {
            clearTimeout(timer);
            pendingHistory.delete(reqId);
            reject(error);
        }
    });
}

function rejectPendingHistory(socket, error) {
    for (const [reqId, pending] of pendingHistory) {
        if (pending.socket !== socket) continue;
        clearTimeout(pending.timer);
        pendingHistory.delete(reqId);
        pending.reject(error);
    }
}

function enqueueMarketOperation(operation) {
    const result = marketOperationQueue.then(operation);
    marketOperationQueue = result.catch((error) => {
        console.error('Market operation failed:', error.message);
    });
    return result;
}

async function activateCurrentMarket(socket) {
    const symbol = currentSymbol;
    const ticks = await requestHistory(symbol, socket);
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) return;
    installHistory(symbol, ticks);
    sendToSocket(socket, { ticks: symbol, subscribe: 1 });
    connectedSymbol = symbol;
    console.log(`Loaded ${ticks.length} history ticks for ${symbol}`);
}

function switchMarket(symbol) {
    return enqueueMarketOperation(async () => {
        const socket = await waitForSocketOpen();
        if (symbol === currentSymbol && historyLoaded && connectedSymbol === symbol) {
            return {
                symbol,
                historyCount: historicalTicks.length,
                history: historicalTicks,
            };
        }

        const previousSymbol = currentSymbol;
        sendToSocket(socket, { forget_all: 'ticks' });
        connectedSymbol = null;
        try {
            const ticks = await requestHistory(symbol, socket);
            if (socket !== ws || socket.readyState !== WebSocket.OPEN) {
                throw new Error('Deriv connection closed while changing markets');
            }

            installHistory(symbol, ticks);
            sendToSocket(socket, { ticks: symbol, subscribe: 1 });
            connectedSymbol = symbol;
            console.log(`Switched to ${symbol} with ${ticks.length} history ticks`);
            return {
                symbol,
                historyCount: ticks.length,
                history: historicalTicks,
            };
        } catch (error) {
            if (socket === ws && socket.readyState === WebSocket.OPEN) {
                try {
                    sendToSocket(socket, { ticks: previousSymbol, subscribe: 1 });
                    connectedSymbol = previousSymbol;
                } catch (restoreError) {
                    console.error('Could not restore previous market subscription:', restoreError.message);
                }
            }
            throw error;
        }
    });
}

function handleMessage(socket, data) {
    if (socket !== ws) return;
    const rawMessage = data.toString();
    let msg;
    try {
        msg = JSON.parse(rawMessage);
    } catch (error) {
        console.error('Could not parse Deriv message:', error.message);
        return;
    }

    if (msg.req_id !== undefined && pendingHistory.has(msg.req_id)) {
        const pending = pendingHistory.get(msg.req_id);
        if (pending.socket !== socket) return;
        clearTimeout(pending.timer);
        pendingHistory.delete(msg.req_id);

        if (msg.error) {
            pending.reject(new Error(msg.error.message || 'Deriv history request failed'));
        } else if (msg.history && Array.isArray(msg.history.prices)) {
            pending.resolve(historyFromMessage(msg, rawMessage, pending.symbol));
        } else {
            pending.reject(new Error(`Unexpected history response for ${pending.symbol}`));
        }
        return;
    }

    if (!msg.tick || msg.tick.quote === undefined || msg.tick.quote === null) return;
    const symbol = msg.tick.symbol || connectedSymbol;
    if (!symbol || symbol !== currentSymbol) return;

    const quote = preserveQuotePrecision(
        extractRawTickQuote(rawMessage, msg.tick.quote),
        msg.tick.pip_size
    );
    const price = numericQuote(quote);
    const digit = digitFromRawQuote(quote);
    if (price === null || digit === null) return;

    const trend = previousQuote === null
        ? 'flat'
        : price > previousQuote ? 'up'
            : price < previousQuote ? 'down' : 'flat';
    previousQuote = price;

    const tick = {
        quote,
        digit,
        timestamp: Number(msg.tick.epoch) || Math.floor(Date.now() / 1000),
        trend,
        symbol,
    };
    const lastHistoricalTick = historicalTicks.at(-1);
    if (!lastHistoricalTick
        || lastHistoricalTick.timestamp !== tick.timestamp
        || lastHistoricalTick.quote !== tick.quote) {
        historicalTicks.push(tick);
        if (historicalTicks.length > HISTORY_LIMIT) historicalTicks.shift();
    }
    latestTick = tick;

    writeToClients(sseClients, tick);
    writeToClients(directionClients, {
        quote,
        trend,
        timestamp: tick.timestamp,
        symbol,
    });
}

function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    console.log(`Reconnecting to Deriv in ${delay / 1000}s`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToDeriv();
    }, delay);
}

function connectToDeriv() {
    if (shuttingDown) return;
    const socket = new WebSocket(WS_URL, { handshakeTimeout: 15000 });
    ws = socket;

    socket.on('open', () => {
        if (socket !== ws) return;
        reconnectDelay = 1000;
        console.log('Connected to Deriv public WebSocket');
        for (const waiter of [...socketOpenWaiters]) waiter.resolve(socket);
        enqueueMarketOperation(() => activateCurrentMarket(socket)).catch((error) => {
            console.error('Could not initialize market data:', error.message);
            if (socket === ws && socket.readyState === WebSocket.OPEN) socket.close();
        });
    });

    socket.on('message', (data) => handleMessage(socket, data));

    socket.on('error', (error) => {
        console.error('Deriv WebSocket error:', error.message);
    });

    socket.on('close', (code, reason) => {
        if (socket !== ws) return;
        console.warn(`Deriv WebSocket closed (${code})${reason.length ? `: ${reason}` : ''}`);
        connectedSymbol = null;
        rejectPendingHistory(socket, new Error('Deriv connection closed before history arrived'));
        scheduleReconnect();
    });
}

const server = http.createServer(async (req, res) => {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
        sendJson(res, 400, { error: 'Invalid request URL' });
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
    }

    if (url.pathname === '/stream' || url.pathname === '/stream/direction') {
        const clients = url.pathname === '/stream' ? sseClients : directionClients;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
    }

    if (url.pathname === '/switch') {
        const symbol = url.searchParams.get('symbol');
        if (!symbol || !Object.hasOwn(MARKETS, symbol)) {
            sendJson(res, 400, { error: 'Choose a supported market symbol' });
            return;
        }
        try {
            sendJson(res, 200, await switchMarket(symbol));
        } catch (error) {
            sendJson(res, 502, { error: error.message || 'Could not switch markets' });
        }
        return;
    }

    if (url.pathname === '/history') {
        try {
            await waitForHistory();
            sendJson(res, 200, { history: historicalTicks, symbol: currentSymbol });
        } catch (error) {
            sendJson(res, 503, { error: error.message });
        }
        return;
    }

    if (url.pathname === '/history/direction') {
        try {
            await waitForHistory();
        } catch (error) {
            sendJson(res, 503, { error: error.message });
            return;
        }
        const requestedCount = Number.parseInt(url.searchParams.get('count') || '100', 10);
        const count = Number.isFinite(requestedCount)
            ? Math.max(1, Math.min(HISTORY_LIMIT, requestedCount))
            : 100;
        const ticks = historicalTicks.slice(-count).map(({ quote, trend, timestamp, symbol }) => ({
            quote,
            trend,
            timestamp,
            symbol,
        }));
        sendJson(res, 200, { ticks, symbol: currentSymbol });
        return;
    }

    if (url.pathname === '/markets') {
        sendJson(res, 200, { markets: MARKETS, current: currentSymbol });
        return;
    }

    const fileName = STATIC_FILES.get(url.pathname);
    if (fileName) {
        const filePath = path.join(__dirname, 'site', fileName);
        fs.readFile(filePath, (error, content) => {
            if (error) {
                sendJson(res, 500, { error: 'Could not load the requested page' });
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
            });
            res.end(content);
        });
        return;
    }

    sendJson(res, 404, { error: 'Not found' });
});

server.on('error', (error) => {
    console.error('HTTP server error:', error.message);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

const keepAliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            sendToSocket(ws, { ping: 1 });
        } catch (error) {
            console.error('Deriv keep-alive failed:', error.message);
        }
    }
}, 30000);

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAliveTimer);
    clearTimeout(reconnectTimer);
    for (const waiter of [...socketOpenWaiters]) {
        waiter.reject(new Error('Server is shutting down'));
    }
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
connectToDeriv();