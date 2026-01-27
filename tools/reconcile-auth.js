#!/usr/bin/env node
/**
 * Reconcile Firebase Authentication users into Firestore `users/{uid}` docs.
 * - Creates a Firestore user doc for any Auth user missing one (doc id = auth.uid)
 * - Attaches orders from `orders` collection matching email to users/{uid}/orders
 * - Moves wishlist items from top-level `wishlists` or from legacy user docs (email-keyed) into users/{uid}/wishlist
 *
 * Usage: node tools/reconcile-auth.js
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){
  console.error('serviceAccountKey.json not found at', servicePath);
  process.exit(1);
}
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function ensureUserDoc(docId, userRecord){
  // Use email as doc id when available (lowercased) to match legacy callers that expect users/{email}
  const docRef = db.collection('users').doc(docId);
  const snap = await docRef.get();
  if(snap.exists){ return docRef; }
  const payload = {
    uid: userRecord.uid,
    email: userRecord.email || null,
    displayName: userRecord.displayName || null,
    photoURL: userRecord.photoURL || null,
    emailVerified: !!userRecord.emailVerified,
    providers: (userRecord.providerData||[]).map(p=>p.providerId).filter(Boolean),
    createdAt: userRecord.metadata && userRecord.metadata.creationTime ? admin.firestore.Timestamp.fromDate(new Date(userRecord.metadata.creationTime)) : admin.firestore.FieldValue.serverTimestamp(),
    migratedFromAuth: true,
    migratedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await docRef.set(payload, { merge:true });
  console.log('Created user doc for docId=', docId, ' email=', payload.email);
  return docRef;
}

async function attachOrdersToUser(docId, email){
  try{
    const ordersQ = db.collection('orders').where('customerEmail','==',email);
    const snap = await ordersQ.get();
    if(snap.empty) return 0;
    let count = 0;
    for(const doc of snap.docs){
      const data = doc.data();
      await db.collection('users').doc(docId).collection('orders').doc(doc.id).set(Object.assign({}, data, { migratedAt: admin.firestore.FieldValue.serverTimestamp() }), { merge:true });
      count++;
    }
    console.log(`Attached ${count} orders for ${email} -> users/${docId}/orders`);
    return count;
  }catch(e){ console.warn('attachOrders error', e); return 0; }
}

async function moveWishlistsToUser(docId, email){
  let moved = 0;
  try{
    // 1) move from top-level `wishlists` where ownerEmail == email
    const q = db.collection('wishlists').where('ownerEmail','==',email);
    const snap = await q.get();
    for(const doc of snap.docs){
      const data = doc.data();
      await db.collection('users').doc(docId).collection('wishlist').doc(doc.id).set(Object.assign({}, data, { migratedAt: admin.firestore.FieldValue.serverTimestamp() }));
      // optionally remove original; keep it for audit but we will leave it to manual cleanup
      moved++;
    }
    // 2) check for legacy user docs keyed by sanitized email that may have wishlist array
    const usersByEmail = await db.collection('users').where('email','==',email).get();
    for(const udoc of usersByEmail.docs){
      const udata = udoc.data();
      if(Array.isArray(udata.wishlist) && udata.wishlist.length){
        for(const item of udata.wishlist){
          const newDoc = db.collection('users').doc(docId).collection('wishlist').doc();
          await newDoc.set(Object.assign({}, item, { migratedAt: admin.firestore.FieldValue.serverTimestamp(), originUserDoc: udoc.id }));
          moved++;
        }
      }
    }
    if(moved) console.log(`Moved ${moved} wishlist items for ${email} -> users/${docId}/wishlist`);
    return moved;
  }catch(e){ console.warn('moveWishlists error', e); return moved; }
}

async function reconcile(){
  console.log('Reconciling auth users into Firestore...');
  let nextPageToken = undefined;
  let totalUsers = 0;
  do{
    const list = await admin.auth().listUsers(1000, nextPageToken);
    for(const userRecord of list.users){
      totalUsers++;
      const email = userRecord.email || null;
      // prefer email as the document id when available so `users/{email}` exists
      const docId = email ? String(email).toLowerCase() : userRecord.uid;
      try{
        await ensureUserDoc(docId, userRecord);
        if(email){
          await attachOrdersToUser(docId, email);
          await moveWishlistsToUser(docId, email);
        }
      }catch(e){ console.warn('user reconcile error', docId, email, e); }
    }
    nextPageToken = list.pageToken;
  }while(nextPageToken);
  console.log('Reconciliation complete. Processed', totalUsers, 'auth users.');
}

reconcile().then(()=>{ console.log('Done'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(2); });
