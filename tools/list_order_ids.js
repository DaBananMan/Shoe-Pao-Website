const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const rows = db.prepare('SELECT id, status, total, created_at FROM Orders ORDER BY datetime(created_at) DESC').all();
console.log(JSON.stringify(rows, null, 2));
