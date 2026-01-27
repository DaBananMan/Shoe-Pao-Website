(async function(){
  try{
    const admin = require('firebase-admin');
    const path = require('path');
    const saPath = path.join(__dirname, '..', 'service-account.json');
    let sa = null;
    try{ sa = require(saPath); }catch(e){ console.error('service-account.json not found or invalid', e); process.exit(2); }
    if(!admin.apps || !admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });

  const email = process.env.ADMIN_DEFAULT_EMAIL || 'admin@gmail.com';
    const password = process.env.ADMIN_DEFAULT_PASSWORD || 'password';
    const disable = String(process.env.ADMIN_DISABLE_AUTO_CREATE || '').toLowerCase() === 'true';
    if(disable){ console.log('Auto-create disabled via ADMIN_DISABLE_AUTO_CREATE'); process.exit(0); }

    try{
      const u = await admin.auth().getUserByEmail(email);
      console.log('admin exists', u.uid, u.email);
      try{ await admin.auth().setCustomUserClaims(u.uid, Object.assign({}, u.customClaims || {}, { admin: true })); }catch(e){}
      const fdb = admin.firestore();
      await fdb.collection('accounts').doc(u.uid).set({ uid: u.uid, email: (u.email||'').toLowerCase(), role: 'admin', displayName: u.displayName||'Admin' }, { merge: true });
      console.log('accounts doc ensured for', u.uid);
      process.exit(0);
    }catch(e){
      if (e && (e.code === 'auth/user-not-found' || String(e).toLowerCase().indexOf('no user record') !== -1)){
        console.log('creating admin', email);
        const opts = { email: email, emailVerified: true, displayName: 'Admin' };
        if(password && password.length >= 6) opts.password = password;
        const created = await admin.auth().createUser(opts);
        console.log('created admin', created.uid, email);
        try{ await admin.auth().setCustomUserClaims(created.uid, { admin: true }); }catch(err){}
        try{ const fdb = admin.firestore(); await fdb.collection('accounts').doc(created.uid).set({ uid: created.uid, email: email.toLowerCase(), role: 'admin', displayName: 'Admin', createdAt: new Date().toISOString() }, { merge: true }); }catch(err){ console.warn('failed to write accounts doc', err); }
        console.log('done');
        process.exit(0);
      }
      console.error('lookup error', e);
      process.exit(3);
    }
  }catch(err){ console.error('fatal', err); process.exit(4); }
})();
