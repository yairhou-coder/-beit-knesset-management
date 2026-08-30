/** הגדרות עמותות וישויות משפטיות (סעיפים 25, 26, 29). */

import { api } from '../api.js';
import { badge, esc } from '../format.js';
import { field, openModal, section, selectOptions, table, toast } from '../ui.js';
import { label, state } from '../state.js';

export async function renderOrganizations() {
  const response = await api.organizations();

  const rows = table(
    [
      { header: 'שם העמותה', cell: (row) => `<strong>${esc(row.name)}</strong>` },
      { header: 'מספר עמותה / ח.פ.', cell: (row) => esc(row.legalNumber ?? '—') },
      {
        header: 'פרטי חשבון',
        cell: (row) =>
          row.bank.account
            ? `<span class="small">${esc(row.bank.name ?? '')} · סניף ${esc(row.bank.branch ?? '')} · חשבון ${esc(row.bank.account)}</span>`
            : '<span class="muted">—</span>',
      },
      { header: 'מערכת סליקה', cell: (row) => esc(row.integrations.payment.provider) },
      { header: 'מערכת קבלות', cell: (row) => esc(row.integrations.receipt.provider) },
      { header: 'מערכת הודעות', cell: (row) => esc(row.integrations.notification.provider) },
      {
        header: 'סוגי מסמכים',
        cell: (row) =>
          row.allowedDocumentTypes
            .map((type) => `<span class="badge neutral">${esc(label('documentTypes', type))}</span>`)
            .join(' '),
      },
      {
        header: 'הפקת קבלות',
        cell: (row) =>
          badge(
            label('receiptIssueModes', row.receiptIssueMode),
            row.receiptIssueMode === 'automatic' ? 'positive' : 'warning',
          ),
      },
      { header: '', cell: (row) => `<button class="btn small" data-edit="${row.id}">עריכה</button>` },
    ],
    response.items,
    'לא הוגדרו עמותות',
  );

  return section('עמותות וישויות משפטיות', rows, {
    hint: 'לכל עמותה הגדרות Integration נפרדות. אין ערבוב בין הנתונים הכספיים.',
    flush: true,
  });
}

export function bindOrganizations(root, reload) {
  root.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.edit);
      const response = await api.get(`/organizations/${id}`);
      openOrganizationModal(response.organization, reload);
    });
  });
}

function openOrganizationModal(org, onDone) {
  const documentTypes = Object.entries(state.lookups.documentTypes ?? {});
  const issueModes = Object.entries(state.lookups.receiptIssueModes ?? {}).map(([value, text]) => ({
    value,
    label: text,
  }));

  const checkboxes = documentTypes
    .map(
      ([value, text]) => `
      <label class="small" style="display:flex;align-items:center;gap:6px;font-weight:400">
        <input type="checkbox" name="documentType" value="${esc(value)}" style="width:auto"
          ${org.allowedDocumentTypes.includes(value) ? 'checked' : ''} />
        ${esc(text)}
      </label>`,
    )
    .join('');

  openModal({
    title: `הגדרות - ${org.name}`,
    bodyHtml: `
      <div class="form-grid">
        ${field('שם העמותה', `<input type="text" name="name" value="${esc(org.name)}" required />`)}
        ${field('מספר עמותה / ח.פ.', `<input type="text" name="legalNumber" value="${esc(org.legalNumber ?? '')}" />`)}
        ${field('בנק', `<input type="text" name="bankName" value="${esc(org.bank.name ?? '')}" />`)}
        ${field('סניף', `<input type="text" name="bankBranch" value="${esc(org.bank.branch ?? '')}" />`)}
        ${field('מספר חשבון', `<input type="text" name="bankAccount" value="${esc(org.bank.account ?? '')}" />`)}
        ${field('בעל החשבון', `<input type="text" name="accountHolder" value="${esc(org.bank.holder ?? '')}" />`)}
        ${field('מערכת סליקה', `<input type="text" name="paymentProvider" value="${esc(org.integrations.payment.provider)}" />`)}
        ${field('מערכת הפקת קבלות', `<input type="text" name="receiptProvider" value="${esc(org.integrations.receipt.provider)}" />`)}
        ${field('מערכת הודעות', `<input type="text" name="notificationProvider" value="${esc(org.integrations.notification.provider)}" />`)}
        ${field(
          'אופן הפקת קבלות',
          `<select name="receiptIssueMode">${selectOptions(issueModes, org.receiptIssueMode)}</select>`,
        )}
        <div class="field full">
          <label>סוגי מסמכים שהעמותה רשאית להפיק</label>
          <div style="display:flex;flex-wrap:wrap;gap:12px;padding-top:4px">${checkboxes}</div>
        </div>
      </div>
      <p class="small muted full">
        פרטי ה-API של כל ספק נשמרים בנפרד לכל עמותה ואינם מוצגים כאן.
        חיבור ספק חדש נעשה ברישום ה-Provider בקוד, ללא שינוי בלוגיקת המערכת.
      </p>`,
    submitLabel: 'שמירת ההגדרות',
    onSubmit: async (formData) => {
      const allowedDocumentTypes = formData.getAll('documentType');
      if (allowedDocumentTypes.length === 0) {
        throw new Error('יש לבחור לפחות סוג מסמך אחד');
      }
      await api.updateOrganization(org.id, {
        name: formData.get('name'),
        legalNumber: formData.get('legalNumber'),
        bankName: formData.get('bankName'),
        bankBranch: formData.get('bankBranch'),
        bankAccount: formData.get('bankAccount'),
        accountHolder: formData.get('accountHolder'),
        paymentProvider: formData.get('paymentProvider'),
        receiptProvider: formData.get('receiptProvider'),
        notificationProvider: formData.get('notificationProvider'),
        receiptIssueMode: formData.get('receiptIssueMode'),
        allowedDocumentTypes,
      });
      toast('ההגדרות נשמרו', 'success');
      onDone?.();
    },
  });
}
