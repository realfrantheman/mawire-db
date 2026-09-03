'use strict';

const efts = require('./FIX-sec-efts');
const refresh = require('./refresh-file-backed');
const sec = require('./FIX-sec-ingestor-index');

// refresh-file-backed closes over the shared SEC module object. Replace only its
// network discovery function with the corrected, database-free EFTS client and
// query root forms once; the existing extraction and strict review logic stays unchanged.
sec.fetchRecentFilings = efts.fetchRecentFilings;
refresh.SEC_FORMS.splice(0, refresh.SEC_FORMS.length, ...efts.ROOT_FORMS);

refresh.run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
