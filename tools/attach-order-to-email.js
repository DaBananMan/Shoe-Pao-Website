#!/usr/bin/env node
/**
 * Attach a specific order doc into users/{email}/orders by copying it.
 * Usage: node tools/attach-order-to-email.js <email> <orderId>
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function attach(email, orderId){
  const key = String(email).toLowerCase();
  const orderRef = db.collection('orders').doc(orderId);
  const snap = await orderRef.get();
  if(!snap.exists){
    console.error('Order not found:', orderId);
    process.exit(2);
  }
  const data = snap.data();
  // copy into users/{email}/orders/{orderId}
  const destRef = db.collection('users').doc(key).collection('orders').doc(orderId);
  await destRef.set(Object.assign({}, data, { attachedAt: admin.firestore.FieldValue.serverTimestamp(), attachedBy: 'attach-order-to-email' }));
  console.log('Copied order', orderId, 'to users/' + key + '/orders');
  // annotate original
  await orderRef.set({ possibleOwner: key, attachedToUser: true, attachedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log('Annotated original order', orderId);
}

if(process.argv.length < 4){ console.error('Usage: node tools/attach-order-to-email.js <email> <orderId>'); process.exit(1); }
const email = process.argv[2];
const orderId = process.argv[3];
attach(email, orderId).then(()=>{ console.log('Done'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(3); });
