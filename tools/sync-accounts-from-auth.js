#!/usr/bin/env node
// tools/sync-accounts-from-auth.js
// Lists Firebase Auth users via Admin SDK and ensures a Firestore `accounts` doc exists for each.

const path = require('path');
async function main(){
  try{
    const admin = require('firebase-admin');
    // Initialize using service-account.json in project root when available
    const saPath = path.join(__dirname, '..', 'service-account.json');
    if (require('fs').existsSync(saPath)){
      const sa = require(saPath);
      try{ admin.initializeApp({ credential: admin.credential.cert(sa) }); }catch(e){ /* already initialized */ }
    } else {
      try{ admin.initializeApp(); }catch(e){}
    }
    if(!admin.apps || !admin.apps.length) return console.error('firebase-admin not initialized. Place service-account.json in project root or set GOOGLE_APPLICATION_CREDENTIALS.');

    const db = admin.firestore();
    console.log('Listing users from Firebase Auth...');
    let nextPageToken = undefined; let total = 0;
    do{
      const res = await admin.auth().listUsers(1000, nextPageToken);
      nextPageToken = res.pageToken;
      for(const user of (res.users || [])){
        try{
          const uid = user.uid;
          const email = (user.email || '').toLowerCase();
          const payload = {
            uid: uid,
            email: email,
            displayName: user.displayName || '',
            emailVerified: !!user.emailVerified,
            disabled: !!user.disabled,
            createdAt: user.metadata && user.metadata.creationTime ? user.metadata.creationTime : new Date().toISOString(),
            lastSignInAt: user.metadata && user.metadata.lastSignInTime ? user.metadata.lastSignInTime : null
          };
          // Only create canonical accounts keyed by UID. Do not create encoded-email alias docs.
          await db.collection('accounts').doc(uid).set(payload, { merge: true });
          total++;
          if(total % 50 === 0) console.log('Processed', total, 'users...');
        }catch(e){ console.warn('Failed to upsert account for user', user.uid, e && e.message ? e.message : e); }
      }
    }while(nextPageToken);

    console.log('Done. Processed', total, 'users.');
    process.exit(0);
  }catch(err){ console.error('sync failed', err); process.exit(2); }
}

main();
