const admin = require("firebase-admin");
const service = require("./serviceAccountKey.json"); // adjust path if different
admin.initializeApp({credential: admin.credential.cert(service)});
const db = admin.firestore();
async function list() {
  const cols = await db.listCollections();
  for (const c of cols) {
    const snap = await c.limit(5).get();
    console.log(c.id, 'docs:', snap.size);
    snap.forEach(doc => console.log('  -', doc.id));
  }
  process.exit(0);
}
list().catch(e=>{console.error(e); process.exit(1);});
