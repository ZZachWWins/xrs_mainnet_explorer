// Local-only static preview with the same fixed read-only proxy as deployment.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {proxyResponse} from './src/proxy.mjs';
const directory = fileURLToPath(new URL('./dist/', import.meta.url));
const types = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json'};
let active = 0;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:8770');
  try {
    if (url.pathname.startsWith('/networks/')) {
      if (active >= 20) { response.writeHead(503, {'Cache-Control': 'no-store'}).end(); return; }
      active++;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 8192) throw new Error('Body too large'); chunks.push(chunk); }
        const init = {method: request.method, headers: {'Content-Type': 'application/json'}};
        if (request.method !== 'GET' && request.method !== 'HEAD') init.body = Buffer.concat(chunks);
        const result = await proxyResponse(new Request(url, init));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } finally { active--; }
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) { response.writeHead(400).end(); return; }
    let relative = pathname.replace(/^\/+/, '') || 'index.html';
    if (!path.extname(relative)) relative = 'index.html';
    const full = path.resolve(directory, relative);
    if (!full.startsWith(directory)) { response.writeHead(403).end(); return; }
    const data = await readFile(full);
    response.writeHead(200, {'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404, {'Cache-Control': 'no-store'}).end('Unavailable'); }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(8770, '127.0.0.1', () => console.log('Explorer preview: http://127.0.0.1:8770'));
