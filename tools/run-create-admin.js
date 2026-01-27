// Small launcher to set env vars safely and run the create-default-admin helper
process.env.ADMIN_DEFAULT_EMAIL = 'admin@gmail.com';
process.env.ADMIN_DEFAULT_PASSWORD = 'admin';
require('./create-default-admin.js');
