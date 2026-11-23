/**
 * Anil Plastics API Adapter (v12.0)
 * Self-healing URL discovery (?url= param, ap_webhook_url, anil_webhook_url) & safe JSON parsing.
 */
window.AnilApi = (function () {
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // Allow sharing a pre-configured link like index.html?url=https://script.google.com/macros/s/.../exec
  try {
    const qp = new URLSearchParams(window.location.search);
    const sharedUrl = qp.get('url') || qp.get('server') || qp.get('webhook');
    if (sharedUrl && /^https:\/\/script\.google\.com\//i.test(sharedUrl.trim())) {
      lsSet('ap_webhook_url', sharedUrl.trim());
    }
  } catch (e) {}

  function getConfig() {
    let user = null;
    try {
      user = JSON.parse(lsGet('ap_user_profile') || 'null');
    } catch (e) {
      user = null;
      lsDel('ap_user_profile');
    }
    const url = (
      lsGet('ap_webhook_url') ||
      lsGet('anil_webhook_url') ||
      lsGet('ap_webhook_v6') ||
      lsGet('webhookUrl') ||
      ''
    ).trim();
    return {
      url,
      token: (lsGet('ap_user_token') || '').trim(),
      user
    };
  }

  function setUrl(url) {
    const clean = String(url || '').trim();
    lsSet('ap_webhook_url', clean);
    if (clean) lsSet('anil_webhook_url', clean);
  }

  function setSession(userObj) {
    if (!userObj) {
      lsDel('ap_user_token');
      lsDel('ap_user_profile');
      return;
    }
    lsSet('ap_user_token', userObj.token || '');
    lsSet('ap_user_profile', JSON.stringify(userObj));
  }

  async function post(action, payload) {
    const cfg = getConfig();
    if (!cfg.url) throw new Error('Server URL not configured. Paste your Apps Script /exec URL.');
    const body = Object.assign({}, payload || {}, { action });
    if (action !== 'login' && cfg.token && !body.token) body.token = cfg.token;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 25000) : null;

    let res;
    try {
      res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Server timed out (25s). Check internet connection.');
      }
      throw new Error('Network error: ' + (err && err.message ? err.message : 'Cannot reach server'));
    } finally {
      if (timer) clearTimeout(timer);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Invalid server response (check /exec URL & deployment access): ' + text.slice(0, 100));
    }
    if (data && data.authError) {
      window.dispatchEvent(new CustomEvent('ap:auth-expired', { detail: data.message }));
    }
    return data;
  }

  return {
    getConfig,
    setUrl,
    setSession,
    login: (name, pin) => post('login', { name, pin, client: 'phone' }),
    info: () => post('info', {}),
    parties: () => post('parties', {}),
    fetchStockFeed: (version) => post('stockFeed', { version: version || '' }),
    syncOrders: (salesmanName, orders) => post('syncOrders', { salesmanName, orders }),
    myOrders: (ids, from) => post('myOrders', { ids: ids || [], from: from || '' }),
    myTasks: () => post('myTasks', {}),
    taskStart: (orderId, taskId) => post('taskStart', { orderId, taskId: taskId || orderId }),
    taskItemResult: (orderId, itemNo, resultStatus, fulfilledQty, reason) =>
      post('taskItemResult', { orderId, itemNo, resultStatus, fulfilledQty, reason }),
    taskComplete: (orderId, items, taskId, note) =>
      post('taskComplete', { orderId, taskId: taskId || orderId, items: items || [], note: note || '' }),
    // Owner Command Center endpoints (server-enforced Owner-only / Admin-or-Owner)
    ownerDashboard: () => post('ownerDashboard', {}),
    orderEvents: (orderId) => post('orderEvents', { orderId }),
    releaseOrder: (orderId, assignedTo, assignedName, priority, dueTime) =>
      post('releaseOrder', { orderId, assignedTo, assignedName, priority, dueTime }),
    reassign: (orderId, assignedTo, assignedName, priority, dueTime) =>
      post('reassign', { orderId, assignedTo, assignedName, priority, dueTime }),
    setStatus: (ids, status, extra) => post('setStatus', Object.assign({ ids, status }, extra || {})),
    updateDispatchNote: (orderId, transportNote) => post('updateDispatchNote', { orderId, transportNote }),
    cancelOrder: (orderId, reason) => post('cancelOrder', { orderId, reason }),
    deleteOrder: (orderId) => post('deleteOrder', { orderId }),
    createCustomTask: (payload) => post('createCustomTask', payload),
    getMfgMaster: () => post('getMfgMaster', {}),
    uploadStockAudit: (items) => post('uploadStockAudit', { items: items || [] }),
    // Physical Inventory Audit Module Endpoints (Ver 12.0)
    auditMyPackage: (sessionId) => post('auditMyPackage', { sessionId: sessionId || '' }),
    auditSyncCounts: (sessionId, deviceBatchID, counts) => post('auditSyncCounts', { sessionId: sessionId || '', deviceBatchID, counts: counts || [] }),
    auditTaskStatus: (taskId, status) => post('auditTaskStatus', { taskId, status }),
    auditPulse: (sessionId) => post('auditPulse', { sessionId: sessionId || '' }),
    auditVerifyCount: (payload) => post('auditVerifyCount', payload),
    auditSaveConversion: (payload) => post('auditSaveConversion', payload),
    auditResolveException: (exceptionId, resolutionNote) => post('auditResolveException', { exceptionId, resolutionNote }),
    systemDiagnostics: () => post('systemDiagnostics', {})
  };
})();
