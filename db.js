/**
 * Anil Plastics Hybrid Storage Engine (IndexedDB + Automatic localStorage Fallback) v09.1
 * Guarantees instant, non-hanging startup on Android Chrome, WebViews, file://, content://, and HTTPS.
 */
window.AnilDB = (function () {
  const DB_NAME = 'AnilPlasticsDB_v8';
  const DB_VER = 1;
  let dbPromise = null;
  let idbDisabled = false;
  const MEM_FALLBACK = { items: [], orders: [], tasks: [], taskQueue: [], pdfs: [], meta: [] };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function lsStoreKey(store) { return 'ap_ls_store_' + store; }

  function lsReadStore(store) {
    if (store === 'pdfs') return MEM_FALLBACK.pdfs;
    const raw = lsGet(lsStoreKey(store));
    if (!raw) return MEM_FALLBACK[store] || [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return MEM_FALLBACK[store] || [];
    }
  }

  function lsWriteStore(store, arr) {
    MEM_FALLBACK[store] = arr;
    if (store === 'pdfs') return true;
    // Strip search helper before saving to localStorage to stay compact
    const compact = store === 'items'
      ? arr.map((it) => ({
          _key: it._key,
          ItemName: it.ItemName,
          MfgCode: it.MfgCode,
          Barcode: it.Barcode,
          Pack: it.Pack,
          RawStock: it.RawStock,
          Reserved: it.Reserved,
          Stock: it.Stock,
          SaleRate: it.SaleRate
        }))
      : arr;
    return lsSet(lsStoreKey(store), JSON.stringify(compact));
  }

  function keyFieldOf(store) {
    if (store === 'items') return '_key';
    if (store === 'orders' || store === 'pdfs') return 'id';
    if (store === 'tasks') return 'orderId';
    if (store === 'taskQueue') return 'qid';
    return 'k';
  }

  function open() {
    if (idbDisabled || typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB unavailable'));
    }
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          idbDisabled = true;
          reject(new Error('IndexedDB open timeout'));
        }
      }, 1500);

      try {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: '_key' });
          if (!db.objectStoreNames.contains('orders')) db.createObjectStore('orders', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'orderId' });
          if (!db.objectStoreNames.contains('taskQueue')) db.createObjectStore('taskQueue', { keyPath: 'qid', autoIncrement: true });
          if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        };
        req.onsuccess = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(req.result);
          }
        };
        req.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            idbDisabled = true;
            reject(req.error || new Error('IndexedDB open error'));
          }
        };
        req.onblocked = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            idbDisabled = true;
            reject(new Error('IndexedDB blocked'));
          }
        };
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          idbDisabled = true;
          reject(err);
        }
      }
    });
    return dbPromise;
  }

  async function getAll(store) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return lsReadStore(store);
    }
  }

  async function putMany(store, arr, clearFirst) {
    // Always mirror small stores or fallback when IDB is disabled
    if (store !== 'items' || idbDisabled) {
      const kf = keyFieldOf(store);
      let base = clearFirst ? [] : lsReadStore(store);
      const map = new Map(base.map((x) => [x[kf], x]));
      for (const item of arr) {
        if (store === 'taskQueue' && item.qid == null) item.qid = Date.now() + Math.random();
        map.set(item[kf], item);
      }
      lsWriteStore(store, Array.from(map.values()));
    }
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        const s = t.objectStore(store);
        if (clearFirst) s.clear();
        for (const item of arr) s.put(item);
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
      });
    } catch (e) {
      if (store === 'items') {
        const kf = keyFieldOf(store);
        let base = clearFirst ? [] : lsReadStore(store);
        const map = new Map(base.map((x) => [x[kf], x]));
        for (const item of arr) map.set(item[kf], item);
        lsWriteStore(store, Array.from(map.values()));
      }
      return true;
    }
  }

  async function putOne(store, obj) {
    return putMany(store, [obj], false);
  }

  async function deleteOne(store, key) {
    const kf = keyFieldOf(store);
    const cur = lsReadStore(store).filter((x) => x[kf] !== key);
    lsWriteStore(store, cur);
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        t.objectStore(store).delete(key);
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
      });
    } catch (e) {
      return true;
    }
  }

  async function clearAll() {
    const stores = ['items', 'orders', 'tasks', 'taskQueue', 'meta'];
    stores.forEach((st) => {
      MEM_FALLBACK[st] = [];
      lsDel(lsStoreKey(st));
    });
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(stores, 'readwrite');
        stores.forEach((st) => t.objectStore(st).clear());
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
      });
    } catch (e) {
      return true;
    }
  }

  function makeItemKey(it) {
    const bc = String(it.Barcode || '').trim();
    const nm = String(it.ItemName || '').trim().toLowerCase();
    return bc ? (bc + '::' + nm) : ('NO_BC::' + nm);
  }

  async function migrateFromLegacyLocalStorage() {
    if (lsGet('ap_idb_migrated_v87')) return;

    // Migrate Ver 06 & Ver 07 URLs
    const oldUrl = lsGet('ap_webhook_v6') || lsGet('anil_webhook_url') || lsGet('webhookUrl');
    if (oldUrl && !lsGet('ap_webhook_url')) {
      lsSet('ap_webhook_url', oldUrl.trim());
    }

    // Migrate Ver 06 & Ver 07 items (including Ver 06 'master_items_data')
    const itemKeys = ['master_items_data', 'ap_items_v6', 'ap_items', 'anil_items', 'masterItems'];
    for (const k of itemKeys) {
      const raw = lsGet(k);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) {
            const norm = parsed.map((it) => {
              const obj = {
                ItemName: String(it.ItemName || it.name || ''),
                MfgCode: String(it.MfgCode || it.mfg || 'UNKNOWN'),
                Barcode: String(it.Barcode || it.barcode || ''),
                Pack: String(it.Pack || it.pack || 'PC'),
                Stock: Number(it.Stock != null ? it.Stock : (it.stock || 0)) || 0,
                SaleRate: Number(it.SaleRate != null ? it.SaleRate : (it.rate || 0)) || 0
              };
              obj._key = makeItemKey(obj);
              return obj;
            }).filter((x) => x.ItemName);
            if (norm.length) await putMany('items', norm, false);
          }
        } catch (e) {}
      }
    }

    // Migrate Ver 06 & Ver 07 orders (including Ver 06 'booked_orders_data')
    const orderKeys = ['booked_orders_data', 'ap_orders_v6', 'ap_orders', 'anil_orders', 'savedOrders'];
    for (const k of orderKeys) {
      const raw = lsGet(k);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) {
            const norm = parsed.map((o) => Object.assign({ status: o.synced ? 'Synced' : 'New' }, o)).filter((o) => o && o.id);
            if (norm.length) await putMany('orders', norm, false);
          }
        } catch (e) {}
      }
    }

    lsSet('ap_idb_migrated_v87', '1');
  }

  return {
    open, getAll, putMany, putOne, deleteOne, clearAll, makeItemKey, migrateFromLegacyLocalStorage
  };
})();
