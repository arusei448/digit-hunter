console.log("STEP 1: script started");

const WebSocket = require('ws');

const connection = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');

connection.on('open', () => {
    console.log("STEP 2: websocket OPEN");
    connection.send(JSON.stringify({ "ticks": "R_50", "subscribe": 1 }));
    console.log("STEP 3: sent ticks request for R_50");
});

connection.on('message', (data) => {
    const response = JSON.parse(data);
    if (response.tick) {
        const quote = response.tick.quote;
        const lastDigit = quote.toString().slice(-1);
        console.log(`TICK: ${quote} | Last Digit: ${lastDigit}`);
    } else {
        console.log("RAW:", JSON.stringify(response));
    }
});

connection.on('error', (e) => console.log("ERROR:", e.message));
connection.on('close', () => console.log("STEP 4: websocket closed"));