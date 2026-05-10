let currentCertId = null;
let currentVerifyUrl = null;

async function generateCertificate() {
  const recipientName  = document.getElementById('recipientName').value.trim();
  const courseName     = document.getElementById('courseName').value.trim();
  const instructorName = document.getElementById('instructorName').value.trim();
  const completionDate = document.getElementById('completionDate').value;
  const recipientEmail = document.getElementById('recipientEmail').value.trim();
  const userScoreRaw   = document.getElementById('userScore').value.trim();
  const userScore      = userScoreRaw ? Math.min(100, Math.max(1, parseInt(userScoreRaw))) : null;

  hideError();
  if (!recipientName) { showError("Please enter the recipient's name."); return; }
  if (!courseName)     { showError('Please enter the course or achievement name.'); return; }

  const btn = document.getElementById('generateBtn');
  setLoading(true, btn);
  showOverlay('AI is designing your certificate...');

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientName, courseName, instructorName, completionDate, recipientEmail, userScore })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    currentCertId    = data.certId;
    currentVerifyUrl = data.verifyUrl;

    renderCertificate(data);
    showToast('Certificate generated successfully!');
  } catch (err) {
    showError('Error: ' + err.message);
  } finally {
    setLoading(false, btn);
    hideOverlay();
  }
}

function renderCertificate(data) {
  const { aiData, certId } = data;

  document.getElementById('previewPlaceholder').style.display = 'none';
  document.getElementById('certOutput').style.display = 'flex';

  const bar = document.getElementById('aiInfoBar');
  const score = aiData && aiData.validation ? aiData.validation.credentialScore || 90 : 90;
  const themeName = aiData && aiData.theme ? aiData.theme.name || 'Classic' : 'Classic';
  bar.innerHTML =
    '<span style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:2px;text-transform:uppercase;">AI Generated</span>' +
    '<span class="ai-tag theme">🎨 ' + themeName + '</span>' +
    '<span class="ai-tag score">⭐ ' + score + '/100</span>' +
    '<span class="ai-tag valid">✅ Verified</span>';

  var iframe = document.getElementById('certIframe');
  iframe.style.height = '0';

  function applyScale() {
    var wrapper = document.querySelector('.cert-wrapper');
    if (!wrapper) return;
    var scale = wrapper.getBoundingClientRect().width / 1122;
    iframe.style.transform = 'scale(' + scale + ')';
  }

  iframe.src = '/cert/' + certId;
  iframe.onload = applyScale;
  window.addEventListener('resize', applyScale);
  setTimeout(applyScale, 50);

  document.getElementById('emailForm').style.display = 'none';
  document.getElementById('emailStatus').textContent = '';
}

async function downloadPDF() {
  if (!currentCertId) { showToast('Generate a certificate first.'); return; }
  showToast('Generating PDF...');
  try {
    const res = await fetch('/api/download-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certId: currentCertId })
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'PDF failed'); }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'certificate.pdf'; a.click();
    URL.revokeObjectURL(url);
    showToast('PDF downloaded!');
  } catch (err) { showToast('Failed: ' + err.message); }
}

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
  statusEl.textContent = 'Sending...';
  try {
    const res  = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certId: currentCertId, recipientEmail: email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send');
    statusEl.textContent = '✅ Email sent to ' + email;
    showToast('Certificate emailed successfully!');
    document.getElementById('emailForm').style.display = 'none';
  } catch (err) {
    statusEl.textContent = '❌ ' + err.message;
    showToast('Failed: ' + err.message);
  }
}

function openVerify() {
  if (!currentCertId) { showToast('Generate a certificate first.'); return; }
  window.open('/verify/' + currentCertId, '_blank');
}

function showOverlay(text) {
  var el = document.getElementById('loadingOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loadingOverlay';
    el.className = 'loading-overlay';
    el.innerHTML = '<div class="loading-spinner"></div><p class="loading-text" id="overlayText"></p>';
    document.body.appendChild(el);
  }
  document.getElementById('overlayText').textContent = text || 'Loading...';
  el.style.display = 'flex';
}

function hideOverlay() {
  var el = document.getElementById('loadingOverlay');
  if (el) el.style.display = 'none';
}

function setLoading(loading, btn) {
  btn.disabled = loading;
  var txt = document.querySelector('.btn-text');
  var ico = document.querySelector('.btn-icon');
  var ldr = document.getElementById('btnLoader');
  if (txt) txt.style.display = loading ? 'none' : 'inline';
  if (ico) ico.style.display = loading ? 'none' : 'inline';
  if (ldr) ldr.style.display = loading ? 'inline' : 'none';
}

function showError(msg) {
  var el = document.getElementById('errorBox');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  var el = document.getElementById('errorBox');
  if (el) el.style.display = 'none';
}

function showToast(msg) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function() { el.classList.remove('show'); }, 3500);
}

var dateInput = document.getElementById('completionDate');
if (dateInput) dateInput.valueAsDate = new Date();

var emailField = document.getElementById('recipientEmail');
if (emailField) {
  emailField.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') generateCertificate();
  });
}
