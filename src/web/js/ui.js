/** רכיבי UI משותפים: מקטעים, טבלאות, חלוניות והודעות. */

import { esc, money, number } from './format.js';

export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

export function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root');
  const node = el(`<div class="toast ${kind}">${esc(message)}</div>`);
  root.appendChild(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3500);
}

export function loading() {
  return '<div class="loading">טוען…</div>';
}

/** כרטיס סטטיסטיקה. לחיצה מובילה לרשימה המתאימה (סעיף 30). */
export function statCard(card) {
  const value =
    card.amountAgorot !== undefined && card.amountAgorot !== null
      ? money(card.amountAgorot)
      : typeof card.count === 'string'
        ? esc(card.count)
        : number(card.count ?? 0);
  const meta =
    card.amountAgorot !== undefined && card.count !== undefined && card.count !== null
      ? (card.hint ?? `${number(card.count)} רשומות`)
      : (card.hint ?? '');
  return `
    <a class="stat-card tone-${esc(card.tone ?? 'neutral')}" href="${esc(card.link ?? '#')}">
      <div class="stat-title">${esc(card.title)}</div>
      <div class="stat-value">${value}</div>
      ${meta ? `<div class="stat-meta">${esc(meta)}</div>` : ''}
    </a>`;
}

export function section(title, bodyHtml, options = {}) {
  const hint = options.hint ? `<span class="section-hint">${esc(options.hint)}</span>` : '';
  const actions = options.actions ?? '';
  return `
    <section class="section">
      <div class="section-head">
        <h2>${esc(title)}</h2>
        <div class="btn-row">${hint}${actions}</div>
      </div>
      <div class="section-body ${options.flush ? 'flush' : ''}">${bodyHtml}</div>
    </section>`;
}

/**
 * טבלה גנרית.
 * columns: [{ header, cell(row), className }]
 */
export function table(columns, rows, emptyMessage = 'אין נתונים להצגה') {
  if (!rows || rows.length === 0) {
    return `<div class="empty">${esc(emptyMessage)}</div>`;
  }
  const head = columns
    .map((column) => `<th class="${column.className ?? ''}">${esc(column.header)}</th>`)
    .join('');
  const bodyRows = rows
    .map((row, index) => {
      const cells = columns
        .map((column) => `<td class="${column.className ?? ''}">${column.cell(row, index)}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}

export function progressBar(paid, total) {
  const percent = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  return `<div class="progress" title="${percent}% נגבו"><span style="width:${percent}%"></span></div>`;
}

/** שדה טופס. */
export function field(label, inputHtml, options = {}) {
  return `<div class="field ${options.className ?? ''}">
    <label${options.for ? ` for="${esc(options.for)}"` : ''}>${esc(label)}</label>
    ${inputHtml}
  </div>`;
}

export function selectOptions(items, selectedValue, options = {}) {
  const placeholder = options.placeholder
    ? `<option value="">${esc(options.placeholder)}</option>`
    : '';
  const rendered = items
    .map((item) => {
      const value = String(item.value);
      const selected = String(selectedValue ?? '') === value ? ' selected' : '';
      return `<option value="${esc(value)}"${selected}>${esc(item.label)}</option>`;
    })
    .join('');
  return placeholder + rendered;
}

/** ממיר אובייקט תוויות ({key: label}) לרשימת אפשרויות. */
export function labelsToOptions(labels) {
  return Object.entries(labels ?? {}).map(([value, label]) => ({ value, label }));
}

/**
 * פותח חלונית מודאלית עם טופס.
 * fields: HTML של גוף הטופס. onSubmit מקבל FormData ומחזיר Promise.
 */
export function openModal({ title, bodyHtml, submitLabel = 'שמירה', onSubmit }) {
  const root = document.getElementById('modal-root');
  const backdrop = el(`
    <div class="modal-backdrop">
      <form class="modal" novalidate>
        <div class="modal-head">
          <h2>${esc(title)}</h2>
          <button type="button" class="close-x" aria-label="סגירה">&times;</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">
          <button type="submit" class="btn primary">${esc(submitLabel)}</button>
          <button type="button" class="btn" data-cancel>ביטול</button>
        </div>
      </form>
    </div>`);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  backdrop.querySelector('.close-x').addEventListener('click', close);
  backdrop.querySelector('[data-cancel]').addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  const form = backdrop.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      await onSubmit(new FormData(form));
      close();
    } catch (error) {
      toast(error.message ?? 'הפעולה נכשלה', 'error');
      submitButton.disabled = false;
    }
  });

  root.appendChild(backdrop);
  const firstInput = backdrop.querySelector('input, select, textarea');
  firstInput?.focus();
  return { close };
}

/** אישור פעולה. */
export function confirmAction(message) {
  return window.confirm(message);
}
