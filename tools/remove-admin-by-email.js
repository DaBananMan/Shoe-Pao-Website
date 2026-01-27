// Remove a Firebase Auth user by email and clean up accounts docs
(async function(){
  try{
    const emailArg = process.argv[2];
    if(!emailArg){ console.error('Usage: node remove-admin-by-email.js <email>'); process.exit(2); }
    const email = String(emailArg).trim().toLowerCase();
    const admin = require('firebase-admin');
    const path = require('path');
    const saPath = path.join(__dirname, '..', 'service-account.json');
    try{ const sa = require(saPath); if(!admin.apps || !admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) }); }catch(e){ try{ if(!admin.apps || !admin.apps.length) admin.initializeApp(); }catch(err){} }

    if(!admin.apps || !admin.apps.length){ console.error('firebase-admin not initialized; ensure service-account.json is present'); process.exit(3); }

    try{
      const user = await admin.auth().getUserByEmail(email);
      console.log('Found user:', user.uid, user.email);
      // delete auth user
      try{ await admin.auth().deleteUser(user.uid); console.log('Deleted auth user', user.uid); }catch(e){ console.warn('Failed to delete auth user', e); }
      // delete canonical accounts doc by uid
      try{ const fdb = admin.firestore(); await fdb.collection('accounts').doc(user.uid).delete(); console.log('Deleted accounts doc for uid', user.uid); }catch(e){ console.warn('Failed to delete accounts doc for uid', e); }
      // also attempt to delete alias doc by encoded email
      try{ const aliasId = encodeURIComponent(email); const fdb = admin.firestore(); const aliasRef = fdb.collection('accounts').doc(aliasId); const aliasSnap = await aliasRef.get(); if(aliasSnap.exists){ await aliasRef.delete(); console.log('Deleted alias accounts doc', aliasId); } }catch(e){ console.warn('Failed to delete alias doc', e); }
      console.log('Cleanup complete for', email);
      process.exit(0);
    }catch(err){
      if(err && err.code === 'auth/user-not-found'){ console.log('No auth user found for', email, '- attempting to clean any legacy accounts docs');
        try{ const adminSdk = admin; const fdb = adminSdk.firestore(); const aliasId = encodeURIComponent(email); const docs = [aliasId]; // try alias only
          for(const id of docs){ try{ const ref = fdb.collection('accounts').doc(id); const snap = await ref.get(); if(snap.exists){ await ref.delete(); console.log('Deleted accounts doc', id); } }catch(e){ console.warn('failed deleting accounts doc', id, e); } }
        }catch(e){ console.warn('failed to clean legacy accounts docs', e); }
        process.exit(0);
      }
      console.error('Error looking up user by email', err);
      process.exit(4);
    }
  }catch(e){ console.error('fatal', e); process.exit(5); }
})();
