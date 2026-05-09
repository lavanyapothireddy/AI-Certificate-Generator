/* ──────────────────────────────────────────────
   AI Certificate Generator — Frontend Logic
────────────────────────────────────────────── */

let currentCertId = null;
let currentCertHtml = null;
let currentVerifyUrl = null;

// ─────────────────────────────────────────────
// GENERATE CERTIFICATE
// ─────────────────────────────────────────────
async function generateCertificate() {
  const recipientName  = document.getElementById('recipientName').value.trim();
  const courseName     = document.getElementById('courseName').value.trim();
  const instructorName = document.getElementById('instructorName').value.trim();
  const completionDate = document.getElementById('completionDate').value;
  const recipientEmail = document.getElementById('recipientEmail').value.trim();

  hideError();

  if (!recipientName) { showError('Please enter the recipient\'s name.'); return; }
  if (!courseName)     { showError('Please enter the course or achievement name.'); return; }

  const btn = document.getElementById('generateBtn');
  setLoading(true, btn);
  showOverlay('✦ AI is designing your certificate…');

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientName, courseName, instructorName, completionDate, recipientEmail })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    currentCertId   = data.certId;
    currentCertHtml = data.html;
    currentVerifyUrl = data.verifyUrl;

    renderCertificate(data);
    showToast('🎉 Certificate generated successfully!');
  } catch (err) {
    showError('Error: ' + err.message);
  } finally {
    setLoading(false, btn);
    hideOverlay();
  }
}

// ─────────────────────────────────────────────
// RENDER CERTIFICATE IN IFRAME
// ─────────────────────────────────────────────
function renderCertificate(data) {
  const { aiData, html } = data;

  // Show output, hide placeholder
  document.getElementById('previewPlaceholder').style.display = 'none';
  document.getElementById('certOutput').style.display = 'flex';

  // AI Info Bar
  const bar = document.getElementById('aiInfoBar');
  const score = aiData?.validation?.credentialScore || 90;
  const themeName = aiData?.theme?.name || 'Classic';
  bar.innerHTML = `
    <span style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:2px;text-transform:uppercase;">AI Generated</span>
    <span class="ai-tag theme">🎨 ${themeName}</span>
    <span class="ai-tag score">⭐ ${score}/100 Credential Score</span>
    <span class="ai-tag valid">✅ Verified</span>
  `;

  // Inject into iframe
  const iframe = document.getElementById('certIframe');
  iframe.style.height = '0';
  iframe.style.paddingBottom = '';

  // Write HTML to iframe
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  iframe.src = url;

  iframe.onload = () => {
    // Set iframe height based on content (A4 landscape ratio)
    const wrapper = document.querySelector('.cert-wrapper');
    const w = wrapper.clientWidth;
    // A4 landscape: 297mm × 210mm → ratio 0.707
    iframe.style.height = Math.round(w * 0.707) + 'px';
  };

  // Reset email form
  document.getElementById('emailForm').style.display = 'none';
  document.getElementById('emailStatus').textContent = '';
}

// ─────────────────────────────────────────────
// DOWNLOAD PDF
// ─────────────────────────────────────────────
async function downloadPDF() {
  if (!currentCertHtml) { showToast('Generate a certificate first.'); return; }

  showToast('📄 Generating PDF…');
  try {
    const res = await fetch('/api/download-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: currentCertHtml })
    });

    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'PDF failed');
    }

    const blob  = await res.blob();
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href      = url;
    a.download  = 'certificate.pdf';
    a.click();
    URL.revokeObjectURL(url);
    showToast('✅ PDF downloaded!');
  } catch (err) {
    showToast('❌ ' + err.message);
  }
}

// ─────────────────────────────────────────────
// SEND EMAIL
// ─────────────────────────────────────────────
function sendEmail() {
  if (!currentCertId) { showToast('Generate a certificate first.'); return; }
  const form = document.getElementById('emailForm');
  form.style.display = form.style.display === 'none' ? 'flex' : 'none';
  if (form.style.display === 'flex') {
    const prefill = document.getElementById('recipientEmail').value.trim();
    if (prefill) document.getElementById('emailInput').value = prefill;
    document.getElementById('emailInput').focus();
  }
}

async function sendEmailConfirm() {
  const email = document.getElementById('emailInput').value.trim();
  if (!email) { showToast('Please enter an email address.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Invalid email address.'); return; }

  const statusEl = document.getElementById('emailStatus');
  statusEl.textContent = 'Sending…';

  try {
    const res  = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certId: currentCertId, recipientEmail: email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send');
    statusEl.textContent = '✅ Email sent to ' + email;
    showToast('📧 Certificate emailed successfully!');
    document.getElementById('emailForm').style.display = 'none';
  } catch (err) {
    statusEl.textContent = '❌ ' + err.message;
    showToast('❌ ' + err.message);
  }
}

// ─────────────────────────────────────────────
// VERIFY
// ─────────────────────────────────────────────
function openVerify() {
  if (!currentVerifyUrl) { showToast('Generate a certificate first.'); return; }
  window.open(currentVerifyUrl, '_blank');
}

// ─────────────────────────────────────────────
// LOADING OVERLAY
// ─────────────────────────────────────────────
function showOverlay(text) {
  let el = document.getElementById('loadingOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loadingOverlay';
    el.className = 'loading-overlay';
    el.innerHTML = `<div class="loading-spinner"></div><p class="loading-text" id="overlayText"></p>`;
    document.body.appendChild(el);
  }
  document.getElementById('overlayText').textContent = text || 'Loading…';
  el.style.display = 'flex';
}

function hideOverlay() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.style.display = 'none';
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function setLoading(loading, btn) {
  btn.disabled = loading;
  document.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  document.querySelector('.btn-icon').style.display = loading ? 'none' : 'inline';
  document.getElementById('btnLoader').style.display = loading ? 'inline' : 'none';
}

function showError(msg) {
  const el = document.getElementById('errorBox');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('errorBox').style.display = 'none';
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}

// Set default date to today
document.getElementById('completionDate').valueAsDate = new Date();

// Allow pressing Enter in last text field to trigger generate
document.getElementById('recipientEmail').addEventListener('keydown', e => {
  if (e.key === 'Enter') generateCertificate();
});
