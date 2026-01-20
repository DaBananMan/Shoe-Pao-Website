#!/usr/bin/env node
/**
 * Print all top-level wishlist docs with their data to help manual owner assignment.
 * Usage: node tools/print-wishlists.js
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run(){
  const snap = await db.collection('wishlists').get();
  console.log('Found', snap.size, 'top-level wishlist docs');
  for(const doc of snap.docs){
    const data = doc.data();
    console.log('\n--- doc id:', doc.id, '---');
    console.log(JSON.stringify(data, null, 2));
  }
}

run().then(()=>{ console.log('\nDone'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(2); });
