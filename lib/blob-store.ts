/**
 * Keeps the original notation files (Guitar Pro, MusicXML) in IndexedDB.
 *
 * The converted chart goes to localStorage with everything else, but the file itself
 * stays too: alphaTab draws the notation from the file, not from the chart, and a
 * 100 KB binary encoded into localStorage's 5 MB string budget would crowd out charts.
 * IndexedDB stores bytes as bytes and has far more room.
 *
 * Keyed by chart id, so a chart and its file are found together and deleted together.
 */

const DB_NAME = "jammer";
const STORE = "scores";

export interface StoredScore {
  chartId: string;
  name: string;
  bytes: ArrayBuffer;
  savedAt: string;
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "chartId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    // Private browsing on some phones refuses IndexedDB. The file then just isn't
    // remembered; everything else still works.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}

export async function saveScoreFile(
  chartId: string,
  name: string,
  bytes: ArrayBuffer,
): Promise<boolean> {
  const record: StoredScore = {
    chartId,
    name,
    bytes: bytes.slice(0),
    savedAt: new Date().toISOString(),
  };
  const ok = await run<IDBValidKey>("readwrite", (s) => s.put(record));
  return ok !== null;
}

export async function loadScoreFile(chartId: string): Promise<StoredScore | null> {
  return run<StoredScore>("readonly", (s) => s.get(chartId));
}

export async function deleteScoreFile(chartId: string): Promise<void> {
  await run("readwrite", (s) => s.delete(chartId));
}
