const express = require('express');
const path = require('path');
const db = require('./server/db');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Canonical pickup origin used for simulations and directions
const SHOEPAO_ORIGIN = 'Blk 15 Lot 25 Phase 2 MV Villar Avenue Camella Springville Central Molino 3 , Bacoor, Philippines, 4102';
// keep raw body for webhook signature verification when needed
app.use(express.json({ limit: '1mb', verify: function(req, res, buf){ try{ req.rawBody = buf; }catch(e){} } }));
// Dev-friendly CORS middleware: allow requests from Apache/other origins during local development.
// NOTE: This is intentionally permissive for dev only. Remove or restrict in production.
app.use(function(req, res, next){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Aftership-Signature');
  // quick response to preflight
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname)));

// Load AfterShip API key from trackingapi_key.json if present
let AFTERSHIP_KEY = null;
let AFTERSHIP_SECRET = null;
try{
  const keyPath = path.join(__dirname, 'trackingapi_key.json');
  if (fs.existsSync(keyPath)){
    const raw = fs.readFileSync(keyPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    AFTERSHIP_KEY = (parsed.api_key || parsed.key || parsed.token || null);
    AFTERSHIP_SECRET = (parsed.api_secret || parsed.secret || null);
    console.log('AfterShip API key loaded:', AFTERSHIP_KEY ? 'yes' : 'no', ' secret:', AFTERSHIP_SECRET ? 'yes' : 'no');
  }
}catch(e){ console.warn('Failed to read trackingapi_key.json', e); }


// Helper to call AfterShip API (simple wrapper using native https)
function aftershipRequest(method, pathUrl, body) {
  return new Promise((resolve, reject) => {
    if (!AFTERSHIP_KEY) return reject(new Error('AfterShip API key not configured'));
    const opts = {
      hostname: 'api.aftership.com',
      port: 443,
      path: pathUrl,
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'aftership-api-key': AFTERSHIP_KEY,
        'Accept': 'application/json'
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try{
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const err = new Error('AfterShip API error: ' + (json.message || res.statusCode));
          err.code = res.statusCode; err.body = json; return reject(err);
        }catch(e){ return reject(e); }
      });
    });
    req.on('error', (err) => reject(err));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Create a tracker
async function aftershipCreateTracker(slug, trackingNumber, title){
  const payload = { tracking: { tracking_number: String(trackingNumber || ''), slug: String(slug || '').toLowerCase(), title: title || '' } };
  return aftershipRequest('POST', '/v4/trackings', payload).then(r => r).catch(err => { throw err; });
}

// Get tracker details
async function aftershipGetTracker(slug, trackingNumber){
  const p = '/v4/trackings/' + encodeURIComponent(slug || '') + '/' + encodeURIComponent(trackingNumber || '');
  return aftershipRequest('GET', p).then(r => r).catch(err => { throw err; });
}

function mapAftershipTagToOrderStatus(tag){
  if(!tag) return null;
  var t = String(tag||'').toLowerCase();
  if(t.indexOf('delivered') !== -1) return 'delivered';
  if(t.indexOf('out_for_delivery') !== -1 || t.indexOf('out for delivery') !== -1) return 'out for delivery';
  if(t.indexOf('in_transit') !== -1 || t.indexOf('in transit') !== -1) return 'in transit';
  if(t.indexOf('picked_up') !== -1 || t.indexOf('picked up') !== -1) return 'picked up';
  if(t.indexOf('exception') !== -1 || t.indexOf('failed') !== -1) return 'exception';
  if(t.indexOf('pending') !== -1 || t.indexOf('info_received') !== -1) return 'processing';
  return null;
}

// Server-side canonicalization and transition guard
function canonicalizeStatus(s){
  if(!s) return '';
  const k = String(s).toLowerCase().trim();
  if(k.indexOf('delivered') !== -1) return 'delivered';
  if(k.indexOf('out for delivery') !== -1 || k.indexOf('out_for_delivery') !== -1) return 'out for delivery';
  if(k.indexOf('in transit') !== -1 || k.indexOf('in_transit') !== -1) return 'in transit';
  if(k.indexOf('picked') !== -1 || k === 'picked_up') return 'picked up';
  if(k === 'shipped') return 'shipped';
  if(k === 'processing' || k === 'confirmed' || k === 'preparing' || k.indexOf('prepare') !== -1) return 'processing';
  if(k === 'pending' || k.indexOf('pending') !== -1) return 'pending payment';
  if(k === 'cancelled' || k === 'canceled') return 'cancelled';
  if(k === 'refunded') return 'refunded';
  if(k === 'archived') return 'archived';
  return s;
}

function serverCanTransition(current, next){
  // very conservative transition map to avoid jumping straight to delivered
  const allowed = {
    'pending payment': ['confirmed','cancelled'],
    'confirmed': ['processing','cancelled'],
    'processing': ['shipped','cancelled','refunded'],
    'shipped': ['out for delivery','picked up','delivered','in transit'],
    'picked up': ['in transit','out for delivery','delivered'],
    'in transit': ['out for delivery','delivered'],
    'out for delivery': ['delivered'],
    'delivered': ['archived'],
    'refund requested': ['refunded'],
    'refunded': ['archived'],
    'cancelled': ['archived'],
    'archived': []
  };
  const cur = String(current || '').toLowerCase();
  const nxt = String(next || '').toLowerCase();
  if(!cur) return true; // unknown current -> allow
  if(cur === nxt) return true;
  const allowedTo = allowed[cur] || [];
  if(allowedTo.indexOf(nxt) !== -1) return true;
  // allow promotion to intermediate states like 'picked up' from 'shipped'
  return false;
}

// Best-effort: sync order status to Firestore using firebase-admin if available and configured
async function syncOrderStatusToFirestore(orderId, status){
  try{
    const admin = require('firebase-admin');
    if(!admin) return;
    if(!admin.apps || !admin.apps.length){
      try{ admin.initializeApp(); }catch(e){ console.warn('firebase-admin init failed', e); return; }
    }
    const fdb = admin.firestore();
    try{
      await fdb.collection('orders').doc(String(orderId)).set({ status: status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }catch(e){
      // fallback: try to find doc where field id == orderId
      try{
        const q = await fdb.collection('orders').where('id','==',String(orderId)).limit(1).get();
        if(!q.empty){ await q.docs[0].ref.set({ status: status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
      }catch(err){ console.warn('failed to sync order status via fallback', err); }
    }
  }catch(e){ /* silent */ }
}

function nowIso(){
  return new Date().toISOString();
}

function maybeParseJson(s){
  try{
    if (typeof s === 'string'){
      const t = s.trim();
      if ((t.startsWith('{') || t.startsWith('['))) return JSON.parse(s);
    }
  }catch(e){}
  return s;
}

// OpenRouteService routing removed: routing helper functions were removed per user request.
// If routing is re-introduced later, add server-side helpers here and ensure the API key
// is only read from environment or secure config.

function ensureSqlSafeString(v){
  // If a structured object/array was passed for a textual field (e.g. delivery address),
  // store it as a JSON string so sqlite bindings receive a string.
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try{ return JSON.stringify(v); }catch(e){ return String(v); }
}

function normalizeStatus(s){
  return String(s || '').trim();
}

function generateOrderId(){
  const rand = Math.floor(Math.random() * 900000 + 100000);
  const year = new Date().getFullYear().toString().slice(-2);
  return `ORD${year}${rand}`;
}

function generateTrackingNumber(orderId){
  // Simple readable tracking id for dev: TRK + base36 timestamp + random
  try{
    return 'TRK' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*90000+10000).toString(36).toUpperCase();
  }catch(e){
    return 'TRK' + Math.floor(Math.random()*900000000 + 100000000);
  }
}

// Generate a random human-readable location for simulation/tracking events
function getRandomLocation(order){
  const samples = [
    'Quezon City, NCR', 'Makati, NCR', 'Pasig, NCR', 'Taguig, NCR', 'Manila, NCR',
    'Caloocan, NCR', 'Quezon Province', 'Laguna Province', 'Rizal Province',
    'Cebu City, Cebu', 'Lapu-Lapu, Cebu', 'Iloilo City, Iloilo', 'Davao City, Davao'
  ];
  try{
    // Prefer to pick near delivery city if available
    if(order && (order.city || (order.deliveryAddress && order.deliveryAddress.city))){
      const city = (order.city || (order.deliveryAddress && order.deliveryAddress.city) || '').toString().toLowerCase();
      for(const s of samples){ if(s.toLowerCase().indexOf(city) !== -1) return s; }
    }
  }catch(e){}
  return samples[Math.floor(Math.random() * samples.length)];
}

// Generate a simple route (array of location strings) from a fixed pickup origin to the
// order's delivery address. This is a heuristic generator for dev simulation only.
function generateRouteForOrder(order, steps){
  // default pickup origin (can be customized)
  // Use ShoePao pickup origin as the canonical starting location for "Picked up" events
  const ORIGIN = 'Blk 15 Lot 25 Phase 2 MV Villar Avenue Camella Springville Central Molino 3 , Bacoor, Philippines, 4102';
  steps = Number(steps) || 5;
  try{
    // Attempt to parse structured delivery address if stored as JSON string
    let destObj = null;
    if(order){
      if(order.delivery_address && typeof order.delivery_address === 'string'){
        try{ destObj = JSON.parse(order.delivery_address); }catch(e){ destObj = null; }
      }
      if(!destObj && order.deliveryAddress) destObj = order.deliveryAddress;
      // If still a string, attempt to split into parts
      if(!destObj && order.delivery_address && typeof order.delivery_address === 'string'){
        const parts = order.delivery_address.split(',').map(p=>p.trim()).filter(Boolean);
        destObj = { raw: order.delivery_address, parts };
      }
    }

    // Extract city/province/street tokens when available
    const destCity = (destObj && (destObj.city || (destObj.parts && destObj.parts.slice(-2,-1)[0]) || destObj.parts && destObj.parts.slice(-3,-2)[0])) || '';
    const destProvince = (destObj && (destObj.province || destObj.region || (destObj.parts && destObj.parts.slice(-2)[0]))) || '';
    const destStreet = (destObj && (destObj.street || destObj.line1 || (destObj.parts && destObj.parts[0]))) || (destObj && destObj.raw) || '';

    // Build route waypoints (tuned to match 5 simulation steps by default)
    const route = [];
    // Step 1: Pickup
    route.push(ORIGIN);
    // Step 2: Pickup hub / loaded
    route.push('Caloocan Local Hub - Loaded Truck');
    // Step 3: Regional sorting center (prefer province if present)
    if(destProvince) route.push((String(destProvince).toUpperCase() + ' Sorting Center').replace(/\s+/g,' '));
    else route.push('Metro Manila Sorting Center');
    // Step 4: Arrival at destination city or out for delivery
    if(destCity) route.push('Arrived at ' + String(destCity).toUpperCase());
    else route.push('Arrived at Destination City');
    // Step 5: Final delivery point (street/barangay if available)
    if(destStreet) route.push(String(destStreet));
    else route.push('Recipient Address');

    // If requested steps differ, interpolate / trim accordingly
    if(route.length === steps) return route;
    if(route.length > steps) return route.slice(0, steps);
    // route shorter than steps: pad by duplicating last element or using random nearby
    while(route.length < steps){
      route.splice(route.length-1, 0, route[route.length-1] + ' - In transit');
    }
    return route;
  }catch(e){
    // fallback to repeated random locations
    const out = [];
    for(let i=0;i<steps;i++) out.push(getRandomLocation(order||{}));
    return out;
  }
}

// Serve order details page for /orders/:orderId
app.get('/orders/:orderId', (req, res) => {
  res.sendFile(path.join(__dirname, 'order-detail.html'));
});

// Shop route
app.get('/shop', (req, res) => {
  res.sendFile(path.join(__dirname, 'product-list.html'));
});

// List orders (optional): /api/orders?userId=... (admin can omit to get all)
app.get('/api/orders', (req, res) => {
  const userId = req.query.userId || '';
  const sql = userId
    ? 'SELECT * FROM Orders WHERE user_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM Orders ORDER BY created_at DESC';
  const rows = userId ? db.prepare(sql).all(userId) : db.prepare(sql).all();
  // attempt to parse stored JSON address fields so clients receive structured objects when appropriate
  const fixed = rows.map(r => ({ ...r, delivery_address: maybeParseJson(r.delivery_address) }));
  res.json({ orders: fixed });
});

// Lightweight health check used by the PHP proxy and client-side pings to ensure the
// Node server is up. Returns 200 with a small JSON payload.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, now: new Date().toISOString(), env: process.env.NODE_ENV || 'development' });
});

// Existence check (returns 200 with { exists: true/false }) to avoid 404 noise from clients
app.get('/api/orders/:orderId/exists', (req, res) => {
  const id = req.params.orderId;
  try{
    const order = db.prepare('SELECT 1 as found FROM Orders WHERE id = ?').get(id);
    return res.json({ exists: !!order });
  }catch(e){ return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// Get order by id
app.get('/api/orders/:orderId', (req, res) => {
  const id = req.params.orderId;
  const order = db.prepare('SELECT * FROM Orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // parse delivery address JSON if present
  order.delivery_address = maybeParseJson(order.delivery_address);
  const items = db.prepare('SELECT product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(id);
  res.json({ order, items });
});

// Get tracking events
app.get('/api/orders/:orderId/tracking', (req, res) => {
  const id = req.params.orderId;
  const tracking = db.prepare('SELECT status, message, timestamp, location FROM OrderTracking WHERE order_id = ? ORDER BY timestamp ASC').all(id);
  // If an external tracking number exists for this order, try to fetch latest AfterShip data too
  try{
    const order = db.prepare('SELECT tracking_number, courier_name FROM Orders WHERE id = ?').get(id);
    if (order && order.tracking_number && AFTERSHIP_KEY) {
      // attempt to find slug from courier_name or use 'unknown'
      const slug = (order.courier_name || '').toLowerCase().replace(/\s+/g,'-') || '';
      aftershipGetTracker(slug || '','' + order.tracking_number).then(apiResp => {
        // AfterShip returns tracking object under data.tracking or tracking
        const t = apiResp && (apiResp.data && apiResp.data.tracking) ? apiResp.data.tracking : apiResp.tracking || null;
        const checkpoints = (t && Array.isArray(t.checkpoints)) ? t.checkpoints.map(cp => ({ status: cp.tag || cp.message || '', message: cp.message || '', timestamp: cp.checkpoint_time || cp.time || cp.created_at || '' })) : [];
        return res.json({ tracking, external: { tracking_number: order.tracking_number, courier: order.courier_name, checkpoints } });
      }).catch(err => {
        // on error, return DB-only
        return res.json({ tracking, error: String(err && err.message ? err.message : err) });
      });
      return;
    }
  }catch(e){ /* ignore */ }
  res.json({ tracking });
});

// OpenRouteService directions endpoint removed per user request.
// Routing and directions are disabled in this server build.

// Create an AfterShip tracker for an order (admin action)
app.post('/api/orders/:orderId/aftership/create', async (req, res) => {
  const id = req.params.orderId;
  const body = req.body || {};
  const slug = (body.courier_slug || body.courier || body.slug || '').toLowerCase();
  const trackingNumber = body.tracking_number || body.trackingNumber || body.tracking || '';
  if (!trackingNumber) return res.status(400).json({ error: 'tracking_number required' });
  if (!AFTERSHIP_KEY) return res.status(500).json({ error: 'AfterShip API key not configured' });
  try{
    const r = await aftershipCreateTracker(slug, trackingNumber, 'Order ' + id);
    // update order with courier and tracking
    db.prepare('UPDATE Orders SET courier_name = ?, tracking_number = ? WHERE id = ?').run(slug || '', trackingNumber, id);
    // insert initial tracking event
    const now = new Date().toISOString();
  db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)').run(id, 'Tracking created', 'Tracker created on AfterShip', now, getRandomLocation({}));
    return res.json({ ok: true, resp: r });
  }catch(e){ console.error('aftership create failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// Refresh AfterShip tracking for an order (force fetch)
app.post('/api/orders/:orderId/aftership/refresh', async (req, res) => {
  const id = req.params.orderId;
  const order = db.prepare('SELECT tracking_number, courier_name FROM Orders WHERE id = ?').get(id);
  if (!order || !order.tracking_number) return res.status(400).json({ error: 'Order has no tracking number' });
  if (!AFTERSHIP_KEY) return res.status(500).json({ error: 'AfterShip API key not configured' });
  const slug = (order.courier_name || '').toLowerCase().replace(/\s+/g,'-');
  try{
    const apiResp = await aftershipGetTracker(slug || '', order.tracking_number);
    const t = apiResp && (apiResp.data && apiResp.data.tracking) ? apiResp.data.tracking : apiResp.tracking || null;
    const checkpoints = (t && Array.isArray(t.checkpoints)) ? t.checkpoints : [];
    // Insert any new checkpoints into OrderTracking (avoid duplicates by timestamp+message)
    const existing = db.prepare('SELECT message, timestamp FROM OrderTracking WHERE order_id = ?').all(id).map(r => (r.message + '||' + r.timestamp));
  const insert = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
        checkpoints.forEach(cp => {
        const key = (cp.message || cp.tag || '') + '||' + (cp.checkpoint_time || cp.time || cp.created_at || '');
        if (!existing.includes(key)) {
          insert.run(id, (cp.tag || cp.message || ''), (cp.message || cp.tag || ''), (cp.checkpoint_time || cp.time || cp.created_at || new Date().toISOString()), (cp.location || cp.city || getRandomLocation({})));
        }
      });
    });
    tx();
    // Determine latest checkpoint and update order status if mappable (guarded)
    try{
      if (checkpoints && checkpoints.length){
        var last = checkpoints[checkpoints.length - 1];
        var tag = last.tag || last.status || last.tag || last.message || '';
        var mapped = mapAftershipTagToOrderStatus(tag);
        if(mapped){
          try{
            var curRow = db.prepare('SELECT status FROM Orders WHERE id = ?').get(id);
            var curStatus = curRow && curRow.status ? curRow.status : '';
            var mappedCanon = canonicalizeStatus(mapped) || mapped;
            if(serverCanTransition(curStatus, mappedCanon)){
              db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(mapped, id);
              try{ syncOrderStatusToFirestore(id, mapped).catch(()=>{}); }catch(e){}
            }
          }catch(e){ /* ignore transition check failure */ }
        }
      }
    }catch(e){ /* ignore */ }
    return res.json({ ok: true, checkpoints });
  }catch(e){ console.error('aftership refresh failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// AfterShip webhook receiver (configure this URL in AfterShip dashboard)
app.post('/api/aftership/webhook', (req, res) => {
  const body = req.body || {};
  try{
    // If a secret is configured, verify signature (support common header names)
    if (AFTERSHIP_SECRET) {
      try{
        const headerSig = (req.headers['aftership-signature'] || req.headers['x-aftership-signature'] || req.headers['signature'] || '').toString();
        if (!headerSig) {
          console.warn('Webhook received without signature header');
          return res.status(401).json({ error: 'missing signature' });
        }
        const raw = req.rawBody || Buffer.from(JSON.stringify(body) || '');
        const hmacHex = crypto.createHmac('sha256', String(AFTERSHIP_SECRET)).update(raw).digest('hex');
        const hmacBase64 = crypto.createHmac('sha256', String(AFTERSHIP_SECRET)).update(raw).digest('base64');
        if (headerSig !== hmacHex && headerSig !== hmacBase64) {
          console.warn('Webhook signature mismatch', headerSig, hmacHex, hmacBase64);
          return res.status(401).json({ error: 'invalid signature' });
        }
      }catch(e){ console.warn('Webhook signature verification failed', e); return res.status(401).json({ error: 'signature verification failed' }); }
    }

    // AfterShip sends data.tracking with checkpoints
    const tracking = body && (body.data && body.data.tracking) ? body.data.tracking : body.tracking || null;
    if (!tracking) {
      return res.status(200).json({ ok: true, note: 'no tracking payload' });
    }
    const tn = tracking.tracking_number || tracking.trackingNumber || tracking.tracking_number;
    if (!tn) return res.status(200).json({ ok: true, note: 'no tracking number' });
    // find order by tracking_number
    const order = db.prepare('SELECT id FROM Orders WHERE tracking_number = ?').get(tn);
    if (!order) return res.status(200).json({ ok: true, note: 'order not found for tracking' });
    const checkpoints = Array.isArray(tracking.checkpoints) ? tracking.checkpoints : [];
  const insert = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
    const existing = db.prepare('SELECT message, timestamp FROM OrderTracking WHERE order_id = ?').all(order.id).map(r => (r.message + '||' + r.timestamp));
    const tx = db.transaction(() => {
      checkpoints.forEach(cp => {
        const key = (cp.message || cp.tag || '') + '||' + (cp.checkpoint_time || cp.time || cp.created_at || '');
        if (!existing.includes(key)) {
          insert.run(order.id, (cp.tag || cp.message || ''), (cp.message || cp.tag || ''), (cp.checkpoint_time || cp.time || cp.created_at || new Date().toISOString()), (cp.location || cp.city || getRandomLocation({})));
        }
      });
    });
    try{ tx();
      // update order status from latest checkpoint if available
      if (checkpoints && checkpoints.length){
        var lastCp = checkpoints[checkpoints.length - 1];
        var tagCp = lastCp.tag || lastCp.status || lastCp.message || '';
        var mappedStatus = mapAftershipTagToOrderStatus(tagCp);
        if(mappedStatus){
          try{
            var curRow = db.prepare('SELECT status FROM Orders WHERE id = ?').get(order.id);
            var curStatus = curRow && curRow.status ? curRow.status : '';
            var mappedCanon = canonicalizeStatus(mappedStatus) || mappedStatus;
            if(serverCanTransition(curStatus, mappedCanon)){
              db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(mappedStatus, order.id);
              try{ syncOrderStatusToFirestore(order.id, mappedStatus).catch(()=>{}); }catch(e){}
            }
          }catch(e){ /* ignore */ }
        }
      }
    }catch(e){ console.warn('webhook tx failed', e); }
    return res.status(200).json({ ok: true });
  }catch(e){ console.error('webhook handler error', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// In-memory simulation timers for dev/testing: advance order through phases every N seconds
const simulateTimers = new Map();
const SIMULATION_STEPS = ['Preparing','Picked up','In transit','Out for delivery','Delivered'];

// Start simulation for an order (dev/testing)
app.post('/api/orders/:orderId/simulate/start', (req, res) => {
  const id = req.params.orderId;
  if (simulateTimers.has(id)) return res.json({ ok: false, message: 'Simulation already running' });
  // Determine start step based on current order status so simulation begins at the
  // correct phase (e.g. start at 'Picked up' when admin marks an order 'shipped').
  let stepIndex = 0;
  const intervalMs = 1000 * 10; // 10 seconds per step
  // Prepare a route for this order (picked up outside interval so it's stable across ticks)
  const orderRow = db.prepare('SELECT id, tracking_number, delivery_address, recipient_name, status FROM Orders WHERE id = ?').get(id);
  const routeForOrder = generateRouteForOrder(orderRow || {}, SIMULATION_STEPS.length);

  // Map certain order.status values to simulation step indices
  function mapStatusToSimIndex(s){
    if(!s) return 0;
    const k = String(s).toLowerCase();
    if(k.indexOf('deliver') !== -1 || k === 'delivered') return SIMULATION_STEPS.indexOf('Delivered');
    if(k.indexOf('out for delivery') !== -1 || k.indexOf('out_for_delivery') !== -1) return SIMULATION_STEPS.indexOf('Out for delivery');
    if(k.indexOf('in transit') !== -1 || k.indexOf('in_transit') !== -1) return SIMULATION_STEPS.indexOf('In transit');
    if(k.indexOf('picked') !== -1 || k === 'picked_up') return SIMULATION_STEPS.indexOf('Picked up');
    if(k === 'shipped') return SIMULATION_STEPS.indexOf('Picked up');
    if(k === 'processing' || k === 'confirmed' || k === 'preparing') return SIMULATION_STEPS.indexOf('Preparing');
    return 0;
  }

  if(orderRow && orderRow.status){
    const idx = mapStatusToSimIndex(orderRow.status);
    if(typeof idx === 'number' && idx >= 0 && idx < SIMULATION_STEPS.length) {
      // Start simulation at the mapped index (so first inserted step matches admin status progression)
      stepIndex = idx;
    }
  }

  // Also consider existing tracking events so we continue the simulation from the
  // last recorded checkpoint instead of restarting earlier steps. This prevents
  // the UI from jumping back to 'Order placed' when admin starts simulation
  // after some steps already exist.
  try{
    const lastEv = db.prepare('SELECT status FROM OrderTracking WHERE order_id = ? ORDER BY timestamp DESC LIMIT 1').get(id);
    if(lastEv && lastEv.status){
      const s = String(lastEv.status || '').trim();
      // normalize common messages like 'Tracking assigned' out of consideration
      if(s.toLowerCase().indexOf('tracking assigned') === -1){
        // find index of this status within simulation steps
        const evIndex = SIMULATION_STEPS.findIndex(step => step.toLowerCase() === s.toLowerCase());
        if(evIndex !== -1){
          // continue from next step after the latest checkpoint
          stepIndex = Math.max(stepIndex, evIndex + 1);
        }
      }
    }
  }catch(e){ /* ignore DB read issues and fall back to status mapping */ }

  console.log('Starting simulation for order', id, 'route:', routeForOrder, 'starting at step index', stepIndex);
  // If we've already completed all simulation steps, nothing to do.
  if (stepIndex >= SIMULATION_STEPS.length) return res.json({ ok: false, message: 'No simulation steps remain' });

  const t = setInterval(() => {
    try{
      const order = db.prepare('SELECT id, tracking_number FROM Orders WHERE id = ?').get(id);
      if (!order) { clearInterval(t); simulateTimers.delete(id); return; }
      if (stepIndex >= SIMULATION_STEPS.length) { clearInterval(t); simulateTimers.delete(id); return; }
      const step = SIMULATION_STEPS[stepIndex++];
      const now = new Date().toISOString();
      // insert tracking checkpoint (with generated location)
      try{
        // choose location from the precomputed route (match step index)
        // Do not include a location for the early online steps 'Order placed' and 'Preparing'.
        let location = '';
        if (step !== 'Order placed' && step !== 'Preparing'){
          location = (routeForOrder && routeForOrder.length > 0) ? (routeForOrder[Math.max(0, Math.min(routeForOrder.length - 1, stepIndex - 1))]) : getRandomLocation({});
          // Ensure 'Picked up' uses the canonical origin when available
          if(step === 'Picked up') location = SHOEPAO_ORIGIN;
        }
        db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)').run(id, step, step, now, location);
      }catch(e){ }
      // update order status
      try{ db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(step, id); }catch(e){}
      // attempt Firestore sync (best-effort)
      try{ syncOrderStatusToFirestore(id, step).catch(()=>{}); }catch(e){}
      // stop after final step
      if (step === 'Delivered') { clearInterval(t); simulateTimers.delete(id); }
    }catch(e){ console.warn('simulate tick failed', e); }
  }, intervalMs);
  simulateTimers.set(id, t);
  return res.json({ ok: true, message: 'Simulation started' });
});

// Stop simulation for an order
app.post('/api/orders/:orderId/simulate/stop', (req, res) => {
  const id = req.params.orderId;
  const t = simulateTimers.get(id);
  if (t) { clearInterval(t); simulateTimers.delete(id); return res.json({ ok: true, message: 'Simulation stopped' }); }
  return res.json({ ok: false, message: 'No simulation running' });
});

// Update an order (admin convenience) - accepts partial fields and returns updated order
app.put('/api/orders/:orderId', (req, res) => {
  try{
    const id = req.params.orderId;
    const body = req.body || {};
    const allowed = ['status','courier_name','tracking_number','recipient_name','recipient_phone','delivery_address'];
    const setParts = [];
    const params = [];
    allowed.forEach(k => {
      if(Object.prototype.hasOwnProperty.call(body, k)){
        setParts.push(k + ' = ?');
        params.push(body[k] === null || body[k] === undefined ? '' : String(body[k]));
      }
    });
    if(setParts.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
    params.push(id);
  const sql = 'UPDATE Orders SET ' + setParts.join(', ') + ' WHERE id = ?';
  // Ensure the prepared statement's run() is invoked with the statement as `this`.
  // Using apply(null, params) can break bindings inside the sqlite3 wrapper and
  // cause a runtime error (500). Bind correctly using the statement as the thisArg.
  const stmt = db.prepare(sql);
  stmt.run.apply(stmt, params);
    const saved = db.prepare('SELECT * FROM Orders WHERE id = ?').get(id);
    if(saved) saved.delivery_address = maybeParseJson(saved.delivery_address);
    return res.json({ ok: true, order: saved });
  }catch(e){ console.error('order update failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// Create order
app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const orderId = body.id || generateOrderId();
  const createdAt = body.created_at || nowIso();
  // derive tracking number (auto-generate if not supplied)
  let trackingNum = body.tracking_number || body.trackingNumber || body.tracking || '';
  if(!trackingNum){ trackingNum = generateTrackingNumber(orderId); }

  // derive courier name from provided fields or deliveryCode mapping
  let courierName = body.courier_name || body.courierName || body.courier || '';
  if(!courierName){
    const dc = String(body.deliveryCode || body.delivery_code || '').toLowerCase();
    if(dc === 'personal') courierName = 'Personal Delivery';
    else if(dc === 'lalamove') courierName = 'Lalamove';
    else if(dc === 'jnt') courierName = 'J&T Express';
    else if(dc === 'jrs') courierName = 'JRS';
  }

  // ensure user_id is a primitive or JSON string
  let userIdVal = body.user_id || body.userId || body.email || null;
  if (userIdVal !== null && (typeof userIdVal !== 'string' && typeof userIdVal !== 'number' && typeof userIdVal !== 'bigint')) {
    userIdVal = ensureSqlSafeString(userIdVal);
  }

  const order = {
    id: orderId,
    user_id: userIdVal,
    status: normalizeStatus(body.status || 'Order placed'),
    total: Number(body.total || 0),
    shipping_fee: Number(body.shipping_fee || body.shippingFee || 0),
    discount: Number(body.discount || 0),
    payment_method: body.payment_method || body.paymentMethod || body.paymentLabel || '',
    created_at: createdAt,
    delivery_address: ensureSqlSafeString(body.delivery_address || body.deliveryAddress || body.shippingAddress || ''),
    recipient_name: ensureSqlSafeString(body.recipient_name || body.recipientName || body.customerName || ''),
    recipient_phone: ensureSqlSafeString(body.recipient_phone || body.recipientPhone || body.customerPhone || ''),
    courier_name: courierName,
    tracking_number: trackingNum
  };

  const items = Array.isArray(body.items) ? body.items : [];
  const tracking = Array.isArray(body.tracking) ? body.tracking : [{
    status: 'Order placed',
    message: 'Order placed',
    timestamp: createdAt
  }];

  // ensure we include an initial tracking assignment event when a tracking number exists
  if(trackingNum){
    tracking.push({ status: 'Tracking assigned', message: 'Tracking number: ' + trackingNum, timestamp: createdAt });
  }

  const insertOrder = db.prepare(`
    INSERT INTO Orders (id, user_id, status, total, shipping_fee, discount, payment_method, created_at, delivery_address, recipient_name, recipient_phone, courier_name, tracking_number)
    VALUES (@id, @user_id, @status, @total, @shipping_fee, @discount, @payment_method, @created_at, @delivery_address, @recipient_name, @recipient_phone, @courier_name, @tracking_number)
  `);
  const insertItem = db.prepare(`
    INSERT INTO OrderItems (order_id, product_id, name, price, qty, image_url)
    VALUES (@order_id, @product_id, @name, @price, @qty, @image_url)
  `);
  const insertTracking = db.prepare(`
    INSERT INTO OrderTracking (order_id, status, message, timestamp, location)
    VALUES (@order_id, @status, @message, @timestamp, @location)
  `);

  const tx = db.transaction(() => {
    // Sanitize and restrict the bound parameters to primitive types that sqlite accepts.
    const insertParams = {
      id: String(order.id || ''),
      user_id: (order.user_id === null || order.user_id === undefined) ? null : String(order.user_id),
      status: String(order.status || ''),
      total: Number(order.total || 0),
      shipping_fee: Number(order.shipping_fee || 0),
      discount: Number(order.discount || 0),
      payment_method: String(order.payment_method || ''),
      created_at: String(order.created_at || nowIso()),
      delivery_address: String(order.delivery_address || ''),
      recipient_name: String(order.recipient_name || ''),
      recipient_phone: String(order.recipient_phone || ''),
      courier_name: String(order.courier_name || ''),
      tracking_number: String(order.tracking_number || '')
    };

    // Defensive check: coerce any remaining non-primitive values and log which keys were coerced
    Object.keys(insertParams).forEach(k => {
      const v = insertParams[k];
      const t = typeof v;
      const isBuffer = (v && typeof v === 'object' && v.buffer && v.byteLength !== undefined);
      if (!(v === null || t === 'string' || t === 'number' || t === 'bigint' || Buffer.isBuffer(v) || isBuffer)){
        try{
          console.warn('Coercing order.insert param to string for sqlite bind:', k, 'type:', t);
        }catch(e){}
        insertParams[k] = ensureSqlSafeString(v);
      }
    });

    // Log the shaped params (types and truncated values) to help debug binding issues.
    try{
      const types = Object.fromEntries(Object.keys(insertParams).map(k => [k, typeof insertParams[k]]));
      const preview = Object.fromEntries(Object.keys(insertParams).map(k => [k, (insertParams[k] === null ? null : (String(insertParams[k]).slice(0, 200)))]));
      console.log('Inserting Order - param types:', types);
      console.log('Inserting Order - param preview:', preview);
    }catch(e){}

    insertOrder.run(insertParams);
    items.forEach(it => {
      const prodIdRaw = (it.product_id || it.productId || it.id || it.sku || null);
      const itemParams = {
        order_id: orderId,
        product_id: prodIdRaw == null ? null : String(prodIdRaw),
        name: String(it.name || it.title || ''),
        price: Number(it.price || 0),
        qty: Number(it.qty || it.quantity || 1),
        image_url: String(it.image_url || it.image || it.imageUrl || it.img || '')
      };
      // defensive coercion for item params
      Object.keys(itemParams).forEach(k => {
        const v = itemParams[k];
        const t = typeof v;
        if (!(v === null || t === 'string' || t === 'number' || t === 'bigint' || Buffer.isBuffer(v))){
          try{ console.warn('Coercing OrderItem param to string for sqlite bind:', k, 'type:', t); }catch(e){}
          itemParams[k] = ensureSqlSafeString(v);
        }
      });
      insertItem.run(itemParams);
    });
    tracking.forEach(ev => {
      insertTracking.run({
        order_id: orderId,
        status: normalizeStatus(ev.status || ev.message || ''),
        message: ev.message || ev.status || '',
        timestamp: ev.timestamp || nowIso(),
        location: ev.location || ev.location_name || getRandomLocation({})
      });
    });
  });

  try {
    tx();
    // Return the authoritative server copy so clients (admin/client) immediately receive generated fields
    try{
      const saved = db.prepare('SELECT * FROM Orders WHERE id = ?').get(orderId);
      if(saved){ saved.delivery_address = maybeParseJson(saved.delivery_address); }
      const itemsSaved = db.prepare('SELECT product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(orderId);
      return res.status(201).json({ orderId, order: saved, items: itemsSaved });
    }catch(e){ return res.status(201).json({ orderId }); }
  } catch (e) {
    console.error('Create order failed', e && (e.stack || e.message || e));
    // Provide more actionable error in dev; map common SQLite constraint errors to 409
    try{
      var msg = e && (e.message || String(e)) || 'Failed to create order';
      if(msg.toLowerCase().indexOf('unique') !== -1 || msg.toLowerCase().indexOf('constraint') !== -1) return res.status(409).json({ error: msg });
      return res.status(500).json({ error: msg });
    }catch(_){ return res.status(500).json({ error: 'Failed to create order' }); }
  }
});

// Dev-only migration: assign tracking numbers to existing orders missing them
// Usage: POST /api/orders/migrate-assign-tracking?confirm=1
app.post('/api/orders/migrate-assign-tracking', (req, res) => {
  try{
    const confirmed = (req.query && String(req.query.confirm || '').toLowerCase()) === '1' || req.body && req.body.confirm === true;
    if(!confirmed) return res.status(400).json({ error: 'Confirmation required. Call with ?confirm=1 to run.' });
    const rows = db.prepare("SELECT id, courier_name, tracking_number FROM Orders WHERE tracking_number IS NULL OR tracking_number = ''").all();
  const insertTracking = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
    const updateOrder = db.prepare('UPDATE Orders SET tracking_number = ?, courier_name = ? WHERE id = ?');
    const now = new Date().toISOString();
    const results = [];
    const tx = db.transaction(() => {
      rows.forEach(r => {
        const tn = generateTrackingNumber(r.id);
        const courier = r.courier_name || '';
        updateOrder.run(tn, courier, r.id);
  insertTracking.run(r.id, 'Tracking assigned', 'Tracking number: ' + tn, now, getRandomLocation(r));
        results.push({ id: r.id, tracking_number: tn });
      });
    });
    tx();
    return res.json({ ok: true, count: results.length, assigned: results });
  }catch(e){ console.error('migration failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

app.listen(PORT, () => {
  console.log(`ShoePao server running on http://localhost:${PORT}`);
});

// Periodic poller to refresh tracking statuses for orders with tracking numbers
if (AFTERSHIP_KEY) {
  // If webhook secret is configured, rely primarily on webhooks and poll less frequently (hourly).
  const pollIntervalMs = AFTERSHIP_SECRET ? (1000 * 60 * 60) : (1000 * 60 * 5);
  setInterval(async () => {
    try{
      const rows = db.prepare("SELECT id, tracking_number, courier_name FROM Orders WHERE tracking_number IS NOT NULL AND tracking_number <> ''").all();
      for (const r of rows) {
        try{
          const slug = (r.courier_name || '').toLowerCase().replace(/\s+/g,'-');
          const apiResp = await aftershipGetTracker(slug || '', r.tracking_number);
          const t = apiResp && (apiResp.data && apiResp.data.tracking) ? apiResp.data.tracking : apiResp.tracking || null;
          const checkpoints = (t && Array.isArray(t.checkpoints)) ? t.checkpoints : [];
          if (checkpoints.length) {
            const existing = db.prepare('SELECT message, timestamp FROM OrderTracking WHERE order_id = ?').all(r.id).map(x => (x.message + '||' + x.timestamp));
            const insert = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp) VALUES (?, ?, ?, ?)');
            const tx = db.transaction(() => {
              checkpoints.forEach(cp => {
                      const key = (cp.message || cp.tag || '') + '||' + (cp.checkpoint_time || cp.time || cp.created_at || '');
                      if (!existing.includes(key)) {
                        insert.run(r.id, (cp.tag || cp.message || ''), (cp.message || cp.tag || ''), (cp.checkpoint_time || cp.time || cp.created_at || new Date().toISOString()), (cp.location || cp.city || getRandomLocation(r)));
                      }
                    });
            });
              try{ tx();
                // update Orders.status to latest checkpoint mapping
                var lastCp = checkpoints[checkpoints.length - 1];
                var mapped = mapAftershipTagToOrderStatus(lastCp && (lastCp.tag || lastCp.status || lastCp.message) );
                if(mapped){
                  try{
                    var curRow = db.prepare('SELECT status FROM Orders WHERE id = ?').get(r.id);
                    var curStatus = curRow && curRow.status ? curRow.status : '';
                    var mappedCanon = canonicalizeStatus(mapped) || mapped;
                    if(serverCanTransition(curStatus, mappedCanon)){
                      db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(mapped, r.id);
                      try{ syncOrderStatusToFirestore(r.id, mapped).catch(()=>{}); }catch(e){}
                    }
                  }catch(e){ /* ignore */ }
                }
              }catch(e){ console.warn('poller tx failed', e); }
          }
        }catch(e){ /* individual order poll fail - continue */ }
      }
    }catch(e){ console.warn('tracking poller failed', e); }
  }, pollIntervalMs);
}
