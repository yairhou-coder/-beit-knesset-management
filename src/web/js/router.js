/** ניתוב מבוסס hash: #/route?param=value */

const routes = new Map();
let notFoundHandler = null;
let current = null;

export function register(name, handler) {
  routes.set(name, handler);
}

export function setNotFound(handler) {
  notFoundHandler = handler;
}

export function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const name = (path || 'dashboard').replace(/\/$/, '');
  const params = Object.fromEntries(new URLSearchParams(query).entries());
  return { name, params, segments: name.split('/') };
}

export function navigate(name, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  window.location.hash = `#/${name}${query ? `?${query}` : ''}`;
}

/** מרענן את המסך הנוכחי (לאחר פעולה ששינתה נתונים). */
export function reload() {
  if (current) void handle();
}

async function handle() {
  const route = parseHash();
  current = route;
  // מסכים כמו members/12 מנותבים למטפל של הקטע הראשון.
  const handler = routes.get(route.name) ?? routes.get(route.segments[0]);
  if (!handler) {
    notFoundHandler?.(route);
    return;
  }
  await handler(route);
}

export function start() {
  window.addEventListener('hashchange', () => {
    void handle();
  });
  if (!window.location.hash) {
    window.location.hash = '#/dashboard';
    return;
  }
  void handle();
}

export function currentRoute() {
  return current;
}
