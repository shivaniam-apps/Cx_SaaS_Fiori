// Deep links in path form (O16 / I41). The app routes with a HashRouter
// (#/audit-log), but a link typed or shared in path form (/audit-log,
// /transports?status=OPEN) reaches the server as a path: wherever
// index.html is served for it (Vite dev server, an approuter fallback), the
// router saw an empty hash and rendered the Dashboard under a mangled URL
// (/audit-log#/dashboard). This translates such a location into the hash
// route ONCE at boot, before the router mounts. Dependency-free: runs under
// node --test.

const clean = (v) => String(v ?? '');

// Vite's BASE_URL is './' for relative builds; anything without a leading
// slash means "the app is mounted at the document's directory", i.e. '/'.
export function normaliseBase(base) {
  const text = clean(base).trim();
  if (!text || !text.startsWith('/')) return '/';
  return text.endsWith('/') ? text : `${text}/`;
}

// The href to replace the current location with, or null when nothing has
// to change: the hash already carries a route, or the path is the app
// root (optionally index.html). Query and (non-route) hash are preserved.
export function hashRouteFor(location, base) {
  const pathname = clean(location?.pathname);
  const search = clean(location?.search);
  const hash = clean(location?.hash);
  if (/^#\/./.test(hash)) return null;               // already a hash route

  const root = normaliseBase(base);
  let route = pathname.startsWith(root) ? pathname.slice(root.length - 1) : pathname;
  route = route.replace(/^\/+/, '/').replace(/\/index\.html$/i, '/');
  if (!route || route === '/') return null;

  return `${root}#${route}${search}`;
}
