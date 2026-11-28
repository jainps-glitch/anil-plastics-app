/**
 * Anil Plastics Hybrid Storage Engine (IndexedDB + Compact localStorage Fallback) v13.0
 * - 5000ms IndexedDB startup tolerance for budget Android devices with 15,000+ SKUs
 * - Compact tuple serialization if localStorage fallback is ever triggered
 * - Built-in storage health & diagnostics reporter
 */
window.AnilDB = (function () {
  const DB_NAME = 'AnilPlasticsDB_v8';
  const DB_VER = 2;
  let dbPromise = null;
  let idbDisabled = false;
  let lastQuotaWarning = '';
  const MEM_FALLBACK = { items: [], orders: [], tasks: [], taskQueue: [], pdfs: [], meta: [], auditTasks: [], auditItems: [], auditCounts: [] };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try {
      localStorage.setItem(k, v);
      lastQuotaWarning = '';
      return true;
    } catch (e) {
      lastQuotaWarning = 'Phone browser storage quota full (' + (e && e.message ? e.message : 'QuotaExceeded') + ').';
      return false;
    }
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function lsStoreKey(store) { return 'ap_ls_store_' + store; }

  function lsReadStore(store) {
    if (store === 'pdfs') return MEM_FALLBACK.pdfs;
    const raw = lsGet(lsStoreKey(store));
    if (!raw) return MEM_FALLBACK[store] || [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return MEM_FALLBACK[store] || [];
      if (store === 'items' && arr.length && Array.isArray(arr[0])) {
        return arr.map((t) => ({
          ItemName: t[0] || '',
          MfgCode: t[1] || 'UNKNOWN',
          Barcode: t[2] || '',
          Pack: t[3] || 'PC',
          RawStock: Number(t[4]) || 0,
          Reserved: Number(t[5]) || 0,
          Stock: Number(t[6]) || 0,
          SaleRate: Number(t[7]) || 0,
          _key: t[8] || makeItemKey({ Barcode: t[2], ItemName: t[0] })
        }));
      }
      return arr;
    } catch (e) {
      return MEM_FALLBACK[store] || [];
    }
  }

  function lsWriteStore(store, arr) {
    MEM_FALLBACK[store] = arr;
    if (store === 'pdfs') return true;
    const compact = store === 'items'
      ? arr.map((it) => [
          it.ItemName || '',
          it.MfgCode || '',
          it.Barcode || '',
          it.Pack || 'PC',
          Number(it.RawStock) || 0,
          Number(it.Reserved) || 0,
          Number(it.Stock) || 0,
          Number(it.SaleRate) || 0,
          it._key || ''
        ])
      : arr;
    return lsSet(lsStoreKey(store), JSON.stringify(compact));
  }

  function keyFieldOf(store) {
    if (store === 'items' || store === 'auditItems') return '_key';
    if (store === 'auditTasks') return 'taskId';
    if (store === 'auditCounts') return 'countId';
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
      }, 5000);

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
          if (!db.objectStoreNames.contains('auditTasks')) db.createObjectStore('auditTasks', { keyPath: 'taskId' });
          if (!db.objectStoreNames.contains('auditItems')) db.createObjectStore('auditItems', { keyPath: '_key' });
          if (!db.objectStoreNames.contains('auditCounts')) db.createObjectStore('auditCounts', { keyPath: 'countId' });
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
    const stores = ['items', 'orders', 'tasks', 'taskQueue', 'meta', 'auditTasks', 'auditItems', 'auditCounts'];
    stores.forEach((st) => {
      MEM_FALLBACK[st] = [];
      lsDel(lsStoreKey(st));
    });
    lastQuotaWarning = '';
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

    const oldUrl = lsGet('ap_webhook_v6') || lsGet('anil_webhook_url') || lsGet('webhookUrl');
    if (oldUrl && !lsGet('ap_webhook_url')) {
      lsSet('ap_webhook_url', oldUrl.trim());
    }

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

  async function getDiagnostics() {
    const stores = ['items', 'orders', 'tasks', 'taskQueue', 'auditTasks', 'auditItems', 'auditCounts'];
    const counts = {};
    for (const s of stores) {
      try { counts[s] = (await getAll(s)).length; } catch (e) { counts[s] = -1; }
    }
    return {
      engine: idbDisabled ? 'localStorage Fallback' : 'IndexedDB (Primary)',
      quotaWarning: lastQuotaWarning || 'OK',
      counts
    };
  }

  return {
    open, getAll, putMany, putOne, deleteOne, clearAll, makeItemKey, migrateFromLegacyLocalStorage, getDiagnostics
  };
})();
