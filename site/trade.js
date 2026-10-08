(function () {
  const token = sessionStorage.getItem('deriv_token');
  const otpUrl = sessionStorage.getItem('deriv_otp_url');
  const accountId = sessionStorage.getItem('deriv_account_id');
  const accountType = sessionStorage.getItem('deriv_account_type');

  if (!token || !otpUrl) {
    return;
  }

  document.getElementById('not-connected').style.display = 'none';
  document.getElementById('trade-content').style.display = 'block';

  let authenticatedWs = null;
  let currentBalance = 0;
  let currentProposal = null;
  let selectedContractType = 'CALL';
  let selectedSymbol = 'R_100';
  let selectedDuration = 5;
  let stakeAmount = 1;
  let openPositions = new Map();
  let subscribedContracts = new Set();
  let chart = null;
  let chartSeries = null;
  let chartData = [];
  let lastTickCount = 0;

  const balanceDisplay = document.getElementById('balance-display');
  const accountBadge = document.getElementById('account-badge');
  const payoutDisplay = document.getElementById('payout-display');
  const payoutEmpty = document.getElementById('payout-empty');
  const riseBtn = document.getElementById('rise-btn');
  const fallBtn = document.getElementById('fall-btn');
  const stakeInput = document.getElementById('stake-input');
  const positionsBody = document.getElementById('positions-body');
  const chartPrice = document.getElementById('chart-price');
  const chartSymbolLabel = document.getElementById('chart-symbol-label');
  const marketSelect = document.getElementById('market-select');
  const modal = document.getElementById('contract-modal');

  const SYMBOL_NAMES = {
    R_10: 'Volatility 10 Index', R_25: 'Volatility 25 Index', R_50: 'Volatility 50 Index',
    R_75: 'Volatility 75 Index', R_100: 'Volatility 100 Index',
    '1HZ10V': 'Volatility 10 (1s) Index', '1HZ25V': 'Volatility 25 (1s) Index',
    '1HZ50V': 'Volatility 50 (1s) Index', '1HZ75V': 'Volatility 75 (1s) Index',
    '1HZ100V': 'Volatility 100 (1s) Index',
  };

  function initChart() {
    if (typeof LightweightCharts === 'undefined') return;
    chart = LightweightCharts.createChart(document.getElementById('trade-chart'), {
      layout: { background: { color: '#1a1d24' }, textColor: '#8892a0', fontSize: 11 },
      grid: { vertLines: { color: '#2a2e37' }, horzLines: { color: '#2a2e37' } },
      rightPriceScale: { borderColor: '#2a2e37' },
      timeScale: { borderColor: '#2a2e37', timeVisible: false },
      crosshair: { mode: 0 },
    });
    chartSeries = chart.addAreaSeries({
      lineColor: '#54c8d5', topColor: 'rgba(84,200,213,.15)', bottomColor: 'rgba(84,200,213,0)',
      lineWidth: 2,
    });
    window.addEventListener('resize', function () { if (chart) chart.applyOptions({ width: document.getElementById('trade-chart').clientWidth }); });
  }

  function updateBalanceDisplay(balance) {
    currentBalance = balance;
    balanceDisplay.textContent = '$' + Number(balance).toFixed(2);
  }

  function updatePayoutPreview(proposal) {
    const payout = Number(proposal.payout);
    payoutDisplay.textContent = '$' + payout.toFixed(2);
    payoutDisplay.style.display = 'block';
    payoutEmpty.style.display = 'none';
  }

  function clearPayoutPreview() {
    payoutDisplay.style.display = 'none';
    payoutEmpty.style.display = 'block';
  }

  function requestProposal() {
    if (!authenticatedWs || authenticatedWs.readyState !== WebSocket.OPEN) return;
    clearPayoutPreview();
    riseBtn.disabled = true;
    fallBtn.disabled = true;
    authenticatedWs.send(JSON.stringify({
      proposal: 1,
      amount: stakeAmount,
      basis: 'stake',
      contract_type: selectedContractType,
      currency: 'USD',
      symbol: selectedSymbol,
      duration: selectedDuration,
      duration_unit: 't',
    }));
  }

  function buyContract() {
    if (!currentProposal) return;
    authenticatedWs.send(JSON.stringify({
      buy: currentProposal.id,
      price: currentProposal.ask_price,
    }));
  }

  function monitorContract(contractId) {
    if (subscribedContracts.has(contractId)) return;
    subscribedContracts.add(contractId);
    authenticatedWs.send(JSON.stringify({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1,
    }));
  }

  function sellContract(contractId) {
    authenticatedWs.send(JSON.stringify({ sell: contractId, price: 0 }));
  }

  function addOpenPosition(buyData) {
    const id = buyData.contract_id;
    openPositions.set(id, {
      contractId: id,
      type: buyData.contract_type || selectedContractType,
      stake: Number(buyData.buy_price || buyData.price || 0).toFixed(2),
      entrySpot: '—',
      pnl: 0,
      status: 'open',
    });
    renderPositions();
    monitorContract(id);
    showModal(id);
  }

  function updateContractStatus(contract) {
    const id = contract.contract_id;
    if (openPositions.has(id)) {
      const pos = openPositions.get(id);
      pos.entrySpot = contract.entry_spot || pos.entrySpot;
      pos.pnl = contract.profit !== undefined ? Number(contract.profit) : pos.pnl;
      pos.status = contract.status || pos.status;
      if (contract.status === 'won' || contract.status === 'lost') {
        pos.status = contract.status;
      }
    }
    renderPositions();
    if (modal.classList.contains('show') && document.getElementById('modal-contract-id').textContent === String(id)) {
      updateModal(contract);
    }
  }

  function removeOpenPosition(contractId) {
    openPositions.delete(contractId);
    renderPositions();
  }

  function renderPositions() {
    if (openPositions.size === 0) {
      positionsBody.innerHTML = '<tr class="empty-row"><td colspan="6">No open positions</td></tr>';
      return;
    }
    let html = '';
    openPositions.forEach(function (pos) {
      const pnlClass = pos.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlText = (pos.pnl >= 0 ? '+' : '') + '$' + Number(pos.pnl).toFixed(2);
      const showSell = pos.status === 'open';
      html += '<tr>'
        + '<td>' + pos.contractId + '</td>'
        + '<td>' + pos.type + '</td>'
        + '<td>$' + pos.stake + '</td>'
        + '<td>' + pos.entrySpot + '</td>'
        + '<td class="' + pnlClass + '">' + pnlText + '</td>'
        + '<td>' + (showSell ? '<button class="sell-btn" data-id="' + pos.contractId + '">Sell</button>' : '—') + '</td>'
        + '</tr>';
    });
    positionsBody.innerHTML = html;
    positionsBody.querySelectorAll('.sell-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { sellContract(Number(btn.dataset.id)); });
    });
  }

  function showModal(contractId) {
    const pos = openPositions.get(contractId);
    if (!pos) return;
    document.getElementById('modal-contract-id').textContent = pos.contractId;
    document.getElementById('modal-type').textContent = pos.type;
    document.getElementById('modal-entry').textContent = pos.entrySpot;
    document.getElementById('modal-current').textContent = '—';
    document.getElementById('modal-pnl').textContent = '$0.00';
    document.getElementById('modal-status').textContent = pos.status;
    modal.classList.add('show');
  }

  function updateModal(contract) {
    document.getElementById('modal-current').textContent = contract.current_spot || '—';
    const pnl = Number(contract.profit || 0);
    const pnlEl = document.getElementById('modal-pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    pnlEl.style.color = pnl >= 0 ? 'var(--lime)' : 'var(--coral)';
    document.getElementById('modal-status').textContent = contract.status || 'open';
  }

  function handleWsMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.error) {
      console.error('Deriv API error:', msg.error.message);
      return;
    }

    switch (msg.msg_type) {
      case 'balance':
        updateBalanceDisplay(msg.balance.balance);
        break;
      case 'proposal':
        currentProposal = msg.proposal;
        updatePayoutPreview(msg.proposal);
        riseBtn.disabled = selectedContractType !== 'CALL';
        fallBtn.disabled = selectedContractType !== 'PUT';
        break;
      case 'buy':
        addOpenPosition(msg.buy);
        currentProposal = null;
        clearPayoutPreview();
        setTimeout(requestProposal, 500);
        break;
      case 'proposal_open_contract':
        updateContractStatus(msg.proposal_open_contract);
        break;
      case 'sell':
        removeOpenPosition(msg.sell.contract_id);
        break;
      case 'portfolio':
        if (msg.portfolio && msg.portfolio.contracts) {
          msg.portfolio.contracts.forEach(function (c) {
            openPositions.set(c.contract_id, {
              contractId: c.contract_id,
              type: c.contract_type || '—',
              stake: Number(c.buy_price || 0).toFixed(2),
              entrySpot: '—',
              pnl: 0,
              status: 'open',
            });
          });
          renderPositions();
          msg.portfolio.contracts.forEach(function (c) { monitorContract(c.contract_id); });
        }
        break;
      case 'tick':
        if (msg.tick && chartSeries) {
          const price = Number(msg.tick.quote);
          const time = Number(msg.tick.epoch);
          chartSeries.update({ time: time, value: price });
          chartPrice.textContent = price.toFixed(2);
          lastTickCount++;
          if (lastTickCount > 500) {
            chartData = chartData.slice(-500);
          }
        }
        break;
    }
  }

  function connectTrading() {
    authenticatedWs = new WebSocket(otpUrl);
    authenticatedWs.onopen = function () {
      accountBadge.textContent = accountType === 'demo' ? 'Demo' : 'Real';
      accountBadge.className = 'account-badge ' + (accountType === 'demo' ? 'demo' : 'real');
      const initialBalance = sessionStorage.getItem('deriv_balance');
      if (initialBalance) updateBalanceDisplay(Number(initialBalance));
      authenticatedWs.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      authenticatedWs.send(JSON.stringify({ portfolio: 1 }));
      authenticatedWs.send(JSON.stringify({ ticks: selectedSymbol, subscribe: 1 }));
      requestProposal();
    };
    authenticatedWs.onmessage = handleWsMessage;
    authenticatedWs.onerror = function () { console.error('Trading WebSocket error'); };
  }

  function logout() {
    if (authenticatedWs) authenticatedWs.close();
    sessionStorage.removeItem('deriv_token');
    sessionStorage.removeItem('deriv_otp_url');
    sessionStorage.removeItem('deriv_account_id');
    sessionStorage.removeItem('deriv_account_type');
    sessionStorage.removeItem('deriv_balance');
    window.location.href = '/login';
  }

  function switchSymbol(newSymbol) {
    selectedSymbol = newSymbol;
    chartSymbolLabel.textContent = SYMBOL_NAMES[newSymbol] || newSymbol;
    if (authenticatedWs && authenticatedWs.readyState === WebSocket.OPEN) {
      authenticatedWs.send(JSON.stringify({ forget_all: 'ticks' }));
      chartData = [];
      if (chartSeries) chartSeries.setData([]);
      authenticatedWs.send(JSON.stringify({ ticks: newSymbol, subscribe: 1 }));
      requestProposal();
    }
  }

  document.querySelectorAll('.contract-type-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.contract-type-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedContractType = btn.dataset.type;
      requestProposal();
    });
  });

  document.querySelectorAll('.duration-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.duration-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedDuration = Number(btn.dataset.dur);
      requestProposal();
    });
  });

  document.getElementById('stake-minus').addEventListener('click', function () {
    stakeInput.value = Math.max(0.35, Number(stakeInput.value) - 0.5).toFixed(2);
    stakeAmount = Number(stakeInput.value);
    requestProposal();
  });
  document.getElementById('stake-plus').addEventListener('click', function () {
    stakeInput.value = (Number(stakeInput.value) + 0.5).toFixed(2);
    stakeAmount = Number(stakeInput.value);
    requestProposal();
  });
  stakeInput.addEventListener('change', function () {
    stakeAmount = Math.max(0.35, Number(stakeInput.value) || 1);
    stakeInput.value = stakeAmount.toFixed(2);
    requestProposal();
  });

  riseBtn.addEventListener('click', function () {
    selectedContractType = 'CALL';
    buyContract();
  });
  fallBtn.addEventListener('click', function () {
    selectedContractType = 'PUT';
    buyContract();
  });

  marketSelect.addEventListener('change', function () { switchSymbol(marketSelect.value); });

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('modal-close').addEventListener('click', function () { modal.classList.remove('show'); });

  initChart();
  connectTrading();
})();
