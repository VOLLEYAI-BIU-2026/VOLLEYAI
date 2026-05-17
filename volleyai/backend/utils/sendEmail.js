// utils/sendEmail.js
const nodemailer = require("nodemailer");

async function sendEmail({ to, subject, html }) {
  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT || 587);
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;

  if (!host || !user || !pass) {
    throw new Error("Missing MAIL_HOST / MAIL_USER / MAIL_PASS in .env");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || `VolleyAI <${user}>`,
    to,
    subject,
    html,
  });

  return info;
}

module.exports = sendEmail;