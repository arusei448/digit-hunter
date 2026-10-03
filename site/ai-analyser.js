(() => {
  let currentStrategy = "trend";
  let latestAnalysis = null;

  const tpLabel = document.getElementById("tp-label");
  const tpMarket = document.getElementById("tp-market");
  const tpPrice = document.getElementById("tp-price");
  const tpScore = document.getElementById("tp-score");
  const tpRationale = document.getElementById("tp-rationale");
  const marketRows = document.getElementById("market-rows");
  const tableTitle = document.getElementById("table-title");
  const strategyButtons = [...document.querySelectorAll(".strategy-btn")];

  function acceptAnalysis(data) {
    if (!data || !Array.isArray(data.markets)) return;
    if (latestAnalysis && Number(data.timestamp) < Number(latestAnalysis.timestamp)) return;
    latestAnalysis = data;
    render(data);
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "—";
    return value.toLocaleString("en-US", { maximumFractionDigits: 8, useGrouping: false });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function buildRationale(market) {
    const parts = [];
    if (currentStrategy === "trend") {
      if (market.rSquared > 0.7) parts.push(`<strong>Strong trend strength</strong> (R² ${market.rSquared.toFixed(2)})`);
      else if (market.rSquared > 0.4) parts.push(`Moderate trend strength (R² ${market.rSquared.toFixed(2)})`);
      else parts.push(`Weak directional bias (R² ${market.rSquared.toFixed(2)})`);

      if (market.riseFall.upPct > 60) parts.push(`${market.riseFall.upPct.toFixed(0)}% up-ticks`);
      else if (market.riseFall.upPct < 40) parts.push(`${(100 - market.riseFall.upPct).toFixed(0)}% down-ticks`);
      else parts.push(`Balanced tick flow (${market.riseFall.upPct.toFixed(0)}% up)`);

      if (market.hurst > 0.55) parts.push(`Hurst ${market.hurst.toFixed(2)} indicates trending behaviour in this sample`);
    } else {
      if (market.hurst < 0.45) parts.push(`Hurst ${market.hurst.toFixed(2)} suggests <strong>mean-reverting conditions</strong> in this sample`);
      else parts.push(`Hurst ${market.hurst.toFixed(2)} — mixed conditions`);

      if (market.digitDistribution.chiSq > 15) parts.push(`Notable digit skew (χ² ${market.digitDistribution.chiSq.toFixed(1)})`);
      else parts.push(`Digit distribution near uniform (χ² ${market.digitDistribution.chiSq.toFixed(1)})`);

      if (market.streak.currentStreak >= 4) {
        parts.push(`Current ${market.streak.currentStreak}-tick ${escapeHtml(market.streak.direction)} streak`);
      }
    }
    return parts.join(" · ");
  }

  function showEmptyState() {
    tpMarket.textContent = "Collecting market data…";
    tpPrice.textContent = "Waiting for at least 20 ticks per market";
    tpScore.textContent = "—";
    tpRationale.textContent = "Scores describe the latest buffered conditions and are not predictions.";
    marketRows.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#6b7280;padding:30px;">Waiting for data from all markets…</td></tr>';
  }

  function render(data) {
    const markets = Array.isArray(data.markets) ? data.markets : [];
    if (markets.length === 0) {
      showEmptyState();
      return;
    }

    const scoreKey = currentStrategy === "trend" ? "trendScore" : "reversionScore";
    const strategyName = currentStrategy === "trend" ? "Trend-Following" : "Mean-Reversion";
    const sorted = markets
      .filter((market) => Number.isFinite(market[scoreKey]))
      .slice()
      .sort((a, b) => b[scoreKey] - a[scoreKey]);
    if (sorted.length === 0) {
      showEmptyState();
      return;
    }

    const top = sorted[0];
    tpLabel.textContent = `Top ${strategyName} Score`;
    tpMarket.textContent = top.name;
    tpPrice.textContent = `${formatPrice(top.currentPrice)} · ${top.tickCount} ticks analysed`;
    tpScore.textContent = `Score: ${top[scoreKey]} / 100`;
    tpRationale.innerHTML = buildRationale(top);
    tableTitle.textContent = `All Markets — Ranked by ${strategyName} Score`;

    marketRows.innerHTML = "";
    sorted.forEach((market, index) => {
      const row = document.createElement("tr");
      const rankClass = index === 0 ? "top1" : index === 1 ? "top2" : index === 2 ? "top3" : "";
      const score = Math.max(0, Math.min(100, market[scoreKey]));
      const risePct = market.riseFall.upPct;
      const riseClass = risePct > 50 ? "green" : risePct < 50 ? "red" : "";
      row.innerHTML = `
        <td><span class="rank-badge ${rankClass}">${index + 1}</span></td>
        <td class="market-cell">${escapeHtml(market.name)}</td>
        <td class="num-cell">${formatPrice(market.currentPrice)}</td>
        <td>
          <span class="score-bar" aria-label="Score ${score} out of 100"><span class="score-bar-fill" style="display:block;width:${score}%"></span></span>
          <span class="score-cell">${score}</span>
        </td>
        <td class="num-cell hide-mobile">${market.rSquared.toFixed(2)}</td>
        <td class="num-cell ${riseClass} hide-mobile">${risePct.toFixed(1)}%</td>
        <td class="num-cell hide-mobile">${(market.volatility * 100).toFixed(2)}%</td>
        <td class="num-cell hide-mobile">${market.hurst.toFixed(2)}</td>
        <td class="num-cell hide-mobile">${market.streak.currentStreak} ${escapeHtml(market.streak.direction)}</td>
      `;
      marketRows.appendChild(row);
    });
  }

  strategyButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentStrategy = button.dataset.strategy === "reversion" ? "reversion" : "trend";
      strategyButtons.forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      if (latestAnalysis) render(latestAnalysis);
    });
  });

  const eventSource = new EventSource("/stream/ai");
  eventSource.onmessage = (event) => {
    try {
      acceptAnalysis(JSON.parse(event.data));
    } catch (error) {
      console.error("Could not parse AI analysis update:", error);
    }
  };
  eventSource.onerror = () => {
    // EventSource reconnects automatically; retain the latest valid analysis.
  };

  fetch("/ai-analysis", { headers: { Accept: "application/json" } })
    .then((response) => {
      if (!response.ok) throw new Error(`Analysis request failed (${response.status})`);
      return response.json();
    })
    .then(acceptAnalysis)
    .catch((error) => {
      tpRationale.textContent = `Waiting for live analysis data. ${error.message}`;
    });
})();