Setup notes — temporary development Firestore rules

This project includes a permissive `infra/firestore.rules` file you can apply to
your Firebase project for local development. These rules allow read/write access
to the `products` and `sales` collections so the admin UI (`inventory.html`) can
receive live updates without requiring extra auth plumbing.

IMPORTANT: These rules are insecure. Use them only for local testing and revert
them as soon as you have functioning authentication and proper role checks.

Options to apply the rules

1) Apply via the Firebase Console (quickest)
   - Open https://console.firebase.google.com/
   - Select your project (project id = `shoe-pao-special` if you're using the sample config)
   - Go to Firestore Database -> Rules
   - Replace rules with the contents of `infra/firestore.rules` and click Publish

2) Apply via Firebase CLI (recommended for repeatable dev workflows)
   - Install the Firebase CLI if you don't have it: `npm install -g firebase-tools`
   - Login: `firebase login`
   - Initialize rules in your project folder (if not already):

     firebase init firestore

   - Copy `infra/firestore.rules` into the `firestore.rules` file created by the init step
   - Deploy only rules:

     firebase deploy --only firestore:rules --project your-project-id

What to do next (secure rules)

Once you've verified the UI works with these dev rules, do one of the following:

- Replace permissive rules with auth-based rules that require `request.auth != null`.
- Add a `profiles/{uid}` document that stores a `role` or `isStaff` boolean and check it in rules.
- Use custom claims (set on the server-side) and check `request.auth.token.staff == true`.

Example secure rule (allow read/write for users with `staff` custom claim):

service cloud.firestore {
  match /databases/{database}/documents {
    match /products/{productId} {
      allow read: if true; // public reads are OK for storefront; change as needed
      allow write: if request.auth != null && request.auth.token.staff == true;
    }
    match /sales/{saleId} {
      allow read, write: if request.auth != null && request.auth.token.staff == true;
    }
  }
}

If you need help wiring auth (email/password sign-in, adding staff accounts, or
setting custom claims), tell me which provider you want and I will add the
client sign-in UI and example server-side steps to set custom claims.
