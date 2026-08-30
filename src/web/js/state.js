/** מצב גלובלי קל: נתוני עזר שנטענים פעם אחת + סינון העמותה הפעילה. */

import { api } from './api.js';

export const state = {
  lookups: {},
  organizations: [],
  commitmentTypes: [],
  events: [],
  members: [],
  /** מזהה העמותה שנבחרה בסרגל הצד, או null עבור "כל העמותות". */
  organizationId: null,
};

const STORAGE_KEY = 'bk.organizationId';

export async function loadReferenceData() {
  const [lookups, organizations, commitmentTypes, events, members] = await Promise.all([
    api.lookups(),
    api.organizations(),
    api.commitmentTypes(),
    api.events(),
    api.members(),
  ]);
  state.lookups = lookups;
  state.organizations = organizations.items;
  state.commitmentTypes = commitmentTypes.items;
  state.events = events.items;
  state.members = members.items;

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && state.organizations.some((org) => String(org.id) === stored)) {
    state.organizationId = Number(stored);
  }
}

export async function refreshMembers() {
  const response = await api.members();
  state.members = response.items;
}

export function setOrganization(id) {
  state.organizationId = id ? Number(id) : null;
  if (state.organizationId) {
    window.localStorage.setItem(STORAGE_KEY, String(state.organizationId));
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

export function organizationName(id) {
  return state.organizations.find((org) => org.id === id)?.name ?? '—';
}

/** מוסיף את סינון העמותה הפעילה לפרמטרים, אם לא נקבע אחרת במסך. */
export function withOrg(params = {}) {
  if (params.organizationId !== undefined) return params;
  return state.organizationId ? { ...params, organizationId: state.organizationId } : params;
}

export function label(group, key) {
  return state.lookups?.[group]?.[key] ?? key ?? '';
}

export function memberOptions() {
  return state.members.map((member) => ({ value: member.id, label: member.fullName }));
}

export function organizationOptions() {
  return state.organizations.map((org) => ({ value: org.id, label: org.name }));
}

export function commitmentTypeOptions() {
  return state.commitmentTypes.map((type) => ({ value: type.id, label: type.name }));
}

export function eventOptions(organizationId) {
  return state.events
    .filter((event) => !organizationId || !event.organizationId || event.organizationId === organizationId)
    .map((event) => ({ value: event.id, label: event.name }));
}
