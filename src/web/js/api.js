/** עטיפה דקה מעל fetch לכל קריאות ה-API. */

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error?.message || `שגיאה ${response.status}`;
    const error = new Error(message);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** בונה query string מאובייקט, תוך דילוג על ערכים ריקים. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export const api = {
  get: (path) => request('GET', path),
  del: (path) => request('DELETE', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),

  dashboard: (params) => request('GET', `/dashboard${qs(params)}`),
  report: (params) => request('GET', `/dashboard/report${qs(params)}`),
  alerts: (params) => request('GET', `/dashboard/alerts${qs(params)}`),
  resolveAlert: (id) => request('POST', `/dashboard/alerts/${id}/resolve`),

  collections: (params) => request('GET', `/collections${qs(params)}`),
  debtors: (params) => request('GET', `/collections/debtors${qs(params)}`),

  commitments: (params) => request('GET', `/commitments${qs(params)}`),
  commitment: (id) => request('GET', `/commitments/${id}`),
  createCommitment: (body) => request('POST', '/commitments', body),
  cancelCommitment: (id, reason) => request('POST', `/commitments/${id}/cancel`, { reason }),

  payments: (params) => request('GET', `/payments${qs(params)}`),
  recordPayment: (body) => request('POST', '/payments', body),
  assignPayment: (id, body) => request('POST', `/payments/${id}/assign`, body),

  incomes: (params) => request('GET', `/incomes${qs(params)}`),

  expenses: (params) => request('GET', `/expenses${qs(params)}`),
  expenseCategories: () => request('GET', '/expenses/categories'),
  budget: (params) => request('GET', `/expenses/budget${qs(params)}`),
  updateCategoryBudget: (id, body) => request('PATCH', `/expenses/categories/${id}`, body),
  createExpense: (body) => request('POST', '/expenses', body),
  updateExpense: (id, body) => request('PATCH', `/expenses/${id}`, body),
  deleteExpense: (id) => request('DELETE', `/expenses/${id}`),
  scanInvoice: (file) => request('POST', '/expenses/scan-invoice', file),
  attachInvoice: (id, file) => request('POST', `/expenses/${id}/attachments`, file),

  receipts: (params) => request('GET', `/receipts${qs(params)}`),
  retryReceipt: (id) => request('POST', `/receipts/${id}/retry`),
  retryAllReceipts: (organizationId) => request('POST', '/receipts/retry-all', { organizationId }),
  approveReceipt: (id) => request('POST', `/receipts/${id}/approve`),
  cancelReceipt: (id, reason) => request('POST', `/receipts/${id}/cancel`, { reason }),

  members: (params) => request('GET', `/members${qs(params)}`),
  memberCard: (id, params) => request('GET', `/members/${id}/card${qs(params)}`),
  createMember: (body) => request('POST', '/members', body),

  organizations: () => request('GET', '/organizations'),
  updateOrganization: (id, body) => request('PATCH', `/organizations/${id}`, body),

  standingOrders: (params) => request('GET', `/standing-orders${qs(params)}`),
  chargeStandingOrder: (id) => request('POST', `/standing-orders/${id}/charge`),

  seats: (params) => request('GET', `/seats${qs(params)}`),
  createSeatCommitment: (body) => request('POST', '/seats', body),
  updateSeatPlan: (id, body) => request('PATCH', `/seats/${id}`, body),

  notifications: (params) => request('GET', `/notifications${qs(params)}`),
  sendDebtReminder: (body) => request('POST', '/notifications/debt-reminder', body),
  sendDebtRemindersBulk: (body) => request('POST', '/notifications/debt-reminders/bulk', body),

  lookups: () => request('GET', '/lookups'),
  commitmentTypes: () => request('GET', '/commitment-types'),
  events: (params) => request('GET', `/events${qs(params)}`),
};
