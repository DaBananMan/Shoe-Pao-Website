Cleanup unverified / anonymous accounts

This project includes a helper script to identify and (optionally) delete Firestore `users/{uid}` documents and corresponding Firebase Auth user accounts that are either anonymous or have not verified their email.

Prerequisites
- Node.js (14+)
- npm
- Service account JSON for your Firebase project (generate from Firebase Console -> Project Settings -> Service accounts)

Install deps (in project root):

```powershell
npm install firebase-admin
```

Run a dry-run (no deletions):

```powershell
node tools/cleanup-unverified.js C:\path\to\serviceAccountKey.json --projectId=your-project-id
```

To actually delete Firestore user docs, pass --yes:

```powershell
node tools/cleanup-unverified.js C:\path\to\serviceAccountKey.json --projectId=your-project-id --yes
```

To also delete the corresponding Firebase Auth user accounts (be careful), add --delete-auth:

```powershell
node tools/cleanup-unverified.js C:\path\to\serviceAccountKey.json --projectId=your-project-id --delete-auth --yes
```

Safety notes
- This script is destructive when run with --yes. Make a Firestore export/backup before deleting if needed.
- It deletes only accounts that are anonymous (no email) or have emailVerified === false.
- You should audit the list printed by the script before running with --yes.
