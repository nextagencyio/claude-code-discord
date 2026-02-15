// Claude Code Bridge - Chrome Extension Popup

const $ = (id) => document.getElementById(id);

let currentPort = 9222;

function showToast(text, duration = 1500) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

async function checkCDP(port) {
  try {
    const resp = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function listTabs(port) {
  try {
    const resp = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return [];
    const tabs = await resp.json();
    return tabs.filter(t => t.type === 'page');
  } catch {
    return [];
  }
}

function renderTabs(tabs) {
  const container = $('tabList');
  $('tabsTitle').textContent = `Tabs (${tabs.length})`;

  if (tabs.length === 0) {
    container.innerHTML = '<div class="tab-item"><span class="tab-title" style="color:#888;">No open tabs</span></div>';
    return;
  }

  container.innerHTML = tabs.slice(0, 20).map(tab => {
    const title = (tab.title || 'Untitled').substring(0, 50);
    const url = (tab.url || '').substring(0, 60);
    return `<div class="tab-item">
      <span class="tab-title">${escapeHtml(title)}</span>
      <span class="tab-url">${escapeHtml(url)}</span>
    </div>`;
  }).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function init() {
  // Read saved port preference
  const stored = await chrome.storage?.local?.get('cdpPort').catch(() => null);
  if (stored?.cdpPort) {
    currentPort = stored.cdpPort;
    $('portInput').value = currentPort;
  }

  const info = await checkCDP(currentPort);

  $('loading').style.display = 'none';
  $('app').style.display = 'block';

  if (info) {
    // Connected
    $('statusDot').classList.add('connected');
    $('statusText').textContent = 'CDP Connected';
    $('connectedView').style.display = 'block';
    $('disconnectedView').style.display = 'none';

    $('browserName').textContent = info.Browser || 'Unknown';
    $('portValue').textContent = String(currentPort);
    $('protocolValue').textContent = info['Protocol-Version'] || '-';

    const tabs = await listTabs(currentPort);
    renderTabs(tabs);
  } else {
    // Disconnected
    $('statusDot').classList.add('disconnected');
    $('statusText').textContent = 'Not Connected';
    $('connectedView').style.display = 'none';
    $('disconnectedView').style.display = 'block';
  }
}

// Copy /browser connect command
$('copyCmd')?.addEventListener('click', () => {
  const cmd = currentPort === 9222
    ? '/browser connect'
    : `/browser connect port:${currentPort}`;
  navigator.clipboard.writeText(cmd);
  showToast('Copied!');
});

// Refresh button
$('refresh')?.addEventListener('click', () => {
  $('app').style.display = 'none';
  $('loading').style.display = 'block';
  $('statusDot').classList.remove('connected', 'disconnected');
  init();
});

// Retry with different port
$('retryBtn')?.addEventListener('click', () => {
  const port = parseInt($('portInput').value, 10);
  if (port >= 1024 && port <= 65535) {
    currentPort = port;
    chrome.storage?.local?.set({ cdpPort: port }).catch(() => {});
    $('app').style.display = 'none';
    $('loading').style.display = 'block';
    $('statusDot').classList.remove('connected', 'disconnected');
    init();
  }
});

// Copy launch command
$('copyLaunch')?.addEventListener('click', () => {
  const port = $('portInput').value || '9222';
  const isLinux = navigator.userAgent.includes('Linux');
  const cmd = isLinux
    ? `google-chrome --remote-debugging-port=${port}`
    : `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`;
  navigator.clipboard.writeText(cmd);
  showToast('Copied!');
});

// Enter key on port input triggers retry
$('portInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('retryBtn').click();
});

init();
