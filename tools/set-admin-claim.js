#!/usr/bin/env node
(async function(){
  try{
    const path = require('path');
    const admin = require('firebase-admin');
    const email = process.argv[2];
    const valueArg = process.argv[3] || 'true';
    const value = String(valueArg).toLowerCase() === 'true';
    if(!email){ console.error('Usage: node tools/set-admin-claim.js <email> [true|false]'); process.exit(2); }

    const saPath = path.join(__dirname, '..', 'service-account.json');
    let sa = null;
    try{ sa = require(saPath); }catch(e){ console.error('service-account.json not found or invalid', e); process.exit(3); }
    if(!admin.apps || !admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });

    try{
      const user = await admin.auth().getUserByEmail(email);
      const newClaims = Object.assign({}, user.customClaims || {}, { admin: value });
      await admin.auth().setCustomUserClaims(user.uid, newClaims);
      console.log('Set admin claim for', email, '->', value, 'uid=', user.uid);
      process.exit(0);
    }catch(e){ console.error('Failed to set admin claim for', email, e); process.exit(4); }
  }catch(err){ console.error('fatal', err); process.exit(5); }
})();
