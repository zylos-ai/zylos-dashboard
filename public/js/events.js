export function connectEvents(onSummary, fallbackRefresh) {
  if (!window.EventSource) {
    setInterval(fallbackRefresh, 5000);
    return;
  }

  const source = new EventSource('/api/events');
  let fallbackTimer = null;

  source.addEventListener('metrics', (event) => {
    try {
      onSummary(JSON.parse(event.data));
    } catch {
      fallbackRefresh();
    }
  });

  source.addEventListener('error', () => {
    if (!fallbackTimer) {
      fallbackTimer = setInterval(fallbackRefresh, 5000);
    }
  });
}
