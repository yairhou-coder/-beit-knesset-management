/** נקודת הכניסה של ה-UI: טעינת נתוני עזר, ניתוב וחיבור המסכים. */

import { loading, toast } from './ui.js';
import { loadReferenceData, setOrganization, state } from './state.js';
import { navigate, parseHash, register, setNotFound, start } from './router.js';

import { renderDashboard } from './pages/dashboard.js';
import { bindCollections, renderCollections } from './pages/collections.js';
import { bindReceipts, renderReceipts } from './pages/receipts.js';
import {
  bindAlerts,
  bindCommitments,
  bindNotifications,
  bindPayments,
  bindStandingOrders,
  renderAlerts,
  renderCommitments,
  renderIncomes,
  renderNotifications,
  renderPayments,
  renderReports,
  renderStandingOrders,
} from './pages/lists.js';
import {
  bindMemberCard,
  bindMembersList,
  openMemberModal,
  renderMemberCard,
  renderMembersList,
} from './pages/members.js';
import { bindOrganizations, renderOrganizations } from './pages/organizations.js';
import { renderAbout } from './pages/about.js';
import { openCommitmentModal, openPaymentModal } from './pages/paymentForm.js';

const view = document.getElementById('view');
const titleEl = document.getElementById('page-title');
const actionsEl = document.getElementById('page-actions');

const TITLES = {
  dashboard: 'דשבורד',
  collections: 'גבייה וחובות',
  commitments: 'התחייבויות',
  payments: 'תשלומים',
  incomes: 'הכנסות',
  receipts: 'קבלות ומסמכים',
  members: 'חברי קהילה',
  'standing-orders': 'הוראות קבע',
  reports: 'דוחות',
  organizations: 'עמותות',
  notifications: 'תזכורות',
  alerts: 'התראות מנהל',
  about: 'אודות המערכת',
};

/** כפתורי הפעולה בראש כל מסך. */
function pageActions(route, reload) {
  const buttons = [];
  const add = (labelText, className, onClick) => {
    const button = document.createElement('button');
    button.className = `btn ${className}`;
    button.textContent = labelText;
    button.addEventListener('click', onClick);
    buttons.push(button);
  };

  switch (route.segments[0]) {
    case 'dashboard':
    case 'collections':
    case 'commitments':
      add('התחייבות חדשה', 'primary', () => openCommitmentModal({ onDone: reload }));
      add('רישום תשלום', '', () => openPaymentModal({ onDone: reload }));
      break;
    case 'payments':
      add('רישום תשלום', 'primary', () => openPaymentModal({ onDone: reload }));
      break;
    case 'members':
      if (route.segments.length === 1) {
        add('חבר חדש', 'primary', () => openMemberModal(reload));
      }
      break;
    default:
      break;
  }

  actionsEl.replaceChildren(...buttons);
}

function setActiveNav(route) {
  const key = route.segments[0];
  document.querySelectorAll('#nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === key);
  });
  const isMemberCard = key === 'members' && route.segments.length > 1;
  titleEl.textContent = isMemberCard ? 'כרטיס חבר' : (TITLES[key] ?? 'בית המדרש אנשי מעשה');
}

/** עוטף מסך: מציג טעינה, מרנדר, ומחבר מאזינים. */
function page(render, bind) {
  return async (route) => {
    setActiveNav(route);
    view.innerHTML = loading();
    const reload = () => {
      void page(render, bind)(parseHash());
    };
    pageActions(route, reload);
    try {
      view.innerHTML = await render(route);
      bind?.(view, reload, route);
    } catch (error) {
      view.innerHTML = `<div class="section"><div class="empty">שגיאה בטעינת המסך: ${error.message}</div></div>`;
      toast(error.message, 'error');
    }
  };
}

/** מסך החברים מטפל גם ברשימה וגם בכרטיס חבר בודד. */
const membersPage = async (route) => {
  const handler =
    route.segments.length > 1
      ? page(renderMemberCard, bindMemberCard)
      : page(renderMembersList, bindMembersList);
  await handler(route);
};

function setupOrgFilter() {
  const select = document.getElementById('org-filter');
  const options = [
    '<option value="">כל העמותות</option>',
    ...state.organizations.map(
      (org) =>
        `<option value="${org.id}"${state.organizationId === org.id ? ' selected' : ''}>${org.name}</option>`,
    ),
  ];
  select.innerHTML = options.join('');
  select.addEventListener('change', () => {
    setOrganization(select.value);
    // רענון המסך הנוכחי עם הסינון החדש.
    const route = parseHash();
    navigate(route.name, route.params);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

async function bootstrap() {
  try {
    await loadReferenceData();
  } catch (error) {
    view.innerHTML = `<div class="section"><div class="empty">לא ניתן לטעון את נתוני המערכת: ${error.message}</div></div>`;
    return;
  }

  setupOrgFilter();

  register('dashboard', page(renderDashboard));
  register('collections', page(renderCollections, bindCollections));
  register('commitments', page(renderCommitments, bindCommitments));
  register('payments', page(renderPayments, bindPayments));
  register('incomes', page(renderIncomes));
  register('receipts', page(renderReceipts, bindReceipts));
  register('members', membersPage);
  register('standing-orders', page(renderStandingOrders, bindStandingOrders));
  register('reports', page(renderReports));
  register('organizations', page(renderOrganizations, bindOrganizations));
  register('notifications', page(renderNotifications, bindNotifications));
  register('alerts', page(renderAlerts, bindAlerts));
  register('about', page(renderAbout));

  setNotFound(() => {
    view.innerHTML = '<div class="section"><div class="empty">המסך המבוקש לא נמצא</div></div>';
  });

  start();
}

void bootstrap();
