#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function readJson(p){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch(e){ console.error('Failed to read',p,e); return null; } }

const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){
  console.error('serviceAccountKey.json not found at', servicePath);
  process.exit(1);
}

const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function emailKey(email){
  // Use the raw lowercased email as the document id when possible so callers can use users/{email}
  // We avoid aggressive sanitization (dots/@ are allowed in Firestore doc ids) but lowercase for consistency.
  return String(email||'').toLowerCase();
}

async function main(){
  console.log('Starting sync to Firestore...');
  const dataDir = path.resolve(__dirname, '..', 'data');

  // 1) seed users
  const usersFile = path.join(dataDir, 'users.json');
  const users = readJson(usersFile) || [];
  console.log('Found', users.length, 'users');
  for(const u of users){
    try{
      const candidate = u.email || u.emailAddress || u.username;
      const key = candidate ? emailKey(candidate) : ('user_' + Math.random().toString(36).slice(2,8));
      const doc = Object.assign({}, u);
      delete doc.password; // don't store plaintext password
      await db.collection('users').doc(key).set(Object.assign({}, doc, { migratedAt: admin.firestore.FieldValue.serverTimestamp() }), { merge: true });
      console.log('Upserted user:', key);
    }catch(e){ console.error('User write failed', e); }
  }

  // 2) seed orders
  const ordersFile = path.join(dataDir, 'orders.json');
  const orders = readJson(ordersFile) || [];
  console.log('Found', orders.length, 'orders');
  for(const o of orders){
    try{
      const id = o.id || ('order_' + Math.random().toString(36).slice(2,9));
      const payload = Object.assign({}, o);
      // remove any circular or non-serializable fields
      await db.collection('orders').doc(id).set(Object.assign({}, payload, { migratedAt: admin.firestore.FieldValue.serverTimestamp() }));
      console.log('Wrote order', id, 'to orders collection');
      const em = o.customerEmail || (o.profile && o.profile.email) || null;
      if(em){
        const key = emailKey(em);
        await db.collection('users').doc(key).collection('orders').doc(id).set(Object.assign({}, payload, { migratedAt: admin.firestore.FieldValue.serverTimestamp() }));
        console.log('  attached to user', key);
      }
    }catch(e){ console.error('Order write failed', e); }
  }

  // 3) seed wishlists
  const wishlistFile = path.join(dataDir, 'wishlist.json');
  const wishs = readJson(wishlistFile) || [];
  console.log('Found', wishs.length, 'wishlist items');
  for(const w of wishs){
    try{
      // if ownerEmail present, attach to user's wishlist array
      const owner = w.ownerEmail || w.email || null;
      const payload = Object.assign({}, w);
      if(owner){
        const key = emailKey(owner);
        // append to array field 'wishlist' on user doc (legacy format) and also create a wishlist subcollection
        await db.collection('users').doc(key).set({ wishlist: admin.firestore.FieldValue.arrayUnion(payload), migratedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        // also write as a dedicated doc in users/{email}/wishlist for easier per-item access
        const wlDoc = db.collection('users').doc(key).collection('wishlist').doc();
        await wlDoc.set(Object.assign({}, payload, { migratedAt: admin.firestore.FieldValue.serverTimestamp() }));
        console.log('Attached wishlist item to user', key);
      } else {
        // store in a top-level collection for manual review
        const docRef = db.collection('wishlists').doc();
        await docRef.set(Object.assign({}, payload, { migratedAt: admin.firestore.FieldValue.serverTimestamp(), ownerEmail: null }));
        console.log('Wrote wishlist item to top-level wishlists:', docRef.id);
      }
    }catch(e){ console.error('Wishlist write failed', e); }
  }

  console.log('Sync complete.');
  process.exit(0);
}

main().catch(e=>{ console.error(e); process.exit(2); });
