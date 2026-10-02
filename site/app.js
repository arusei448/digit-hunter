(() => {
  const $ = (id) => document.getElementById(id);
  const FALLBACK_MARKETS = {
    "1HZ10V": "Volatility 10 (1s) Index", "1HZ25V": "Volatility 25 (1s) Index",
    "1HZ50V": "Volatility 50 (1s) Index", "1HZ75V": "Volatility 75 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index", "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index", "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index", "R_100": "Volatility 100 Index"
  };
  const chartContainer = $("chart-container");
  let chart = null;
  let lineSeries = null;
  let chartReady = false;
  let allTicks = [];
  let maxTicks = 200;
  let currentSymbol = "1HZ10V";
  let currentMarkets = { ...FALLBACK_MARKETS };
  let lastReceivedAt = 0;
  let streamOpenedAt = 0;
  let switching = false;
  let switchingSymbol = null;
  let bufferedSwitchTicks = [];
  let stream = null;
  let lastChartTime = null;

  function createChart() {
    if (!window.LightweightCharts || !chartContainer) return;
    chart = LightweightCharts.createChart(chartContainer, {
      width: chartContainer.clientWidth,
      height: 292,
      layout: { background: { color: "#1a1d24" }, textColor: "#778390", fontFamily: '"DM Mono", monospace' },
      grid: { vertLines: { color: "#242830" }, horzLines: { color: "#242830" } },
      rightPriceScale: { borderColor: "#343943", scaleMargins: { top: .14, bottom: .12 } },
      timeScale: { borderColor: "#343943", timeVisible: true, secondsVisible: true, rightOffset: 3 },
      crosshair: { vertLine: { color: "#506069", labelBackgroundColor: "#29484c" }, horzLine: { color: "#506069", labelBackgroundColor: "#29484c" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true }
    });
    lineSeries = chart.addLineSeries({
      color: "#54c8d5", lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: true, crosshairMarkerRadius: 3,
      crosshairMarkerBorderColor: "#54c8d5", crosshairMarkerBackgroundColor: "#1a1d24"
    });
    chartReady = true;
    resizeChart();
  }

  function resizeChart() {
    if (chart && chartContainer) chart.applyOptions({ width: Math.max(1, chartContainer.clientWidth) });
  }

  function extractDigit(quote) {
    const lastCharacter = String(quote ?? "").slice(-1);
    const digit = Number.parseInt(lastCharacter, 10);
    return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : null;
  }

  function normalizeTick(tick) {
    const quote = String(tick.quote ?? "");
    const value = Number(quote);
    const digit = extractDigit(quote);
    const timestamp = Number(tick.timestamp);
    if (!Number.isFinite(value) || !Number.isFinite(timestamp) || digit === null) return null;
    return { quote, value, digit, timestamp, trend: tick.trend || "flat", symbol: tick.symbol };
  }

  function selectedTicks() {
    return allTicks.slice(-maxTicks);
  }

  function setChartData(ticks, fitContent = true) {
    if (!chartReady) return;
    // Lightweight Charts requires ascending, unique time keys. When the feed
    // timestamps several ticks to the same second, separate their plotted time
    // keys by a millisecond so every real quote is still present in the series.
    const points = [];
    let previousTime = null;
    for (const tick of ticks) {
      const time = previousTime !== null && tick.timestamp <= previousTime
        ? previousTime + 0.001
        : tick.timestamp;
      points.push({ time, value: tick.value });
      previousTime = time;
    }
    lineSeries.setData(points);
    lastChartTime = points.length ? points[points.length - 1].time : null;
    if (points.length && fitContent) chart.timeScale().fitContent();
    $("chart-empty").hidden = points.length > 0;
    $("chart-empty-copy").textContent = points.length ? "" : "Waiting for market history";
  }

  function renderDistribution() {
    const ticks = selectedTicks();
    const counts = Array(10).fill(0);
    ticks.forEach((tick) => { if (tick.digit >= 0 && tick.digit <= 9) counts[tick.digit] += 1; });
    const total = ticks.length;
    const latest = total ? ticks[total - 1].digit : null;
    let hot = null;
    let cold = null;
    if (total) {
      hot = 0; cold = 0;
      for (let digit = 1; digit < 10; digit += 1) {
        if (counts[digit] > counts[hot]) hot = digit;
        if (counts[digit] < counts[cold]) cold = digit;
      }
    }

    const digits = $("digits");
    digits.replaceChildren();
    for (let digit = 0; digit < 10; digit += 1) {
      const cell = document.createElement("div");
      cell.className = "digit-cell";
      const circle = document.createElement("div");
      circle.className = "digit-circle";
      if (digit === latest) circle.classList.add("latest");
      else if (digit === hot && total > 5) circle.classList.add("hot");
      else if (digit === cold && total > 5) circle.classList.add("cold");
      const number = document.createElement("span");
      number.className = "digit-number";
      number.textContent = String(digit);
      const percent = document.createElement("span");
      percent.className = "digit-percent";
      percent.textContent = total ? `${((counts[digit] / total) * 100).toFixed(1)}%` : "—";
      circle.append(number, percent);
      const tag = document.createElement("span");
      tag.className = "digit-tag";
      tag.textContent = digit === latest && total ? "latest" : digit === hot && total > 5 ? "most" : digit === cold && total > 5 ? "least" : "";
      cell.append(circle, tag);
      digits.appendChild(cell);
    }

    $("distribution-note").textContent = `${total.toLocaleString()} ${total === 1 ? "tick" : "ticks"} in sample`;
    $("total-ticks").textContent = total ? total.toLocaleString() : "—";
    $("latest-digit").textContent = latest === null ? "—" : String(latest);
    $("hot-digit").textContent = hot === null || total <= 5 ? "—" : `${hot} · ${counts[hot]}`;
    $("cold-digit").textContent = cold === null || total <= 5 ? "—" : `${cold} · ${counts[cold]}`;

    const visualHistory = [];
    let priorDigit = null;
    for (let i = ticks.length - 1; i >= 0 && visualHistory.length < 30; i -= 1) {
      const tick = ticks[i];
      if (tick.digit === priorDigit) continue;
      visualHistory.push(tick.digit);
      priorDigit = tick.digit;
    }
    const history = $("history");
    history.replaceChildren();
    if (!visualHistory.length) {
      const empty = document.createElement("span");
      empty.className = "history-empty";
      empty.textContent = "Digits will appear here as ticks arrive.";
      history.appendChild(empty);
    } else {
      visualHistory.forEach((digit) => {
        const pill = document.createElement("span");
        pill.className = `history-pill d${digit}`;
        pill.textContent = String(digit);
        history.appendChild(pill);
      });
    }
  }

  function renderWindow() {
    const ticks = selectedTicks();
    $("chart-meta").textContent = `Last ${maxTicks} ticks · ${ticks.length.toLocaleString()} available · full-precision quotes`;
    document.querySelectorAll(".tf-btn").forEach((button) => {
      const active = Number(button.dataset.tf) === maxTicks;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderDistribution();
    setChartData(ticks);
  }

  function setConnection(state, label) {
    const el = $("connection");
    el.classList.remove("live", "stale", "offline");
    if (state) el.classList.add(state);
    $("stream-status").textContent = label;
  }

  function showError(message) {
    $("error-message").textContent = message;
    $("error-banner").hidden = false;
  }

  function clearError() {
    $("error-banner").hidden = true;
  }

  function setMarketIdentity(symbol) {
    currentSymbol = symbol;
    const label = currentMarkets[symbol] || FALLBACK_MARKETS[symbol] || symbol;
    $("market-select").value = symbol;
    $("market-name").textContent = label;
    $("market-symbol").textContent = symbol;
    $("market-icon").textContent = symbol.replace("1HZ", "").replace("R_", "") + (symbol.startsWith("1HZ") ? "S" : "");
  }

  function updateQuote(tick) {
    const price = $("price");
    const arrow = $("price-arrow");
    price.textContent = tick.quote;
    price.classList.remove("up", "down");
    arrow.classList.remove("up", "down");
    if (tick.trend === "up") {
      price.classList.add("up"); arrow.classList.add("up"); arrow.textContent = "▲";
    } else if (tick.trend === "down") {
      price.classList.add("down"); arrow.classList.add("down"); arrow.textContent = "▼";
    } else {
      arrow.textContent = "—";
    }
    $("last-update").textContent = `Updated ${new Date(tick.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }

  async function requestJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json();
  }

  function populateMarkets(markets) {
    if (!markets || typeof markets !== "object") return;
    currentMarkets = { ...FALLBACK_MARKETS, ...markets };
    const select = $("market-select");
    const current = select.value;
    select.replaceChildren();
    Object.entries(currentMarkets).forEach(([symbol, label]) => {
      const option = document.createElement("option");
      option.value = symbol;
      option.textContent = label;
      select.appendChild(option);
    });
    if (currentMarkets[current]) select.value = current;
  }

  function mergeBufferedTicks(historyTicks, bufferedTicks) {
    const occurrences = new Map();
    for (const tick of historyTicks) {
      const key = `${tick.timestamp}:${tick.quote}`;
      occurrences.set(key, (occurrences.get(key) || 0) + 1);
    }
    const additions = [];
    for (const tick of bufferedTicks) {
      const key = `${tick.timestamp}:${tick.quote}`;
      const count = occurrences.get(key) || 0;
      if (count > 0) occurrences.set(key, count - 1);
      else additions.push(tick);
    }
    return [...historyTicks, ...additions].sort((a, b) => a.timestamp - b.timestamp).slice(-1000);
  }

  async function loadInitial() {
    clearError();
    $("chart-empty").hidden = false;
    $("chart-empty-copy").textContent = "Loading market history";
    try {
      const marketData = await requestJson("/markets");
      populateMarkets(marketData.markets);
      const symbol = currentMarkets[marketData.current] ? marketData.current : Object.keys(currentMarkets)[0];
      setMarketIdentity(symbol);
      let historyData = await requestJson("/history");
      if (historyData.symbol && historyData.symbol !== symbol) {
        const refreshed = await requestJson(`/switch?symbol=${encodeURIComponent(symbol)}`);
        if (refreshed.symbol !== symbol) throw new Error("The market switch was not confirmed.");
        historyData = await requestJson("/history");
      }
      if (historyData.symbol && historyData.symbol !== symbol) throw new Error("Received history for a different market.");
      const history = Array.isArray(historyData.history) ? historyData.history : [];
      allTicks = (history || []).map(normalizeTick).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp).slice(-1000);
      const latest = allTicks[allTicks.length - 1];
      if (latest) updateQuote(latest);
      renderWindow();
      clearError();
    } catch (error) {
      showError(`Unable to load market history. ${error.message}`);
      $("chart-empty-copy").textContent = "History unavailable — retry to reconnect.";
      $("chart-empty").hidden = false;
      setConnection("offline", "Data unavailable");
    }
  }

  async function switchMarket(symbol) {
    if (!symbol || symbol === currentSymbol || switching) return;
    const previousSymbol = currentSymbol;
    switching = true;
    switchingSymbol = symbol;
    bufferedSwitchTicks = [];
    $("market-select").disabled = true;
    clearError();
    allTicks = [];
    lastReceivedAt = 0;
    $("price").textContent = "—";
    $("last-update").textContent = "Waiting for first tick";
    setConnection("", "Switching market");
    renderWindow();
    $("chart-empty").hidden = false;
    $("chart-empty-copy").textContent = "Loading selected market history";
    try {
      const switched = await requestJson(`/switch?symbol=${encodeURIComponent(symbol)}`);
      if (!switched.symbol || switched.symbol !== symbol) throw new Error("Market switch was not confirmed by the data service.");
      setMarketIdentity(symbol);
      const data = await requestJson("/history");
      if (data.symbol && data.symbol !== symbol) throw new Error("Received history for a different market.");
      const historyTicks = (data.history || []).map(normalizeTick).filter(Boolean);
      allTicks = mergeBufferedTicks(historyTicks, bufferedSwitchTicks);
      const latest = allTicks[allTicks.length - 1];
      if (latest) updateQuote(latest);
      renderWindow();
      clearError();
      setConnection(lastReceivedAt ? "live" : "", lastReceivedAt ? "Live" : "History loaded");
    } catch (error) {
      setMarketIdentity(previousSymbol);
      showError(`Could not switch market. ${error.message}`);
      setConnection("offline", "Switch failed");
      try {
        const markets = await requestJson("/markets");
        if (markets.current !== previousSymbol) {
          await requestJson(`/switch?symbol=${encodeURIComponent(previousSymbol)}`);
        }
        const restored = await requestJson("/history");
        if (restored.symbol === previousSymbol) {
          allTicks = (restored.history || []).map(normalizeTick).filter(Boolean);
          const latest = allTicks[allTicks.length - 1];
          if (latest) updateQuote(latest);
        }
      } catch {
        // Keep the switch error visible if the old history is also unavailable.
      }
      renderWindow();
    } finally {
      switching = false;
      switchingSymbol = null;
      bufferedSwitchTicks = [];
      $("market-select").disabled = false;
    }
  }

  function connectStream() {
    if (stream) stream.close();
    stream = new EventSource("/stream");
    stream.onopen = () => {
      streamOpenedAt = Date.now();
      if (!lastReceivedAt) setConnection("", "Waiting for tick");
    };
    stream.onmessage = (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (switching) {
        if (payload.symbol === switchingSymbol) {
          const buffered = normalizeTick(payload);
          if (buffered) {
            bufferedSwitchTicks.push(buffered);
            lastReceivedAt = Date.now();
          }
        }
        return;
      }
      if (payload.symbol && payload.symbol !== currentSymbol) return;
      const tick = normalizeTick(payload);
      if (!tick) return;
      lastReceivedAt = Date.now();
      updateQuote(tick);
      const previousTickCount = allTicks.length;
      allTicks.push(tick);
      if (allTicks.length > 1000) allTicks.shift();
      setConnection("live", "Live");
      clearError();
      renderDistribution();
      const view = selectedTicks();
      const chartMustReset = previousTickCount >= maxTicks || (lastChartTime !== null && tick.timestamp <= lastChartTime);
      if (chartMustReset) {
        setChartData(view, false);
      } else if (chartReady) {
        lineSeries.update({ time: tick.timestamp, value: tick.value });
        lastChartTime = tick.timestamp;
        $("chart-empty").hidden = view.length > 0;
      }
      $("chart-meta").textContent = `Last ${maxTicks} ticks · ${view.length.toLocaleString()} available · full-precision quotes`;
    };
    stream.onerror = () => {
      if (!lastReceivedAt) setConnection("offline", "Reconnecting");
      else setConnection("stale", "Stream interrupted");
    };
  }

  document.querySelectorAll(".tf-btn").forEach((button) => {
    button.addEventListener("click", () => {
      maxTicks = Number(button.dataset.tf);
      renderWindow();
    });
  });
  $("market-select").addEventListener("change", (event) => switchMarket(event.target.value));
  $("retry-button").addEventListener("click", () => loadInitial());

  createChart();
  window.addEventListener("resize", resizeChart);
  loadInitial().finally(connectStream);
  window.setInterval(() => {
    if (switching) return;
    const reference = lastReceivedAt || streamOpenedAt;
    if (!reference) return;
    const age = Date.now() - reference;
    if (age > 7000) {
      setConnection("stale", "Stale stream");
      if (lastReceivedAt) $("last-update").textContent = `${(age / 1000).toFixed(0)}s since last tick`;
    } else if (!switching) {
      setConnection(lastReceivedAt ? "live" : "", lastReceivedAt ? "Live" : "Waiting for tick");
    }
  }, 1000);
})();