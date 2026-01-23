// tools/check-missing-tracking.js
// Run with: node tools/check-missing-tracking.js
// Prints Orders rows missing tracking_number.

const db = require('../server/db');

function main(){
  try{
    const rows = db.prepare("SELECT id, tracking_number, recipient_name, created_at FROM Orders WHERE tracking_number IS NULL OR tracking_number = ''").all();
    console.log('missing:', rows.length);
    if(rows.length){
      console.dir(rows, { depth: 5 });
    }
  }catch(e){
    console.error('failed', e && (e.stack || e.message || e));
    process.exit(2);
  }
}

if(require.main === module) main();
