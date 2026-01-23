#!/usr/bin/env node
/**
 * Search across collectionGroup('orders') for an order by document id or by 'id' field, or list orders matching an email.
 * Usage: node tools/find-order-collectiongroup.js <orderId?> <email?>
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
  console.log('Searching collectionGroup("orders") for matches...');
  if(orderId){
    // search by doc id first
    const q = await db.collectionGroup('orders').where('id','==',orderId).get();
    if(!q.empty){
      console.log('Found', q.size, 'matches for id field ==', orderId);
      for(const d of q.docs){ console.log(' - path:', d.ref.path, ' docId:', d.id, ' keys:', Object.keys(d.data())); }
    } else {
      console.log('No collectionGroup orders with id field ==', orderId);
    }
    // also try doc id match (rare for subcollections)
    const all = await db.collectionGroup('orders').get();
    for(const d of all.docs){ if(String(d.id) === String(orderId)){ console.log('Found doc with docId ==', orderId, ' path:', d.ref.path); } }
  }
  if(email){
    console.log('\nSearching for orders with customerEmail ==', email, 'in collectionGroup orders');
    const q2 = await db.collectionGroup('orders').where('customerEmail','==',email).get();
    if(q2.empty) console.log('No orders in any users/*/orders subcollections with customerEmail ==', email);
    else { console.log('Found', q2.size, 'matches:'); for(const d of q2.docs){ console.log(' -', d.ref.path, ' id-field:', d.data().id || '-', 'status:', d.data().status || '-'); } }
  }
  // Also show top-level orders with same email for completeness
  if(email){
    console.log('\nAlso checking top-level orders collection for customerEmail ==', email);
    const top = await db.collection('orders').where('customerEmail','==',email).get();
    if(top.empty) console.log('No top-level orders for that email'); else { for(const d of top.docs) console.log(' - top orders/', d.id, ' id-field:', d.data().id || '-', 'status:', d.data().status || '-'); }
  }
}

const orderId = process.argv[2] || null;
const email = process.argv[3] || null;
if(!orderId && !email){ console.error('Usage: node tools/find-order-collectiongroup.js <orderId?> <email?>'); process.exit(1); }
find(orderId, email).then(()=>{ console.log('Done'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(2); });
