#!/usr/bin/env node
/**
 * Search orders by document id or by `id` field, and list delivered orders for a given email.
 * Usage: node tools/find-order.js <orderId> <email>
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function find(orderId, email){
  console.log('Checking doc id:', orderId);
  const docRef = db.collection('orders').doc(orderId);
  const docSnap = await docRef.get();
  if(docSnap.exists){
    console.log('Found by doc id:', orderId, ' data keys:', Object.keys(docSnap.data()));
  } else {
    console.log('No doc with that document id. Searching `id` field...');
    const q = await db.collection('orders').where('id','==',orderId).get();
    if(q.empty) console.log('No orders with id field ==', orderId);
    else {
      for(const d of q.docs){ console.log('Found order doc', d.id, '-> id field matches, data keys:', Object.keys(d.data())); }
    }
  }

  if(email){
    const key = String(email).toLowerCase();
    console.log('\nSearching for orders with customerEmail ==', email, 'and delivered/completed status');
    const statusSnap = await db.collection('orders').where('customerEmail','==',email).get();
    if(statusSnap.empty) console.log('No orders with customerEmail ==', email);
    else {
      for(const d of statusSnap.docs){
        const data = d.data();
        console.log(' - doc:', d.id, 'id-field:', data.id || '-', 'status:', data.status || '-', 'customerName:', data.customerName || '-', 'tracking:', data.tracking || '-');
      }
    }
    console.log('\nAlso listing orders where status contains "deliver" or "completed" (any email) to help locate delivered orders:');
    const all = await db.collection('orders').get();
    for(const d of all.docs){
      const s = String((d.data()||{}).status||'').toLowerCase();
      if(s.includes('deliver') || s.includes('completed')){
        const data = d.data();
        console.log(' *', d.id, 'id-field:', data.id || '-', 'status:', data.status || '-', 'customerEmail:', data.customerEmail || '-', 'customerName:', data.customerName || '-');
      }
    }
  }
}

if(process.argv.length < 3){ console.error('Usage: node tools/find-order.js <orderId> [email]'); process.exit(1); }
const orderId = process.argv[2];
const email = process.argv[3];
find(orderId, email).then(()=>{ console.log('Done'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(2); });
