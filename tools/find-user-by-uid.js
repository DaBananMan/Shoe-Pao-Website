#!/usr/bin/env node
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function find(uid){
  const q = await db.collection('users').where('uid','==',uid).get();
  console.log('Found', q.size, 'matching users docs for uid=', uid);
  for(const d of q.docs){
    console.log(' - doc id:', d.id, ' keys:', Object.keys(d.data()));
  }
}

const uid = process.argv[2];
if(!uid){ console.error('Usage: node tools/find-user-by-uid.js <uid>'); process.exit(2); }
find(uid).then(()=>process.exit(0)).catch(e=>{ console.error(e); process.exit(3); });
