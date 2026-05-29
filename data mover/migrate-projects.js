// migrate-projects.js
// 1. Copies all documents from `projects` collection (source → target Firestore)
// 2. Downloads images from source Firebase Storage
// 3. Re-uploads them to target Firebase Storage
// 4. Rewrites the `photos` array in the target document with new URLs
//
// ENV FILES:
//   .env.source  — source (old) project credentials
//   .env.target  — target (new) project credentials + ADMIN_EMAIL + ADMIN_PASSWORD
//
// USAGE:
//   npm install
//   node migrate-projects.js

import { initializeApp }                                         from "firebase/app";
import { getFirestore, collection, getDocs, doc, setDoc }        from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL }          from "firebase/storage";
import { getAuth, signInWithEmailAndPassword }                    from "firebase/auth";
import dotenv                                                     from "dotenv";
import { resolve }                                               from "path";

// ─── Load env files ────────────────────────────────────────────────────────────

const sourceEnv = dotenv.config({ path: resolve(process.cwd(), ".env.source") }).parsed;
const targetEnv = dotenv.config({ path: resolve(process.cwd(), ".env.target") }).parsed;

function assertEnv(env, file, required) {
  const missing = required.filter(k => !env?.[k]);
  if (missing.length) {
    console.error(`❌ Missing keys in ${file}: ${missing.join(", ")}`);
    process.exit(1);
  }
}

assertEnv(sourceEnv, ".env.source", [
  "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_APP_ID",
]);

assertEnv(targetEnv, ".env.target", [
  "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_APP_ID",
  "ADMIN_EMAIL", "ADMIN_PASSWORD",
]);

function toFirebaseConfig(env) {
  return {
    apiKey:            env.VITE_FIREBASE_API_KEY,
    authDomain:        env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId:         env.VITE_FIREBASE_PROJECT_ID,
    storageBucket:     env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId:             env.VITE_FIREBASE_APP_ID,
  };
}

// ─── Init Firebase apps ────────────────────────────────────────────────────────

const sourceApp = initializeApp(toFirebaseConfig(sourceEnv), "source");
const targetApp = initializeApp(toFirebaseConfig(targetEnv), "target");

const sourceDb      = getFirestore(sourceApp);
const targetDb      = getFirestore(targetApp);
const targetStorage = getStorage(targetApp);
const targetAuth    = getAuth(targetApp);

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Given a Firebase Storage download URL, extract the object path.
 * e.g. "https://firebasestorage.googleapis.com/v0/b/<bucket>/o/projects%2Fabc%2Fimg.jpg?..."
 *   → "projects/abc/img.jpg"
 */
function extractStoragePath(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/o\/(.+)$/);
    if (!match) throw new Error("No /o/ segment found");
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Download a file from a public URL and return it as an ArrayBuffer.
 */
async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Guess a MIME type from a file extension.
 */
function guessMime(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}

// ─── Main migration ────────────────────────────────────────────────────────────

const COLLECTION = "projects";

async function migrate() {
  console.log("\n🔐 Signing in to target project as admin...");
  await signInWithEmailAndPassword(targetAuth, targetEnv.ADMIN_EMAIL, targetEnv.ADMIN_PASSWORD);
  console.log("   ✅ Signed in.\n");

  console.log(`🔄 Migrating "${COLLECTION}" collection...`);
  console.log(`   Source : ${sourceEnv.VITE_FIREBASE_PROJECT_ID}`);
  console.log(`   Target : ${targetEnv.VITE_FIREBASE_PROJECT_ID}\n`);

  const snapshot = await getDocs(collection(sourceDb, COLLECTION));

  if (snapshot.empty) {
    console.warn("⚠️  No documents found. Nothing to migrate.");
    return;
  }

  console.log(`📦 Found ${snapshot.size} document(s).\n`);

  let docSuccess = 0, docFail = 0;

  for (const sourceDoc of snapshot.docs) {
    const docId = sourceDoc.id;
    const data  = { ...sourceDoc.data() };

    console.log(`\n📄 Document: ${docId}  (${data.name ?? ""})`);

    // ── Rewrite photos array ────────────────────────────────────────────────
    if (Array.isArray(data.photos) && data.photos.length > 0) {
      console.log(`   📸 ${data.photos.length} photo(s) to migrate...`);
      const newPhotos = [];

      for (let i = 0; i < data.photos.length; i++) {
        const originalUrl = data.photos[i];
        const storagePath = extractStoragePath(originalUrl);

        if (!storagePath) {
          console.warn(`   ⚠️  [${i}] Could not parse storage path, keeping original URL.`);
          newPhotos.push(originalUrl);
          continue;
        }

        try {
          const buffer   = await downloadFile(originalUrl);
          const bytes    = new Uint8Array(buffer);
          const mimeType = guessMime(storagePath);

          // Upload to target at the same path so folder structure is preserved
          const targetRef = ref(targetStorage, storagePath);
          await uploadBytes(targetRef, bytes, { contentType: mimeType });

          const newUrl = await getDownloadURL(targetRef);
          newPhotos.push(newUrl);
          console.log(`   ✅ [${i}] ${storagePath}`);
        } catch (err) {
          console.error(`   ❌ [${i}] Image failed: ${err.message} — keeping original URL`);
          newPhotos.push(originalUrl); // fallback so doc isn't broken
        }
      }

      data.photos = newPhotos;
    } else {
      console.log("   (no photos field)");
    }

    // ── Write document to target Firestore ──────────────────────────────────
    try {
      await setDoc(doc(targetDb, COLLECTION, docId), data);
      console.log(`   ✅ Firestore document written.`);
      docSuccess++;
    } catch (err) {
      console.error(`   ❌ Firestore write failed: ${err.message}`);
      docFail++;
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`✔  Migration complete.`);
  console.log(`   Documents: ${docSuccess} succeeded, ${docFail} failed.`);
}

migrate().catch((err) => {
  console.error("\n💥 Fatal error:", err.message);
  process.exit(1);
});
