// Persistent storage layer (IndexedDB). Adapted from cork-grader-2/js/db.js:
// no referenceLibrary store -- v3's grading is a fixed formula, not trained
// from examples, so there's nothing to build a library of.

const DB_NAME = 'cork-grader-7';
const DB_VERSION = 1;

const STORE_LOG = 'dailyLog';
const STORE_SETTINGS = 'settings';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (evt) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LOG)) {
        const log = db.createObjectStore(STORE_LOG, { keyPath: 'id', autoIncrement: true });
        log.createIndex('dateKey', 'dateKey', { unique: false });
        log.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked (another tab holds an old version open)'));
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Daily log ----

export function dateKeyFor(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function addLogEntry({ grade, porosityPct, porePorosityPct, discolorationPct, weighted, top3Mm, numPores, diameterMm, videoW, videoH, sharpenLevel, timestamp }) {
  const ts = timestamp || Date.now();
  const store = await tx(STORE_LOG, 'readwrite');
  return wrap(store.add({
    dateKey: dateKeyFor(new Date(ts)),
    timestamp: ts,
    grade,
    porosityPct: porosityPct ?? null,
    top3Mm: top3Mm ?? null,
    numPores: numPores ?? null,
    diameterMm: diameterMm ?? null,
    // What produced this reading, so settings can be compared from the export alone.
    videoW: videoW ?? null,
    videoH: videoH ?? null,
    sharpenLevel: sharpenLevel ?? null,
    porePorosityPct: porePorosityPct ?? null,
    discolorationPct: discolorationPct ?? null,
    weighted: weighted ?? null,
  }));
}

export async function getLogForDate(dateKey) {
  const store = await tx(STORE_LOG, 'readonly');
  const idx = store.index('dateKey');
  return wrap(idx.getAll(IDBKeyRange.only(dateKey)));
}

export async function getAllLogEntries() {
  const store = await tx(STORE_LOG, 'readonly');
  return wrap(store.getAll());
}

export async function getAllLogDates() {
  const store = await tx(STORE_LOG, 'readonly');
  const all = await wrap(store.getAll());
  return [...new Set(all.map((e) => e.dateKey))].sort().reverse();
}

export async function deleteLogEntry(id) {
  const store = await tx(STORE_LOG, 'readwrite');
  return wrap(store.delete(id));
}

// ---- Settings (calibration region, session diameter, misc key/value) ----

export async function getSetting(key, fallback = null) {
  const store = await tx(STORE_SETTINGS, 'readonly');
  const result = await wrap(store.get(key));
  return result ? result.value : fallback;
}

export async function setSetting(key, value) {
  const store = await tx(STORE_SETTINGS, 'readwrite');
  return wrap(store.put({ key, value }));
}

// ---- Storage durability helpers ----

export async function requestPersistentStorage() {
  if (!(navigator.storage && navigator.storage.persist)) return { supported: false };
  const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  if (already) return { supported: true, persisted: true };
  const granted = await navigator.storage.persist();
  return { supported: true, persisted: granted };
}

export async function getStorageEstimate() {
  if (!(navigator.storage && navigator.storage.estimate)) return null;
  return navigator.storage.estimate();
}
