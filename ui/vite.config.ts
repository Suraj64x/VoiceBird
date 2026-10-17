import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const py = path.join(root, '.venv', 'Scripts', 'python.exe');
const API_PORT = 7879;

const portBusy = (port: number) =>
  new Promise<boolean>((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
  });

// One command starts everything: Vite (UI, hot reload) + the Python backend.
// The backend is restarted if it crashes.
function backend() {
  let child: ChildProcess | null = null;
  let stopping = false;
  const start = async () => {
    if (stopping || !existsSync(py) || !existsSync(path.join(root, 'server', 'app.py')) || (await portBusy(API_PORT))) {
      if (!stopping) setTimeout(start, 3000).unref();
      return;
    }
    child = spawn(py, ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('exit', () => {
      child = null;
      if (!stopping) setTimeout(start, 2000).unref();
    });
  };
  return {
    name: 'voicebird-backend',
    configureServer(server: any) {
      start();
      const stop = () => { stopping = true; child?.kill(); };
      server.httpServer?.on('close', stop);
      process.on('exit', stop);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), backend()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 7878,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, timeout: 0, proxyTimeout: 0 } },
  },
});
