#!/usr/bin/env node
// Usage: node tools/patch_order.js <orderId> '<jsonPayload>'
// Example payload: '{"status":"pending payment","total":2395,"shipping_fee":280,"items":[{"product_id":"SP-NIK-XXXX-0WUE","name":"Nike Airmax Yellow","price":2395,"qty":1,"image_url":""}]}'

const path = require('path');
const db = require('../server/db');

function exitWith(msg){ console.error(msg); process.exit(1); }

async function main(){
  const args = process.argv.slice(2);
  if(args.length < 2) return exitWith('Usage: node tools/patch_order.js <orderId> <jsonPayload>');
  const orderId = args[0];
  let payload;
  const fs = require('fs');
  // If second arg is a path to an existing file, read JSON from it
  const maybePath = args[1];
  try{
    if(fs.existsSync(maybePath)){
      payload = JSON.parse(fs.readFileSync(maybePath, 'utf8'));
    } else {
      payload = JSON.parse(args[1]);
    }
  }catch(e){ return exitWith('Invalid JSON payload or file: ' + e.message); }

  // Allowed top-level fields we will apply: status, total, shipping_fee, discount, tracking_number, courier_name, recipient_name, recipient_phone, delivery_address, items
  const up = {};
  ['status','total','shipping_fee','discount','tracking_number','courier_name','recipient_name','recipient_phone','delivery_address'].forEach(k=>{ if(typeof payload[k] !== 'undefined') up[k]=payload[k]; });

  try{
    if(Object.keys(up).length){
      const parts = Object.keys(up).map(k => `${k} = ?`).join(', ');
      const params = Object.keys(up).map(k => up[k]);
      params.push(orderId);
      const sql = `UPDATE Orders SET ${parts} WHERE id = ?`;
      db.prepare(sql).run(...params);
      console.log('Updated Orders row for', orderId);
    }

    if(Array.isArray(payload.items)){
      // Remove existing items
      db.prepare('DELETE FROM OrderItems WHERE order_id = ?').run(orderId);
      const insert = db.prepare('INSERT INTO OrderItems (order_id, product_id, name, price, qty, image_url) VALUES (@order_id,@product_id,@name,@price,@qty,@image_url)');
      for(const it of payload.items){
        insert.run({ order_id: orderId, product_id: it.product_id || '', name: it.name || '', price: Number(it.price || 0), qty: Number(it.qty || it.quantity || 1), image_url: it.image_url || it.image || '' });
      }
      console.log('Replaced items for', orderId);
    }

    // Fetch resulting order
    const order = db.prepare('SELECT * FROM Orders WHERE id = ?').get(orderId);
    const items = db.prepare('SELECT * FROM OrderItems WHERE order_id = ? ORDER BY id ASC').all(orderId);
    const tracking = db.prepare('SELECT * FROM OrderTracking WHERE order_id = ? ORDER BY id ASC').all(orderId);
    const out = { order: order || null, items: items, tracking: tracking };
    const fs = require('fs');
    fs.writeFileSync(path.join(__dirname,'..','tmp_order_' + orderId + '_after.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log('Wrote tmp_order_' + orderId + '_after.json');
    console.log(JSON.stringify(out, null, 2));
  }catch(e){ console.error('Failed to patch order', e); process.exit(2); }
}

main();
