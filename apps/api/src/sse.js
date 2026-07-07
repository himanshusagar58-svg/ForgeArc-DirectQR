const clientsByRestaurant = new Map();

function write(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function openRestaurantEventStream(req, res) {
  const restaurantId = req.user.restaurant_id;
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  write(res, 'connected', { restaurantId, time: new Date().toISOString() });

  const clients = clientsByRestaurant.get(restaurantId) || new Set();
  clients.add(res);
  clientsByRestaurant.set(restaurantId, clients);
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) clientsByRestaurant.delete(restaurantId);
  });
}

export function publishRestaurantEvent(restaurantId, event, payload = {}) {
  const clients = clientsByRestaurant.get(restaurantId);
  if (!clients?.size) return;
  for (const res of clients) {
    try {
      write(res, event, payload);
    } catch {
      clients.delete(res);
    }
  }
  if (!clients.size) clientsByRestaurant.delete(restaurantId);
}
