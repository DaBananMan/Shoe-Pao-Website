#!/usr/bin/env node
/**
 * cleanup-unverified.js
 *
 * Usage:
 *   node tools/cleanup-unverified.js /path/to/serviceAccountKey.json --projectId=your-project-id [--delete-auth] [--yes]
 *
 * This script will:
 *  - List Firebase Auth users
 *  - Identify users that are anonymous (no email) OR have emailVerified === false
 *  - For each such user, check for a Firestore document at `users/{uid}` and report it
 *  - If --delete-auth is provided, it will also delete the Auth user accounts (optional)
 *  - It will only perform deletions if --yes is provided as a safety guard
 *
 * IMPORTANT: Run in a controlled environment. Keep backups (export Firestore) before deleting.
 */

const fs = require('fs');
const path = require('path');

if (process.argv.length < 3) {
  console.error('Usage: node tools/cleanup-unverified.js /path/to/serviceAccountKey.json --projectId=PROJECT_ID [--delete-auth] [--yes]');
  process.exit(2);
}

const serviceAccountPath = process.argv[2];
const args = process.argv.slice(3);
const projectIdArg = args.find(a => a.startsWith('--projectId='));
const deleteAuth = args.includes('--delete-auth');
const doDelete = args.includes('--yes');

if (!projectIdArg) {
  console.error('Missing --projectId=PROJECT_ID'); process.exit(2);
}
const projectId = projectIdArg.split('=')[1];

if (!fs.existsSync(serviceAccountPath)) {
  console.error('Service account file not found at', serviceAccountPath);
  process.exit(2);
}

const admin = require('firebase-admin');

const serviceAccount = require(path.resolve(serviceAccountPath));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId
});

const auth = admin.auth();
const db = admin.firestore();

(async function main(){
  console.log('Listing users (paginated)...');
  let nextPageToken;
  const toDelete = [];
  do {
    const res = await auth.listUsers(1000, nextPageToken);
    for (const user of res.users) {
      const isAnonymous = !user.email && (!user.providerData || user.providerData.length === 0);
      const unverified = !!user.email && !user.emailVerified;
      if (isAnonymous || unverified) {
        // check if Firestore users doc exists
        const docRef = db.doc('users/' + user.uid);
        const docSnap = await docRef.get();
        toDelete.push({ uid: user.uid, email: user.email || null, isAnonymous, emailVerified: !!user.emailVerified, hasUserDoc: docSnap.exists });
      }
    }
    nextPageToken = res.pageToken;
  } while (nextPageToken);

  if (toDelete.length === 0) {
    console.log('No anonymous or unverified users found. Nothing to do.');
    process.exit(0);
  }

  console.log('\nFound', toDelete.length, 'accounts that are anonymous or unverified. Sample:');
  console.table(toDelete.slice(0, 20));

  if (!doDelete) {
    console.log('\nDry run mode. To actually delete the Firestore docs and/or Auth users, re-run with --yes (and optionally --delete-auth).');
    process.exit(0);
  }

  console.log('\nProceeding with deletion as requested...');

  for (const item of toDelete) {
    try {
      if (item.hasUserDoc) {
        console.log('Deleting users/' + item.uid);
        await db.doc('users/' + item.uid).delete();
      } else {
        console.log('No users/' + item.uid + ' doc to delete.');
      }
      if (deleteAuth) {
        console.log('Deleting Auth user', item.uid);
        await auth.deleteUser(item.uid);
      }
    } catch (err) {
      console.error('Failed to delete for', item.uid, err);
    }
  }

  console.log('Done.');
  process.exit(0);
})();
