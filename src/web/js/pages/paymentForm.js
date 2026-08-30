/**
 * טפסים לרישום התחייבות ותשלום.
 * רישום תשלום הוא הצומת של סעיף 27: מעדכן יתרה, רושם הכנסה ומפיק קבלה.
 */

import { api } from '../api.js';
import { esc, money } from '../format.js';
import { field, openModal, selectOptions, toast } from '../ui.js';
import {
  commitmentTypeOptions,
  eventOptions,
  label,
  memberOptions,
  organizationOptions,
  state,
} from '../state.js';

function methodOptions() {
  return Object.entries(state.lookups.paymentMethods ?? {}).map(([value, text]) => ({
    value,
    label: text,
  }));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** רישום תשלום עבור התחייבות קיימת, או תשלום עצמאי. */
export async function openPaymentModal({ commitmentId, memberId, onDone }) {
  let commitment = null;
  if (commitmentId) {
    const response = await api.commitment(commitmentId);
    commitment = response.commitment;
  }

  const context = commitment
    ? `<div class="section-body" style="padding:0">
         <dl class="kv">
           <dt>חבר</dt><dd>${esc(commitment.member.name)}</dd>
           <dt>התחייבות</dt><dd>${esc(commitment.type.name)} · ${money(commitment.amountAgorot)}</dd>
           <dt>שולם עד כה</dt><dd>${money(commitment.paidAgorot)}</dd>
           <dt>יתרה לתשלום</dt><dd><strong>${money(commitment.balanceAgorot)}</strong></dd>
           <dt>עמותה</dt><dd>${esc(commitment.organization.name)}</dd>
         </dl>
       </div>`
    : '';

  const bodyHtml = `
    ${context ? `<div class="full">${context}</div>` : ''}
    <div class="form-grid">
      ${
        commitment
          ? ''
          : `${field('חבר', `<select name="memberId">${selectOptions(memberOptions(), memberId, { placeholder: 'ללא שיוך לחבר' })}</select>`)}
             ${field('עמותה', `<select name="organizationId" required>${selectOptions(organizationOptions(), state.organizationId)}</select>`)}`
      }
      ${field(
        'סכום התשלום (₪)',
        `<input type="number" name="amountShekels" min="0.01" step="0.01" required
                value="${commitment ? commitment.balanceAgorot / 100 : ''}" />`,
        { className: commitment ? '' : 'full' },
      )}
      ${field('תאריך התשלום', `<input type="date" name="paymentDate" value="${todayIso()}" required />`)}
      ${field('אמצעי תשלום', `<select name="method">${selectOptions(methodOptions(), 'cash')}</select>`)}
      ${field(
        'הפקת קבלה',
        `<select name="receiptRequired">
           <option value="true" selected>נדרשת קבלה</option>
           <option value="false">ללא קבלה</option>
         </select>`,
      )}
      ${field('תיאור', `<input type="text" name="description" placeholder="למשל: תשלום חלקי עבור עלייה" />`, { className: 'full' })}
    </div>
    <p class="small muted full">
      תשלום חלקי מקטין אוטומטית את יתרת החוב. ההכנסה נרשמת רק עכשיו, עם קבלת התשלום בפועל,
      ובעקבותיה מופקת קבלה בהתאם להגדרת העמותה.
    </p>`;

  openModal({
    title: commitment ? 'רישום תשלום עבור התחייבות' : 'רישום תשלום',
    bodyHtml,
    submitLabel: 'רישום התשלום',
    onSubmit: async (formData) => {
      const payload = {
        amountShekels: formData.get('amountShekels'),
        paymentDate: formData.get('paymentDate'),
        method: formData.get('method'),
        receiptRequired: formData.get('receiptRequired') === 'true',
        description: formData.get('description') || undefined,
      };
      if (commitment) {
        payload.commitmentId = commitment.id;
      } else {
        const selectedMember = formData.get('memberId');
        payload.memberId = selectedMember ? Number(selectedMember) : null;
        payload.organizationId = Number(formData.get('organizationId'));
      }

      const result = await api.recordPayment(payload);
      const receiptStatus = result.payment.receipt?.status;
      const parts = [`התשלום נרשם: ${money(result.payment.amountAgorot)}`];
      if (result.commitment) {
        parts.push(`יתרה: ${money(result.commitment.balanceAgorot)}`);
      }
      if (receiptStatus === 'issued') {
        parts.push(`קבלה ${result.payment.receipt.number}`);
      } else if (receiptStatus === 'awaiting_approval') {
        parts.push('הקבלה ממתינה לאישור גזבר');
      } else if (receiptStatus) {
        parts.push('הקבלה ממתינה להפקה');
      }
      toast(parts.join(' · '), 'success');
      onDone?.();
    },
  });
}

/** יצירת התחייבות חדשה (סעיף 23). */
export function openCommitmentModal({ memberId, onDone }) {
  const orgId = state.organizationId ?? state.organizations[0]?.id;
  const bodyHtml = `
    <div class="form-grid">
      ${field('חבר', `<select name="memberId" required>${selectOptions(memberOptions(), memberId, { placeholder: 'בחרו חבר' })}</select>`)}
      ${field('עמותה', `<select name="organizationId" required>${selectOptions(organizationOptions(), orgId)}</select>`)}
      ${field('סוג התחייבות', `<select name="commitmentTypeId" required>${selectOptions(commitmentTypeOptions(), '', { placeholder: 'בחרו סוג' })}</select>`)}
      ${field('אירוע / שבת / חג', `<select name="eventId">${selectOptions(eventOptions(), '', { placeholder: 'ללא שיוך' })}</select>`)}
      ${field('סכום ההתחייבות (₪)', `<input type="number" name="amountShekels" min="0.01" step="0.01" required placeholder="1800" />`)}
      ${field('תאריך ההתחייבות', `<input type="date" name="commitmentDate" value="${todayIso()}" required />`)}
      ${field('מועד אחרון לתשלום', `<input type="date" name="dueDate" />`)}
      ${field('אמצעי תשלום מתוכנן', `<select name="plannedPaymentMethod">${selectOptions(methodOptions(), '', { placeholder: 'לא נקבע' })}</select>`)}
      ${field('הערות', `<textarea name="notes" placeholder="למשל: עליית מפטיר"></textarea>`, { className: 'full' })}
    </div>
    <p class="small muted full">
      התחייבות איננה הכנסה. ההכנסה תירשם רק כאשר יתקבל תשלום בפועל.
    </p>`;

  openModal({
    title: 'התחייבות חדשה',
    bodyHtml,
    submitLabel: 'יצירת התחייבות',
    onSubmit: async (formData) => {
      const commitment = await api.createCommitment({
        memberId: Number(formData.get('memberId')),
        organizationId: Number(formData.get('organizationId')),
        commitmentTypeId: Number(formData.get('commitmentTypeId')),
        eventId: formData.get('eventId') ? Number(formData.get('eventId')) : null,
        amountShekels: formData.get('amountShekels'),
        commitmentDate: formData.get('commitmentDate'),
        dueDate: formData.get('dueDate') || null,
        plannedPaymentMethod: formData.get('plannedPaymentMethod') || null,
        notes: formData.get('notes') || null,
      });
      toast(
        `נוצרה התחייבות על ${money(commitment.commitment.amountAgorot)} עבור ${commitment.commitment.member.name}`,
        'success',
      );
      onDone?.();
    },
  });
}

/** שיוך תשלום שלא שויך לחבר (סעיף 30). */
export function openAssignPaymentModal({ payment, onDone }) {
  const bodyHtml = `
    <p class="full">
      תשלום על סך <strong>${money(payment.amountAgorot)}</strong> מתאריך ${esc(payment.paymentDate)}
      (${esc(label('paymentMethods', payment.method))}) אינו משויך לחבר.
    </p>
    <div class="form-grid">
      ${field('שיוך לחבר', `<select name="memberId" required>${selectOptions(memberOptions(), '', { placeholder: 'בחרו חבר' })}</select>`, { className: 'full' })}
      ${field('שיוך להתחייבות (אופציונלי)', `<select name="commitmentId"><option value="">ללא</option></select>`, { className: 'full' })}
    </div>`;

  const modal = openModal({
    title: 'שיוך תשלום לחבר',
    bodyHtml,
    submitLabel: 'שיוך',
    onSubmit: async (formData) => {
      await api.assignPayment(payment.id, {
        memberId: Number(formData.get('memberId')),
        commitmentId: formData.get('commitmentId') ? Number(formData.get('commitmentId')) : null,
      });
      toast('התשלום שויך לחבר', 'success');
      onDone?.();
    },
  });

  // בעת בחירת חבר נטענות ההתחייבויות הפתוחות שלו באותה עמותה.
  const memberSelect = document.querySelector('.modal [name="memberId"]');
  const commitmentSelect = document.querySelector('.modal [name="commitmentId"]');
  memberSelect?.addEventListener('change', async () => {
    const memberIdValue = memberSelect.value;
    commitmentSelect.innerHTML = '<option value="">ללא</option>';
    if (!memberIdValue) return;
    const response = await api.commitments({
      memberId: memberIdValue,
      organizationId: payment.organization.id,
      status: 'outstanding',
    });
    for (const item of response.items) {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = `${item.type.name} · יתרה ${money(item.balanceAgorot)}`;
      commitmentSelect.appendChild(option);
    }
  });

  return modal;
}
