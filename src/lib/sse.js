export class SseHub {
  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
    this.clients = new Set();
    this.timer = null;
  }

  add(res, producer) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    const client = { res, producer };
    this.clients.add(client);
    this.start();
    res.on('close', () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stop();
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    for (const client of this.clients) {
      try {
        const payload = await client.producer();
        client.res.write(`event: metrics\n`);
        client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        client.res.write(`event: error\n`);
        client.res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
    }
  }
}
