(() => {
  const $ = (id) => document.getElementById(id);
  const MOMENTUM_THRESHOLD = 65;
  $("momentum-threshold").textContent = `${MOMENTUM_THRESHOLD}%`;
  const FALLBACK_MARKETS = {
    "1HZ10V": "Volatility 10 (1s) Index", "1HZ25V": "Volatility 25 (1s) Index",
    "1HZ50V": "Volatility 50 (1s) Index", "1HZ75V": "Volatility 75 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index", "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index", "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index", "R_100": "Volatility 100 Index"
  };
  let allTicks = [];
  let windowSize = 50;
  let currentSymbol = "1HZ10V";
  let currentMarkets = { ...FALLBACK_MARKETS };
  let lastTickId = null;
  let currentPipSize = 4;
  let lastReceivedAt = 0;
  let streamOpenedAt = 0;
  let switching = false;
  let switchingSymbol = null;
  let bufferedSwitchTicks = [];
  let stream = null;
  let streamBars = [];

  function preserveQuotePrecision(quote, pipSize) {
    const value = String(quote);
    if (!Number.isInteger(pipSize) || pipSize < 0 || pipSize > 12) return value;
    const decimalIndex = value.indexOf(".");
    if (pipSize === 0) return value;
    if (decimalIndex === -1) return `${value}.${"0".repeat(pipSize)}`;
    const currentPrecision = value.length - decimalIndex - 1;
    return currentPrecision < pipSize
      ? `${value}${"0".repeat(pipSize - currentPrecision)}`
      : value;
  }

  function normalizeTick(source) {
    const pipSize = source.pipSize;
    const hasPipSize = typeof pipSize === "number"
      && Number.isInteger(pipSize)
      && pipSize >= 0
      && pipSize <= 12;
    if (hasPipSize) currentPipSize = pipSize;
    const quote = hasPipSize
      ? preserveQuotePrecision(source.quote ?? "", currentPipSize)
      : String(source.quote ?? "");
    const numericQuote = Number(quote);
    const timestamp = Number(source.timestamp);
    if (!Number.isFinite(numericQuote) || !Number.isFinite(timestamp)) return null;
    const digit = Number.parseInt(quote.slice(-1), 10);
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) return null;
    return {
      quote,
      numericQuote,
      timestamp,
      trend: ["up", "down", "flat"].includes(source.trend) ? source.trend : "flat",
      symbol: source.symbol,
      digit,
      tickId: source.tickId ?? null,
      pipSize: hasPipSize ? pipSize : null
    };
  }

  function setConnection(state, label) {
    const connection = $("connection");
    connection.classList.remove("live", "stale", "offline");
    if (state) connection.classList.add(state);
    $("stream-status").textContent = label;
  }

  function showError(message) {
    $("error-message").textContent = message;
    $("error-banner").hidden = false;
  }

  function clearError() {
    $("error-banner").hidden = true;
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
    const prior = select.value;
    select.replaceChildren();
    Object.entries(currentMarkets).forEach(([symbol, label]) => {
      const option = document.createElement("option");
      option.value = symbol;
      option.textContent = label;
      select.appendChild(option);
    });
    if (currentMarkets[prior]) select.value = prior;
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

  function getWindow() {
    return allTicks.slice(-windowSize);
  }

  function updatePrice(tick) {
    $("price").textContent = tick.quote;
    $("price").classList.remove("up", "down");
    if (tick.trend === "up") $("price").classList.add("up");
    if (tick.trend === "down") $("price").classList.add("down");
    $("digit-badge").textContent = tick.digit;
    $("market-symbol").textContent = `${tick.symbol || currentSymbol} · exact quote`;
  }

  function initStreamBars() {
    const bars = $("stream-bars");
    bars.replaceChildren();
    streamBars = Array.from({ length: 40 }, (_, index) => {
      const bar = document.createElement("div");
      bar.className = "stream-bar flat";
      bar.id = `stream-bar-${index}`;
      bar.style.height = "6px";
      bars.appendChild(bar);
      return bar;
    });
  }

  function renderStream() {
    const recent = allTicks.slice(-40);
    const padding = streamBars.length - recent.length;
    streamBars.forEach((bar, index) => {
      const tick = recent[index - padding];
      const trend = tick?.trend || "flat";
      bar.classList.toggle("rise", trend === "up");
      bar.classList.toggle("fall", trend === "down");
      bar.classList.toggle("flat", trend === "flat");
      bar.style.height = !tick ? "6px" : trend === "up" ? "100%" : trend === "down" ? "45%" : "20%";
      bar.title = tick ? `${trend.toUpperCase()} · ${tick.quote}` : "";
      bar.setAttribute("aria-label", tick ? `${trend} tick` : "No tick yet");
    });
  }

  function renderStats() {
    const windowTicks = getWindow();
    const total = windowTicks.length;
    if (!total) {
      $("net-change").textContent = "—";
      $("change-pct").textContent = "—";
      $("direction").textContent = "—";
      $("direction").className = "stat-value blue";
      $("direction-foot").textContent = "Awaiting enough ticks";
      $("rise-bar").style.width = "0%";
      $("fall-bar").style.width = "0%";
      $("rise-counts").textContent = "—";
      $("fall-counts").textContent = "—";
      $("rise-percent").textContent = "—";
      $("fall-percent").textContent = "—";
      $("rise-note").textContent = "Waiting for market data.";
      $("fall-note").textContent = "Waiting for market data.";
      $("rise-note").className = "direction-note";
      $("fall-note").className = "direction-note";
      return;
    }

    const first = windowTicks[0].numericQuote;
    const last = windowTicks[total - 1].numericQuote;
    const net = last - first;
    const pct = first !== 0 ? (net / first) * 100 : null;
    const decimals = Math.min(8, Math.max(2, ...windowTicks.map((tick) => {
      const part = tick.quote.split(".")[1];
      return part ? part.length : 0;
    })));
    const sign = net > 0 ? "+" : "";
    $("net-change").textContent = `${sign}${net.toFixed(decimals)}`;
    $("net-change").className = `stat-value ${net > 0 ? "green" : net < 0 ? "red" : "blue"}`;
    $("change-pct").textContent = pct === null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(4)}%`;
    $("change-pct").className = `stat-value ${pct === null || pct === 0 ? "blue" : pct > 0 ? "green" : "red"}`;

    let up = 0;
    let down = 0;
    windowTicks.forEach((tick) => {
      if (tick.trend === "up") up += 1;
      else if (tick.trend === "down") down += 1;
    });
    const direction = up > down ? "RISING" : down > up ? "FALLING" : "FLAT";
    $("direction").textContent = direction;
    $("direction").className = `stat-value ${direction === "RISING" ? "green" : direction === "FALLING" ? "red" : "blue"}`;
    $("direction-foot").textContent = `${up + down} directional · ${total} total ticks`;

    const upPct = (up / total) * 100;
    const downPct = (down / total) * 100;
    $("rise-bar").style.width = `${upPct}%`;
    $("fall-bar").style.width = `${downPct}%`;
    $("rise-counts").textContent = `${up} / ${total} (${upPct.toFixed(0)}%)`;
    $("fall-counts").textContent = `${down} / ${total} (${downPct.toFixed(0)}%)`;
    $("rise-percent").textContent = `${upPct.toFixed(1)}%`;
    $("fall-percent").textContent = `${downPct.toFixed(1)}%`;

    if (upPct >= MOMENTUM_THRESHOLD) {
      $("rise-note").textContent = `Bullish momentum detected · ${upPct.toFixed(0)}% up ticks.`;
      $("rise-note").className = "direction-note signal-rise";
    } else {
      $("rise-note").textContent = `Insufficient bullish momentum. Wait for ${MOMENTUM_THRESHOLD}%+ up ticks.`;
      $("rise-note").className = "direction-note";
    }
    if (downPct >= MOMENTUM_THRESHOLD) {
      $("fall-note").textContent = `Bearish momentum detected · ${downPct.toFixed(0)}% down ticks.`;
      $("fall-note").className = "direction-note signal-fall";
    } else {
      $("fall-note").textContent = `Insufficient bearish momentum. Wait for ${MOMENTUM_THRESHOLD}%+ down ticks.`;
      $("fall-note").className = "direction-note";
    }
  }

  function renderAll() {
    renderStats();
    renderStream();
  }

  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderStream();
      renderStats();
    });
  }

  async function loadInitial() {
    $("loading-state").hidden = false;
    $("loading-copy").textContent = "Loading recent tick history";
    clearError();
    try {
      const marketsData = await requestJson("/markets");
      populateMarkets(marketsData.markets);
      const symbol = currentMarkets[marketsData.current] ? marketsData.current : Object.keys(currentMarkets)[0];
      currentSymbol = symbol;
      $("market-select").value = symbol;
      $("market-symbol").textContent = `${symbol} · exact quote`;
      const data = await requestJson("/history/direction?count=1000");
      if (data.symbol && data.symbol !== symbol) throw new Error("History market did not match the selected instrument.");
      allTicks = (data.ticks || []).map(normalizeTick).filter(Boolean).slice(-1000);
      const latest = allTicks[allTicks.length - 1];
      if (latest) updatePrice(latest);
      renderAll();
      clearError();
    } catch (error) {
      showError(`Unable to load direction history. ${error.message}`);
      $("loading-copy").textContent = "History unavailable — retry to reconnect.";
      renderAll();
      setConnection("offline", "Data unavailable");
    } finally {
      $("loading-state").hidden = true;
    }
  }

  async function switchMarket(symbol) {
    if (!symbol || symbol === currentSymbol || switching) return;
    const previousSymbol = currentSymbol;
    switching = true;
    switchingSymbol = symbol;
    lastTickId = null;
    currentPipSize = 4;
    bufferedSwitchTicks = [];
    $("market-select").disabled = true;
    clearError();
    allTicks = [];
    lastReceivedAt = 0;
    $("price").textContent = "—";
    $("digit-badge").textContent = "—";
    $("market-symbol").textContent = `${symbol} · loading`;
    $("loading-state").hidden = false;
    $("loading-copy").textContent = "Switching market and loading fresh history";
    setConnection("", "Switching market");
    scheduleRender();
    try {
      const switched = await requestJson(`/switch?symbol=${encodeURIComponent(symbol)}`);
      if (!switched.symbol || switched.symbol !== symbol) throw new Error("Market switch was not confirmed by the data service.");
      if (!Array.isArray(switched.history)) throw new Error("The selected market history was not included in the switch response.");
      currentSymbol = symbol;
      const historyTicks = switched.history.map(normalizeTick).filter(Boolean);
      allTicks = mergeBufferedTicks(historyTicks, bufferedSwitchTicks);
      lastTickId = bufferedSwitchTicks.at(-1)?.tickId ?? null;
      const latest = allTicks[allTicks.length - 1];
      if (latest) updatePrice(latest);
      $("market-symbol").textContent = `${symbol} · exact quote`;
      scheduleRender();
      clearError();
      setConnection(lastReceivedAt ? "live" : "", lastReceivedAt ? "Live" : "History loaded");
    } catch (error) {
      currentSymbol = previousSymbol;
      $("market-select").value = previousSymbol;
      showError(`Could not switch market. ${error.message}`);
      setConnection("offline", "Switch failed");
      try {
        const markets = await requestJson("/markets");
        if (markets.current !== previousSymbol) {
          const restored = await requestJson(`/switch?symbol=${encodeURIComponent(previousSymbol)}`);
          if (restored.symbol === previousSymbol && Array.isArray(restored.history)) {
            allTicks = restored.history.map(normalizeTick).filter(Boolean);
            const latest = allTicks[allTicks.length - 1];
            if (latest) updatePrice(latest);
            $("market-symbol").textContent = `${previousSymbol} · exact quote`;
          }
        } else {
          const restored = await requestJson("/history/direction?count=1000");
          if (restored.symbol === previousSymbol) {
            allTicks = (restored.ticks || []).map(normalizeTick).filter(Boolean);
            const latest = allTicks[allTicks.length - 1];
            if (latest) updatePrice(latest);
            $("market-symbol").textContent = `${previousSymbol} · exact quote`;
          }
        }
      } catch {
        // Keep the switch error visible if the previous market cannot be restored.
      }
      scheduleRender();
    } finally {
      switching = false;
      switchingSymbol = null;
      bufferedSwitchTicks = [];
      $("market-select").disabled = false;
      $("loading-state").hidden = true;
    }
  }

  function connectStream() {
    if (stream) stream.close();
    stream = new EventSource("/stream/direction");
    stream.onopen = () => {
      streamOpenedAt = Date.now();
      if (!lastReceivedAt) setConnection("", "Waiting for tick");
    };
    stream.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (switching) {
        if (data.symbol === switchingSymbol) {
          const buffered = normalizeTick(data);
          if (buffered) {
            lastReceivedAt = Date.now();
            if (buffered.tickId !== null
              && bufferedSwitchTicks.some((tick) => tick.tickId === buffered.tickId)) return;
            bufferedSwitchTicks.push(buffered);
          }
        }
        return;
      }
      if (data.symbol && data.symbol !== currentSymbol) return;
      const tick = normalizeTick(data);
      if (!tick) return;
      lastReceivedAt = Date.now();
      updatePrice(tick);
      setConnection("live", "Live");
      clearError();
      if (tick.tickId !== null && tick.tickId === lastTickId) return;
      if (tick.tickId !== null) lastTickId = tick.tickId;
      allTicks.push(tick);
      if (allTicks.length > 1000) allTicks.shift();
      scheduleRender();
    };
    stream.onerror = () => {
      if (!lastReceivedAt) setConnection("offline", "Reconnecting");
      else setConnection("stale", "Stream interrupted");
    };
  }

  document.querySelectorAll(".tf-btn").forEach((button) => {
    button.addEventListener("click", () => {
      windowSize = Number(button.dataset.tf);
      document.querySelectorAll(".tf-btn").forEach((item) => {
        const active = Number(item.dataset.tf) === windowSize;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      renderAll();
    });
  });
  $("market-select").addEventListener("change", (event) => switchMarket(event.target.value));
  $("retry-button").addEventListener("click", loadInitial);

  initStreamBars();
  renderStream();
  loadInitial().finally(connectStream);
  window.setInterval(() => {
    if (switching) return;
    const reference = lastReceivedAt || streamOpenedAt;
    if (!reference) return;
    const age = Date.now() - reference;
    if (age > 7000) setConnection("stale", "Stale stream");
    else setConnection(lastReceivedAt ? "live" : "", lastReceivedAt ? "Live" : "Waiting for tick");
  }, 1000);

  // ---------- AI Insight widget ----------
  const aiInsightMarket = $("ai-insight-market");
  const aiInsightScore = $("ai-insight-score");
  const aiInsightNote = $("ai-insight-note");
  let lastAiTimestamp = 0;
  function renderAiInsight(data) {
    if (!data) return;
    const timestamp = Number(data.timestamp) || Date.now();
    if (timestamp < lastAiTimestamp) return;
    const markets = Array.isArray(data.markets) ? data.markets : [];
    if (markets.length === 0) return;
    lastAiTimestamp = timestamp;
    const top = markets.slice().sort((a, b) => b.trendScore - a.trendScore)[0];
    if (!top) return;
    aiInsightMarket.textContent = top.name;
    aiInsightScore.textContent = `${top.trendScore} / 100`;
    const parts = [];
    if (top.rSquared > 0.7) parts.push(`R² ${top.rSquared.toFixed(2)}`);
    if (top.riseFall.upPct > 60) parts.push(`${top.riseFall.upPct.toFixed(0)}% up`);
    else if (top.riseFall.upPct < 40) parts.push(`${(100 - top.riseFall.upPct).toFixed(0)}% down`);

    aiInsightNote.textContent = parts.length > 0
      ? `Highest trend-following score · ${parts.join(" · ")}`
      : "Highest trend-following score from current conditions.";
  }

  const aiEventSource = new EventSource("/stream/ai");
  aiEventSource.onmessage = (event) => {
    try { renderAiInsight(JSON.parse(event.data)); } catch { return; }
  };
  fetch("/ai-analysis", { headers: { Accept: "application/json" } })
    .then((response) => response.ok ? response.json() : null)
    .then(renderAiInsight)
    .catch(() => {});
})();