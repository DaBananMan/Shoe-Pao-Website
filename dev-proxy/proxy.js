#!/usr/bin/env node
// Simple development proxy to forward requests to Snap CameraKit API
// - For local development only. Do NOT expose this publicly.
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();
const PORT = process.env.PORT || 3000;

const TARGET = process.env.CAMERA_KIT_API_TARGET || 'https://camera-kit-api.snapar.com';

// Basic health endpoint
app.get('/.health', (req, res) => res.json({ ok: true, target: TARGET }));

// Handle OPTIONS preflight for any path under /camera-kit-api
app.options('/camera-kit-api/*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  return res.sendStatus(204);
});

// Proxy middleware
app.use('/camera-kit-api', createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  pathRewrite: {
    '^/camera-kit-api': '/',
  },
  onProxyReq: (proxyReq, req, res) => {
    // If you want to inject an Authorization header for dev, set CAMERA_KIT_TOKEN env var
    const token = process.env.CAMERA_KIT_TOKEN;
    if (token) {
      proxyReq.setHeader('Authorization', `Bearer ${token}`);
    }
    // Ensure content-type is preserved for JSON bodies
  },
  onProxyRes: (proxyRes, req, res) => {
    // Add permissive CORS headers for local development
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    proxyRes.headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
    proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization';
  },
  logLevel: 'warn'
}));

app.listen(PORT, () => {
  console.log(`Dev proxy running on http://localhost:${PORT}/camera-kit-api -> ${TARGET}`);
  console.log('Set CAMERA_KIT_TOKEN env var to have the proxy add Authorization: Bearer <token> to proxied requests.');
  console.log('Health: http://localhost:%s/.health', PORT);
});
