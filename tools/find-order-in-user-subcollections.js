#!/usr/bin/env node
/**
 * Iterate users collection and check users/{userId}/orders subcollections for a matching order id or customerEmail.
 * Usage: node tools/find-order-in-user-subcollections.js <orderId?> <email?>
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
  console.log('Scanning users/*/orders subcollections...');
  const usersSnap = await db.collection('users').get();
  let found = 0;
  for(const u of usersSnap.docs){
    const uid = u.id;
    const ordersRef = db.collection('users').doc(uid).collection('orders');
    if(orderId){
      const q = await ordersRef.where('id','==',orderId).get();
      if(!q.empty){
        for(const d of q.docs){ console.log('Found order in users/' + uid + '/orders -> doc:', d.id, ' keys:', Object.keys(d.data())); found++; }
      }
      // also check doc id
      const doc = await ordersRef.doc(orderId).get();
      if(doc.exists){ console.log('Found order by doc id in users/' + uid + '/orders -> doc:', doc.id); found++; }
    }
    if(email){
      const q2 = await ordersRef.where('customerEmail','==',email).get();
      if(!q2.empty){
        for(const d of q2.docs){ console.log('Found order for email in users/' + uid + '/orders -> doc:', d.id, ' id-field:', d.data().id || '-', 'status:', d.data().status || '-'); found++; }
      }
    }
  }
  if(found===0) console.log('No matches found in users/*/orders');
}

const orderId = process.argv[2] || null;
const email = process.argv[3] || null;
if(!orderId && !email){ console.error('Usage: node tools/find-order-in-user-subcollections.js <orderId?> <email?>'); process.exit(1); }
find(orderId, email).then(()=>{ console.log('Done'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(2); });
