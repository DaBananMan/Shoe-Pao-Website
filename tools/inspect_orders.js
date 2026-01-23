const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
function getRecentOrders(limit=50){
  const rows = db.prepare('SELECT * FROM Orders ORDER BY datetime(created_at) DESC LIMIT ?').all(limit);
  return rows.map(r=>{
    const items = db.prepare('SELECT product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(r.id);
    const tracking = db.prepare('SELECT status, message, timestamp, location FROM OrderTracking WHERE order_id = ? ORDER BY timestamp ASC').all(r.id);
    return Object.assign({}, r, { items, tracking });
  });
}
const out = getRecentOrders(60);
console.log(JSON.stringify(out, null, 2));
