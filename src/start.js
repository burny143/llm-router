const { exec } = require('child_process');
const path = require('path');
// Always launch Electron from the project root (where package.json lives),
// regardless of where this script is invoked from.
const projectRoot = path.resolve(__dirname, '..');
exec('npx electron .', { cwd: projectRoot, stdio: 'inherit' });
