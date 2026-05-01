const pill = document.querySelector('#health-pill');
const facts = document.querySelector('#facts');

function fact(label, value) {
  const item = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value == null ? 'n/a' : String(value);
  item.append(dt, dd);
  return item;
}

async function load() {
  try {
    const [health, config] = await Promise.all([
      fetch('/api/health').then((res) => res.json()),
      fetch('/api/config').then((res) => res.json())
    ]);

    pill.textContent = health.ok ? 'Online' : 'Degraded';
    pill.className = `status-pill ${health.ok ? 'ok' : 'error'}`;
    facts.replaceChildren(
      fact('Version', health.version),
      fact('Phase', health.phase),
      fact('Uptime', `${health.uptimeSeconds}s`),
      fact('Host', `${config.host}:${config.port}`),
      fact('Data Dir', config.dataDir),
      fact('Theme', config.theme)
    );
  } catch (err) {
    pill.textContent = 'Error';
    pill.className = 'status-pill error';
    facts.replaceChildren(fact('Error', err.message));
  }
}

load();
