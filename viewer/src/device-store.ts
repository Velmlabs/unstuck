/** What a paired phone keeps in this browser: its id, its non-extractable private key and its Cloud token. */
export interface DeviceRecord {
  deviceId: string;
  privateKey: CryptoKey;
  deviceToken: string;
  /** The Cloud API this phone was paired with (records from before 0.1.6 have none: https://unstuck.sh). */
  apiBase?: string;
  /** The name it was paired as, for "already paired as …". */
  label?: string;
}

export interface DeviceStore {
  get(): Promise<DeviceRecord | null>;
  put(r: DeviceRecord): Promise<void>;
  clear(): Promise<void>;
}

const DB = 'unstuck-device';
const STORE = 'device';
const KEY = 'device';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => void req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** IndexedDB `unstuck-device`: one record per origin (clearing site data unpairs the phone). */
export function indexedDbDeviceStore(): DeviceStore {
  return {
    get: async () => ((await run<DeviceRecord | undefined>('readonly', (s) => s.get(KEY))) ?? null),
    put: async (r) => void (await run('readwrite', (s) => s.put(r, KEY))),
    clear: async () => void (await run('readwrite', (s) => s.delete(KEY))),
  };
}
