const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const [,, orderId, productId, name, price, imageUrl] = process.argv;
if(!orderId || !name){
  console.error('Usage: node tools/fix_order_item.js <orderId> <productId> <name> [price] [imageUrl]');
  process.exit(2);
}
try{
  const items = db.prepare('SELECT id, product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(orderId);
  if(!items || !items.length){
    console.error('No items found for order', orderId); process.exit(1);
  }
  console.log('Found items:', items);
  const stmt = db.prepare('UPDATE OrderItems SET product_id = ?, name = ?, price = ?, image_url = ? WHERE order_id = ?');
  const p = productId || items[0].product_id || '';
  const pr = (typeof price !== 'undefined' && price !== null) ? Number(price) : (items[0].price || 0);
  const img = imageUrl || items[0].image_url || '';
  const info = stmt.run(p, name, pr, img, orderId);
  console.log('Updated rows:', info.changes);
  const updated = db.prepare('SELECT id, product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(orderId);
  console.log('After update:', updated);
}catch(e){ console.error('Error:', e); process.exit(1); }