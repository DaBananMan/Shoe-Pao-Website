const express = require('express');
const path = require('path');
const db = require('./server/db');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Canonical pickup origin used for simulations and directions
const SHOEPAO_ORIGIN = 'Blk 15 Lot 25 Phase 2 MV Villar Avenue Camella Springville Central Molino 3 , Bacoor, Philippines, 4102';
// keep raw body for webhook signature verification when needed
app.use(express.json({ limit: '1mb', verify: function(req, res, buf){ try{ req.rawBody = buf; }catch(e){} } }));
// Dev-friendly CORS middleware: allow requests from Apache/other origins during local development.
// NOTE: This is intentionally permissive for dev only. Remove or restrict in production.
app.use(function(req, res, next){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Aftership-Signature');
  // quick response to preflight
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname)));

// Short link redirect route: /r/:id -> redirects to stored target link (Firebase verification link)
app.get('/r/:id', async (req, res) => {
  try{
    const id = (req.params && req.params.id) ? String(req.params.id) : null;
    if(!id) return res.status(400).send('Missing id');
    try{
      const row = db.prepare('SELECT target FROM ShortLinks WHERE id = ?').get(id);
      if(row && row.target){
        // redirect to the original verification link
        return res.redirect(302, row.target);
      } else {
        return res.status(404).send('Not found');
      }
    }catch(e){ console.warn('ShortLinks lookup failed', e); return res.status(500).send('Server error'); }
  }catch(e){ console.error('Redirect error', e); return res.status(500).send('Server error'); }
});

// Load AfterShip API key from trackingapi_key.json if present
let AFTERSHIP_KEY = null;
let AFTERSHIP_SECRET = null;
try{
  const keyPath = path.join(__dirname, 'trackingapi_key.json');
  if (fs.existsSync(keyPath)){
    const raw = fs.readFileSync(keyPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    AFTERSHIP_KEY = (parsed.api_key || parsed.key || parsed.token || null);
    AFTERSHIP_SECRET = (parsed.api_secret || parsed.secret || null);
    console.log('AfterShip API key loaded:', AFTERSHIP_KEY ? 'yes' : 'no', ' secret:', AFTERSHIP_SECRET ? 'yes' : 'no');
  }
}catch(e){ console.warn('Failed to read trackingapi_key.json', e); }

// Initialize firebase-admin if a service account JSON is present in the project root
let admin = null;
try{
  const saPath = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(saPath)){
    try{
      admin = require('firebase-admin');
      const sa = require(saPath);
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      console.log('firebase-admin initialized from service-account.json');
    }catch(e){
      console.warn('Failed to initialize firebase-admin from service-account.json', e);
      admin = null;
    }
  } else {
    // Attempt ADC (GOOGLE_APPLICATION_CREDENTIALS) if set in environment
    try{
      admin = require('firebase-admin');
      try{ admin.initializeApp(); console.log('firebase-admin initialized using ADC'); }catch(e){}
    }catch(e){ admin = null; }
  }
}catch(e){ console.warn('firebase-admin init check failed', e); admin = null; }

// Auto-register Windows Scheduled Task to start Node at logon when opt-in is enabled.
// This is intentionally opt-in: set AUTO_REGISTER_STARTUP=true in your environment to allow
// the server process to attempt to register the Scheduled Task for the current user.
// The registration script is `tools/register-startup.ps1` which uses Register-ScheduledTask -Force.
try{
  if (process.platform === 'win32' && (process.env.AUTO_REGISTER_STARTUP === 'true')){
    const { spawn } = require('child_process');
    const regScript = path.join(__dirname, 'tools', 'register-startup.ps1');
    console.log('AUTO_REGISTER_STARTUP enabled — attempting to register scheduled task via', regScript);
    try{
      const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File', regScript], { windowsHide: true });
      ps.stdout.on('data', (d) => { try{ console.log('[register-startup.out]', d.toString().trim()); }catch(e){} });
      ps.stderr.on('data', (d) => { try{ console.warn('[register-startup.err]', d.toString().trim()); }catch(e){} });
      ps.on('close', (code) => { console.log('register-startup.ps1 exited with code', code); });
    }catch(err){ console.warn('Failed to spawn PowerShell to register startup task', err); }
  }
}catch(e){ console.warn('Auto-register startup check failed', e); }


// Helper to call AfterShip API (simple wrapper using native https)
function aftershipRequest(method, pathUrl, body) {
  return new Promise((resolve, reject) => {
    if (!AFTERSHIP_KEY) return reject(new Error('AfterShip API key not configured'));
    const opts = {
      hostname: 'api.aftership.com',
      port: 443,
      path: pathUrl,
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'aftership-api-key': AFTERSHIP_KEY,
        'Accept': 'application/json'
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try{
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const err = new Error('AfterShip API error: ' + (json.message || res.statusCode));
          err.code = res.statusCode; err.body = json; return reject(err);
        }catch(e){ return reject(e); }
      });
    });
    req.on('error', (err) => reject(err));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Server route: generate Firebase email verification link via Admin SDK and send custom HTML email via SMTP
app.post('/api/send-verification-email', async (req, res) => {
  const body = req.body || {};
  const email = (body.email || '').toString().trim();
  const displayName = body.displayName || '';
  const returnUrl = body.returnUrl || process.env.BASE_URL || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : ''));
  if(!email) return res.status(400).json({ error: 'email required' });
  try{
    // Initialize firebase-admin if not already
    const admin = require('firebase-admin');
    try{ if(!admin.apps || !admin.apps.length) admin.initializeApp(); }catch(e){ console.warn('firebase-admin initializeApp() warning', e); }

    const actionCodeSettings = { url: (returnUrl || '') + '/login.html', handleCodeInApp: false };
    const link = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);

    // Create a short redirect id and store mapping in DB so emails show a short link
    try{
      const shortId = crypto.randomBytes(4).toString('hex'); // 8 hex chars
      const createdAt = new Date().toISOString();
      // Insert into ShortLinks table (created in server/db.js)
      try{
        db.prepare('INSERT INTO ShortLinks (id, target, created_at) VALUES (?,?,?)').run(shortId, link, createdAt);
      }catch(e){
        // if insert fails (rare), log but continue using full link
        console.warn('ShortLinks insert failed', e);
      }
      // Build short redirect URL using returnUrl or BASE_URL
      const base = (process.env.BASE_URL || returnUrl || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : '')) ).replace(/\/$/, '');
      var shortRedirect = base + '/r/' + shortId;
    }catch(e){ console.warn('Failed to create short redirect', e); }

    // Prepare mailer (requires SMTP env vars). If SMTP isn't configured, return the
    // generated verification link (and the short redirect when available) so the
    // client can display it — this allows operation without SMTP.
    let nodemailer = null;
    try{ nodemailer = require('nodemailer'); }catch(e){ nodemailer = null; }

    const smtpConfigured = nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
    const resultPayload = { ok: true, verificationLink: link, shortRedirect: (typeof shortRedirect !== 'undefined') ? shortRedirect : null };

    if(!smtpConfigured){
      // No SMTP available — return the link to the client for manual display/open.
      return res.json(resultPayload);
    }

    try{
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: (process.env.SMTP_SECURE === 'true') || false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });

      const from = process.env.EMAIL_FROM || '"Shoe Pao" <noreply@shoe-pao-special.firebaseapp.com>';
      // Prefer using the short redirect URL in the email when available
      const displayLink = (typeof shortRedirect !== 'undefined') ? shortRedirect : link;
      // Shorten the visible link text for the template so the email isn't cluttered
      let displayText = displayLink;
      if (typeof shortRedirect === 'undefined') {
        displayText = displayText.replace(/^https?:\/\//, '');
        if (displayText.length > 72) displayText = displayText.slice(0,72) + '...';
      }
      const html = `
        <div style="font-family: Arial, sans-serif; color: #222;">
          <h2>Shoe Pao Special</h2>
          <p>Hello ${String(displayName || '')},</p>
          <p>Please verify your email address by clicking the button below:</p>
          <p style="text-align:center"><a href="${displayLink}" style="display:inline-block;padding:12px 20px;background:#b71c1c;color:#fff;border-radius:6px;text-decoration:none;">Verify</a></p>
          <p>If the button doesn't work, paste this link into your browser:</p>
          <p><a href="${displayLink}">${displayText}</a></p>
          <p>Thanks,<br>Your Shoe Pao team</p>
        </div>`;

      await transporter.sendMail({ from: from, to: email, subject: 'Verify your email for Shoe Pao', html: html });
      return res.json({ ok: true });
    }catch(e){
      console.warn('send verification email failed, returning link to client', e);
      // If sending failed for any reason, return the link so the UI can show it.
      return res.json(resultPayload);
    }
  }catch(err){
    console.error('send-verification-email failed', err);
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// Server route: generate Firebase password reset link via Admin SDK and send custom email via SMTP
app.post('/api/send-password-reset', async (req, res) => {
  const body = req.body || {};
  const email = (body.email || '').toString().trim();
  const returnUrl = body.returnUrl || process.env.BASE_URL || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : ''));
  if(!email) return res.status(400).json({ error: 'email required' });
  try{
    // Initialize firebase-admin if not already
    const admin = require('firebase-admin');
    try{ if(!admin.apps || !admin.apps.length) admin.initializeApp(); }catch(e){ console.warn('firebase-admin initializeApp() warning', e); }

  // Force in-app reset flow so the link opens our `reset-password.html` page which
  // runs the client-side confirmPasswordReset code and notifies the server.
  const actionCodeSettings = { url: (returnUrl || '') + '/reset-password.html?next=login', handleCodeInApp: true };
    const link = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);

    // Create a short redirect id and store mapping in DB so emails show a short link
    let shortRedirect;
    try{
      const shortId = crypto.randomBytes(4).toString('hex');
      const createdAt = new Date().toISOString();
      try{ db.prepare('INSERT INTO ShortLinks (id, target, created_at) VALUES (?,?,?)').run(shortId, link, createdAt); }catch(e){ console.warn('ShortLinks insert failed', e); }
      const base = (process.env.BASE_URL || returnUrl || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : '')) ).replace(/\/$/, '');
      shortRedirect = base + '/r/' + shortId;
    }catch(e){ console.warn('Failed to create short redirect', e); }

    // Prepare mailer (requires SMTP env vars)
    let nodemailer;
    try{ nodemailer = require('nodemailer'); }catch(e){ console.error('nodemailer not installed', e); return res.status(500).json({ error: 'nodemailer not available on server' }); }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.example.com',
      port: Number(process.env.SMTP_PORT || 587),
      secure: (process.env.SMTP_SECURE === 'true') || false,
      auth: (process.env.SMTP_USER && process.env.SMTP_PASS) ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });

    const from = process.env.EMAIL_FROM || '"Shoe Pao" <noreply@shoe-pao-special.firebaseapp.com>';
    const displayLink = (typeof shortRedirect !== 'undefined') ? shortRedirect : link;
    let displayText = displayLink;
    if (typeof shortRedirect === 'undefined') {
      displayText = displayText.replace(/^https?:\/\//, '');
      if (displayText.length > 72) displayText = displayText.slice(0,72) + '...';
    }

    const html = `
      <div style="font-family: Arial, sans-serif; color: #222;">
        <h2>Shoe Pao Password Reset</h2>
        <p>Hello,</p>
        <p>We received a request to change the password for this account. Click the button below to continue:</p>
        <p style="text-align:center"><a href="${displayLink}" style="display:inline-block;padding:12px 20px;background:#b71c1c;color:#fff;border-radius:6px;text-decoration:none;">Change password</a></p>
        <p>If the button doesn't work, paste this link into your browser:</p>
        <p><a href="${displayLink}">${displayText}</a></p>
        <p>If you didn't request a password change, you can ignore this email.</p>
        <p>Thanks,<br>Your Shoe Pao team</p>
      </div>`;

    await transporter.sendMail({ from: from, to: email, subject: 'Reset your Shoe Pao password', html: html });
    return res.json({ ok: true });
  }catch(err){
    console.error('send-password-reset failed', err);
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// Dev helper: generate a password reset link via Admin SDK and return a short redirect for testing
app.post('/api/generate-password-reset', async (req, res) => {
  const body = req.body || {};
  const email = (body.email || '').toString().trim();
  const returnUrl = body.returnUrl || process.env.BASE_URL || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : ''));
  if (!email) return res.status(400).json({ error: 'email required' });
  try{
    if (!admin) {
      try{ admin = require('firebase-admin'); if(!admin.apps || !admin.apps.length) admin.initializeApp(); }catch(e){ console.warn('firebase-admin not available', e); }
    }
    if (!admin) return res.status(500).json({ error: 'firebase-admin not initialized' });

  // Force in-app reset flow so server-generated links open our reset page which
  // runs the confirmPasswordReset client flow and notifies the server when done.
  const actionCodeSettings = { url: (returnUrl || '') + '/reset-password.html?next=login', handleCodeInApp: true };
  const link = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);

    // create short mapping
    let shortRedirect;
    try{
      const shortId = crypto.randomBytes(4).toString('hex');
      const createdAt = new Date().toISOString();
      try{ db.prepare('INSERT INTO ShortLinks (id, target, created_at) VALUES (?,?,?)').run(shortId, link, createdAt); }catch(e){ console.warn('ShortLinks insert failed', e); }
      const base = (process.env.BASE_URL || returnUrl || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : '')) ).replace(/\/$/, '');
      shortRedirect = base + '/r/' + shortId;
    }catch(e){ console.warn('Failed to create short redirect', e); }

    return res.json({ ok: true, link: link, shortRedirect: shortRedirect });
  }catch(err){ console.error('generate-password-reset failed', err); return res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// Create a short, server-issued password reset token (not Firebase) and optionally email it.
// This token is stored server-side and can be used to directly update the user's password via Admin SDK.
app.post('/api/create-reset-token', async (req, res) => {
  const body = req.body || {};
  const email = (body.email || '').toString().trim().toLowerCase();
  const returnUrl = body.returnUrl || process.env.BASE_URL || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : ''));
  if(!email) return res.status(400).json({ error: 'email required' });
  try{
    const token = crypto.randomBytes(16).toString('hex');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (1000 * 60 * 60)).toISOString(); // 1 hour
    try{ db.prepare('INSERT INTO PasswordResetTokens (token,email,used,created_at,expires_at) VALUES (?,?,?,?,?)').run(token, email, 0, createdAt, expiresAt); }catch(e){ console.warn('PasswordResetTokens insert failed', e); }

    // Build a direct reset URL to the app reset page with our token
    const base = (process.env.BASE_URL || returnUrl || ('http://localhost' + (process.env.PORT ? (':' + process.env.PORT) : '')) ).replace(/\/$/, '');
    const resetUrl = base + '/reset-password.html?token=' + encodeURIComponent(token);

    // Try to send email if SMTP is configured; otherwise, return the resetUrl so the client can display it
    let nodemailer;
    try{ nodemailer = require('nodemailer'); }catch(e){ nodemailer = null; }
    if(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS){
      try{
        const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: (process.env.SMTP_SECURE === 'true') || false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
        const from = process.env.EMAIL_FROM || '"Shoe Pao" <noreply@shoe-pao-special.firebaseapp.com>';
        const html = `<div style="font-family: Arial, sans-serif; color:#222"><p>Hello,</p><p>Click the button below to reset your password:</p><p style="text-align:center"><a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#b71c1c;color:#fff;border-radius:6px;text-decoration:none;">Reset password</a></p><p>If you did not request this, ignore this email.</p></div>`;
        await transporter.sendMail({ from: from, to: email, subject: 'Reset your Shoe Pao password', html: html });
        return res.json({ ok: true });
      }catch(e){ console.warn('send email failed for reset token', e); return res.json({ ok: true, resetUrl: resetUrl }); }
    }

    return res.json({ ok: true, resetUrl: resetUrl });
  }catch(err){ console.error('create-reset-token failed', err); return res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// Confirm a server-issued reset token and set a new password using firebase-admin
app.post('/api/confirm-reset', async (req, res) => {
  const body = req.body || {};
  const token = (body.token || '').toString().trim();
  const newPassword = (body.password || '').toString();
  if(!token || !newPassword) return res.status(400).json({ error: 'token and password required' });
  try{
    const row = db.prepare('SELECT email, used, expires_at FROM PasswordResetTokens WHERE token = ?').get(token);
    if(!row) return res.status(400).json({ error: 'invalid token' });
    if(row.used) return res.status(400).json({ error: 'token already used' });
    if(new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'token expired' });

    if(!admin) {
      try{ admin = require('firebase-admin'); if(!admin.apps || !admin.apps.length) admin.initializeApp(); }catch(e){ console.warn('firebase-admin not initialized', e); }
    }
    if(!admin) return res.status(500).json({ error: 'firebase-admin not available' });

    const user = await admin.auth().getUserByEmail(row.email);
    await admin.auth().updateUser(user.uid, { password: newPassword });
    // mark token used
    try{ db.prepare('UPDATE PasswordResetTokens SET used = 1 WHERE token = ?').run(token); }catch(e){ console.warn('mark token used failed', e); }
    return res.json({ ok: true });
  }catch(err){ console.error('confirm-reset failed', err); return res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// Record that a password reset was completed for an email (client informs server).
// This is intentionally lightweight: it simply stores an event the client page can poll
// to detect cross-device password resets. No auth required, but entries should be
// short-lived and are meant for UX only.
app.post('/api/password-reset-event', async (req, res) => {
  try{
    const body = req.body || {};
    const email = (body.email || '').toString().trim().toLowerCase();
    if(!email) return res.status(400).json({ error: 'email required' });
    const createdAt = new Date().toISOString();
    try{ db.prepare('INSERT INTO PasswordResetEvents (email, created_at) VALUES (?,?)').run(email, createdAt); }catch(e){ console.warn('insert PasswordResetEvents failed', e); }
    return res.json({ ok: true });
  }catch(err){ console.error('password-reset-event failed', err); return res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// Query whether a password reset event exists for an email within a recent timeframe.
app.get('/api/password-reset-status', async (req, res) => {
  try{
    const email = (req.query.email || '').toString().trim().toLowerCase();
    if(!email) return res.status(400).json({ error: 'email required' });
    // Return the most recent event for this email, if any
    try{
      const row = db.prepare('SELECT created_at FROM PasswordResetEvents WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email);
      if(!row) return res.json({ changed: false });
      return res.json({ changed: true, at: row.created_at });
    }catch(e){ console.warn('PasswordResetEvents lookup failed', e); return res.status(500).json({ error: 'db error' }); }
  }catch(err){ console.error('password-reset-status failed', err); return res.status(500).json({ error: String(err && err.message ? err.message : err) }); }
});

// Create a tracker
async function aftershipCreateTracker(slug, trackingNumber, title){
  const payload = { tracking: { tracking_number: String(trackingNumber || ''), slug: String(slug || '').toLowerCase(), title: title || '' } };
  return aftershipRequest('POST', '/v4/trackings', payload).then(r => r).catch(err => { throw err; });
}

// Get tracker details
async function aftershipGetTracker(slug, trackingNumber){
  const p = '/v4/trackings/' + encodeURIComponent(slug || '') + '/' + encodeURIComponent(trackingNumber || '');
  return aftershipRequest('GET', p).then(r => r).catch(err => { throw err; });
}

function mapAftershipTagToOrderStatus(tag){
  if(!tag) return null;
  var t = String(tag||'').toLowerCase();
  if(t.indexOf('delivered') !== -1) return 'delivered';
  if(t.indexOf('out_for_delivery') !== -1 || t.indexOf('out for delivery') !== -1) return 'out for delivery';
  if(t.indexOf('in_transit') !== -1 || t.indexOf('in transit') !== -1) return 'in transit';
  if(t.indexOf('picked_up') !== -1 || t.indexOf('picked up') !== -1) return 'picked up';
  if(t.indexOf('exception') !== -1 || t.indexOf('failed') !== -1) return 'exception';
  if(t.indexOf('pending') !== -1 || t.indexOf('info_received') !== -1) return 'processing';
  return null;
}

// Server-side canonicalization and transition guard
function canonicalizeStatus(s){
  if(!s) return '';
  const k = String(s).toLowerCase().trim();
  if(k.indexOf('delivered') !== -1) return 'delivered';
  if(k.indexOf('out for delivery') !== -1 || k.indexOf('out_for_delivery') !== -1) return 'out for delivery';
  if(k.indexOf('in transit') !== -1 || k.indexOf('in_transit') !== -1) return 'in transit';
  if(k.indexOf('picked') !== -1 || k === 'picked_up') return 'picked up';
  if(k === 'shipped') return 'shipped';
  if(k === 'processing' || k === 'confirmed' || k === 'preparing' || k.indexOf('prepare') !== -1) return 'processing';
  if(k === 'pending' || k.indexOf('pending') !== -1) return 'pending payment';
  if(k === 'cancelled' || k === 'canceled') return 'cancelled';
  if(k === 'refunded') return 'refunded';
  if(k === 'archived') return 'archived';
  return s;
}

function serverCanTransition(current, next){
  // very conservative transition map to avoid jumping straight to delivered
  const allowed = {
    'pending payment': ['confirmed','cancelled'],
    'confirmed': ['processing','cancelled'],
    'processing': ['shipped','cancelled','refunded'],
    'shipped': ['out for delivery','picked up','delivered','in transit'],
    'picked up': ['in transit','out for delivery','delivered'],
    'in transit': ['out for delivery','delivered'],
    'out for delivery': ['delivered'],
    'delivered': ['archived'],
    'refund requested': ['refunded'],
    'refunded': ['archived'],
    'cancelled': ['archived'],
    'archived': []
  };
  const cur = String(current || '').toLowerCase();
  const nxt = String(next || '').toLowerCase();
  if(!cur) return true; // unknown current -> allow
  if(cur === nxt) return true;
  const allowedTo = allowed[cur] || [];
  if(allowedTo.indexOf(nxt) !== -1) return true;
  // allow promotion to intermediate states like 'picked up' from 'shipped'
  return false;
}

// Best-effort: sync order status to Firestore using firebase-admin if available and configured
async function syncOrderStatusToFirestore(orderId, status){
  try{
    const admin = require('firebase-admin');
    if(!admin) return;
    if(!admin.apps || !admin.apps.length){
      try{ admin.initializeApp(); }catch(e){ console.warn('firebase-admin init failed', e); return; }
    }
    const fdb = admin.firestore();
    try{
      await fdb.collection('orders').doc(String(orderId)).set({ status: status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }catch(e){
      // fallback: try to find doc where field id == orderId
      try{
        const q = await fdb.collection('orders').where('id','==',String(orderId)).limit(1).get();
        if(!q.empty){ await q.docs[0].ref.set({ status: status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
      }catch(err){ console.warn('failed to sync order status via fallback', err); }
    }
  }catch(e){ /* silent */ }
}

function nowIso(){
  return new Date().toISOString();
}

function maybeParseJson(s){
  try{
    if (typeof s === 'string'){
      const t = s.trim();
      if ((t.startsWith('{') || t.startsWith('['))) return JSON.parse(s);
    }
  }catch(e){}
  return s;
}

// OpenRouteService routing removed: routing helper functions were removed per user request.
// If routing is re-introduced later, add server-side helpers here and ensure the API key
// is only read from environment or secure config.

function ensureSqlSafeString(v){
  // If a structured object/array was passed for a textual field (e.g. delivery address),
  // store it as a JSON string so sqlite bindings receive a string.
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try{ return JSON.stringify(v); }catch(e){ return String(v); }
}

function normalizeStatus(s){
  return String(s || '').trim();
}

function generateOrderId(){
  const rand = Math.floor(Math.random() * 900000 + 100000);
  const year = new Date().getFullYear().toString().slice(-2);
  return `ORD${year}${rand}`;
}

function generateTrackingNumber(orderId){
  // Simple readable tracking id for dev: TRK + base36 timestamp + random
  try{
    return 'TRK' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*90000+10000).toString(36).toUpperCase();
  }catch(e){
    return 'TRK' + Math.floor(Math.random()*900000000 + 100000000);
  }
}

// Generate a random human-readable location for simulation/tracking events
function getRandomLocation(order){
  const samples = [
    'Quezon City, NCR', 'Makati, NCR', 'Pasig, NCR', 'Taguig, NCR', 'Manila, NCR',
    'Caloocan, NCR', 'Quezon Province', 'Laguna Province', 'Rizal Province',
    'Cebu City, Cebu', 'Lapu-Lapu, Cebu', 'Iloilo City, Iloilo', 'Davao City, Davao'
  ];
  try{
    // Prefer to pick near delivery city if available
    if(order && (order.city || (order.deliveryAddress && order.deliveryAddress.city))){
      const city = (order.city || (order.deliveryAddress && order.deliveryAddress.city) || '').toString().toLowerCase();
      for(const s of samples){ if(s.toLowerCase().indexOf(city) !== -1) return s; }
    }
  }catch(e){}
  return samples[Math.floor(Math.random() * samples.length)];
}

// Generate a simple route (array of location strings) from a fixed pickup origin to the
// order's delivery address. This is a heuristic generator for dev simulation only.
function generateRouteForOrder(order, steps){
  // default pickup origin (can be customized)
  // Use ShoePao pickup origin as the canonical starting location for "Picked up" events
  const ORIGIN = 'Blk 15 Lot 25 Phase 2 MV Villar Avenue Camella Springville Central Molino 3 , Bacoor, Philippines, 4102';
  steps = Number(steps) || 5;
  try{
    // Attempt to parse structured delivery address if stored as JSON string
    let destObj = null;
    if(order){
      if(order.delivery_address && typeof order.delivery_address === 'string'){
        try{ destObj = JSON.parse(order.delivery_address); }catch(e){ destObj = null; }
      }
      if(!destObj && order.deliveryAddress) destObj = order.deliveryAddress;
      // If still a string, attempt to split into parts
      if(!destObj && order.delivery_address && typeof order.delivery_address === 'string'){
        const parts = order.delivery_address.split(',').map(p=>p.trim()).filter(Boolean);
        destObj = { raw: order.delivery_address, parts };
      }
    }

    // Extract city/province/street tokens when available
    const destCity = (destObj && (destObj.city || (destObj.parts && destObj.parts.slice(-2,-1)[0]) || destObj.parts && destObj.parts.slice(-3,-2)[0])) || '';
    const destProvince = (destObj && (destObj.province || destObj.region || (destObj.parts && destObj.parts.slice(-2)[0]))) || '';
    const destStreet = (destObj && (destObj.street || destObj.line1 || (destObj.parts && destObj.parts[0]))) || (destObj && destObj.raw) || '';

    // Build route waypoints (tuned to match 5 simulation steps by default)
    const route = [];
    // Step 1: Pickup
    route.push(ORIGIN);
    // Step 2: Pickup hub / loaded
    route.push('Caloocan Local Hub - Loaded Truck');
    // Step 3: Regional sorting center (prefer province if present)
    if(destProvince) route.push((String(destProvince).toUpperCase() + ' Sorting Center').replace(/\s+/g,' '));
    else route.push('Metro Manila Sorting Center');
    // Step 4: Arrival at destination city or out for delivery
    if(destCity) route.push('Arrived at ' + String(destCity).toUpperCase());
    else route.push('Arrived at Destination City');
    // Step 5: Final delivery point (street/barangay if available)
    if(destStreet) route.push(String(destStreet));
    else route.push('Recipient Address');

    // If requested steps differ, interpolate / trim accordingly
    if(route.length === steps) return route;
    if(route.length > steps) return route.slice(0, steps);
    // route shorter than steps: pad by duplicating last element or using random nearby
    while(route.length < steps){
      route.splice(route.length-1, 0, route[route.length-1] + ' - In transit');
    }
    return route;
  }catch(e){
    // fallback to repeated random locations
    const out = [];
    for(let i=0;i<steps;i++) out.push(getRandomLocation(order||{}));
    return out;
  }
}

// Serve order details page for /orders/:orderId
app.get('/orders/:orderId', (req, res) => {
  res.sendFile(path.join(__dirname, 'order-detail.html'));
});

// Shop route
app.get('/shop', (req, res) => {
  res.sendFile(path.join(__dirname, 'product-list.html'));
});

// List orders (optional): /api/orders?userId=... (admin can omit to get all)
app.get('/api/orders', (req, res) => {
  const userId = req.query.userId || '';
  const sql = userId
    ? 'SELECT * FROM Orders WHERE user_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM Orders ORDER BY created_at DESC';
  const rows = userId ? db.prepare(sql).all(userId) : db.prepare(sql).all();
  // attempt to parse stored JSON address fields so clients receive structured objects when appropriate
  const fixed = rows.map(r => ({ ...r, delivery_address: maybeParseJson(r.delivery_address) }));
  res.json({ orders: fixed });
});

// Lightweight health check used by the PHP proxy and client-side pings to ensure the
// Node server is up. Returns 200 with a small JSON payload.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, now: new Date().toISOString(), env: process.env.NODE_ENV || 'development' });
});

// Existence check (returns 200 with { exists: true/false }) to avoid 404 noise from clients
app.get('/api/orders/:orderId/exists', (req, res) => {
  const id = req.params.orderId;
  try{
    const order = db.prepare('SELECT 1 as found FROM Orders WHERE id = ?').get(id);
    return res.json({ exists: !!order });
  }catch(e){ return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// Get order by id
app.get('/api/orders/:orderId', (req, res) => {
  const id = req.params.orderId;
  const order = db.prepare('SELECT * FROM Orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // parse delivery address JSON if present
  order.delivery_address = maybeParseJson(order.delivery_address);
  const items = db.prepare('SELECT product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(id);
  res.json({ order, items });
});

// Get tracking events
app.get('/api/orders/:orderId/tracking', (req, res) => {
  const id = req.params.orderId;
  const tracking = db.prepare('SELECT status, message, timestamp, location FROM OrderTracking WHERE order_id = ? ORDER BY timestamp ASC').all(id);
  // If an external tracking number exists for this order, try to fetch latest AfterShip data too
  try{
    const order = db.prepare('SELECT tracking_number, courier_name FROM Orders WHERE id = ?').get(id);
    if (order && order.tracking_number && AFTERSHIP_KEY) {
      // attempt to find slug from courier_name or use 'unknown'
      const slug = (order.courier_name || '').toLowerCase().replace(/\s+/g,'-') || '';
      aftershipGetTracker(slug || '','' + order.tracking_number).then(apiResp => {
        // AfterShip returns tracking object under data.tracking or tracking
        const t = apiResp && (apiResp.data && apiResp.data.tracking) ? apiResp.data.tracking : apiResp.tracking || null;
        const checkpoints = (t && Array.isArray(t.checkpoints)) ? t.checkpoints.map(cp => ({ status: cp.tag || cp.message || '', message: cp.message || '', timestamp: cp.checkpoint_time || cp.time || cp.created_at || '' })) : [];
        return res.json({ tracking, external: { tracking_number: order.tracking_number, courier: order.courier_name, checkpoints } });
      }).catch(err => {
        // on error, return DB-only
        return res.json({ tracking, error: String(err && err.message ? err.message : err) });
      });
      return;
    }
  }catch(e){ /* ignore */ }
  res.json({ tracking });
});

// OpenRouteService directions endpoint removed per user request.
// Routing and directions are disabled in this server build.

// Create an AfterShip tracker for an order (admin action)
app.post('/api/orders/:orderId/aftership/create', async (req, res) => {
  const id = req.params.orderId;
  const body = req.body || {};
  const slug = (body.courier_slug || body.courier || body.slug || '').toLowerCase();
  const trackingNumber = body.tracking_number || body.trackingNumber || body.tracking || '';
  if (!trackingNumber) return res.status(400).json({ error: 'tracking_number required' });
  if (!AFTERSHIP_KEY) return res.status(500).json({ error: 'AfterShip API key not configured' });
  try{
    const r = await aftershipCreateTracker(slug, trackingNumber, 'Order ' + id);
    // update order with courier and tracking
    db.prepare('UPDATE Orders SET courier_name = ?, tracking_number = ? WHERE id = ?').run(slug || '', trackingNumber, id);
    // insert initial tracking event
    const now = new Date().toISOString();
  db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)').run(id, 'Tracking created', 'Tracker created on AfterShip', now, getRandomLocation({}));
    return res.json({ ok: true, resp: r });
  }catch(e){ console.error('aftership create failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// Refresh AfterShip tracking for an order (force fetch)
app.post('/api/orders/:orderId/aftership/refresh', async (req, res) => {
  const id = req.params.orderId;
  const order = db.prepare('SELECT tracking_number, courier_name FROM Orders WHERE id = ?').get(id);
  if (!order || !order.tracking_number) return res.status(400).json({ error: 'Order has no tracking number' });
  if (!AFTERSHIP_KEY) return res.status(500).json({ error: 'AfterShip API key not configured' });
  const slug = (order.courier_name || '').toLowerCase().replace(/\s+/g,'-');
  try{
    const apiResp = await aftershipGetTracker(slug || '', order.tracking_number);
    const t = apiResp && (apiResp.data && apiResp.data.tracking) ? apiResp.data.tracking : apiResp.tracking || null;
    const checkpoints = (t && Array.isArray(t.checkpoints)) ? t.checkpoints : [];
    // Insert any new checkpoints into OrderTracking (avoid duplicates by timestamp+message)
    const existingRows = (db.prepare('SELECT id, status, message, timestamp, location FROM OrderTracking WHERE order_id = ?').all(id) || []).reduce((acc, r) => {
      const k = String(r.message || '') + '||' + String(r.timestamp || ''); acc[k] = r; return acc; }, {});
  const insert = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
        checkpoints.forEach(cp => {
        const msg = (cp.message || cp.tag || '');
        const ts = (cp.checkpoint_time || cp.time || cp.created_at || '');
        const key = String(msg) + '||' + String(ts);
        const existing = existingRows[key];
        if (!existing) {
          insert.run(id, (cp.tag || cp.message || ''), (cp.message || cp.tag || ''), ts || new Date().toISOString(), (cp.location || cp.city || getRandomLocation({})));
        } else {
          // if incoming differs in status/message/location, append a new timeline row instead of mutating
          const incomingStatus = (cp.tag || cp.message || '');
          const incomingMessage = (cp.message || cp.tag || '');
          const incomingLocation = (cp.location || cp.city || '');
          if (String(existing.status || '') !== String(incomingStatus) || String(existing.message || '') !== String(incomingMessage) || String(existing.location || '') !== String(incomingLocation)) {
            insert.run(id, incomingStatus, incomingMessage, ts || new Date().toISOString(), incomingLocation || getRandomLocation({}));
          }
        }
      });
    });
    tx();
    // Determine latest checkpoint and update order status if mappable (guarded)
    try{
      if (checkpoints && checkpoints.length){
        var last = checkpoints[checkpoints.length - 1];
        var tag = last.tag || last.status || last.tag || last.message || '';
        var mapped = mapAftershipTagToOrderStatus(tag);
        if(mapped){
          try{
            var curRow = db.prepare('SELECT status FROM Orders WHERE id = ?').get(id);
            var curStatus = curRow && curRow.status ? curRow.status : '';
            var mappedCanon = canonicalizeStatus(mapped) || mapped;
            if(serverCanTransition(curStatus, mappedCanon)){
              db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(mapped, id);
              try{ syncOrderStatusToFirestore(id, mapped).catch(()=>{}); }catch(e){}
            }
          }catch(e){ /* ignore transition check failure */ }
        }
      }
    }catch(e){ /* ignore */ }
    return res.json({ ok: true, checkpoints });
  }catch(e){ console.error('aftership refresh failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// AfterShip webhook receiver (configure this URL in AfterShip dashboard)
app.post('/api/aftership/webhook', (req, res) => {
  const body = req.body || {};
  try{
    // If a secret is configured, verify signature (support common header names)
    if (AFTERSHIP_SECRET) {
      try{
        const headerSig = (req.headers['aftership-signature'] || req.headers['x-aftership-signature'] || req.headers['signature'] || '').toString();
        if (!headerSig) {
          console.warn('Webhook received without signature header');
          return res.status(401).json({ error: 'missing signature' });
        }
        const raw = req.rawBody || Buffer.from(JSON.stringify(body) || '');
        const hmacHex = crypto.createHmac('sha256', String(AFTERSHIP_SECRET)).update(raw).digest('hex');
        const hmacBase64 = crypto.createHmac('sha256', String(AFTERSHIP_SECRET)).update(raw).digest('base64');
        if (headerSig !== hmacHex && headerSig !== hmacBase64) {
          console.warn('Webhook signature mismatch', headerSig, hmacHex, hmacBase64);
          return res.status(401).json({ error: 'invalid signature' });
        }
      }catch(e){ console.warn('Webhook signature verification failed', e); return res.status(401).json({ error: 'signature verification failed' }); }
    }

    // AfterShip sends data.tracking with checkpoints
    const tracking = body && (body.data && body.data.tracking) ? body.data.tracking : body.tracking || null;
    if (!tracking) {
      return res.status(200).json({ ok: true, note: 'no tracking payload' });
    }
    const tn = tracking.tracking_number || tracking.trackingNumber || tracking.tracking_number;
    if (!tn) return res.status(200).json({ ok: true, note: 'no tracking number' });
    // find order by tracking_number
    const order = db.prepare('SELECT id, status FROM Orders WHERE tracking_number = ?').get(tn);
    if (!order) return res.status(200).json({ ok: true, note: 'order not found for tracking' });
    const checkpoints = Array.isArray(tracking.checkpoints) ? tracking.checkpoints : [];
  const insert = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
  const existingRows = (db.prepare('SELECT id, status, message, timestamp, location FROM OrderTracking WHERE order_id = ?').all(order.id) || []).reduce((acc, r) => { const k = String(r.message || '') + '||' + String(r.timestamp || ''); acc[k] = r; return acc; }, {});
    // Determine if we should accept updates: if the order is already 'out for delivery' or 'delivered',
    // block further checkpoint updates unless the incoming data signals 'delivered' (so we can transition).
    const curOrderStatus = order && order.status ? String(order.status).toLowerCase() : '';
    const statusLocked = (curOrderStatus === 'out for delivery' || curOrderStatus === 'delivered');

    // If locked and there are checkpoints, inspect the last checkpoint's mapped status
    if (statusLocked && checkpoints && checkpoints.length) {
      const lastCp = checkpoints[checkpoints.length - 1];
      const tagCp = lastCp.tag || lastCp.status || lastCp.message || '';
      const mappedStatus = mapAftershipTagToOrderStatus(tagCp);
      // Allow only a transition to 'delivered' when locked; otherwise ignore the webhook to preserve timeline
      if (mappedStatus !== 'delivered') {
        return res.status(200).json({ ok: true, note: 'skipped: order status locked at out for delivery/delivered' });
      }
      // otherwise fall through and allow insertion of the delivered checkpoint
    }

    const tx = db.transaction(() => {
      checkpoints.forEach(cp => {
        const msg = (cp.message || cp.tag || '');
        const ts = (cp.checkpoint_time || cp.time || cp.created_at || '');
        const key = String(msg) + '||' + String(ts);
        const existing = existingRows[key];
        if (!existing) {
          insert.run(order.id, (cp.tag || cp.message || ''), (cp.message || cp.tag || ''), ts || new Date().toISOString(), (cp.location || cp.city || getRandomLocation({})));
        } else {
          const incomingStatus = (cp.tag || cp.message || '');
          const incomingMessage = (cp.message || cp.tag || '');
          const incomingLocation = (cp.location || cp.city || '');
          if (String(existing.status || '') !== String(incomingStatus) || String(existing.message || '') !== String(incomingMessage) || String(existing.location || '') !== String(incomingLocation)) {
            insert.run(order.id, incomingStatus, incomingMessage, ts || new Date().toISOString(), incomingLocation || getRandomLocation({}));
          }
        }
      });
    });
    try{ tx();
      // update order status from latest checkpoint if available
      if (checkpoints && checkpoints.length){
        var lastCp = checkpoints[checkpoints.length - 1];
        var tagCp = lastCp.tag || lastCp.status || lastCp.message || '';
        var mappedStatus = mapAftershipTagToOrderStatus(tagCp);
        if(mappedStatus){
          try{
            var curRow = db.prepare('SELECT status FROM Orders WHERE id = ?').get(order.id);
            var curStatus = curRow && curRow.status ? curRow.status : '';
            var mappedCanon = canonicalizeStatus(mappedStatus) || mappedStatus;
            if(serverCanTransition(curStatus, mappedCanon)){
              db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(mappedStatus, order.id);
              try{ syncOrderStatusToFirestore(order.id, mappedStatus).catch(()=>{}); }catch(e){}
            }
          }catch(e){ /* ignore */ }
        }
      }
    }catch(e){ console.warn('webhook tx failed', e); }
    return res.status(200).json({ ok: true });
  }catch(e){ console.error('webhook handler error', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// In-memory simulation timers for dev/testing: advance order through phases every N seconds
const simulateTimers = new Map();
const SIMULATION_STEPS = ['Preparing','Picked up','In transit','Out for delivery','Delivered'];

// Start simulation for an order (dev/testing)
app.post('/api/orders/:orderId/simulate/start', (req, res) => {
  const id = req.params.orderId;
  if (simulateTimers.has(id)) return res.json({ ok: false, message: 'Simulation already running' });
  // Determine start step based on current order status so simulation begins at the
  // correct phase (e.g. start at 'Picked up' when admin marks an order 'shipped').
  let stepIndex = 0;
  const intervalMs = 1000 * 10; // 10 seconds per step
  // Prepare a route for this order (picked up outside interval so it's stable across ticks)
  const orderRow = db.prepare('SELECT id, tracking_number, delivery_address, recipient_name, status FROM Orders WHERE id = ?').get(id);
  const routeForOrder = generateRouteForOrder(orderRow || {}, SIMULATION_STEPS.length);

  // Map certain order.status values to simulation step indices
  function mapStatusToSimIndex(s){
    if(!s) return 0;
    const k = String(s).toLowerCase();
    if(k.indexOf('deliver') !== -1 || k === 'delivered') return SIMULATION_STEPS.indexOf('Delivered');
    if(k.indexOf('out for delivery') !== -1 || k.indexOf('out_for_delivery') !== -1) return SIMULATION_STEPS.indexOf('Out for delivery');
    if(k.indexOf('in transit') !== -1 || k.indexOf('in_transit') !== -1) return SIMULATION_STEPS.indexOf('In transit');
    if(k.indexOf('picked') !== -1 || k === 'picked_up') return SIMULATION_STEPS.indexOf('Picked up');
    if(k === 'shipped') return SIMULATION_STEPS.indexOf('Picked up');
    if(k === 'processing' || k === 'confirmed' || k === 'preparing') return SIMULATION_STEPS.indexOf('Preparing');
    return 0;
  }

  if(orderRow && orderRow.status){
    const idx = mapStatusToSimIndex(orderRow.status);
    if(typeof idx === 'number' && idx >= 0 && idx < SIMULATION_STEPS.length) {
      // Start simulation at the mapped index (so first inserted step matches admin status progression)
      stepIndex = idx;
    }
  }

  // Also consider existing tracking events so we continue the simulation from the
  // last recorded checkpoint instead of restarting earlier steps. This prevents
  // the UI from jumping back to 'Order placed' when admin starts simulation
  // after some steps already exist.
  try{
    const lastEv = db.prepare('SELECT status FROM OrderTracking WHERE order_id = ? ORDER BY timestamp DESC LIMIT 1').get(id);
    if(lastEv && lastEv.status){
      const s = String(lastEv.status || '').trim();
      // normalize common messages like 'Tracking assigned' out of consideration
      if(s.toLowerCase().indexOf('tracking assigned') === -1){
        // find index of this status within simulation steps
        const evIndex = SIMULATION_STEPS.findIndex(step => step.toLowerCase() === s.toLowerCase());
        if(evIndex !== -1){
          // continue from next step after the latest checkpoint
          stepIndex = Math.max(stepIndex, evIndex + 1);
        }
      }
    }
  }catch(e){ /* ignore DB read issues and fall back to status mapping */ }

  console.log('Starting simulation for order', id, 'route:', routeForOrder, 'starting at step index', stepIndex);
  // If we've already completed all simulation steps, nothing to do.
  if (stepIndex >= SIMULATION_STEPS.length) return res.json({ ok: false, message: 'No simulation steps remain' });

  const t = setInterval(() => {
    try{
      const order = db.prepare('SELECT id, tracking_number FROM Orders WHERE id = ?').get(id);
      if (!order) { clearInterval(t); simulateTimers.delete(id); return; }
      if (stepIndex >= SIMULATION_STEPS.length) { clearInterval(t); simulateTimers.delete(id); return; }
      const step = SIMULATION_STEPS[stepIndex++];
      const now = new Date().toISOString();
      // insert tracking checkpoint (with generated location)
      try{
        // choose location from the precomputed route (match step index)
        // Do not include a location for the early online steps 'Order placed' and 'Preparing'.
        let location = '';
        if (step !== 'Order placed' && step !== 'Preparing'){
          location = (routeForOrder && routeForOrder.length > 0) ? (routeForOrder[Math.max(0, Math.min(routeForOrder.length - 1, stepIndex - 1))]) : getRandomLocation({});
          // Ensure 'Picked up' uses the canonical origin when available
          if(step === 'Picked up') location = SHOEPAO_ORIGIN;
        }
        db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)').run(id, step, step, now, location);
      }catch(e){ }
      // update order status
      try{ db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(step, id); }catch(e){}
      // attempt Firestore sync (best-effort)
      try{ syncOrderStatusToFirestore(id, step).catch(()=>{}); }catch(e){}
      // stop after final step
      if (step === 'Delivered') { clearInterval(t); simulateTimers.delete(id); }
    }catch(e){ console.warn('simulate tick failed', e); }
  }, intervalMs);
  simulateTimers.set(id, t);
  return res.json({ ok: true, message: 'Simulation started' });
});

// Stop simulation for an order
app.post('/api/orders/:orderId/simulate/stop', (req, res) => {
  const id = req.params.orderId;
  const t = simulateTimers.get(id);
  if (t) { clearInterval(t); simulateTimers.delete(id); return res.json({ ok: true, message: 'Simulation stopped' }); }
  return res.json({ ok: false, message: 'No simulation running' });
});

// Update an order (admin convenience) - accepts partial fields and returns updated order
app.put('/api/orders/:orderId', (req, res) => {
  try{
    const id = req.params.orderId;
    const body = req.body || {};
    const allowed = ['status','courier_name','tracking_number','recipient_name','recipient_phone','delivery_address'];
    const setParts = [];
    const params = [];
    allowed.forEach(k => {
      if(Object.prototype.hasOwnProperty.call(body, k)){
        setParts.push(k + ' = ?');
        params.push(body[k] === null || body[k] === undefined ? '' : String(body[k]));
      }
    });
    if(setParts.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
    params.push(id);
  const sql = 'UPDATE Orders SET ' + setParts.join(', ') + ' WHERE id = ?';
  // Ensure the prepared statement's run() is invoked with the statement as `this`.
  // Using apply(null, params) can break bindings inside the sqlite3 wrapper and
  // cause a runtime error (500). Bind correctly using the statement as the thisArg.
  const stmt = db.prepare(sql);
  stmt.run.apply(stmt, params);
    const saved = db.prepare('SELECT * FROM Orders WHERE id = ?').get(id);
    if(saved) saved.delivery_address = maybeParseJson(saved.delivery_address);
    return res.json({ ok: true, order: saved });
  }catch(e){ console.error('order update failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

// Create order
app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const orderId = body.id || generateOrderId();
  const createdAt = body.created_at || nowIso();
  // derive tracking number (auto-generate if not supplied)
  let trackingNum = body.tracking_number || body.trackingNumber || body.tracking || '';
  if(!trackingNum){ trackingNum = generateTrackingNumber(orderId); }

  // derive courier name from provided fields or deliveryCode mapping
  let courierName = body.courier_name || body.courierName || body.courier || '';
  if(!courierName){
    const dc = String(body.deliveryCode || body.delivery_code || '').toLowerCase();
    if(dc === 'personal') courierName = 'Personal Delivery';
    else if(dc === 'lalamove') courierName = 'Lalamove';
    else if(dc === 'jnt') courierName = 'J&T Express';
    else if(dc === 'jrs') courierName = 'JRS';
  }

  // ensure user_id is a primitive or JSON string
  let userIdVal = body.user_id || body.userId || body.email || null;
  if (userIdVal !== null && (typeof userIdVal !== 'string' && typeof userIdVal !== 'number' && typeof userIdVal !== 'bigint')) {
    userIdVal = ensureSqlSafeString(userIdVal);
  }

  const order = {
    id: orderId,
    user_id: userIdVal,
    status: normalizeStatus(body.status || 'Order placed'),
    total: Number(body.total || 0),
    shipping_fee: Number(body.shipping_fee || body.shippingFee || 0),
    discount: Number(body.discount || 0),
    payment_method: body.payment_method || body.paymentMethod || body.paymentLabel || '',
    created_at: createdAt,
    delivery_address: ensureSqlSafeString(body.delivery_address || body.deliveryAddress || body.shippingAddress || ''),
    recipient_name: ensureSqlSafeString(body.recipient_name || body.recipientName || body.customerName || ''),
    recipient_phone: ensureSqlSafeString(body.recipient_phone || body.recipientPhone || body.customerPhone || ''),
    courier_name: courierName,
    tracking_number: trackingNum
  };

  const items = Array.isArray(body.items) ? body.items : [];
  const tracking = Array.isArray(body.tracking) ? body.tracking : [{
    status: 'Order placed',
    message: 'Order placed',
    timestamp: createdAt
  }];

  // ensure we include an initial tracking assignment event when a tracking number exists
  if(trackingNum){
    tracking.push({ status: 'Tracking assigned', message: 'Tracking number: ' + trackingNum, timestamp: createdAt });
  }

  const insertOrder = db.prepare(`
    INSERT INTO Orders (id, user_id, status, total, shipping_fee, discount, payment_method, created_at, delivery_address, recipient_name, recipient_phone, courier_name, tracking_number)
    VALUES (@id, @user_id, @status, @total, @shipping_fee, @discount, @payment_method, @created_at, @delivery_address, @recipient_name, @recipient_phone, @courier_name, @tracking_number)
  `);
  const insertItem = db.prepare(`
    INSERT INTO OrderItems (order_id, product_id, name, price, qty, image_url)
    VALUES (@order_id, @product_id, @name, @price, @qty, @image_url)
  `);
  const insertTracking = db.prepare(`
    INSERT INTO OrderTracking (order_id, status, message, timestamp, location)
    VALUES (@order_id, @status, @message, @timestamp, @location)
  `);

  const tx = db.transaction(() => {
    // Sanitize and restrict the bound parameters to primitive types that sqlite accepts.
    const insertParams = {
      id: String(order.id || ''),
      user_id: (order.user_id === null || order.user_id === undefined) ? null : String(order.user_id),
      status: String(order.status || ''),
      total: Number(order.total || 0),
      shipping_fee: Number(order.shipping_fee || 0),
      discount: Number(order.discount || 0),
      payment_method: String(order.payment_method || ''),
      created_at: String(order.created_at || nowIso()),
      delivery_address: String(order.delivery_address || ''),
      recipient_name: String(order.recipient_name || ''),
      recipient_phone: String(order.recipient_phone || ''),
      courier_name: String(order.courier_name || ''),
      tracking_number: String(order.tracking_number || '')
    };

    // Defensive check: coerce any remaining non-primitive values and log which keys were coerced
    Object.keys(insertParams).forEach(k => {
      const v = insertParams[k];
      const t = typeof v;
      const isBuffer = (v && typeof v === 'object' && v.buffer && v.byteLength !== undefined);
      if (!(v === null || t === 'string' || t === 'number' || t === 'bigint' || Buffer.isBuffer(v) || isBuffer)){
        try{
          console.warn('Coercing order.insert param to string for sqlite bind:', k, 'type:', t);
        }catch(e){}
        insertParams[k] = ensureSqlSafeString(v);
      }
    });

    // Log the shaped params (types and truncated values) to help debug binding issues.
    try{
      const types = Object.fromEntries(Object.keys(insertParams).map(k => [k, typeof insertParams[k]]));
      const preview = Object.fromEntries(Object.keys(insertParams).map(k => [k, (insertParams[k] === null ? null : (String(insertParams[k]).slice(0, 200)))]));
      console.log('Inserting Order - param types:', types);
      console.log('Inserting Order - param preview:', preview);
    }catch(e){}

    insertOrder.run(insertParams);
    items.forEach(it => {
      const prodIdRaw = (it.product_id || it.productId || it.id || it.sku || null);
      const itemParams = {
        order_id: orderId,
        product_id: prodIdRaw == null ? null : String(prodIdRaw),
        name: String(it.name || it.title || ''),
        price: Number(it.price || 0),
        qty: Number(it.qty || it.quantity || 1),
        image_url: String(it.image_url || it.image || it.imageUrl || it.img || '')
      };
      // defensive coercion for item params
      Object.keys(itemParams).forEach(k => {
        const v = itemParams[k];
        const t = typeof v;
        if (!(v === null || t === 'string' || t === 'number' || t === 'bigint' || Buffer.isBuffer(v))){
          try{ console.warn('Coercing OrderItem param to string for sqlite bind:', k, 'type:', t); }catch(e){}
          itemParams[k] = ensureSqlSafeString(v);
        }
      });
      insertItem.run(itemParams);
    });
    tracking.forEach(ev => {
      insertTracking.run({
        order_id: orderId,
        status: normalizeStatus(ev.status || ev.message || ''),
        message: ev.message || ev.status || '',
        timestamp: ev.timestamp || nowIso(),
        location: ev.location || ev.location_name || getRandomLocation({})
      });
    });
  });

  try {
    tx();
    // Return the authoritative server copy so clients (admin/client) immediately receive generated fields
    try{
      const saved = db.prepare('SELECT * FROM Orders WHERE id = ?').get(orderId);
      if(saved){ saved.delivery_address = maybeParseJson(saved.delivery_address); }
      const itemsSaved = db.prepare('SELECT product_id, name, price, qty, image_url FROM OrderItems WHERE order_id = ?').all(orderId);
      return res.status(201).json({ orderId, order: saved, items: itemsSaved });
    }catch(e){ return res.status(201).json({ orderId }); }
  } catch (e) {
    console.error('Create order failed', e && (e.stack || e.message || e));
    // Provide more actionable error in dev; map common SQLite constraint errors to 409
    try{
      var msg = e && (e.message || String(e)) || 'Failed to create order';
      if(msg.toLowerCase().indexOf('unique') !== -1 || msg.toLowerCase().indexOf('constraint') !== -1) return res.status(409).json({ error: msg });
      return res.status(500).json({ error: msg });
    }catch(_){ return res.status(500).json({ error: 'Failed to create order' }); }
  }
});

// Dev-only migration: assign tracking numbers to existing orders missing them
// Usage: POST /api/orders/migrate-assign-tracking?confirm=1
app.post('/api/orders/migrate-assign-tracking', (req, res) => {
  try{
    const confirmed = (req.query && String(req.query.confirm || '').toLowerCase()) === '1' || req.body && req.body.confirm === true;
    if(!confirmed) return res.status(400).json({ error: 'Confirmation required. Call with ?confirm=1 to run.' });
    const rows = db.prepare("SELECT id, courier_name, tracking_number FROM Orders WHERE tracking_number IS NULL OR tracking_number = ''").all();
  const insertTracking = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
    const updateOrder = db.prepare('UPDATE Orders SET tracking_number = ?, courier_name = ? WHERE id = ?');
    const now = new Date().toISOString();
    const results = [];
    const tx = db.transaction(() => {
      rows.forEach(r => {
        const tn = generateTrackingNumber(r.id);
        const courier = r.courier_name || '';
        updateOrder.run(tn, courier, r.id);
  insertTracking.run(r.id, 'Tracking assigned', 'Tracking number: ' + tn, now, getRandomLocation(r));
        results.push({ id: r.id, tracking_number: tn });
      });
    });
    tx();
    return res.json({ ok: true, count: results.length, assigned: results });
  }catch(e){ console.error('migration failed', e); return res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

app.listen(PORT, () => {
  console.log(`ShoePao server running on http://localhost:${PORT}`);
});

// Global handlers to surface and log otherwise-unhandled errors so the server doesn't
// silently exit in development. In production, prefer a process manager (pm2/nssm)
// to restart on crashes and collect logs.
process.on('uncaughtException', (err) => {
  try { console.error('UNCAUGHT_EXCEPTION:', err && (err.stack || err.message || err)); } catch (e) { /* ignore */ }
  // Don't call process.exit here in dev; let the process stay alive so the proxy
  // and local tooling can continue to interrogate and debug. Use an external
  // process manager to restart on failure in production.
});

process.on('unhandledRejection', (reason, p) => {
  try { console.error('UNHANDLED_REJECTION:', reason); } catch (e) { /* ignore */ }
});

// Periodic poller to refresh tracking statuses for orders with tracking numbers
if (AFTERSHIP_KEY) {
  // If webhook secret is configured, rely primarily on webhooks and poll less frequently (hourly).
  const pollIntervalMs = AFTERSHIP_SECRET ? (1000 * 60 * 60) : (1000 * 60 * 5);
  setInterval(async () => {
    try{
      const rows = db.prepare("SELECT id, tracking_number, courier_name FROM Orders WHERE tracking_number IS NOT NULL AND tracking_number <> ''").all();
      for (const r of rows) {
        try{
          const slug = (r.courier_name || '').toLowerCase().replace(/\s+/g,'-');
          const apiResp = await aftershipGetTracker(slug || '', r.tracking_number);
          const t = apiResp && (apiResp.data && apiResp.data.tracking) ? apiResp.data.tracking : apiResp.tracking || null;
          const checkpoints = (t && Array.isArray(t.checkpoints)) ? t.checkpoints : [];
          if (checkpoints.length) {
                // If the order is already 'out for delivery' or 'delivered', avoid changing its timeline
                // unless the latest checkpoint maps to 'delivered' (so we can record final delivery).
                const curRowStatus = db.prepare('SELECT status FROM Orders WHERE id = ?').get(r.id);
                const curOrderStatus = curRowStatus && curRowStatus.status ? String(curRowStatus.status).toLowerCase() : '';
                const statusLocked = (curOrderStatus === 'out for delivery' || curOrderStatus === 'delivered');
                if (statusLocked) {
                  const lastCp = checkpoints[checkpoints.length - 1];
                  const mapped = mapAftershipTagToOrderStatus(lastCp && (lastCp.tag || lastCp.status || lastCp.message));
                  if (mapped !== 'delivered') {
                    // skip updates for locked orders to preserve timeline; continue to next order
                    continue;
                  }
                  // otherwise allow processing so delivered event is recorded
                }
                const existingRows = (db.prepare('SELECT id, status, message, timestamp, location FROM OrderTracking WHERE order_id = ?').all(r.id) || []).reduce((acc, row) => { const k = String(row.message || '') + '||' + String(row.timestamp || ''); acc[k] = row; return acc; }, {});
            const insert = db.prepare('INSERT INTO OrderTracking (order_id, status, message, timestamp, location) VALUES (?, ?, ?, ?, ?)');
            const tx = db.transaction(() => {
              checkpoints.forEach(cp => {
                      const msg = (cp.message || cp.tag || '');
                      const ts = (cp.checkpoint_time || cp.time || cp.created_at || '');
                      const key = String(msg) + '||' + String(ts);
                      const existing = existingRows[key];
                      if (!existing) {
                        insert.run(r.id, (cp.tag || cp.message || ''), (cp.message || cp.tag || ''), ts || new Date().toISOString(), (cp.location || cp.city || getRandomLocation(r)));
                      } else {
                        const incomingStatus = (cp.tag || cp.message || '');
                        const incomingMessage = (cp.message || cp.tag || '');
                        const incomingLocation = (cp.location || cp.city || '');
                        if (String(existing.status || '') !== String(incomingStatus) || String(existing.message || '') !== String(incomingMessage) || String(existing.location || '') !== String(incomingLocation)) {
                          insert.run(r.id, incomingStatus, incomingMessage, ts || new Date().toISOString(), incomingLocation || getRandomLocation(r));
                        }
                      }
                    });
            });
              try{ tx();
                // update Orders.status to latest checkpoint mapping
                var lastCp = checkpoints[checkpoints.length - 1];
                var mapped = mapAftershipTagToOrderStatus(lastCp && (lastCp.tag || lastCp.status || lastCp.message) );
                if(mapped){
                  try{
                    var curRow = db.prepare('SELECT status FROM Orders WHERE id = ?').get(r.id);
                    var curStatus = curRow && curRow.status ? curRow.status : '';
                    var mappedCanon = canonicalizeStatus(mapped) || mapped;
                    if(serverCanTransition(curStatus, mappedCanon)){
                      db.prepare('UPDATE Orders SET status = ? WHERE id = ?').run(mapped, r.id);
                      try{ syncOrderStatusToFirestore(r.id, mapped).catch(()=>{}); }catch(e){}
                    }
                  }catch(e){ /* ignore */ }
                }
              }catch(e){ console.warn('poller tx failed', e); }
          }
        }catch(e){ /* individual order poll fail - continue */ }
      }
    }catch(e){ console.warn('tracking poller failed', e); }
  }, pollIntervalMs);
}
