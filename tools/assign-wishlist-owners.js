#!/usr/bin/env node
/**
 * Find owners for top-level wishlist docs and attach them into users/{email}/wishlist
 * Heuristics:
 *  - If wishlist doc has ownerEmail, copy to users/{email}/wishlist
 *  - Else, try to match by scanning users collection for wishlist array items that match by title+size
 *  - Else, try to match by users/{email}/wishlist subcollections
 *  - If found, update wishlist doc with ownerEmail and copy item into users/{email}/wishlist
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function itemMatches(a,b){
  if(!a || !b) return false;
  const t1 = String(a.title||'').toLowerCase();
  const t2 = String(b.title||'').toLowerCase();
  if(!t1 || !t2) return false;
  if(!t1.includes(t2) && !t2.includes(t1)) return false;
  const s1 = String(a.size||'').toLowerCase();
  const s2 = String(b.size||'').toLowerCase();
  if(s1 && s2 && s1 !== s2) return false;
  return true;
}

async function run(){
  const snap = await db.collection('wishlists').get();
  console.log('Found', snap.size, 'top-level wishlist docs');
  let autoAssigned = 0;
  for(const doc of snap.docs){
    const data = doc.data();
    const docId = doc.id;
    if(data.ownerEmail){
      const key = String(data.ownerEmail).toLowerCase();
      // copy the wishlist doc into users/{email}/wishlist
      await db.collection('users').doc(key).collection('wishlist').doc(docId).set(Object.assign({}, data, { migratedAt: admin.firestore.FieldValue.serverTimestamp() }));
      console.log('Copied doc', docId, 'to users/' + key + '/wishlist (ownerEmail present)');
      continue;
    }
    // try to find owner by scanning user docs for wishlist array matches
    let found = false;
    const usersSnap = await db.collection('users').get();
    for(const u of usersSnap.docs){
      const udata = u.data();
      // check array
      if(Array.isArray(udata.wishlist) && udata.wishlist.length){
        for(const item of udata.wishlist){
          if(itemMatches(item, data)){
            const key = String(udata.email||u.id).toLowerCase();
            // set ownerEmail on wishlist doc
            await db.collection('wishlists').doc(docId).set({ ownerEmail: key, migratedAt: admin.firestore.FieldValue.serverTimestamp(), matchedFrom: u.id }, { merge: true });
            // copy into users/{key}/wishlist
            await db.collection('users').doc(key).collection('wishlist').doc(docId).set(Object.assign({}, data, { migratedAt: admin.firestore.FieldValue.serverTimestamp(), originUserDoc: u.id }));
            console.log('Matched wishlist', docId, 'to user doc', u.id, '-> users/' + key);
            autoAssigned++;
            found = true;
            break;
          }
        }
      }
      if(found) break;
      // check subcollection
      const wlSub = await db.collection('users').doc(u.id).collection('wishlist').get();
      for(const wld of wlSub.docs){
        const wldata = wld.data();
        if(itemMatches(wldata, data)){
          const key = String(udata.email||u.id).toLowerCase();
          await db.collection('wishlists').doc(docId).set({ ownerEmail: key, migratedAt: admin.firestore.FieldValue.serverTimestamp(), matchedFrom: u.id }, { merge: true });
          await db.collection('users').doc(key).collection('wishlist').doc(docId).set(Object.assign({}, data, { migratedAt: admin.firestore.FieldValue.serverTimestamp(), originUserDoc: u.id }));
          console.log('Matched wishlist (subcollection) ', docId, 'to user doc', u.id, '-> users/' + key);
          autoAssigned++;
          found = true;
          break;
        }
      }
      if(found) break;
    }
    if(!found){
      console.log('No owner found for wishlist', docId, '- leaving for manual review');
    }
  }
  console.log('Auto-assigned', autoAssigned, 'wishlist docs');
}

run().then(()=>{ console.log('Done'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(2); });
