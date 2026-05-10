require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const certificateStore = new Map();

// ── Generate ──
app.post('/api/generate', async (req, res) => {
  try {
    const { recipientName, courseName, instructorName, completionDate, recipientEmail, userScore } = req.body;
    if (!recipientName || !courseName) {
      return res.status(400).json({ error: 'Recipient name and course name are required.' });
    }

    const certId = uuidv4();
    const verifyUrl = `${process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000)}/verify/${certId}`;

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      width: 120, margin: 1,
      color: { dark: '#1a1a2e', light: '#ffffff00' }
    });

    const aiPrompt = `You are an expert certificate designer. Generate a complete, professional certificate for:
- Recipient: ${recipientName}
- Course/Achievement: ${courseName}
- Instructor: ${instructorName || 'The Instructor'}
- Date: ${completionDate || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- Certificate ID: ${certId.slice(0, 8).toUpperCase()}

IMPORTANT DESIGN RULES:
- Use ONLY soft, elegant, professional color palettes. NO bright yellow, neon, or loud colors.
- The background must be a very light cream, off-white, soft ivory, or light pastel — never white or dark.
- The primary/accent color must be rich and muted: deep navy, forest green, burgundy, slate blue, warm brown, deep teal, or dark emerald.
- Body text must be dark (near-black) for readability.
- Choose from these approved theme styles:
  * "Navy & Ivory" — primary #1e2a4a, accent #b8966e, bg: linear-gradient(135deg, #f8f5ef 0%, #ede8dc 100%)
  * "Forest Prestige" — primary #1e3a2f, accent #8faf6e, bg: linear-gradient(135deg, #f5f8f0 0%, #e8f0e0 100%)
  * "Burgundy Classic" — primary #5c1a2e, accent #c9956e, bg: linear-gradient(135deg, #fdf5f0 0%, #f5e8e0 100%)
  * "Slate & Silver" — primary #2c3e50, accent #7f8c9e, bg: linear-gradient(135deg, #f4f6f8 0%, #e8ecf0 100%)
  * "Deep Teal" — primary #0d3d56, accent #5a9eb5, bg: linear-gradient(135deg, #f0f7fa 0%, #ddeef5 100%)
  * "Warm Bronze" — primary #3d2b1f, accent #a0714f, bg: linear-gradient(135deg, #fdf7f0 0%, #f0e6d8 100%)
  * You may also create your own elegant variation following the same rules.

Return ONLY a valid JSON object (no markdown, no backticks) with these exact fields:
{
  "headline": "short congratulatory headline (max 8 words)",
  "body": "1-2 sentence formal certificate body text. Do NOT mention the certificate ID in the body.",
  "tagline": "inspiring one-liner about learning (max 12 words)",
  "theme": {
    "name": "theme name",
    "primaryColor": "#hex — dark, rich color",
    "secondaryColor": "#hex",
    "accentColor": "#hex — warm muted accent",
    "textColor": "#hex — must be dark for readability",
    "bgGradient": "CSS linear-gradient using soft light colors",
    "borderStyle": "ornate or classic",
    "fontPair": {
      "heading": "Cormorant Garamond",
      "body": "Lato"
    }
  },
  "validation": {
    "isValid": true,
    "credentialScore": 88,
    "notes": "brief credential validation note"
  }
}`;

    const aiResponse = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1000,
      messages: [{ role: 'user', content: aiPrompt }]
    });

    let aiData;
    try {
      const rawText = aiResponse.choices[0]?.message?.content || '';
      const clean = rawText.replace(/```json|```/g, '').trim();
      aiData = JSON.parse(clean);
    } catch {
      aiData = {
        headline: 'Certificate of Achievement',
        body: `This certifies that ${recipientName} has successfully completed ${courseName} with distinction.`,
        tagline: 'Knowledge is the foundation of every great achievement.',
        theme: {
          name: 'Navy & Ivory',
          primaryColor: '#1e2a4a',
          secondaryColor: '#2d3d5e',
          accentColor: '#b8966e',
          textColor: '#1e2a4a',
          bgGradient: 'linear-gradient(135deg, #f8f5ef 0%, #ede8dc 100%)',
          borderStyle: 'classic',
          fontPair: { heading: 'Cormorant Garamond', body: 'Lato' }
        },
        validation: { isValid: true, credentialScore: 90, notes: 'Credential verified successfully.' }
      };
    }

    const finalScore = (userScore && userScore >= 1 && userScore <= 100) ? parseInt(userScore) : (aiData.validation?.credentialScore || 90);
    aiData.validation = aiData.validation || {};
    aiData.validation.credentialScore = finalScore;

    const certHTML = buildCertificateHTML({
      recipientName, courseName, instructorName, completionDate,
      certId, qrDataUrl, verifyUrl, aiData
    });

    const certRecord = {
      id: certId,
      recipientName,
      courseName,
      instructorName,
      completionDate,
      recipientEmail,
      userScore: finalScore,
      issuedAt: new Date().toISOString(),
      aiData,
      html: certHTML,
      verifyUrl
    };
    certificateStore.set(certId, certRecord);

    res.json({ success: true, certId, verifyUrl, aiData, html: certHTML });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate certificate.' });
  }
});

// ── Download PDF ──
app.post('/api/download-pdf', async (req, res) => {
  try {
    const { certId } = req.body;
    const cert = certId ? certificateStore.get(certId) : null;

    const recipientName  = cert?.recipientName  || 'Recipient';
    const courseName     = cert?.courseName     || 'Course';
    const instructorName = cert?.instructorName || 'Instructor';
    const completionDate = cert?.completionDate ||
      new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const aiData   = cert?.aiData || {};
    const shortId  = cert ? cert.id.slice(0, 8).toUpperCase() : 'XXXXXXXX';
    const verifyUrl = cert?.verifyUrl || '';

    const theme      = aiData.theme || {};
    const accentHex  = theme.accentColor  || '#b8966e';
    const primaryHex = theme.primaryColor || '#1e2a4a';
    const score      = aiData.validation?.credentialScore || 90;
    const themeName  = theme.name || 'Classic';

    const hex2rgb = h => {
      const c = h.replace('#','');
      return [parseInt(c.substring(0,2),16)/255, parseInt(c.substring(2,4),16)/255, parseInt(c.substring(4,6),16)/255];
    };
    const accentRgb  = hex2rgb(accentHex);
    const primaryRgb = hex2rgb(primaryHex);

    let qrBuffer = null;
    if (verifyUrl) {
      qrBuffer = await QRCode.toBuffer(verifyUrl, { width: 100, margin: 1 });
    }

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${shortId}.pdf"`);
    doc.pipe(res);

    const W = 841.89, H = 595.28, pad = 40;

    doc.rect(0, 0, W, H).fill('#fdfbf0');
    doc.rect(pad, pad, W - pad*2, H - pad*2).lineWidth(4).strokeColor(accentHex).stroke();
    doc.rect(pad + 8, pad + 8, W - (pad+8)*2, H - (pad+8)*2).lineWidth(1).strokeColor(accentHex).stroke();

    const cs = 24;
    [[pad+2, pad+2], [W-pad-2-cs, pad+2], [pad+2, H-pad-2-cs], [W-pad-2-cs, H-pad-2-cs]].forEach(([x, y]) => {
      doc.rect(x, y, cs, cs).fill(accentHex);
    });

    doc.rect(W - pad - 160, pad + 16, 140, 22).fill(accentHex);
    doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
       .text(themeName.toUpperCase(), W - pad - 158, pad + 22, { width: 136, align: 'center' });

    doc.fontSize(10).fillColor(accentHex).font('Helvetica-Bold')
       .text('AI CERTIFICATE GENERATOR', 0, pad + 28, { width: W, align: 'center', characterSpacing: 4 });

    const divY = pad + 52;
    doc.moveTo(W/2 - 100, divY).lineTo(W/2 + 100, divY).lineWidth(1).strokeColor(accentHex).stroke();

    doc.fontSize(32).fillColor(primaryHex).font('Helvetica-Bold')
       .text(aiData.headline || 'Certificate of Achievement', 0, divY + 10, { width: W, align: 'center' });

    doc.fontSize(9).fillColor('#888888').font('Helvetica')
       .text('EXCELLENCE  ·  KNOWLEDGE  ·  ACHIEVEMENT', 0, divY + 52, { width: W, align: 'center', characterSpacing: 3 });

    doc.fontSize(11).fillColor('#555555').font('Helvetica')
       .text('This certificate is proudly presented to', 0, divY + 76, { width: W, align: 'center' });

    doc.fontSize(40).fillColor(primaryHex).font('Helvetica-Bold')
       .text(recipientName, 0, divY + 96, { width: W, align: 'center' });

    const nameY = divY + 96 + 46;
    doc.moveTo(W/2 - 180, nameY).lineTo(W/2 + 180, nameY).lineWidth(2).strokeColor(accentHex).stroke();

    const bodyText = (aiData.body || `This certifies that ${recipientName} has successfully completed ${courseName} with distinction.`)
      .replace(/\.\s*The certificate ID[^.]*\./gi, '.').replace(/certificate ID[^.]*\./gi, '').trim();
    doc.fontSize(10.5).fillColor('#333333').font('Helvetica')
       .text(bodyText, pad + 80, nameY + 14, { width: W - (pad+80)*2, align: 'center', lineGap: 3 });

    doc.fontSize(16).fillColor(accentHex).font('Helvetica-BoldOblique')
       .text(`"${courseName}"`, 0, nameY + 52, { width: W, align: 'center' });

    if (aiData.tagline) {
      doc.fontSize(9).fillColor('#aaaaaa').font('Helvetica-Oblique')
         .text(aiData.tagline, 0, nameY + 76, { width: W, align: 'center' });
    }

    const footerY = H - pad - 72;
    doc.moveTo(pad + 20, footerY - 6).lineTo(pad + 220, footerY - 6).lineWidth(0.5).strokeColor('#cccccc').stroke();

    doc.fontSize(13).fillColor(primaryHex).font('Helvetica-Bold')
       .text(instructorName || 'The Instructor', pad + 20, footerY, { width: 200, align: 'center' });
    doc.fontSize(8).fillColor('#aaaaaa').font('Helvetica')
       .text('INSTRUCTOR / ISSUER', pad + 20, footerY + 18, { width: 200, align: 'center', characterSpacing: 1 });

    doc.fontSize(9).fillColor('#666666').font('Helvetica')
       .text(`Date: ${completionDate}`, W/2 - 100, footerY, { width: 200, align: 'center' })
       .text(`ID: ${shortId}`, W/2 - 100, footerY + 14, { width: 200, align: 'center' })
       .text(`Score: ${score}/100`, W/2 - 100, footerY + 28, { width: 200, align: 'center' });

    if (qrBuffer) {
      doc.image(qrBuffer, W - pad - 110, footerY - 10, { width: 80, height: 80 });
      doc.fontSize(7).fillColor('#aaaaaa').font('Helvetica')
         .text('SCAN TO VERIFY', W - pad - 110, footerY + 72, { width: 80, align: 'center', characterSpacing: 1 });
    }

    doc.end();

  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
  }
});

// ── Send Email ──
app.post('/api/send-email', async (req, res) => {
  try {
    const { certId, recipientEmail } = req.body;
    const cert = certificateStore.get(certId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });

    const toEmail = recipientEmail || cert.recipientEmail;
    if (!toEmail) return res.status(400).json({ error: 'No recipient email provided.' });

    const emailHtml = buildEmailHTML(cert, certId);
    const subject = `🏆 Your Certificate for "${cert.courseName}" — ${cert.recipientName}`;

    if (process.env.RESEND_API_KEY) {
      const from = process.env.EMAIL_FROM || 'CertAI <onboarding@resend.dev>';
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [toEmail], subject, html: emailHtml })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Resend API error');
      return res.json({ success: true, message: `Email sent to ${toEmail}` });
    }

    if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
      });
      await transporter.sendMail({
        from: `CertAI <${process.env.GMAIL_USER}>`,
        to: toEmail, subject, html: emailHtml
      });
      return res.json({ success: true, message: `Email sent to ${toEmail}` });
    }

    return res.status(503).json({ error: 'Email not configured. Set GMAIL_USER and GMAIL_PASS in environment variables.' });

  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message || 'Failed to send email.' });
  }
});

function buildEmailHTML(cert, certId) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:Georgia,serif;">
  <div style="max-width:580px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#1a1a2e,#2d2d4e);padding:40px 40px 32px;text-align:center;">
      <p style="color:#c9a84c;font-size:11px;letter-spacing:4px;text-transform:uppercase;margin:0 0 12px;">AI Certificate Generator</p>
      <h1 style="color:#fff;font-size:28px;margin:0;font-weight:700;">🏆 Certificate Issued!</h1>
    </div>
    <div style="padding:40px;">
      <p style="color:#333;font-size:16px;margin:0 0 8px;">Dear <strong>${cert.recipientName}</strong>,</p>
      <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 24px;">
        Congratulations on successfully completing <strong>"${cert.courseName}"</strong>!
        Your AI-generated certificate has been issued and is ready to view, download, and share.
      </p>
      <div style="background:#fdfbf5;border:1px solid #e8dfc8;border-radius:8px;padding:20px 24px;margin:0 0 28px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:7px 0;color:#888;font-size:13px;width:140px;">Recipient</td><td style="padding:7px 0;color:#1a1a2e;font-size:13px;font-weight:700;">${cert.recipientName}</td></tr>
          <tr><td style="padding:7px 0;color:#888;font-size:13px;">Course</td><td style="padding:7px 0;color:#1a1a2e;font-size:13px;font-weight:700;">${cert.courseName}</td></tr>
          <tr><td style="padding:7px 0;color:#888;font-size:13px;">Score</td><td style="padding:7px 0;color:#1a1a2e;font-size:13px;font-weight:700;">${cert.userScore || 90}/100</td></tr>
          <tr><td style="padding:7px 0;color:#888;font-size:13px;">Issued</td><td style="padding:7px 0;color:#1a1a2e;font-size:13px;">${new Date(cert.issuedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</td></tr>
          <tr><td style="padding:7px 0;color:#888;font-size:13px;">Certificate ID</td><td style="padding:7px 0;color:#c9a84c;font-size:13px;font-weight:700;">${certId.slice(0,8).toUpperCase()}</td></tr>
        </table>
      </div>
      <div style="text-align:center;margin:0 0 28px;">
        <a href="${cert.verifyUrl}" style="display:inline-block;background:#1a1a2e;color:#c9a84c;text-decoration:none;padding:14px 36px;border-radius:6px;font-size:15px;font-weight:700;">
          🔍 View &amp; Verify Certificate
        </a>
      </div>
    </div>
    <div style="background:#f8f5ee;padding:20px 40px;text-align:center;border-top:1px solid #ede8d8;">
      <p style="color:#bbb;font-size:11px;margin:0;">AI Certificate Generator · Powered by Groq &amp; LLaMA 3.3</p>
    </div>
  </div>
</body>
</html>`;
}

// ── Serve Certificate HTML (fixes iframe) ──
app.get('/cert/:certId', (req, res) => {
  const cert = certificateStore.get(req.params.certId);
  if (!cert) return res.status(404).send('<h2>Certificate not found</h2>');
  res.setHeader('Content-Type', 'text/html');
  res.send(cert.html);
});

// ── Verify ──
app.get('/verify/:certId', (req, res) => {
  const cert = certificateStore.get(req.params.certId);
  res.send(verifyPageHTML(cert || null));
});

app.get('/api/verify/:certId', (req, res) => {
  const cert = certificateStore.get(req.params.certId);
  if (!cert) return res.status(404).json({ valid: false, error: 'Certificate not found.' });
  res.json({ valid: true, recipientName: cert.recipientName, courseName: cert.courseName, issuedAt: cert.issuedAt, credentialScore: cert.userScore });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));

// ── Certificate HTML Builder ──
function buildCertificateHTML({ recipientName, courseName, instructorName, completionDate, certId, qrDataUrl, verifyUrl, aiData }) {
  const theme = aiData.theme;
  const date = completionDate
    ? new Date(completionDate + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const shortId = certId.slice(0, 8).toUpperCase();
  const headingFont = theme.fontPair?.heading || 'Cormorant Garamond';
  const bodyFont = theme.fontPair?.body || 'Lato';
  const accent = theme.accentColor || '#b8966e';
  const primary = theme.primaryColor || '#1e2a4a';
  const textCol = theme.textColor || '#1e2a4a';
  const score = aiData.validation?.credentialScore || 90;

  let bodyText = (aiData.body || `This certifies that ${recipientName} has successfully completed ${courseName} with distinction.`)
    .replace(/\.\s*The certificate ID[^.]*\./gi, '.').replace(/certificate ID[^.]*\./gi, '').trim();
  if (bodyText.length > 180) bodyText = bodyText.slice(0, bodyText.lastIndexOf(' ', 180)) + '.';

  const tagline = (aiData.tagline || '').slice(0, 80);
  const headline = (aiData.headline || 'Certificate of Achievement').slice(0, 50);
  const borderCSS = { ornate: `6px double ${accent}`, minimal: `3px solid ${accent}`, geometric: `4px solid ${primary}`, classic: `5px solid ${accent}` }[theme.borderStyle] || `5px solid ${accent}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(headingFont)}:ital,wght@0,400;0,700;1,400&family=${encodeURIComponent(bodyFont)}:wght@400;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1122px; height: 793px; overflow: hidden; }
  .page { width: 1122px; height: 793px; background: ${theme.bgGradient}; display: flex; align-items: center; justify-content: center; }
  .frame { width: 1058px; height: 729px; border: ${borderCSS}; position: relative; display: flex; flex-direction: column; background: rgba(255,255,255,0.28); }
  .c { position: absolute; width: 44px; height: 44px; border-color: ${accent}; border-style: solid; }
  .c-tl { top: 8px; left: 8px; border-width: 2px 0 0 2px; }
  .c-tr { top: 8px; right: 8px; border-width: 2px 2px 0 0; }
  .c-bl { bottom: 8px; left: 8px; border-width: 0 0 2px 2px; }
  .c-br { bottom: 8px; right: 8px; border-width: 0 2px 2px 0; }
  .badge { position: absolute; top: 14px; right: 52px; background: ${accent}; color: #fff; font-family: '${bodyFont}',sans-serif; font-size: 8px; letter-spacing: 2.5px; text-transform: uppercase; padding: 3px 10px; font-weight: 700; }
  .header { height: 110px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding-top: 10px; flex-shrink: 0; }
  .org { font-family: '${bodyFont}',sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 5px; text-transform: uppercase; color: ${accent}; }
  .divider { width: 180px; height: 1px; background: ${accent}; opacity: 0.5; margin: 7px 0; }
  .headline { font-family: '${headingFont}',serif; font-size: 32px; font-weight: 700; color: ${primary}; letter-spacing: 0.5px; text-align: center; line-height: 1.1; }
  .subtitle { font-family: '${bodyFont}',sans-serif; font-size: 10px; letter-spacing: 3.5px; text-transform: uppercase; color: ${textCol}; opacity: 0.5; margin-top: 6px; }
  .middle { height: 380px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 80px; }
  .presented { font-family: '${bodyFont}',sans-serif; font-size: 12px; color: ${textCol}; opacity: 0.55; letter-spacing: 1.5px; margin-bottom: 6px; }
  .name { font-family: '${headingFont}',serif; font-size: 52px; color: ${primary}; font-weight: 700; line-height: 1.1; text-align: center; border-bottom: 2px solid ${accent}; padding-bottom: 10px; margin-bottom: 14px; }
  .body-text { font-family: '${bodyFont}',sans-serif; font-size: 12.5px; line-height: 1.65; text-align: center; color: ${textCol}; opacity: 0.78; max-width: 680px; margin-bottom: 12px; }
  .course { font-family: '${headingFont}',serif; font-size: 22px; color: ${accent}; font-weight: 700; font-style: italic; text-align: center; margin-bottom: 10px; }
  .tagline { font-family: '${bodyFont}',sans-serif; font-size: 10.5px; font-style: italic; color: ${textCol}; opacity: 0.4; letter-spacing: 0.5px; text-align: center; }
  .footer { height: 110px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 52px 12px; border-top: 1px solid ${accent}22; }
  .sig { text-align: center; min-width: 170px; }
  .sig-line { width: 160px; height: 1px; background: ${primary}; opacity: 0.25; margin: 0 auto 5px; }
  .sig-name { font-family: '${headingFont}',serif; font-size: 14px; font-weight: 700; color: ${primary}; }
  .sig-label { font-family: '${bodyFont}',sans-serif; font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; color: ${textCol}; opacity: 0.4; margin-top: 2px; }
  .meta { text-align: center; }
  .meta p { font-family: '${bodyFont}',sans-serif; font-size: 10px; color: ${textCol}; opacity: 0.45; letter-spacing: 0.3px; line-height: 1.8; }
  .score-pill { display: inline-block; background: ${accent}22; border: 1px solid ${accent}66; color: ${accent}; font-weight: 700; padding: 2px 10px; border-radius: 20px; font-size: 10px; margin-top: 3px; }
  .qr { text-align: center; }
  .qr img { width: 76px; height: 76px; display: block; margin: 0 auto; }
  .qr p { font-family: '${bodyFont}',sans-serif; font-size: 8px; letter-spacing: 1.5px; text-transform: uppercase; color: ${textCol}; opacity: 0.35; margin-top: 4px; }
</style>
</head>
<body>
<div class="page">
  <div class="frame">
    <div class="c c-tl"></div><div class="c c-tr"></div><div class="c c-bl"></div><div class="c c-br"></div>
    <div class="badge">${theme.name}</div>
    <div class="header">
      <p class="org">AI Certificate Generator</p>
      <div class="divider"></div>
      <h1 class="headline">${headline}</h1>
      <p class="subtitle">Excellence &nbsp;·&nbsp; Knowledge &nbsp;·&nbsp; Achievement</p>
    </div>
    <div class="middle">
      <p class="presented">This certificate is proudly presented to</p>
      <h2 class="name">${recipientName}</h2>
      <p class="body-text">${bodyText}</p>
      <p class="course">"${courseName}"</p>
      ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
    </div>
    <div class="footer">
      <div class="sig">
        <div class="sig-line"></div>
        <p class="sig-name">${instructorName || 'The Instructor'}</p>
        <p class="sig-label">Instructor / Issuer</p>
      </div>
      <div class="meta">
        <p>${date}</p>
        <p>Certificate ID: ${shortId}</p>
        <div class="score-pill">⭐ Score ${score}/100</div>
      </div>
      <div class="qr">
        <img src="${qrDataUrl}" alt="Verify">
        <p>Scan to Verify</p>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── Verify Page HTML ──
function verifyPageHTML(cert) {
  if (!cert) {
    return `<!DOCTYPE html><html><head><title>Verification Failed</title>
    <style>body{font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f1eb;margin:0;}
    .box{text-align:center;padding:60px;background:#fff;border-radius:16px;box-shadow:0 4px 32px rgba(0,0,0,0.1);max-width:440px;}
    h1{color:#c0392b;font-size:26px;margin-bottom:12px;}p{color:#888;font-size:15px;line-height:1.6;}</style></head>
    <body><div class="box"><div style="font-size:52px;margin-bottom:16px;">❌</div><h1>Certificate Not Found</h1><p>This certificate ID is invalid or has expired.</p></div></body></html>`;
  }
  const t = cert.aiData?.theme;
  const primary = t?.primaryColor || '#1e2a4a';
  const accent = t?.accentColor || '#b8966e';
  const bg = t?.bgGradient || 'linear-gradient(135deg,#f8f5ef 0%,#ede8dc 100%)';
  const score = cert.userScore || cert.aiData?.validation?.credentialScore || 90;
  const issued = new Date(cert.issuedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  return `<!DOCTYPE html>
<html><head><title>Certificate Verified ✅</title>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${bg};padding:24px;}
  .card{background:#fff;border-radius:20px;box-shadow:0 8px 48px rgba(0,0,0,0.12);max-width:480px;width:100%;overflow:hidden;}
  .card-header{background:linear-gradient(135deg,${primary},${primary}dd);padding:36px 40px;text-align:center;}
  .check{font-size:52px;display:block;margin-bottom:12px;}
  .card-header h1{font-family:'Cormorant Garamond',serif;color:#fff;font-size:30px;font-weight:700;margin-bottom:6px;}
  .card-header p{color:rgba(255,255,255,0.6);font-size:13px;letter-spacing:1px;}
  .score-badge{display:inline-block;background:${accent};color:#fff;font-weight:700;font-size:15px;padding:8px 24px;border-radius:100px;margin-top:16px;}
  .card-body{padding:32px 40px;}
  .row{display:flex;justify-content:space-between;align-items:center;padding:13px 0;border-bottom:1px solid #f0ece4;}
  .row:last-child{border-bottom:none;}
  .label{color:#aaa;font-size:13px;font-weight:500;letter-spacing:0.3px;}
  .value{color:${primary};font-size:14px;font-weight:600;text-align:right;max-width:260px;}
  .cert-id{font-family:monospace;background:#f5f5f5;padding:3px 10px;border-radius:6px;font-size:13px;letter-spacing:1px;}
  .card-footer{background:#fdfbf5;border-top:1px solid #f0ece4;padding:18px 40px;text-align:center;}
  .card-footer p{color:#bbb;font-size:11px;letter-spacing:0.5px;}
</style>
</head>
<body>
<div class="card">
  <div class="card-header">
    <span class="check">✅</span>
    <h1>Certificate Verified</h1>
    <p>This certificate is authentic and valid</p>
    <div class="score-badge">⭐ Score: ${score}/100</div>
  </div>
  <div class="card-body">
    <div class="row"><span class="label">Recipient</span><span class="value">${cert.recipientName}</span></div>
    <div class="row"><span class="label">Course</span><span class="value">${cert.courseName}</span></div>
    <div class="row"><span class="label">Instructor</span><span class="value">${cert.instructorName || 'The Instructor'}</span></div>
    <div class="row"><span class="label">Issued</span><span class="value">${issued}</span></div>
    <div class="row"><span class="label">Certificate ID</span><span class="value"><span class="cert-id">${cert.id.slice(0,8).toUpperCase()}</span></span></div>
  </div>
  <div class="card-footer"><p>AI Certificate Generator · Powered by Groq &amp; LLaMA 3.3</p></div>
</div>
</body></html>`;
}
