'use strict';
const nodemailer = require('nodemailer');

function createTransport(cfg) {
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port || 587,
    secure: !!cfg.smtp_secure,
    auth:   cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined,
    tls:    { rejectUnauthorized: false },
  });
}

async function sendAlert(cfg, subject, html) {
  const transport = createTransport(cfg);
  const recipients = cfg.recipients.split(/[,;\s]+/).map(r => r.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('No recipients configured');
  await transport.sendMail({
    from:    cfg.smtp_from || cfg.smtp_user,
    to:      recipients.join(', '),
    subject,
    html,
  });
}

async function testSmtp(cfg) {
  const transport = createTransport(cfg);
  await transport.verify();
  await sendAlert(cfg, 'BattStat — SMTP Test', `
    <div style="font-family:sans-serif;padding:20px">
      <h2 style="color:#185fa5">✓ BattStat SMTP Test</h2>
      <p>Your SMTP configuration is working correctly. You will receive alerts at this address.</p>
    </div>
  `);
}

module.exports = { sendAlert, testSmtp };
