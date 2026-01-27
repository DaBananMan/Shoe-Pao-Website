#!/usr/bin/env node
(async function(){
  try{
    const path = require('path');
    const admin = require('firebase-admin');
    const arg = process.argv[2];
    if(!arg){ console.error('Usage: node tools/revoke-refresh-tokens.js <uid|email>'); process.exit(2); }

    const saPath = path.join(__dirname, '..', 'service-account.json');
    let sa = null;
    try{ sa = require(saPath); }catch(e){ console.error('service-account.json not found or invalid', e); process.exit(3); }
    if(!admin.apps || !admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });

    let uid = arg;
    // If looks like an email, try to resolve
    if(arg.indexOf('@') !== -1){
      try{ const u = await admin.auth().getUserByEmail(arg); uid = u.uid; }catch(e){ console.error('Failed to resolve email to uid', e); process.exit(4); }
    }

    try{
      await admin.auth().revokeRefreshTokens(uid);
      console.log('Revoked refresh tokens for uid', uid);
      // Fetch user to display tokensValidAfterTime
      const u2 = await admin.auth().getUser(uid);
      try{ console.log('tokensValidAfterTime:', u2.tokensValidAfterTime); }catch(e){}
      process.exit(0);
    }catch(e){ console.error('Failed to revoke tokens for', uid, e); process.exit(5); }
  }catch(err){ console.error('fatal', err); process.exit(6); }
})();
