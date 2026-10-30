// Run the API server (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['--watch', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
};
for (const p of procs) {
  p.on('exit', (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
