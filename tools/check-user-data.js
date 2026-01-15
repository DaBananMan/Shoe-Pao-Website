#!/usr/bin/env node
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function check(email){
  const key = String(email).toLowerCase();
  console.log('Checking user doc: users/' + key);
  const userSnap = await db.doc('users/' + key).get();
  console.log(' user exists:', userSnap.exists);
  if(userSnap.exists) console.log(' user data keys:', Object.keys(userSnap.data()));

  const ordersSnap = await db.collection('users').doc(key).collection('orders').get();
  console.log(' orders under users/' + key + '/orders :', ordersSnap.size);
  const wishSnap = await db.collection('users').doc(key).collection('wishlist').get();
  console.log(' wishlist under users/' + key + '/wishlist :', wishSnap.size);

  const ordersTop = await db.collection('orders').where('customerEmail','==',email).get();
  console.log(' orders in top-level orders collection matching customerEmail:', ordersTop.size);

  const wishTop = await db.collection('wishlists').where('ownerEmail','==',email).get();
  console.log(' wishlists in top-level wishlists collection matching ownerEmail:', wishTop.size);
}

const email = process.argv[2];
if(!email){ console.error('Usage: node tools/check-user-data.js someone@example.com'); process.exit(2); }
check(email).then(()=>process.exit(0)).catch(e=>{ console.error(e); process.exit(3); });
