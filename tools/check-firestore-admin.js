(async function(){
  try{
    const admin = require('firebase-admin');
    const path = require('path');
    const sa = require(path.join(__dirname,'..','service-account.json'));
    if(!admin.apps || !admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
    const fdb = admin.firestore();
    const q = await fdb.collection('accounts').limit(1).get();
    console.log('Found accounts docs:', q.size);
    process.exit(0);
  }catch(e){ console.error('admin firestore check failed', e); process.exit(2); }
})();
