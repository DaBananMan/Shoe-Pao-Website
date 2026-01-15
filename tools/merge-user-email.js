#!/usr/bin/env node
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function merge(email, uidDocId){
  const emailKey = String(email).toLowerCase();
  const emailRef = db.collection('users').doc(emailKey);
  const uidRef = db.collection('users').doc(uidDocId);

  const [emailSnap, uidSnap] = await Promise.all([emailRef.get(), uidRef.get()]);
  if(!uidSnap.exists){
    console.error('UID doc not found:', uidDocId);
    process.exit(1);
  }

  const uidData = uidSnap.data() || {};
  const emailData = emailSnap.exists ? (emailSnap.data()||{}) : {};

  console.log('Merging UID doc', uidDocId, 'into email doc users/' + emailKey);

  // 1) Merge simple profile fields (do not overwrite existing email/emailVerified/displayName when present)
  const profileFields = ['displayName','photoURL','providers','createdAt','emailVerified','uid','migratedFromAuth','migratedAt'];
  const toSet = {};
  profileFields.forEach(f=>{
    if(uidData[f] !== undefined && (emailData[f] === undefined || emailData[f] === null || emailData[f] === '')){
      toSet[f] = uidData[f];
    }
  });
  // always ensure email field is present
  if(!emailData.email) toSet.email = emailKey;
  if(!emailData.uid && uidData.uid) toSet.uid = uidData.uid;

  if(Object.keys(toSet).length){
    await emailRef.set(Object.assign({}, toSet, { mergedFrom: uidDocId, mergedAt: admin.firestore.FieldValue.serverTimestamp() }), { merge:true });
    console.log('  merged profile fields:', Object.keys(toSet));
  } else {
    console.log('  no profile fields to merge');
  }

  // 2) Merge wishlist array from uid doc
  let wishlistArrayMoved = 0;
  if(Array.isArray(uidData.wishlist) && uidData.wishlist.length){
    for(const item of uidData.wishlist){
      await emailRef.set({ wishlist: admin.firestore.FieldValue.arrayUnion(item), mergedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      wishlistArrayMoved++;
    }
    console.log('  merged', wishlistArrayMoved, 'wishlist array items into users/' + emailKey + '.wishlist (array)');
  }

  // 3) Copy subcollection 'orders'
  const ordersSnap = await uidRef.collection('orders').get();
  let ordersCopied = 0;
  for(const doc of ordersSnap.docs){
    const data = doc.data();
    await emailRef.collection('orders').doc(doc.id).set(Object.assign({}, data, { migratedFrom: uidDocId, migratedAt: admin.firestore.FieldValue.serverTimestamp() }), { merge:true });
    ordersCopied++;
  }
  console.log('  copied', ordersCopied, 'orders from users/' + uidDocId + '/orders -> users/' + emailKey + '/orders');

  // 4) Copy subcollection 'wishlist'
  const wlSnap = await uidRef.collection('wishlist').get();
  let wlCopied = 0;
  for(const doc of wlSnap.docs){
    const data = doc.data();
    const newDoc = emailRef.collection('wishlist').doc(doc.id);
    await newDoc.set(Object.assign({}, data, { migratedFrom: uidDocId, migratedAt: admin.firestore.FieldValue.serverTimestamp() }));
    wlCopied++;
  }
  console.log('  copied', wlCopied, 'wishlist docs from users/' + uidDocId + '/wishlist -> users/' + emailKey + '/wishlist');

  console.log('Merge complete for', emailKey);
}

if(process.argv.length < 4){
  console.error('Usage: node tools/merge-user-email.js <email> <uidDocId>');
  process.exit(2);
}

const email = process.argv[2];
const uidDocId = process.argv[3];
merge(email, uidDocId).then(()=>process.exit(0)).catch(e=>{ console.error(e); process.exit(3); });
