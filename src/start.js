const { spawn } = require('child_process');
const path = require('path');
// Always launch Electron from the project root (where package.json lives),
// regardless of where this script is invoked from.
const projectRoot = path.resolve(__dirname, '..');
const child = spawn('npx', ['electron', '.'], { cwd: projectRoot, stdio: 'inherit', shell: true });

child.on('error', (err) => {
  console.error('Failed to start Electron:', err.message);
});

child.on('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`Electron exited with code ${code} (signal: ${signal})`);
  }
});
