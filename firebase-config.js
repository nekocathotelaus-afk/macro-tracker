// Firebase project config for Macro Tracker.
//
// These values are NOT secrets — Firebase's own docs confirm this config is
// safe to be public in client-side code. Real security (if ever needed) comes
// from Firestore Security Rules, not from hiding these values. Do not confuse
// this with the Gemini API key (api-backend/), which IS a secret and must
// never appear in this repo.
const firebaseConfig = {
  apiKey: "AIzaSyB1qdUokUC7cwuY_K0_J_65vpEUlVKlzh8",
  authDomain: "macrotracker-bf180.firebaseapp.com",
  projectId: "macrotracker-bf180",
  storageBucket: "macrotracker-bf180.firebasestorage.app",
  messagingSenderId: "272333179919",
  appId: "1:272333179919:web:8a3991405e42a33b19e77a",
  measurementId: "G-SRWKHP12SC",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
