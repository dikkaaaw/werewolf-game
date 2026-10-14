/**
 * supastack-local proxy — a minimal stand-in for Supabase's Kong gateway.
 *
 * supabase-js derives BOTH the PostgREST base URL and the GoTrue base URL from
 * NEXT_PUBLIC_SUPABASE_URL. On hosted Supabase a single Kong front routes:
 *
 *     /rest/v1/*   -> PostgREST
 *     /auth/v1/*   -> GoTrue
 *
 * Pointing NEXT_PUBLIC_SUPABASE_URL straight at PostgREST makes every auth
 * call 404 with "Invalid path specified in request URL", because PostgREST only
 * knows /rest/v1 routes. Rather than reconfigure the test suite (which must keep
 * working against hosted Supabase unchanged), this reproduces the routing layer
 * locally.
 *
 * Binds to 127.0.0.1 only. Adds no dependencies — Node's http module is enough.
 */
import http from 'node:http';

const PORT = Number(process.env.SUPASTACK_PROXY_PORT || 54321);
const HOST = '127.0.0.1';
const PGRST = { host: HOST, port: Number(process.env.SUPASTACK_PGRST_PORT || 3001) };
const AUTH = { host: HOST, port: Number(process.env.SUPASTACK_AUTH_PORT || 9999) };

const ROUTES = [
  // Longest prefix first so /auth/v1 never shadows anything else.
  { prefix: '/auth/v1', target: AUTH },
  { prefix: '/rest/v1', target: PGRST },
];

function route(pathname) {
  return ROUTES.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/'));
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  const match = route(pathname);

  if (!match) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        message:
          'supastack-local: no route for this path. Expected /rest/v1/* or /auth/v1/*.',
      }),
    );
    return;
  }

  const headers = { ...req.headers };
  // Hop-by-hop and length headers must be recomputed for the new hop.
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;

  // Kong strips the service prefix before proxying: /rest/v1/rooms -> PostgREST
  // /rooms, /auth/v1/token -> GoTrue /token. Forwarding the prefix verbatim
  // makes PostgREST 404 with "Invalid path specified in request URL".
  const upstreamPath = req.url.slice(match.prefix.length) || '/';

  const upstream = http.request(
    {
      host: match.target.host,
      port: match.target.port,
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `upstream error: ${err.message}` }));
  });

  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `supastack-local proxy listening on http://${HOST}:${PORT} ` +
      `(/rest/v1 -> :${PGRST.port}, /auth/v1 -> :${AUTH.port})\n`,
  );
});