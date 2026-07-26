/* ============================================================
   firebase-config.example.js

   Copy this to firebase-config.js and paste in your own values from
   the Firebase console: Project settings → General → Your apps →
   SDK setup and configuration → Config.

   These values are NOT secrets. Firebase web config is meant to ship
   in the client — it identifies your project, it doesn't authorize
   access. Your security comes from firestore.rules plus Authentication.
   That said, add firebase-config.js to .gitignore anyway if you'd
   rather not advertise your project ID in a public repo.
   ============================================================ */

export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:abcdef1234567890',
};
