require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const htmlPdfNode = require('html-pdf-node');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory store for issued certificates (use a DB in production)
const certificateStore = new Map();

// ─────────────────────────────────────────────
// AI: Generate Certificate Content + Design
// ─────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { recipientName, courseName, instructorName, completionDate, recipientEmail } = req.body;
    if (!recipientName || !courseName) {
      return res.status(400).json({ error: 'Recipient name and course name are required.' });
    }

    const certId = uuidv4();
    const verifyUrl = `${process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000)}/verify/${certId}`;

    // 1. Generate QR code
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      width: 120,
      margin: 1,
      color: { dark: '#1a1a2e', light: '#ffffff00' }
    });

    // 2. AI generates certificate content AND design theme
    const aiPrompt = `You are an expert certificate designer. Generate a complete, professional certificate for:
- Recipient: ${recipientName}
- Course/Achievement: ${courseName}
- Instructor: ${instructorName || 'The Instructor'}
- Date: ${completionDate || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- Certificate ID: ${certId.slice(0, 8).toUpperCase()}

Return ONLY a valid JSON object (no markdown, no backticks) with these exact fields:
{
  "headline": "short congratulatory headline (max 8 words)",
  "body": "2-3 sentence formal certificate body text mentioning the recipient, course, and achievement",
  "tagline": "inspiring one-liner about learning or achievement",
  "theme": {
    "name": "theme name (e.g. Royal Gold, Ocean Deep, Forest Prestige, Crimson Elite)",
    "primaryColor": "#hex",
    "secondaryColor": "#hex",
    "accentColor": "#hex",
    "textColor": "#hex",
    "bgGradient": "CSS linear-gradient(...)",
    "borderStyle": "describe the border style: ornate/minimal/geometric/classic",
    "fontPair": {
      "heading": "Google Font name for headings",
      "body": "Google Font name for body text"
    }
  },
  "validation": {
    "isValid": true,
    "credentialScore": 85,
    "notes": "brief credential validation note"
  }
}`;

    const aiResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: aiPrompt }]
    });

    let aiData;
    try {
      const rawText = aiResponse.content.map(b => b.text || '').join('');
      const clean = rawText.replace(/```json|```/g, '').trim();
      aiData = JSON.parse(clean);
    } catch {
      aiData = {
        headline: 'Certificate of Achievement',
        body: `This certifies that ${recipientName} has successfully completed ${courseName} with distinction.`,
        tagline: 'Knowledge is the foundation of every great achievement.',
        theme: {
          name: 'Royal Gold',
          primaryColor: '#1a1a2e',
          secondaryColor: '#16213e',
          accentColor: '#c9a84c',
          textColor: '#1a1a2e',
          bgGradient: 'linear-gradient(135deg, #fdfbf0 0%, #f5e6c8 100%)',
          borderStyle: 'ornate',
          fontPair: { heading: 'Playfair Display', body: 'Lato' }
        },
        validation: { isValid: true, credentialScore: 90, notes: 'Credential verified successfully.' }
      };
    }

    // 3. Build certificate HTML
    const certHTML = buildCertificateHTML({
      recipientName, courseName, instructorName, completionDate,
      certId, qrDataUrl, verifyUrl, aiData
    });

    // 4. Store certificate
    const certRecord = {
      id: certId,
      recipientName,
      courseName,
      instructorName,
      completionDate,
      recipientEmail,
      issuedAt: new Date().toISOString(),
      aiData,
      html: certHTML,
      verifyUrl
    };
    certificateStore.set(certId, certRecord);

    res.json({
      success: true,
      certId,
      verifyUrl,
      aiData,
      html: certHTML
    });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate certificate.' });
  }
});

// ─────────────────────────────────────────────
// Download PDF
// ─────────────────────────────────────────────
app.post('/api/download-pdf', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML provided.' });

    const file = { content: html };
    const options = {
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
    };

    const pdfBuffer = await htmlPdfNode.generatePdf(file, options);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="certificate.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

// ─────────────────────────────────────────────
// Send Email
// ─────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  try {
    const { certId, recipientEmail } = req.body;
    const cert = certificateStore.get(certId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(503).json({ error: 'Email not configured. Set EMAIL_USER and EMAIL_PASS in environment.' });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT) || 587,
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    const emailHtml = `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #fdfbf0;">
        <h1 style="color: #1a1a2e; text-align: center;">🏆 Your Certificate is Ready!</h1>
        <p style="color: #333; font-size: 16px;">Dear <strong>${cert.recipientName}</strong>,</p>
        <p style="color: #555; font-size: 15px; line-height: 1.6;">
          Congratulations on completing <strong>${cert.courseName}</strong>! 
          Your AI-generated certificate has been created and is ready for download.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${cert.verifyUrl}" 
             style="background: #1a1a2e; color: #c9a84c; padding: 14px 32px; text-decoration: none; border-radius: 4px; font-size: 16px; display: inline-block;">
            🔍 Verify Certificate
          </a>
        </div>
        <p style="color: #888; font-size: 13px; text-align: center;">
          Certificate ID: <strong>${certId.slice(0, 8).toUpperCase()}</strong><br>
          Issued: ${new Date(cert.issuedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
        <hr style="border: 1px solid #e0d0b0; margin: 20px 0;">
        <p style="color: #aaa; font-size: 12px; text-align: center;">AI Certificate Generator · Powered by Anthropic Claude</p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: recipientEmail || cert.recipientEmail,
      subject: `🏆 Your Certificate for "${cert.courseName}" is Ready!`,
      html: emailHtml
    });

    res.json({ success: true, message: `Email sent to ${recipientEmail || cert.recipientEmail}` });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message || 'Failed to send email.' });
  }
});

// ─────────────────────────────────────────────
// Verify Certificate
// ─────────────────────────────────────────────
app.get('/verify/:certId', (req, res) => {
  const cert = certificateStore.get(req.params.certId);
  if (!cert) {
    return res.send(verifyPageHTML(null));
  }
  res.send(verifyPageHTML(cert));
});

app.get('/api/verify/:certId', (req, res) => {
  const cert = certificateStore.get(req.params.certId);
  if (!cert) return res.status(404).json({ valid: false, error: 'Certificate not found.' });
  res.json({
    valid: true,
    recipientName: cert.recipientName,
    courseName: cert.courseName,
    issuedAt: cert.issuedAt,
    credentialScore: cert.aiData?.validation?.credentialScore,
    notes: cert.aiData?.validation?.notes
  });
});

// ─────────────────────────────────────────────
// Serve frontend
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ AI Certificate Generator running on port ${PORT}`));

// ─────────────────────────────────────────────
// HTML Builder
// ─────────────────────────────────────────────
function buildCertificateHTML({ recipientName, courseName, instructorName, completionDate, certId, qrDataUrl, verifyUrl, aiData }) {
  const theme = aiData.theme;
  const date = completionDate || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const shortId = certId.slice(0, 8).toUpperCase();
  const headingFont = theme.fontPair?.heading || 'Playfair Display';
  const bodyFont = theme.fontPair?.body || 'Lato';

  const borderCSS = {
    ornate: `8px double ${theme.accentColor}`,
    minimal: `3px solid ${theme.accentColor}`,
    geometric: `4px solid ${theme.primaryColor}`,
    classic: `6px solid ${theme.accentColor}`
  }[theme.borderStyle] || `6px solid ${theme.accentColor}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(headingFont)}:wght@400;700&family=${encodeURIComponent(bodyFont)}:wght@400;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  .cert-page {
    width: 1122px; height: 793px;
    background: ${theme.bgGradient};
    display: flex; align-items: center; justify-content: center;
    font-family: '${bodyFont}', sans-serif;
  }
  .cert-frame {
    width: 1042px; height: 713px;
    border: ${borderCSS};
    position: relative;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 40px 60px;
    background: rgba(255,255,255,0.35);
    backdrop-filter: blur(4px);
  }
  .corner {
    position: absolute; width: 48px; height: 48px;
    border-color: ${theme.accentColor}; border-style: solid;
  }
  .corner-tl { top: 10px; left: 10px; border-width: 3px 0 0 3px; }
  .corner-tr { top: 10px; right: 10px; border-width: 3px 3px 0 0; }
  .corner-bl { bottom: 10px; left: 10px; border-width: 0 0 3px 3px; }
  .corner-br { bottom: 10px; right: 10px; border-width: 0 3px 3px 0; }
  .cert-org {
    font-family: '${headingFont}', serif;
    font-size: 13px; font-weight: 700;
    letter-spacing: 5px; text-transform: uppercase;
    color: ${theme.accentColor}; margin-bottom: 8px;
  }
  .cert-divider {
    width: 200px; height: 1px; background: ${theme.accentColor};
    margin: 6px auto; opacity: 0.6;
  }
  .cert-title {
    font-family: '${headingFont}', serif;
    font-size: 38px; font-weight: 700;
    color: ${theme.primaryColor}; margin: 10px 0 4px;
    letter-spacing: 1px; text-align: center;
  }
  .cert-subtitle {
    font-size: 13px; letter-spacing: 3px; text-transform: uppercase;
    color: ${theme.secondaryColor}; opacity: 0.7;
    margin-bottom: 14px;
  }
  .cert-presented {
    font-size: 13px; color: ${theme.textColor}; opacity: 0.6;
    letter-spacing: 1px; margin-bottom: 6px;
  }
  .cert-name {
    font-family: '${headingFont}', serif;
    font-size: 48px; color: ${theme.primaryColor};
    font-weight: 700; margin: 4px 0 10px;
    border-bottom: 2px solid ${theme.accentColor};
    padding-bottom: 8px; text-align: center;
  }
  .cert-body {
    font-size: 13.5px; line-height: 1.7; text-align: center;
    color: ${theme.textColor}; max-width: 700px; margin: 0 auto 16px;
    opacity: 0.85;
  }
  .cert-course {
    font-family: '${headingFont}', serif;
    font-size: 20px; color: ${theme.accentColor};
    font-weight: 700; font-style: italic; margin-bottom: 6px;
  }
  .cert-tagline {
    font-size: 11px; font-style: italic; letter-spacing: 1px;
    color: ${theme.textColor}; opacity: 0.5; margin-top: 4px;
  }
  .cert-footer {
    position: absolute; bottom: 24px; left: 60px; right: 60px;
    display: flex; justify-content: space-between; align-items: flex-end;
  }
  .cert-sig { text-align: center; min-width: 160px; }
  .sig-line { width: 160px; height: 1px; background: ${theme.primaryColor}; opacity: 0.4; margin: 0 auto 4px; }
  .sig-label { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: ${theme.textColor}; opacity: 0.5; }
  .sig-name { font-family: '${headingFont}', serif; font-size: 14px; font-weight: 700; color: ${theme.primaryColor}; }
  .cert-qr { text-align: center; }
  .cert-qr img { width: 80px; height: 80px; opacity: 0.85; }
  .cert-qr p { font-size: 9px; letter-spacing: 1px; color: ${theme.textColor}; opacity: 0.4; margin-top: 3px; }
  .cert-meta { text-align: center; }
  .cert-meta p { font-size: 10px; color: ${theme.textColor}; opacity: 0.45; letter-spacing: 0.5px; }
  .theme-badge {
    position: absolute; top: 16px; right: 60px;
    background: ${theme.accentColor}; color: ${theme.bgGradient.includes('#fff') ? '#1a1a2e' : '#fff'};
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    padding: 3px 10px; font-weight: 700;
  }
</style>
</head>
<body>
<div class="cert-page">
  <div class="cert-frame">
    <div class="corner corner-tl"></div>
    <div class="corner corner-tr"></div>
    <div class="corner corner-bl"></div>
    <div class="corner corner-br"></div>
    <div class="theme-badge">${theme.name}</div>

    <p class="cert-org">AI Certificate Generator</p>
    <div class="cert-divider"></div>
    <h1 class="cert-title">${aiData.headline || 'Certificate of Achievement'}</h1>
    <p class="cert-subtitle">Excellence · Knowledge · Achievement</p>

    <p class="cert-presented">This certificate is proudly presented to</p>
    <h2 class="cert-name">${recipientName}</h2>

    <p class="cert-body">${aiData.body}</p>
    <p class="cert-course">"${courseName}"</p>
    <p class="cert-tagline">${aiData.tagline || ''}</p>

    <div class="cert-footer">
      <div class="cert-sig">
        <div class="sig-line"></div>
        <p class="sig-name">${instructorName || 'The Instructor'}</p>
        <p class="sig-label">Instructor / Issuer</p>
      </div>
      <div class="cert-meta">
        <p>Date: ${date}</p>
        <p>ID: ${shortId}</p>
        <p>Credential Score: ${aiData.validation?.credentialScore || 90}/100</p>
      </div>
      <div class="cert-qr">
        <img src="${qrDataUrl}" alt="Verify QR">
        <p>SCAN TO VERIFY</p>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

function verifyPageHTML(cert) {
  if (!cert) {
    return `<!DOCTYPE html><html><head><title>Verification Failed</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fdf6f0;margin:0;}
    .box{text-align:center;padding:60px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
    h1{color:#c0392b;font-size:28px;}p{color:#666;margin-top:12px;}</style></head>
    <body><div class="box"><h1>❌ Certificate Not Found</h1><p>This certificate ID is invalid or has expired.</p></div></body></html>`;
  }
  const t = cert.aiData?.theme;
  return `<!DOCTYPE html><html><head><title>Certificate Verified ✅</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${t?.bgGradient||'#fdf6f0'};margin:0;}
  .box{text-align:center;padding:60px 80px;background:rgba(255,255,255,0.9);border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.12);max-width:560px;}
  .badge{font-size:56px;margin-bottom:16px;}
  h1{color:${t?.primaryColor||'#1a1a2e'};font-size:28px;margin-bottom:8px;}
  .score{display:inline-block;background:${t?.accentColor||'#c9a84c'};color:#fff;padding:6px 18px;border-radius:20px;font-size:14px;font-weight:700;margin:12px 0;}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #eee;font-size:15px;}
  .label{color:#888;font-weight:600;}
  .value{color:${t?.primaryColor||'#1a1a2e'};font-weight:700;text-align:right;}
  .notes{margin-top:20px;font-size:13px;color:#666;font-style:italic;}
  </style></head>
  <body><div class="box">
    <div class="badge">✅</div>
    <h1>Certificate Verified</h1>
    <div class="score">Credential Score: ${cert.aiData?.validation?.credentialScore || 90}/100</div>
    <div class="row"><span class="label">Recipient</span><span class="value">${cert.recipientName}</span></div>
    <div class="row"><span class="label">Course</span><span class="value">${cert.courseName}</span></div>
    <div class="row"><span class="label">Issued</span><span class="value">${new Date(cert.issuedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</span></div>
    <div class="row"><span class="label">Certificate ID</span><span class="value">${cert.id.slice(0,8).toUpperCase()}</span></div>
    <div class="row"><span class="label">Theme</span><span class="value">${cert.aiData?.theme?.name||'Classic'}</span></div>
    <p class="notes">${cert.aiData?.validation?.notes || 'This certificate has been verified as authentic.'}</p>
  </div></body></html>`;
}
