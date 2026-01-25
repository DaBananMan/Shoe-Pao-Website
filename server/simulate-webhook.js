const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const crypto = require('crypto');

function parseArgs() {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

async function getOrder(orderId, baseUrl){
  return new Promise((resolve, reject) => {
    const u = new url.URL((baseUrl || 'http://localhost:3000') + '/api/orders/' + encodeURIComponent(orderId));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try{ const j = JSON.parse(data || '{}'); resolve(j); }catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
  });
}

function sendWebhook(targetUrl, payload, secret){
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const u = new url.URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    // compute signature if secret provided
    let sig = '';
    if(secret){
      try{
        sig = crypto.createHmac('sha256', String(secret)).update(raw).digest('base64');
      }catch(e){ sig = ''; }
    }
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw)
      }
    };
    if(sig) opts.headers['aftership-signature'] = sig;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', (err) => reject(err));
    req.write(raw);
    req.end();
  });
}

async function main(){
  const argv = parseArgs();
  const target = argv.url || process.env.WEBHOOK_URL || 'http://localhost:3000/api/aftership/webhook';
  const secret = process.env.AFTERSHIP_SECRET || (() => {
    try{
      const p = require('path').join(__dirname, 'trackingapi_key.json');
      if(fs.existsSync(p)){
        const parsed = JSON.parse(fs.readFileSync(p,'utf8')||'{}');
        return parsed.api_secret || parsed.secret || parsed.webhook_secret || null;
      }
    }catch(e){}
    return null;
  })();

  let trackingNumber = argv.tracking || argv.trackingNumber || '';
  if(!trackingNumber && argv.orderId){
    try{
      const ord = await getOrder(argv.orderId, argv.baseUrl || process.env.SERVER_BASE || 'http://localhost:3000');
      if(ord && ord.order && ord.order.tracking_number) trackingNumber = ord.order.tracking_number;
      if(!trackingNumber && ord && ord.tracking_number) trackingNumber = ord.tracking_number;
    }catch(e){ console.error('Failed to fetch order for orderId', argv.orderId, e && e.message); }
  }

  if(!trackingNumber){
    console.error('No tracking number provided. Usage: node server/simulate-webhook.js --tracking=TRK123 OR --orderId=ORD...');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const sample = {
    data: {
      tracking: {
        tracking_number: trackingNumber,
        checkpoints: [
          { tag: 'in_transit', message: 'Arrived at Sorting Center', checkpoint_time: now, location: 'Metro Manila Sorting Center' }
        ]
      }
    }
  };

  try{
    const resp = await sendWebhook(target, sample, secret);
    console.log('Webhook POSTed to', target, 'status:', resp.statusCode);
    try{ console.log('Body:', JSON.parse(resp.body)); }catch(e){ console.log('Body raw:', resp.body); }
    process.exit(0);
  }catch(e){ console.error('Failed to send webhook', e && e.message); process.exit(2); }
}

main();
