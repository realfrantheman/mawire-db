'use strict';

require('./refresh-file-backed-v2').run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
