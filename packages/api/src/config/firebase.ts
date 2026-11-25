import admin from 'firebase-admin';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { resolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../../');

export type FirebaseStatus =
  | { ok: true }
  | { ok: false; error: string };

let firebaseApp: admin.app.App | undefined;
let firebaseError: Error | undefined;

function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, '\n').trim();
  if (!key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('FIREBASE_PRIVATE_KEY must be the service account private key, including the BEGIN PRIVATE KEY line. In Vercel, keep the line breaks as \\n.');
  }
  return key;
}

function initFirebase(): admin.app.App {
  if (admin.apps.length > 0) return admin.app() as admin.app.App;

  let credential: admin.credential.Credential | undefined;
  let projectId: string | undefined;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (credPath) {
    const name = credPath.replace(/^\.\//, '');
    const candidates = [
      credPath.startsWith('/') || /^[A-Za-z]:/.test(credPath) ? credPath : null,
      resolve(process.cwd(), credPath),
      resolve(repoRoot, name),
      resolve(process.cwd(), '..', name),
      resolve(process.cwd(), '..', '..', name),
    ].filter(Boolean) as string[];
    const jsonPath = candidates.find((p) => existsSync(p));
    if (jsonPath) {
      credential = admin.credential.cert(jsonPath);
      try {
        const key = JSON.parse(readFileSync(jsonPath, 'utf8')) as { project_id?: string };
        projectId = key.project_id;
      } catch {
        // The certificate file is still usable without a parsed project id.
      }
    }
  }

  if (!credential) {
    projectId =
      process.env.FIREBASE_PROJECT_ID ??
      process.env.GOOGLE_PROJECT_ID ??
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
    const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKeyRaw) {
      throw new Error(
        'Firebase is not configured. In the Vercel API project, set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY, then redeploy.'
      );
    }
    let privateKey: string;
    try {
      privateKey = normalizePrivateKey(privateKeyRaw);
    } catch (error) {
      throw error instanceof Error ? error : new Error('FIREBASE_PRIVATE_KEY is invalid.');
    }
    try {
      credential = admin.credential.cert({ projectId, clientEmail, privateKey });
    } catch {
      throw new Error('FIREBASE_PRIVATE_KEY could not be read. Paste the service account private key and keep its line breaks as \\n.');
    }
  }

  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET ??
    (projectId ? `${projectId}.appspot.com` : undefined);

  return admin.initializeApp({
    credential,
    storageBucket,
  });
}

export function getFirebaseApp(): admin.app.App {
  if (firebaseApp) return firebaseApp;
  if (firebaseError) throw firebaseError;
  try {
    firebaseApp = initFirebase();
    return firebaseApp;
  } catch (error) {
    firebaseError = error instanceof Error ? error : new Error('Firebase failed to start.');
    throw firebaseError;
  }
}

export function getFirebaseStatus(): FirebaseStatus {
  try {
    getFirebaseApp();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Firebase failed to start.' };
  }
}

function lazyService<T extends object>(factory: () => T): T {
  let value: T | undefined;
  return new Proxy({} as T, {
    get(_target, property) {
      if (!value) value = factory();
      const current = value[property as keyof T];
      return typeof current === 'function' ? (current as (...args: unknown[]) => unknown).bind(value) : current;
    },
  });
}

export const auth: Auth = lazyService(() => admin.auth(getFirebaseApp()));
export const db: Firestore = lazyService(() => admin.firestore(getFirebaseApp()));

export function getStorageBucket(): ReturnType<admin.storage.Storage['bucket']> | null {
  try {
    const app = getFirebaseApp();
    return app.options.storageBucket ? admin.storage(app).bucket(app.options.storageBucket) : null;
  } catch {
    return null;
  }
}
