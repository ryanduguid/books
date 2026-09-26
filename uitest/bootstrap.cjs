const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = process.env.BOOKS_UI_TEST_DIR;
if (!testRoot || !path.isAbsolute(testRoot)) {
  throw new Error('UI tests require an absolute temporary directory');
}

for (const name of ['userData', 'sessionData', 'documents', 'logs']) {
  const directory = path.join(testRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}

process.env.NODE_ENV = 'production';
process.env.IS_TEST = 'true';
require('../dist_electron/build/main.js');
