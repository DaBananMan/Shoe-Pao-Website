const express = require('express');
const path = require('path');
const db = require('./server/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

function nowIso(){
  return new Date().toISOString();
}

function normalizeStatus(s){
  return String(s || '').trim();
}

function generateOrderId(){
  const rand = Math.floor(Math.random() * 900000 + 100000);
  const year = new Date().getFullYear().toString().slice(-2);
  return `ORD${year}${rand}`;
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
  res.json({ orders: rows });
});

// Get order by id
app.get('/api/orders/:orderId', (req, res) => {
  const id = req.params.orderId;
  const order = db.prepare('SELECT * FROM Orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(id);
  res.json({ order, items });
});

// Get tracking events
app.get('/api/orders/:orderId/tracking', (req, res) => {
  const id = req.params.orderId;
  const tracking = db.prepare('SELECT status, message, timestamp FROM OrderTracking WHERE order_id = ? ORDER BY timestamp ASC').all(id);
  res.json({ tracking });
});

// Create order
app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const orderId = body.id || generateOrderId();
  const createdAt = body.created_at || nowIso();

  const order = {
    id: orderId,
    user_id: body.user_id || body.userId || body.email || null,
    status: normalizeStatus(body.status || 'Order placed'),
    total: Number(body.total || 0),
    shipping_fee: Number(body.shipping_fee || body.shippingFee || 0),
    discount: Number(body.discount || 0),
    payment_method: body.payment_method || body.paymentMethod || body.paymentLabel || '',
    created_at: createdAt,
    delivery_address: body.delivery_address || body.deliveryAddress || body.shippingAddress || '',
    recipient_name: body.recipient_name || body.recipientName || body.customerName || '',
    recipient_phone: body.recipient_phone || body.recipientPhone || body.customerPhone || '',
    courier_name: body.courier_name || body.courierName || body.courier || '',
    tracking_number: body.tracking_number || body.trackingNumber || body.tracking || ''
  };

  const items = Array.isArray(body.items) ? body.items : [];
  const tracking = Array.isArray(body.tracking) ? body.tracking : [{
    status: 'Order placed',
    message: 'Order placed',
    timestamp: createdAt
  }];

  const insertOrder = db.prepare(`
    INSERT INTO Orders (id, user_id, status, total, shipping_fee, discount, payment_method, created_at, delivery_address, recipient_name, recipient_phone, courier_name, tracking_number)
    VALUES (@id, @user_id, @status, @total, @shipping_fee, @discount, @payment_method, @created_at, @delivery_address, @recipient_name, @recipient_phone, @courier_name, @tracking_number)
  `);
  const insertItem = db.prepare(`
    INSERT INTO OrderItems (order_id, product_id, name, price, qty, image_url)
    VALUES (@order_id, @product_id, @name, @price, @qty, @image_url)
  `);
  const insertTracking = db.prepare(`
    INSERT INTO OrderTracking (order_id, status, message, timestamp)
    VALUES (@order_id, @status, @message, @timestamp)
  `);

  const tx = db.transaction(() => {
    insertOrder.run(order);
    items.forEach(it => {
      insertItem.run({
        order_id: orderId,
        product_id: it.product_id || it.productId || it.id || null,
        name: it.name || it.title || '',
        price: Number(it.price || 0),
        qty: Number(it.qty || it.quantity || 1),
        image_url: it.image_url || it.image || it.imageUrl || ''
      });
    });
    tracking.forEach(ev => {
      insertTracking.run({
        order_id: orderId,
        status: normalizeStatus(ev.status || ev.message || ''),
        message: ev.message || ev.status || '',
        timestamp: ev.timestamp || nowIso()
      });
    });
  });

  try {
    tx();
    res.status(201).json({ orderId });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.listen(PORT, () => {
  console.log(`ShoePao server running on http://localhost:${PORT}`);
});
