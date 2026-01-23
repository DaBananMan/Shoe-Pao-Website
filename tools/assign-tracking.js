// tools/assign-tracking.js
// Usage:
//  node tools/assign-tracking.js --preview   # show what would be assigned
//  node tools/assign-tracking.js --apply     # apply assignments (updates DB)

const db = require('../server/db');

function generateTrackingNumber(orderId){
  try{
    return 'TRK' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*90000+10000).toString(36).toUpperCase();
  }catch(e){ return 'TRK' + Math.floor(Math.random()*900000000 + 100000000); }
}

function getRandomLocation(order){
  const samples = [
    'Caloocan, NCR', 'Marikina, NCR', 'Mandaluyong, NCR', 'Manila, NCR', 'Quezon City, NCR',
    'Makati, NCR', 'Pasig, NCR', 'Taguig, NCR', 'Laguna Province', 'Rizal Province'
  ];
  try{
    if(order && (order.city || (order.deliveryAddress && order.deliveryAddress.city))){
      const city = (order.city || (order.deliveryAddress && order.deliveryAddress.city) || '').toString().toLowerCase();
      for(const s of samples){ if(s.toLowerCase().indexOf(city) !== -1) return s; }
    }
  }catch(e){}
  return samples[Math.floor(Math.random()*samples.length)];
}

async function run(){
  const rows = db.prepare("SELECT id, recipient_name, delivery_address FROM Orders WHERE tracking_number IS NULL OR tracking_number = ''").all();
  console.log('orders missing tracking:', rows.length);
  if(!rows.length) return;

  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const preview = argv.includes('--preview') || !apply;

  const assignments = rows.map(r => ({ id: r.id, tracking_number: generateTrackingNumber(r.id), recipient_name: r.recipient_name || '', delivery_address: r.delivery_address || '' }));

  if(preview){
    console.log('Preview of assignments (first 50 shown):');
    console.dir(assignments.slice(0,50), { depth: 5 });
  }

  if(apply){
    const update = db.prepare('UPDATE Orders SET tracking_number = ? WHERE id = ?');
    const insert = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    const tx = db.transaction((rowsToApply) => {
      for(const a of rowsToApply){
        update.run(a.tracking_number, a.id);
        insert.run(a.id, 'Tracking assigned', 'Tracking number: ' + a.tracking_number, now, getRandomLocation({}));
      }
    });
    try{
      tx(assignments);
      console.log('Applied assignments for', assignments.length, 'orders');
      console.dir(assignments.slice(0,50), { depth: 5 });
    }catch(e){
      console.error('Failed to apply assignments', e && (e.stack || e.message || e));
    }
  } else {
    console.log('Run with --apply to actually update the DB');
  }
}

if(require.main === module) run();
