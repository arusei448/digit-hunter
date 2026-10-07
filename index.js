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

const ALL_MARKETS = Object.keys(MARKETS);
const MARKET_BUFFER_LIMIT = 500;
const MIN_ANALYSIS_TICKS = 20;

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
const aiClients = new Set();
let mainBroadcastPending = false;
let mainBuffer = [];
let directionBroadcastPending = false;
let directionBuffer = [];
const marketBuffers = {};
for (const symbol of ALL_MARKETS) {
    marketBuffers[symbol] = {
        quotes: [],
        digits: [],
        trends: [],
        timestamps: [],
        previousQuote: null,
    };
}
const liveMarketSymbolsSeen = new Set();
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};
const STATIC_FILES = new Map([
    ['/', 'index.html'],
    ['/risefall', 'risefall.html'],
    ['/ai-analyser', 'ai-analyser.html'],
    ['/app.js', 'app.js'],
    ['/risefall.js', 'risefall.js'],
    ['/ai-analyser.js', 'ai-analyser.js'],
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

function resetMarketBuffer(symbol) {
    const buffer = marketBuffers[symbol];
    if (!buffer) return;
    buffer.quotes.length = 0;
    buffer.digits.length = 0;
    buffer.trends.length = 0;
    buffer.timestamps.length = 0;
    buffer.previousQuote = null;
}

function resetAllMarketBuffers() {
    for (const symbol of ALL_MARKETS) resetMarketBuffer(symbol);
}

function appendMarketTick(symbol, price, digit, timestamp) {
    const buffer = marketBuffers[symbol];
    if (!buffer || price === null || digit === null) return null;

    const trend = buffer.previousQuote === null
        ? 'flat'
        : price > buffer.previousQuote ? 'up'
            : price < buffer.previousQuote ? 'down' : 'flat';
    buffer.previousQuote = price;
    buffer.quotes.push(price);
    buffer.digits.push(digit);
    buffer.trends.push(trend);
    buffer.timestamps.push(timestamp);

    if (buffer.quotes.length > MARKET_BUFFER_LIMIT) {
        buffer.quotes.shift();
        buffer.digits.shift();
        buffer.trends.shift();
        buffer.timestamps.shift();
    }
    return trend;
}

function seedMarketBuffer(symbol, ticks) {
    resetMarketBuffer(symbol);
    for (const tick of ticks.slice(-MARKET_BUFFER_LIMIT)) {
        const price = numericQuote(tick.quote);
        const digit = Number.isInteger(tick.digit) ? tick.digit : digitFromRawQuote(tick.quote);
        appendMarketTick(symbol, price, digit, tick.timestamp);
    }
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

function queueMainBroadcast(tick) {
    mainBuffer.push(tick);
    if (mainBroadcastPending) return;
    mainBroadcastPending = true;
    setTimeout(() => {
        const batch = mainBuffer;
        mainBuffer = [];
        mainBroadcastPending = false;
        if (batch.length > 0) writeToClients(sseClients, batch[batch.length - 1]);
    }, 60);
}

function queueDirectionBroadcast(tick) {
    directionBuffer.push(tick);
    if (directionBroadcastPending) return;
    directionBroadcastPending = true;
    setTimeout(() => {
        const batch = directionBuffer;
        directionBuffer = [];
        directionBroadcastPending = false;
        if (batch.length > 0) writeToClients(directionClients, batch[batch.length - 1]);
    }, 60);
}

function sendToSocket(socket, payload) {
    if (!socket || socket !== ws || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Deriv connection is not available');
    }
    socket.send(JSON.stringify(payload));
}

function subscribeAllMarkets(socket) {
    liveMarketSymbolsSeen.clear();
    for (const symbol of ALL_MARKETS) {
        if (symbol === connectedSymbol) continue;
        sendToSocket(socket, { ticks: symbol, subscribe: 1 });
    }
    console.log(`Subscribed to tick streams for ${ALL_MARKETS.length} markets`);
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
    seedMarketBuffer(symbol, ticks);
    sendToSocket(socket, { ticks: symbol, subscribe: 1 });
    connectedSymbol = symbol;
    subscribeAllMarkets(socket);
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
        const previousHistory = historicalTicks;
        const previousLatestTick = latestTick;
        const previousQuoteValue = previousQuote;
        const previousHistoryLoaded = historyLoaded;
        sendToSocket(socket, { forget_all: 'ticks' });
        connectedSymbol = null;
        try {
            const ticks = await requestHistory(symbol, socket);
            if (socket !== ws || socket.readyState !== WebSocket.OPEN) {
                throw new Error('Deriv connection closed while changing markets');
            }

            installHistory(symbol, ticks);
            seedMarketBuffer(symbol, ticks);
            sendToSocket(socket, { ticks: symbol, subscribe: 1 });
            connectedSymbol = symbol;
            subscribeAllMarkets(socket);
            console.log(`Switched to ${symbol} with ${ticks.length} history ticks`);
            return {
                symbol,
                historyCount: ticks.length,
                history: historicalTicks,
            };
        } catch (error) {
            if (socket === ws && socket.readyState === WebSocket.OPEN) {
                try {
                    sendToSocket(socket, { forget_all: 'ticks' });
                    connectedSymbol = null;
                    sendToSocket(socket, { ticks: previousSymbol, subscribe: 1 });
                    connectedSymbol = previousSymbol;
                    subscribeAllMarkets(socket);
                } catch (restoreError) {
                    console.error('Could not restore previous market subscription:', restoreError.message);
                }
            }
            currentSymbol = previousSymbol;
            historicalTicks = previousHistory;
            latestTick = previousLatestTick;
            previousQuote = previousQuoteValue;
            historyLoaded = previousHistoryLoaded;
            throw error;
        }
    });
}

function calculateRSquared(quotes) {
    const n = quotes.length;
    if (n < 5) return 0;

    const meanX = (n - 1) / 2;
    const meanY = quotes.reduce((sum, quote) => sum + quote, 0) / n;
    let sumX2 = 0;
    let sumY2 = 0;
    let sumXY = 0;

    for (let i = 0; i < n; i++) {
        const centeredX = i - meanX;
        const centeredY = quotes[i] - meanY;
        sumX2 += centeredX * centeredX;
        sumY2 += centeredY * centeredY;
        sumXY += centeredX * centeredY;
    }

    const denominator = Math.sqrt(sumX2 * sumY2);
    if (denominator === 0) return 0;
    return Math.max(0, Math.min(1, (sumXY / denominator) ** 2));
}

function calculateRiseFallRatio(trends) {
    const n = trends.length;
    if (n === 0) return { up: 0, down: 0, upPct: 50, downPct: 50 };

    let up = 0;
    let down = 0;
    for (const trend of trends) {
        if (trend === 'up') up++;
        else if (trend === 'down') down++;
    }

    return {
        up,
        down,
        upPct: (up / n) * 100,
        downPct: (down / n) * 100,
    };
}

function calculateDigitDistribution(digits) {
    const counts = new Array(10).fill(0);
    for (const digit of digits) {
        if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit]++;
    }

    const n = digits.length;
    const percentages = counts.map((count) => n > 0 ? (count / n) * 100 : 0);
    const expected = n / 10;
    let chiSq = 0;
    if (expected > 0) {
        for (const count of counts) {
            chiSq += ((count - expected) ** 2) / expected;
        }
    }

    return { counts, percentages, chiSq };
}

function calculateVolatility(quotes) {
    if (quotes.length < 5) return 0;

    const returns = [];
    for (let i = 1; i < quotes.length; i++) {
        const previous = quotes[i - 1];
        if (previous !== 0) returns.push((quotes[i] - previous) / previous);
    }
    if (returns.length < 3) return 0;

    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
}

function calculateHurstExponent(quotes) {
    const series = quotes.slice(-100);
    const n = series.length;
    if (n < 20) return 0.5;

    const mean = series.reduce((sum, value) => sum + value, 0) / n;
    const deviations = series.map((value) => value - mean);
    let cumulativeDeviation = 0;
    let minDeviation = 0;
    let maxDeviation = 0;
    for (const deviation of deviations) {
        cumulativeDeviation += deviation;
        minDeviation = Math.min(minDeviation, cumulativeDeviation);
        maxDeviation = Math.max(maxDeviation, cumulativeDeviation);
    }

    const range = maxDeviation - minDeviation;
    const standardDeviation = Math.sqrt(
        deviations.reduce((sum, value) => sum + value * value, 0) / n
    );
    if (range === 0 || standardDeviation === 0) return 0.5;

    const estimate = Math.log(range / standardDeviation) / Math.log(n);
    return Number.isFinite(estimate) ? Math.max(0, Math.min(1, estimate)) : 0.5;
}

function calculateStreak(trends) {
    if (trends.length === 0) return { currentStreak: 0, direction: 'none' };

    const direction = trends[trends.length - 1];
    if (direction === 'flat') return { currentStreak: 0, direction: 'flat' };

    let currentStreak = 0;
    for (let i = trends.length - 1; i >= 0; i--) {
        if (trends[i] !== direction) break;
        currentStreak++;
    }
    return { currentStreak, direction };
}

function calculateEMA(values, period) {
    if (values.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(quotes, period = 14) {
    if (quotes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = quotes.length - period; i < quotes.length; i++) {
        const difference = quotes[i] - quotes[i - 1];
        if (difference > 0) gains += difference;
        else if (difference < 0) losses -= difference;
    }
    const averageGain = gains / period;
    const averageLoss = losses / period;
    if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
    const relativeStrength = averageGain / averageLoss;
    return 100 - (100 / (1 + relativeStrength));
}

function calculateTickVelocity(timestamps) {
    const count = Math.min(10, timestamps.length);
    if (count < 2) return 0;
    const span = timestamps[timestamps.length - 1] - timestamps[timestamps.length - count];
    if (span <= 0) return 0;
    return count / span;
}

function calculateWeightedPressure(quotes) {
    if (quotes.length < 5) return 0;
    const recent = quotes.slice(-20);
    let weightedChange = 0;
    let weightSum = 0;
    for (let i = 1; i < recent.length; i++) {
        const change = recent[i] - recent[i - 1];
        const weight = i;
        weightedChange += change * weight;
        weightSum += weight;
    }
    return weightSum > 0 ? weightedChange / weightSum : 0;
}

function calculateBollingerPosition(quotes, period = 20) {
    if (quotes.length < period) return 0;
    const recent = quotes.slice(-period);
    const mean = recent.reduce((sum, quote) => sum + quote, 0) / period;
    const variance = recent.reduce((sum, quote) => sum + (quote - mean) ** 2, 0) / period;
    const standardDeviation = Math.sqrt(variance);
    if (standardDeviation === 0) return 0;
    const zScore = (quotes[quotes.length - 1] - mean) / standardDeviation;
    if (zScore > 1.5) return 1;
    if (zScore < -1.5) return -1;
    return 0;
}

function calculateRunLengthStats(trends) {
    if (trends.length < 5) return { avgRun: 0, maxRun: 0, runsCount: 0 };
    const runs = [];
    let direction = null;
    let currentRun = 0;
    for (const trend of trends) {
        if (trend === 'flat') {
            if (currentRun > 0) runs.push(currentRun);
            direction = null;
            currentRun = 0;
        } else if (trend === direction) {
            currentRun++;
        } else {
            if (currentRun > 0) runs.push(currentRun);
            direction = trend;
            currentRun = 1;
        }
    }
    if (currentRun > 0) runs.push(currentRun);
    if (runs.length === 0) return { avgRun: 0, maxRun: 0, runsCount: 0 };
    return {
        avgRun: runs.reduce((sum, run) => sum + run, 0) / runs.length,
        maxRun: Math.max(...runs),
        runsCount: runs.length,
    };
}

function calculateAutocorrelation(quotes) {
    if (quotes.length < 10) return 0;
    const returns = [];
    for (let i = 1; i < quotes.length; i++) {
        returns.push(quotes[i] - quotes[i - 1]);
    }
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 1; i < returns.length; i++) {
        numerator += (returns[i] - mean) * (returns[i - 1] - mean);
    }
    for (const value of returns) {
        denominator += (value - mean) ** 2;
    }
    return denominator > 0 ? numerator / denominator : 0;
}

function clampScore(score) {
    return Math.round(Math.max(0, Math.min(100, score)));
}

function scoreMarketForTrendFollowing(features) {
    let score = features.rSquared * 25;
    const imbalance = Math.abs(features.riseFall.upPct - 50) / 50;
    score += imbalance * 15;
    if (features.hurst > 0.5) {
        score += ((features.hurst - 0.5) / 0.5) * 15;
    }
    const rsiDeviation = Math.abs(features.rsi - 50) / 50;
    score += rsiDeviation * 15;
    if (features.autocorrelation > 0) {
        score += Math.min(features.autocorrelation * 2, 1) * 15;
    }
    const pressureStrength = Math.min(Math.abs(features.weightedPressure) * 100, 1);
    score += pressureStrength * 10;
    score += Math.abs(features.bollingerPosition) * 5;
    return clampScore(score);
}

function scoreMarketForMeanReversion(features) {
    let score = 0;
    if (features.hurst < 0.5) {
        score += ((0.5 - features.hurst) / 0.5) * 20;
    }
    if (features.autocorrelation < 0) {
        score += Math.min(Math.abs(features.autocorrelation) * 2, 1) * 25;
    }
    const rsiExtreme = Math.max(0, (features.rsi - 70) / 30)
        + Math.max(0, (30 - features.rsi) / 30);
    score += Math.min(rsiExtreme, 1) * 15;
    score += Math.min(features.digitDistribution.chiSq / 20, 1) * 15;
    score += Math.min(features.streak.currentStreak / 15, 1) * 10;
    score += Math.abs(features.bollingerPosition) * 10;
    score += (1 - features.rSquared) * 5;
    return clampScore(score);
}

function analyzeAllMarkets() {
    const results = [];
    for (const symbol of ALL_MARKETS) {
        const buffer = marketBuffers[symbol];
        if (!buffer || buffer.quotes.length < MIN_ANALYSIS_TICKS) continue;

        const features = {
            symbol,
            name: MARKETS[symbol],
            tickCount: buffer.quotes.length,
            currentPrice: buffer.quotes[buffer.quotes.length - 1],
            rSquared: calculateRSquared(buffer.quotes),
            riseFall: calculateRiseFallRatio(buffer.trends),
            digitDistribution: calculateDigitDistribution(buffer.digits),
            volatility: calculateVolatility(buffer.quotes),
            hurst: calculateHurstExponent(buffer.quotes),
            streak: calculateStreak(buffer.trends),
        };

        features.rsi = calculateRSI(buffer.quotes, 14);
        features.ema20 = calculateEMA(buffer.quotes.slice(-20), 20);
        features.tickVelocity = calculateTickVelocity(buffer.timestamps);
        features.weightedPressure = calculateWeightedPressure(buffer.quotes);
        features.bollingerPosition = calculateBollingerPosition(buffer.quotes, 20);
        features.runStats = calculateRunLengthStats(buffer.trends);
        features.autocorrelation = calculateAutocorrelation(buffer.quotes);
        features.trendScore = scoreMarketForTrendFollowing(features);
        features.reversionScore = scoreMarketForMeanReversion(features);
        results.push(features);
    }

    results.sort((a, b) => b.trendScore - a.trendScore);
    return results;
}

function buildAIAnalysisPayload() {
    const markets = analyzeAllMarkets();
    const topReversion = markets.slice().sort((a, b) => b.reversionScore - a.reversionScore)[0] || null;
    return {
        timestamp: Date.now(),
        markets,
        topTrend: markets[0] || null,
        topReversion,
    };
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
    if (!symbol) return;

    const quote = preserveQuotePrecision(
        extractRawTickQuote(rawMessage, msg.tick.quote),
        msg.tick.pip_size
    );
    const price = numericQuote(quote);
    const digit = digitFromRawQuote(quote);
    if (price === null || digit === null) return;

    const timestamp = Number(msg.tick.epoch) || Math.floor(Date.now() / 1000);
    if (marketBuffers[symbol]) {
        appendMarketTick(symbol, price, digit, timestamp);
        if (!liveMarketSymbolsSeen.has(symbol)) {
            liveMarketSymbolsSeen.add(symbol);
            console.log(`Received first live multi-market tick for ${symbol}`);
        }
    }
    if (symbol !== currentSymbol) return;

    const trend = previousQuote === null
        ? 'flat'
        : price > previousQuote ? 'up'
            : price < previousQuote ? 'down' : 'flat';
    previousQuote = price;

    const tick = {
        quote,
        digit,
        timestamp,
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

    queueMainBroadcast(tick);
    queueDirectionBroadcast({
        quote,
        trend,
        timestamp: tick.timestamp,
        symbol,
        tickId: msg.tick.id ?? null,
        pipSize: typeof msg.tick.pip_size === 'number'
            && Number.isInteger(msg.tick.pip_size)
            ? msg.tick.pip_size
            : null,
    });
}

function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) return;
    const delay = reconnectDelay;
    const jitter = Math.random() * 500;
    const reconnectIn = delay + jitter;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    console.log(`Reconnecting to Deriv in ${(reconnectIn / 1000).toFixed(2)}s`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToDeriv();
    }, reconnectIn);
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
        resetAllMarketBuffers();
        liveMarketSymbolsSeen.clear();
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

    if (url.pathname === '/stream/ai') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        aiClients.add(res);
        req.on('close', () => aiClients.delete(res));
        return;
    }

    if (url.pathname === '/ai-analysis') {
        sendJson(res, 200, buildAIAnalysisPayload());
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

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.timeout = 0;

const aiBroadcastTimer = setInterval(() => {
    if (aiClients.size === 0) return;
    writeToClients(aiClients, buildAIAnalysisPayload());
}, 5000);

function writeHeartbeat(clients) {
    for (const client of clients) {
        if (client.destroyed || client.writableEnded) {
            clients.delete(client);
            continue;
        }
        try {
            client.write(': heartbeat\n\n');
        } catch {
            clients.delete(client);
        }
    }
}

const sseHeartbeatTimer = setInterval(() => {
    writeHeartbeat(directionClients);
    writeHeartbeat(sseClients);
    writeHeartbeat(aiClients);
}, 15000);

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
    clearInterval(aiBroadcastTimer);
    clearInterval(sseHeartbeatTimer);
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