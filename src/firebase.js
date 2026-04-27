// Firebase initialization. The values below are the public client config —
// they identify the project but don't grant data access. Real security comes
// from Firestore security rules, configured in the Firebase console.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyBeF0B3h2yphkoxk5CSGmrNgboafb-zG6Y',
  authDomain: 'skyway-ops-app.firebaseapp.com',
  projectId: 'skyway-ops-app',
  storageBucket: 'skyway-ops-app.firebasestorage.app',
  messagingSenderId: '12464871520',
  appId: '1:12464871520:web:d637a1d986c09df5d2cb05',
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
