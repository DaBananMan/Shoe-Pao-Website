#!/usr/bin/env node
/*
  Migration helper: merge alias (encoded-email) documents and any remaining `users` docs
  into canonical `accounts/{uid}` documents.

  Usage:
    node tools/migrate-accounts-merge.js            # dry-run (no writes)
    node tools/migrate-accounts-merge.js --apply    # perform writes/merges
    node tools/migrate-accounts-merge.js --apply --delete-aliases  # also delete alias docs

  Requirements: service-account.json in project root or ADC configured.
*/

const fs = require('fs');
const path = require('path');

async function main(){
  const admin = require('firebase-admin');
  const saPath = path.join(__dirname, '..', 'service-account.json');
  try{
    if (fs.existsSync(saPath)){
      const sa = require(saPath);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('Initialized firebase-admin from service-account.json');
    } else {
      admin.initializeApp();
      console.log('Initialized firebase-admin using ADC');
    }
  }catch(e){ console.error('Failed to init firebase-admin', e); process.exit(1); }

  const db = admin.firestore();
  const dryRun = !process.argv.includes('--apply');
  const deleteAliases = process.argv.includes('--delete-aliases');

  console.log('Migration starting. dryRun=%s, deleteAliases=%s', dryRun, deleteAliases);

  // Fetch all accounts docs
  const accountsSnap = await db.collection('accounts').get();
  const emailAliasDocs = [];
  const uidDocs = {};

  accountsSnap.forEach(doc => {
    const id = doc.id;
    const data = doc.data() || {};
    let decoded = null;
    try{ decoded = decodeURIComponent(id); }catch(e){}
    if (decoded && decoded.indexOf('@') !== -1){
      emailAliasDocs.push({ id, email: decoded.toLowerCase(), data });
    } else {
      uidDocs[id] = data;
    }
  });

  console.log('Found %d uid docs and %d encoded-email alias docs in accounts collection', Object.keys(uidDocs).length, emailAliasDocs.length);

  // Merge alias docs into uid docs
  for (const alias of emailAliasDocs){
    const { id, email, data } = alias;
    let targetUid = (data && data.uid) ? data.uid : null;
    if(!targetUid){
      try{
        const u = await admin.auth().getUserByEmail(email);
        targetUid = u.uid;
      }catch(e){ /* ignore */ }
    }

    if(!targetUid){
      console.log('[skip] alias %s -> no uid found for email %s', id, email);
      continue;
    }

    console.log('[merge] alias %s -> accounts/%s', id, targetUid);
    if(!dryRun){
      // Whitelist fields to merge
      const allowedKeys = ['phone','deliveryAddress','addresses','name','displayName','addressMain','addressDetails','email','emailVerified','createdAt'];
      const mergeData = {};
      for(const k of allowedKeys){ if(data && typeof data[k] !== 'undefined') mergeData[k] = data[k]; }
      // Ensure uid/email present on canonical doc
      mergeData.uid = targetUid;
      if(!mergeData.email) mergeData.email = email;

      await db.collection('accounts').doc(targetUid).set(mergeData, { merge: true });
      if(deleteAliases){
        try{ await db.collection('accounts').doc(id).delete(); console.log('[delete] removed alias doc accounts/%s', id); }catch(e){ console.warn('Failed to delete alias doc', id, e); }
      }
    }
  }

  // If a `users` collection exists, merge those too (legacy)
  const usersRef = db.collection('users');
  let usersExist = false;
  try{ const uTest = await usersRef.limit(1).get(); usersExist = !uTest.empty; }catch(e){ usersExist = false; }

  if(usersExist){
    console.log('Found legacy `users` collection — merging documents into accounts');
    const allUsers = await usersRef.get();
    for(const doc of allUsers.docs){
      const uid = doc.id;
      const data = doc.data() || {};
      const email = (data.email || '').toString().toLowerCase() || null;
      let targetUid = uid || (data && data.uid) || null;
      if(!targetUid && email){
        try{ const u = await admin.auth().getUserByEmail(email); targetUid = u.uid; }catch(e){}
      }
      if(!targetUid){ console.log('[skip user] users/%s — no uid/email to map', doc.id); continue; }
      console.log('[merge user] users/%s -> accounts/%s', doc.id, targetUid);
      if(!dryRun){
        const allowedKeys = ['phone','deliveryAddress','addresses','name','displayName','addressMain','addressDetails','email','emailVerified','createdAt'];
        const mergeData = {};
        for(const k of allowedKeys){ if(typeof data[k] !== 'undefined') mergeData[k] = data[k]; }
        mergeData.uid = targetUid;
        if(email && !mergeData.email) mergeData.email = email;
        await db.collection('accounts').doc(targetUid).set(mergeData, { merge: true });
        if(deleteAliases){ try{ await usersRef.doc(doc.id).delete(); console.log('[delete] removed users/%s', doc.id); }catch(e){ console.warn('Failed to delete users doc', doc.id, e); } }
      }
    }
  } else {
    console.log('No legacy `users` collection found.');
  }

  console.log('Migration complete. dryRun=%s. To apply changes rerun with --apply. To delete alias docs add --delete-aliases.', dryRun);
  process.exit(0);
}

main().catch(err=>{ console.error('Migration failed', err); process.exit(2); });
