const fs = require('fs');
const path = require('path');
const http = require('http');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function normalizeFilePath(rootDir, requestPath) {
  const safeRoot = path.resolve(rootDir);
  const raw = typeof requestPath === 'string' ? requestPath : '/';
  const pathname = raw.split('?')[0].split('#')[0] || '/';
  const decoded = decodeURIComponent(pathname === '/' ? '/simple.html' : pathname);
  const joined = path.resolve(path.join(safeRoot, `.${decoded}`));
  if (!joined.startsWith(safeRoot)) {
    return null;
  }
  return joined;
}

function createStaticServer({ rootDir, host = '127.0.0.1', port = 0 } = {}) {
  const safeRoot = path.resolve(rootDir || '.');
  let server = null;
  let listeningPort = null;

  const handle = (req, res) => {
    const filePath = normalizeFilePath(safeRoot, req && req.url ? req.url : '/');
    if (!filePath) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat || !stat.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not_found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-store, max-age=0'
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end('read_failed');
      });
      stream.pipe(res);
    });
  };

  return {
    async start() {
      if (server) {
        return this;
      }
      server = http.createServer(handle);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      listeningPort = addr && typeof addr.port === 'number' ? addr.port : null;
      return this;
    },

    async stop() {
      if (!server) {
        return;
      }
      const current = server;
      server = null;
      listeningPort = null;
      await new Promise((resolve) => current.close(() => resolve()));
    },

    get origin() {
      if (!listeningPort) {
        return null;
      }
      return `http://${host}:${listeningPort}`;
    },

    urlFor(relativePath = '/simple.html') {
      const clean = String(relativePath || '/').startsWith('/')
        ? String(relativePath || '/')
        : `/${String(relativePath || '')}`;
      return `${this.origin}${clean}`;
    }
  };
}

module.exports = {
  createStaticServer
};
