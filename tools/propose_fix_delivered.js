const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
function canonical(s){ if(!s) return ''; return String(s).toLowerCase().trim(); }
function pickReplacementStatus(tracking){
  if(!Array.isArray(tracking) || tracking.length===0) return 'processing';
  // iterate from last to first and find last status that's NOT delivered (and not tracking assigned)
  for(let i=tracking.length-1;i>=0;i--){
    const s = canonical(tracking[i].status || tracking[i].message || '');
    if(!s) continue;
    if(s.indexOf('deliver') !== -1) continue;
    if(s.indexOf('tracking assigned') !== -1) continue;
    if(s.indexOf('order placed') !== -1) return 'processing';
    // normalize common values
    if(s.indexOf('out for delivery') !== -1) return 'out for delivery';
    if(s.indexOf('in transit') !== -1) return 'in transit';
    if(s.indexOf('picked') !== -1) return 'picked up';
    if(s.indexOf('prepar') !== -1 || s.indexOf('process') !== -1) return 'processing';
    return tracking[i].status || tracking[i].message || tracking[i].status;
  }
  return 'processing';
}

const rows = db.prepare("SELECT id, status FROM Orders WHERE lower(status) LIKE '%deliver%'").all();
const proposals = [];
for(const r of rows){
  const tracking = db.prepare('SELECT status, message, timestamp FROM OrderTracking WHERE order_id = ? ORDER BY timestamp ASC').all(r.id);
  const replacement = pickReplacementStatus(tracking);
  proposals.push({ id: r.id, current: r.status, proposed: replacement, trackingCount: tracking.length, lastTracking: tracking[tracking.length-1] || null });
}
const fs = require('fs');
fs.writeFileSync(path.join(__dirname, '..', 'tmp_proposed_status_fix.json'), JSON.stringify(proposals, null, 2));
console.log('Wrote tmp_proposed_status_fix.json with', proposals.length, 'proposals');
console.log(JSON.stringify(proposals, null, 2));
