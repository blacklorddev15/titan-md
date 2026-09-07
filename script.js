const form = document.getElementById('pairingForm');
const phoneInput = document.getElementById('phone');
const pairButton = document.getElementById('pairButton');
const pairStatus = document.getElementById('pairStatus');
const codeDisplay = document.getElementById('codeDisplay');
const pairingCode = document.getElementById('pairingCode');
const copyCode = document.getElementById('copyCode');
const botStatus = document.getElementById('botStatus');
const botUptime = document.getElementById('botUptime');
const activeSessions = document.getElementById('activeSessions');
const statusLed = document.getElementById('statusLed');
const headerStatus = document.getElementById('headerStatus');

function setMessage(message, state = '') {
  pairStatus.textContent = message;
  pairStatus.className = `inline-status ${state}`.trim();
}

function formatUptime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}D ${hours}H ${minutes}M`;
  if (hours) return `${hours}H ${minutes}M`;
  return `${minutes}M`;
}

function renderStatus(payload) {
  const online = payload?.status === 'online';
  botStatus.textContent = online ? 'ONLINE' : 'OFFLINE';
  botStatus.style.color = online ? '#58ef95' : '#ff6973';
  statusLed.classList.toggle('offline', !online);
  botUptime.textContent = online ? formatUptime(payload.uptime) : '—';
  activeSessions.textContent = online ? String(payload.activeSessions ?? payload.pairedCount ?? 0) : '—';
  headerStatus.textContent = online ? 'BRIDGE ONLINE' : 'BRIDGE OFFLINE';
  document.querySelector('.pulse-dot').style.background = online ? '#22e06f' : '#ff4d5a';
}

async function loadStatus() {
  try {
    const response = await fetch('/api/pairing?stats=1', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const payload = await response.json();
    renderStatus(payload);
  } catch {
    renderStatus({ status: 'offline' });
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const phone = phoneInput.value.replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(phone)) {
    setMessage('Enter a valid international WhatsApp number.', 'error');
    phoneInput.focus();
    return;
  }

  pairButton.disabled = true;
  pairButton.querySelector('span').textContent = 'Generating…';
  codeDisplay.hidden = true;
  setMessage('Contacting the Titan MD bridge…');

  try {
    const response = await fetch('/api/pairing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const payload = await response.json();
    const code = payload?.pairing?.pairing_code || payload?.pairing?.pairingCode || payload?.pairing?.code || payload?.code;
    if (!response.ok || !code) throw new Error(payload.error || 'Pairing code generation failed.');
    pairingCode.textContent = code;
    codeDisplay.hidden = false;
    codeDisplay.classList.remove('hidden');
    setMessage('Pairing code generated. Enter it in WhatsApp Linked devices.', 'success');
    loadStatus();
  } catch (error) {
    setMessage(error.message || 'Titan MD is currently unavailable.', 'error');
  } finally {
    pairButton.disabled = false;
    pairButton.querySelector('span').textContent = 'Generate code';
  }
});

copyCode.addEventListener('click', async () => {
  const code = pairingCode.textContent.trim();
  if (!code || code === '—') return;
  try {
    await navigator.clipboard.writeText(code);
    copyCode.textContent = 'Copied';
    setTimeout(() => { copyCode.textContent = 'Copy code'; }, 1600);
  } catch {
    setMessage('Select the code manually to copy it.', 'error');
  }
});

phoneInput.addEventListener('input', () => {
  phoneInput.value = phoneInput.value.replace(/[^\d ]/g, '');
});

loadStatus();
setInterval(loadStatus, 30000);

