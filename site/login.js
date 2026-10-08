(function () {
  const tokenInput = document.getElementById('token-input');
  const connectBtn = document.getElementById('connect-btn');
  const statusMsg = document.getElementById('status-msg');
  const accountSection = document.getElementById('account-section');
  const accountList = document.getElementById('account-list');

  let validatedToken = null;
  let accounts = [];

  function showStatus(message, type) {
    statusMsg.textContent = message;
    statusMsg.className = 'status-msg show ' + type;
  }

  function hideStatus() {
    statusMsg.className = 'status-msg';
    statusMsg.textContent = '';
  }

  function setLoading(loading) {
    connectBtn.disabled = loading;
    connectBtn.innerHTML = loading
      ? '<span class="spinner"></span> Connecting'
      : 'Connect';
  }

  async function handleConnect() {
    hideStatus();
    accountSection.classList.remove('show');
    accountList.innerHTML = '';

    const token = tokenInput.value.trim();
    if (!token) {
      showStatus('Please enter your API token.', 'error');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();

      if (!res.ok) {
        showStatus(data.error?.message || data.error || 'Invalid token or connection failed.', 'error');
        setLoading(false);
        return;
      }

      const accountList = data.data || data.accounts || data;
      const list = Array.isArray(accountList) ? accountList : (accountList.accounts || []);
      if (!list.length) {
        showStatus('No trading accounts found for this token.', 'error');
        setLoading(false);
        return;
      }

      validatedToken = token;
      accounts = list;
      showAccounts(list);
      showStatus('Token validated. Choose an account to continue.', 'success');
    } catch (err) {
      showStatus('Could not reach the server. Please try again.', 'error');
    }
    setLoading(false);
  }

  function showAccounts(list) {
    accountList.innerHTML = '';
    for (const acct of list) {
      const item = document.createElement('div');
      item.className = 'account-item';
      const isDemo = acct.account_type === 'demo' || acct.is_virtual === 1;
      item.innerHTML =
        '<div class="account-info">'
        + '<span class="account-id">' + (acct.loginid || acct.account_id || 'Account') + '</span>'
        + '<span class="account-type ' + (isDemo ? 'demo' : 'real') + '">' + (isDemo ? 'Demo' : 'Real') + '</span>'
        + '</div>'
        + '<span class="account-balance">' + (acct.currency ? acct.currency + ' ' : '') + (acct.balance !== undefined ? Number(acct.balance).toFixed(2) : '—') + '</span>';
      item.addEventListener('click', function () { selectAccount(acct); });
      accountList.appendChild(item);
    }
    accountSection.classList.add('show');
  }

  async function selectAccount(account) {
    const accountId = account.loginid || account.account_id;
    showStatus('Connecting to ' + accountId + '...', 'info');

    try {
      const res = await fetch('/api/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: validatedToken, accountId }),
      });
      const data = await res.json();

      if (!res.ok) {
        showStatus(data.error?.message || data.error || 'Failed to get authenticated session.', 'error');
        return;
      }

      const otpUrl = data.data?.url || data.url;
      if (!otpUrl) {
        showStatus('No authenticated WebSocket URL returned.', 'error');
        return;
      }

      sessionStorage.setItem('deriv_token', validatedToken);
      sessionStorage.setItem('deriv_account_id', accountId);
      sessionStorage.setItem('deriv_account_type', account.account_type === 'demo' || account.is_virtual === 1 ? 'demo' : 'real');
      sessionStorage.setItem('deriv_otp_url', otpUrl);
      sessionStorage.setItem('deriv_balance', account.balance !== undefined ? String(account.balance) : '0');

      showStatus('Connected! Redirecting to trade page...', 'success');
      setTimeout(function () { window.location.href = '/trade'; }, 800);
    } catch (err) {
      showStatus('Could not establish an authenticated session.', 'error');
    }
  }

  connectBtn.addEventListener('click', handleConnect);
  tokenInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleConnect();
  });
})();
