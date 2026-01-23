const path = require('path');
const fs = require('fs');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const propPath = path.join(__dirname, '..', 'tmp_proposed_status_fix.json');
const outPath = path.join(__dirname, '..', 'tmp_fix_result.json');
if(!fs.existsSync(propPath)){ console.error('Proposals file not found:', propPath); process.exit(1); }
const proposals = JSON.parse(fs.readFileSync(propPath,'utf8'));
const results = [];
const updateStmt = db.prepare('UPDATE Orders SET status = ? WHERE id = ?');
proposals.forEach(p => {
  try{
    const before = db.prepare('SELECT id, status FROM Orders WHERE id = ?').get(p.id);
    if(!before){ results.push(Object.assign({}, p, { applied: false, error: 'order not found' })); return; }
    updateStmt.run(p.proposed, p.id);
    const after = db.prepare('SELECT id, status FROM Orders WHERE id = ?').get(p.id);
    results.push({ id: p.id, before: before.status, after: after.status, applied: true });
  }catch(e){ results.push(Object.assign({}, p, { applied: false, error: String(e && e.message) })); }
});
// Also update data/orders.json if present to keep static client cache in repo in sync
try{
  const dataPath = path.join(__dirname, '..', 'data', 'orders.json');
  if(fs.existsSync(dataPath)){
    const data = JSON.parse(fs.readFileSync(dataPath,'utf8'));
    let mutated = false;
    const byId = new Map(); data.forEach(o => byId.set(String(o.id), o));
    results.forEach(r => {
      if(r.applied && byId.has(String(r.id))){ byId.get(String(r.id)).status = r.after; mutated = true; }
    });
    if(mutated){ fs.writeFileSync(dataPath, JSON.stringify(Array.from(byId.values()), null, 2)); }
  }
}catch(e){ /* ignore file update errors */ }
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log('Wrote', outPath); console.log(JSON.stringify(results, null, 2));
