(function () {
  const token = sessionStorage.getItem('deriv_token');
  const otpUrl = sessionStorage.getItem('deriv_otp_url');

  if (!token || !otpUrl) {
    return;
  }

  document.getElementById('not-connected').style.display = 'none';
  document.getElementById('bot-content').style.display = 'block';

  let authenticatedWs = null;
  let botRunning = false;
  let strategyMap = {};
  let botHistory = [];
  let botState = { round: 0, currentStake: 0, totalPnL: 0, wins: 0, losses: 0 };
  let pendingReqId = null;

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const statusIndicator = document.getElementById('bot-status-indicator');
  const statRounds = document.getElementById('stat-rounds');
  const statStake = document.getElementById('stat-stake');
  const statPnl = document.getElementById('stat-pnl');
  const statWl = document.getElementById('stat-wl');
  const historyBody = document.getElementById('bot-history-body');

  function updateBotStatus(run) {
    if (!run) return;
    botState.round = run.run_count || botState.round;
    botState.currentStake = run.current_stake || botState.currentStake;
    botState.totalPnL = run.profit || botState.totalPnL;
    botState.wins = run.wins || botState.wins;
    botState.losses = run.losses || botState.losses;

    statRounds.textContent = botState.round;
    statStake.textContent = '$' + Number(botState.currentStake).toFixed(2);

    const pnl = Number(botState.totalPnL);
    statPnl.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
    statPnl.className = 'status-value ' + (pnl >= 0 ? 'green' : 'red');
    statWl.textContent = botState.wins + ' / ' + botState.losses;

    if (run.last_contract) {
      addHistoryEntry(run.last_contract);
    }
  }

  function addHistoryEntry(contract) {
    const entry = {
      round: botState.round,
      stake: Number(contract.buy_price || 0).toFixed(2),
      type: contract.contract_type || '—',
      result: contract.status || '—',
      pnl: Number(contract.profit || 0),
    };
    botHistory.unshift(entry);
    if (botHistory.length > 50) botHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    if (botHistory.length === 0) {
      historyBody.innerHTML = '<tr class="empty-row"><td colspan="5">No bot activity yet</td></tr>';
      return;
    }
    let html = '';
    botHistory.forEach(function (h) {
      const pnlClass = h.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlText = (h.pnl >= 0 ? '+' : '') + '$' + Number(h.pnl).toFixed(2);
      const resultColor = h.result === 'won' ? 'var(--lime)' : h.result === 'lost' ? 'var(--coral)' : 'var(--muted)';
      html += '<tr>'
        + '<td>' + h.round + '</td>'
        + '<td>$' + h.stake + '</td>'
        + '<td>' + h.type + '</td>'
        + '<td style="color:' + resultColor + '">' + h.result + '</td>'
        + '<td class="' + pnlClass + '">' + pnlText + '</td>'
        + '</tr>';
    });
    historyBody.innerHTML = html;
  }

  function setRunning(running) {
    botRunning = running;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    statusIndicator.className = 'status-indicator ' + (running ? 'running' : 'stopped');
    statusIndicator.innerHTML = '<span class="status-dot"></span> ' + (running ? 'Running' : 'Stopped');
  }

  function listStrategies() {
    return new Promise(function (resolve, reject) {
      var reqId = Date.now();
      var handler = function (event) {
        var msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.req_id === reqId) {
          authenticatedWs.removeEventListener('message', handler);
          if (msg.error) { reject(new Error(msg.error.message)); return; }
          if (msg.auto_list_strategies && msg.auto_list_strategies.strategies) {
            msg.auto_list_strategies.strategies.forEach(function (s) {
              strategyMap[s.name] = s.id;
            });
          }
          resolve(msg.auto_list_strategies ? msg.auto_list_strategies.strategies : []);
        }
      };
      authenticatedWs.addEventListener('message', handler);
      authenticatedWs.send(JSON.stringify({ auto_list_strategies: 1, req_id: reqId }));
      setTimeout(function () {
        authenticatedWs.removeEventListener('message', handler);
        reject(new Error('Timed out listing strategies'));
      }, 10000);
    });
  }

  async function startBot() {
    if (!authenticatedWs || authenticatedWs.readyState !== WebSocket.OPEN) return;

    var strategyName = document.getElementById('strategy-select').value;
    var config = {
      strategy: strategyName,
      initialStake: Number(document.getElementById('initial-stake').value) || 1,
      multiplier: Number(document.getElementById('multiplier').value) || 2,
      profitThreshold: Number(document.getElementById('profit-threshold').value) || 10,
      lossThreshold: Number(document.getElementById('loss-threshold').value) || 20,
      maxStake: Number(document.getElementById('max-stake').value) || 50,
      symbol: document.getElementById('bot-symbol').value,
      contractType: document.getElementById('bot-contract-type').value,
      duration: Number(document.getElementById('bot-duration').value) || 5,
    };

    startBtn.disabled = true;
    try {
      var strategies = await listStrategies();
      var strategyId = strategyMap[strategyName];
      if (!strategyId && strategies.length > 0) {
        var match = strategies.find(function (s) { return s.name === strategyName; });
        strategyId = match ? match.id : strategies[0].id;
      }

      botState = { round: 0, currentStake: config.initialStake, totalPnL: 0, wins: 0, losses: 0 };
      botHistory = [];
      renderHistory();

      authenticatedWs.send(JSON.stringify({
        auto_start: 1,
        contract_template: {
          contract_type: config.contractType,
          currency: 'USD',
          symbol: config.symbol,
          duration: config.duration,
          duration_unit: 't',
        },
        strategy_id: strategyId,
        strategy_parameters: {
          initial_stake: config.initialStake,
          multiplier: config.multiplier,
          profit_threshold: config.profitThreshold,
          loss_threshold: config.lossThreshold,
          max_stake: config.maxStake,
        },
        subscribe: 1,
      }));
      setRunning(true);
    } catch (err) {
      console.error('Failed to start bot:', err.message);
      startBtn.disabled = false;
    }
  }

  function stopBot() {
    if (!authenticatedWs || authenticatedWs.readyState !== WebSocket.OPEN) return;
    authenticatedWs.send(JSON.stringify({ auto_stop: 1 }));
    setRunning(false);
  }

  function handleWsMessage(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.error) {
      console.error('Bot API error:', msg.error.message);
      return;
    }

    if (msg.msg_type === 'auto_start' || msg.msg_type === 'auto_get') {
      var run = msg.auto_start || msg.auto_get;
      if (run) updateBotStatus(run);
    }
    if (msg.msg_type === 'auto_stop') {
      setRunning(false);
    }
  }

  function connect() {
    authenticatedWs = new WebSocket(otpUrl);
    authenticatedWs.onopen = function () {
      authenticatedWs.send(JSON.stringify({ balance: 1, subscribe: 1 }));
    };
    authenticatedWs.onmessage = handleWsMessage;
    authenticatedWs.onerror = function () { console.error('Bot WebSocket error'); };
  }

  startBtn.addEventListener('click', startBot);
  stopBtn.addEventListener('click', stopBot);

  connect();
})();
