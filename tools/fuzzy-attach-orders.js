#!/usr/bin/env node
/**
 * Fuzzy-match orders to a user's email and copy matched orders into users/{email}/orders
 * Usage: node tools/fuzzy-attach-orders.js someone@example.com
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const servicePath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
if(!fs.existsSync(servicePath)){ console.error('serviceAccountKey.json not found at', servicePath); process.exit(1); }
const serviceAccount = require(servicePath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function scoreOrderForUser(order, user){
  const userEmail = (user.email||'').toLowerCase();
  const userName = (user.displayName||'').toLowerCase();
  const userPhone = (user.phone||'').replace(/[^0-9]/g,'');
  let score = 0;
  const oe = (order.customerEmail||order.profile&&order.profile.email||'') || '';
  if(oe && String(oe).toLowerCase() === userEmail) score += 100;
  const oname = (order.customerName||'').toLowerCase();
  if(userName && oname && (oname.includes(userName) || userName.includes(oname))) score += 40;
  // match by email local-part
  const local = userEmail.split('@')[0];
  if(local && (oname.includes(local) || (order.customerEmail||'').toLowerCase().includes(local))) score += 25;
  // phone match
  const ophone = String(order.customerPhone||'').replace(/[^0-9]/g,'');
  if(userPhone && ophone && userPhone === ophone) score += 50;
  // status weighting: delivered orders more likely
  const status = String(order.status||'').toLowerCase();
  if(status.includes('deliver')) score += 10;
  if(status.includes('completed')) score += 10;
  return score;
}

async function run(email){
  const key = String(email).toLowerCase();
  const userSnap = await db.doc('users/' + key).get();
  if(!userSnap.exists){ console.error('No user doc at users/' + key); process.exit(2); }
  const user = userSnap.data() || {};

  console.log('Searching for candidate orders to attach to', key);
  // fetch all orders (data size small); for larger datasets, restrict by date/status
  const allOrdersSnap = await db.collection('orders').get();
  const candidates = [];
  for(const doc of allOrdersSnap.docs){
    const data = doc.data();
    const s = scoreOrderForUser(data, user);
    if(s >= 40){ // threshold; tuned to prefer strong matches
      candidates.push({ id: doc.id, score: s, data });
    }
  }
  candidates.sort((a,b)=>b.score - a.score);
  console.log('Found', candidates.length, 'candidate orders (score>=40)');
  for(const c of candidates){
    console.log(' -', c.id, 'score=', c.score, 'status=', c.data.status, 'customerEmail=', c.data.customerEmail||c.data.profile&&c.data.profile.email||'-', 'customerName=', c.data.customerName||'-');
  }

  if(candidates.length === 0){ console.log('No likely orders to attach.'); return; }

  // copy candidates into users/{email}/orders
  for(const c of candidates){
    const destRef = db.collection('users').doc(key).collection('orders').doc(c.id);
    await destRef.set(Object.assign({}, c.data, { attachedByFuzzy: true, attachedAt: admin.firestore.FieldValue.serverTimestamp() }), { merge: true });
    console.log('Attached order', c.id, '-> users/' + key + '/orders');
    // mark original order (non-destructive) with a note
    await db.collection('orders').doc(c.id).set({ possibleOwner: key, possibleOwnerScore: c.score }, { merge: true });
  }
}

if(process.argv.length < 3){ console.error('Usage: node tools/fuzzy-attach-orders.js someone@example.com'); process.exit(1); }
const email = process.argv[2];
run(email).then(()=>{ console.log('Done'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(3); });
