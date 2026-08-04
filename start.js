const { exec } = require('child_process');
exec('npx electron .', { stdio: 'inherit' });