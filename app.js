const STORAGE_KEY = 'toybox-teacher-state';
const SUBMISSIONS_KEY = 'toybox-student-submissions';
const ACCOUNTS_KEY = 'vo-nho-student-accounts';
const SESSION_KEY = 'vo-nho-active-student';
const QUIZ_ARCHIVE_KEY = 'vo-nho-quiz-archive';
const ACTIVE_PRACTICE_KEY = 'vo-nho-active-practice-quiz';
const PDF_DATABASE_NAME = 'vo-nho-learning-library';
const TEACHER_PIN_KEY = 'vo-nho-teacher-pin';
const TEACHER_RECOVERY_KEY = 'vo-nho-teacher-recovery-code';
const DEFAULT_TEACHER_PIN = '20022006';
const SKILL_KEYS = ['listening', 'reading', 'speaking', 'writing'];
const QUIZ_TYPES = ['multiple-choice', 'fill-blank', 'matching', 'true-false'];
const DEFAULT_STATE = {
  listening: [
    {
      id: 1,
      prompt: 'Listen and choose the correct word.',
      choices: ['cat', 'tree', 'book', 'chair'],
      answer: 'cat',
      audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
    }
  ],
  reading: [
    {
      id: 1,
      prompt: 'The cat is on the ___ .',
      type: 'fill-blank',
      answer: 'mat',
      choices: ['mat', 'book', 'chair', 'tree']
    }
  ],
  speaking: [
    { id: 1, prompt: 'Say a sentence: "I have a toy bear."' }
  ],
  writing: [
    { id: 1, prompt: 'Write 3 sentences about your favorite toy.' }
  ]
};

const secretTrigger = document.getElementById('secret-trigger');
const passcodeModal = document.getElementById('passcode-modal');
const passcodeInput = document.getElementById('passcode-input');
const unlockBtn = document.getElementById('unlock-btn');
const errorMsg = document.getElementById('error-msg');
const studentCanvas = document.getElementById('student-canvas');
const teacherDashboard = document.getElementById('teacher-dashboard');
const exitTeacher = document.getElementById('exit-teacher');
const accountModal = document.getElementById('account-modal');
const studentAuthForm = document.getElementById('student-auth-form');
const accountFormStatus = document.getElementById('account-form-status');
const studentAccountControl = document.getElementById('student-account-control');
const recordBtn = document.getElementById('record-btn');
const uploadZone = document.getElementById('upload-zone');
const writingUpload = document.getElementById('writing-upload');
const uploadPreview = document.getElementById('upload-preview');
const teacherStatus = document.getElementById('teacher-status');
const mascotAvatar = document.getElementById('mascot-avatar');
const mascotMessage = document.getElementById('mascot-message');
const starBadge = document.getElementById('star-badge');

let clickCount = 0;
let clickTimer = null;
let attemptCount = 0;
let isLocked = false;
let recording = false;
let recorder = null;
let mediaStream = null;
let recordedAudioUrl = null;
let examStarted = false;
let examExitAttempts = 0;
let examWasHidden = false;
let activeArchiveFolderId = '';
let pdfDatabasePromise = null;
let pdfObjectUrls = [];
let lessonSyncStarted = false;

function getQuizArchive() {
  try {
    const archive = JSON.parse(localStorage.getItem(QUIZ_ARCHIVE_KEY) || '[]');
    return Array.isArray(archive) ? archive : [];
  } catch (error) {
    return [];
  }
}

function saveQuizArchive(archive) {
  localStorage.setItem(QUIZ_ARCHIVE_KEY, JSON.stringify(archive));
}

function getActivePublishedQuiz() {
  const selectedId = sessionStorage.getItem(ACTIVE_PRACTICE_KEY);
  for (const folder of getQuizArchive()) {
    const quiz = (folder.quizzes || []).find((item) => item.id === selectedId);
    if (quiz?.openToStudents) return quiz;
  }
  return null;
}

function getBaseLessonData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_STATE));
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  try {
    return { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), ...JSON.parse(saved) };
  } catch (error) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function getLessonData() {
  const lesson = getBaseLessonData();
  const activeQuiz = getActivePublishedQuiz();
  if (!activeQuiz) return lesson;
  return {
    ...lesson,
    listening: JSON.parse(JSON.stringify(activeQuiz.lesson.listening || [])),
    reading: JSON.parse(JSON.stringify(activeQuiz.lesson.reading || []))
  };
}

function saveLessonData(lesson, resetScore = false) {
  if (getActivePublishedQuiz()) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lesson));
  syncLessonToFirebase(lesson);
  if (resetScore) window.__toyboxScore = {};
  renderStudentSkills();
}

function reportLessonSyncError(error) {
  console.error('Firebase lesson sync failed:', error);
  if (teacherStatus) {
    teacherStatus.textContent = 'Lesson saved locally, but Firebase sync failed. Check your connection and database rules.';
  }
}

function syncLessonToFirebase(lesson) {
  if (!window.db) return;
  window.db.ref('toybox_lessons').set(lesson).catch(reportLessonSyncError);
}

function startLessonSync() {
  if (lessonSyncStarted || !window.db) return;
  lessonSyncStarted = true;

  window.db.ref('toybox_lessons').on('value', (snapshot) => {
    const remoteData = snapshot.val();
    if (remoteData === null) {
      syncLessonToFirebase(DEFAULT_STATE);
      return;
    }
    if (typeof remoteData !== 'object' || Array.isArray(remoteData)) {
      reportLessonSyncError(new Error('Firebase toybox_lessons must contain a lesson object.'));
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteData));
    renderStudentSkills();

    const teacherLayout = document.getElementById('teacher-layout');
    if (!teacherDashboard.classList.contains('hidden') && !teacherLayout.classList.contains('hidden')) {
      const activeSkill = document.querySelector('.teacher-skill-tab.active')?.dataset.skill || 'listening';
      createTeacherForm(activeSkill);
    }
  }, reportLessonSyncError);
}

function getStudentAccounts() {
  try {
    const accounts = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(accounts) ? accounts : [];
  } catch (error) {
    return [];
  }
}

async function verifyTeacherPin(value) {
  const saved = localStorage.getItem(TEACHER_PIN_KEY);
  if (!saved) return value === DEFAULT_TEACHER_PIN;
  try {
    const credential = JSON.parse(saved);
    if (!credential.salt || !credential.hash) return value === saved;
    return (await hashStudentPassword(value, credential.salt)).hash === credential.hash;
  } catch (error) {
    return value === saved;
  }
}

async function verifyTeacherRecoveryCode(value) {
  if (value === DEFAULT_TEACHER_PIN) return true;
  const saved = localStorage.getItem(TEACHER_RECOVERY_KEY);
  if (!saved) return false;
  try {
    const credential = JSON.parse(saved);
    return Boolean(credential.salt && credential.hash)
      && (await hashStudentPassword(value, credential.salt)).hash === credential.hash;
  } catch (error) {
    return false;
  }
}

async function updateTeacherPin(event) {
  event.preventDefault();
  const status = document.getElementById('teacher-pin-status');
  const currentPin = document.getElementById('teacher-current-pin').value;
  const newPin = document.getElementById('teacher-new-pin').value;
  const repeatedPin = document.getElementById('teacher-repeat-pin').value;
  const recoveryCode = document.getElementById('teacher-new-recovery-code').value.trim();
  status.textContent = '';

  if (!(await verifyTeacherPin(currentPin))) {
    status.textContent = 'Mã hiện tại chưa đúng.';
    return;
  }
  if (!/^\d{4,6}$/.test(newPin)) {
    status.textContent = 'Mã mới cần có từ 4 đến 6 chữ số.';
    return;
  }
  if (newPin !== repeatedPin) {
    status.textContent = 'Hai lần nhập mã mới chưa khớp.';
    return;
  }
  if (recoveryCode && !/^\d{4,12}$/.test(recoveryCode)) {
    status.textContent = 'Mã khôi phục riêng cần có từ 4 đến 12 chữ số.';
    return;
  }
  const credential = await hashStudentPassword(newPin);
  localStorage.setItem(TEACHER_PIN_KEY, JSON.stringify(credential));
  if (recoveryCode) {
    localStorage.setItem(TEACHER_RECOVERY_KEY, JSON.stringify(await hashStudentPassword(recoveryCode)));
  }
  document.getElementById('teacher-pin-form').reset();
  status.textContent = recoveryCode
    ? 'Đã cập nhật mật khẩu và mã khôi phục riêng.'
    : 'Đã cập nhật mật khẩu giáo viên.';
}

function openTeacherRecovery() {
  passcodeModal.classList.add('hidden');
  const modal = document.getElementById('teacher-recovery-modal');
  modal.classList.remove('hidden');
  document.getElementById('teacher-recovery-code-form').classList.remove('hidden');
  document.getElementById('teacher-recovery-reset-form').classList.add('hidden');
  document.getElementById('teacher-recovery-code-form').reset();
  document.getElementById('teacher-recovery-reset-form').reset();
  document.getElementById('teacher-recovery-code-status').textContent = '';
  document.getElementById('teacher-recovery-reset-status').textContent = '';
  document.getElementById('teacher-recovery-code').focus();
}

async function handleTeacherRecoveryCode(event) {
  event.preventDefault();
  const code = document.getElementById('teacher-recovery-code').value.trim();
  const status = document.getElementById('teacher-recovery-code-status');
  if (!(await verifyTeacherRecoveryCode(code))) {
    status.textContent = 'Mã khôi phục không đúng!';
    return;
  }
  status.textContent = '';
  document.getElementById('teacher-recovery-code-form').classList.add('hidden');
  document.getElementById('teacher-recovery-reset-form').classList.remove('hidden');
  document.getElementById('teacher-recovery-new-pin').focus();
}

async function handleTeacherRecoveryReset(event) {
  event.preventDefault();
  const newPin = document.getElementById('teacher-recovery-new-pin').value;
  const confirmPin = document.getElementById('teacher-recovery-confirm-pin').value;
  const status = document.getElementById('teacher-recovery-reset-status');
  if (!/^\d{4,6}$/.test(newPin)) {
    status.textContent = 'Mật khẩu mới cần có từ 4 đến 6 chữ số.';
    return;
  }
  if (newPin !== confirmPin) {
    status.textContent = 'Hai mật khẩu mới chưa khớp.';
    return;
  }

  try {
    localStorage.setItem(TEACHER_PIN_KEY, JSON.stringify(await hashStudentPassword(newPin)));
    const recoveryModal = document.getElementById('teacher-recovery-modal');
    recoveryModal.classList.add('hidden');
    document.getElementById('teacher-recovery-code-form').classList.remove('hidden');
    document.getElementById('teacher-recovery-reset-form').classList.add('hidden');
    document.getElementById('teacher-recovery-code-form').reset();
    document.getElementById('teacher-recovery-reset-form').reset();
    passcodeInput.value = '';
    passcodeInput.disabled = false;
    unlockBtn.disabled = false;
    attemptCount = 0;
    isLocked = false;
    setMascot('froggo', 'Đổi mật khẩu thành công. Hãy đăng nhập bằng mật khẩu mới.', '');
    errorMsg.classList.add('hidden');
    openTeacherGate();
  } catch (error) {
    status.textContent = error.message || 'Chưa thể lưu mật khẩu mới.';
  }
}

function closeTeacherRecovery() {
  document.getElementById('teacher-recovery-modal').classList.add('hidden');
  document.getElementById('teacher-recovery-code-form').reset();
  document.getElementById('teacher-recovery-reset-form').reset();
  document.getElementById('teacher-recovery-code-form').classList.remove('hidden');
  document.getElementById('teacher-recovery-reset-form').classList.add('hidden');
  passcodeInput.disabled = false;
  unlockBtn.disabled = false;
  attemptCount = 0;
  isLocked = false;
  openTeacherGate();
}

function getActiveStudent() {
  const studentId = sessionStorage.getItem(SESSION_KEY);
  return getStudentAccounts().find((student) => student.id === studentId) || null;
}

function normalizeIdentity(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value) {
  return new Uint8Array(value.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));
}

async function hashStudentPassword(password, saltHex) {
  if (!window.crypto?.subtle || !window.crypto?.getRandomValues) {
    throw new Error('Trình duyệt này chưa hỗ trợ lưu mật khẩu an toàn. Hãy mở Vở Nhỏ bằng localhost.');
  }
  const salt = saltHex ? hexToBytes(saltHex) : window.crypto.getRandomValues(new Uint8Array(16));
  const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const result = await window.crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(result)) };
}

function setAccountMode(mode) {
  const registering = mode === 'register';
  document.getElementById('account-register-tab').classList.toggle('active', registering);
  document.getElementById('account-login-tab').classList.toggle('active', !registering);
  document.getElementById('account-register-tab').setAttribute('aria-selected', String(registering));
  document.getElementById('account-login-tab').setAttribute('aria-selected', String(!registering));
  document.getElementById('account-confirm-group').classList.toggle('hidden', !registering);
  document.querySelector('.account-field-row').classList.toggle('hidden', !registering);
  document.getElementById('account-class').required = registering;
  document.getElementById('account-school').required = registering;
  document.getElementById('account-confirm-password').required = registering;
  document.getElementById('account-password').autocomplete = registering ? 'new-password' : 'current-password';
  document.getElementById('account-form-heading').textContent = registering
    ? 'Bắt đầu bằng vài thông tin của em.'
    : 'Nhập thông tin lớp học để tiếp tục.';
  document.getElementById('account-submit-btn').textContent = registering ? 'Tạo tài khoản' : 'Đăng nhập';
  studentAuthForm.dataset.mode = mode;
  accountFormStatus.textContent = '';
}

function showStudentDesk(student) {
  accountModal.classList.add('hidden');
  studentCanvas.classList.remove('hidden');
  teacherDashboard.classList.add('hidden');
  studentAccountControl.classList.remove('hidden');
  document.getElementById('student-account-summary').textContent = `${student.name} · ${student.className}`;
  renderStudentSkills();
}

function showAccountGate(mode = 'login') {
  studentCanvas.classList.add('hidden');
  teacherDashboard.classList.add('hidden');
  studentAccountControl.classList.add('hidden');
  accountModal.classList.remove('hidden');
  setAccountMode(mode);
}

async function handleStudentAuth(event) {
  event.preventDefault();
  const mode = studentAuthForm.dataset.mode;
  const name = document.getElementById('account-name').value.trim().replace(/\s+/g, ' ');
  const className = document.getElementById('account-class').value.trim().replace(/\s+/g, ' ');
  const school = document.getElementById('account-school').value.trim().replace(/\s+/g, ' ');
  const password = document.getElementById('account-password').value;
  const registering = mode === 'register';
  accountFormStatus.textContent = '';

  if (!name || !password || (registering && (!className || !school))) {
    accountFormStatus.textContent = registering
      ? 'Em hãy điền đủ họ tên, lớp, trường và mật khẩu.'
      : 'Em hãy nhập tên và mật khẩu.';
    return;
  }
  if (password.length < 6) {
    accountFormStatus.textContent = 'Mật khẩu cần có ít nhất 6 ký tự.';
    return;
  }

  const nameMatches = (student) => normalizeIdentity(student.name) === normalizeIdentity(name);
  const accounts = getStudentAccounts();

  try {
    if (registering) {
      if (password !== document.getElementById('account-confirm-password').value) {
        accountFormStatus.textContent = 'Hai lần nhập mật khẩu chưa khớp.';
        return;
      }
      if (accounts.some(nameMatches)) {
        accountFormStatus.textContent = 'Tên này đã có tài khoản. Em hãy đăng nhập nhé.';
        setAccountMode('login');
        return;
      }
      const credential = await hashStudentPassword(password);
      const student = {
        id: window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${credential.salt.slice(0, 8)}`,
        name,
        className,
        school,
        salt: credential.salt,
        passwordHash: credential.hash,
        createdAt: new Date().toISOString()
      };
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([...accounts, student]));
      sessionStorage.setItem(SESSION_KEY, student.id);
      studentAuthForm.reset();
      showStudentDesk(student);
      return;
    }

    const student = accounts.find(nameMatches);
    if (!student) {
      accountFormStatus.textContent = 'Không tìm thấy tài khoản với thông tin này.';
      return;
    }
    const credential = await hashStudentPassword(password, student.salt);
    if (credential.hash !== student.passwordHash) {
      accountFormStatus.textContent = 'Mật khẩu chưa đúng. Em thử lại nhé.';
      return;
    }
    sessionStorage.setItem(SESSION_KEY, student.id);
    studentAuthForm.reset();
    showStudentDesk(student);
  } catch (error) {
    accountFormStatus.textContent = error.message || 'Chưa thể lưu tài khoản. Em thử lại nhé.';
  }
}

function makeTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return [...window.crypto.getRandomValues(new Uint8Array(10))]
    .map((value) => alphabet[value % alphabet.length]).join('');
}

function renderStudentAccounts() {
  const container = document.getElementById('student-accounts-list');
  const accounts = getStudentAccounts();
  document.getElementById('student-account-count').textContent = `${accounts.length} tài khoản`;
  container.replaceChildren();
  if (!accounts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-account-list';
    empty.textContent = 'Chưa có tài khoản học sinh.';
    container.appendChild(empty);
    return;
  }

  accounts.forEach((student) => {
    const row = document.createElement('article');
    row.className = 'student-account-row';
    const identity = document.createElement('div');
    identity.className = 'student-account-identity';
    const name = document.createElement('strong');
    name.textContent = student.name;
    const detail = document.createElement('span');
    detail.textContent = `Lớp ${student.className} · ${student.school}`;
    identity.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'student-account-actions';
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'account-reset-btn';
    resetButton.textContent = 'Cấp mật khẩu tạm';
    resetButton.addEventListener('click', () => resetStudentPassword(student.id));
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'account-delete-btn';
    deleteButton.textContent = 'Xóa tài khoản';
    deleteButton.addEventListener('click', () => deleteStudentAccount(student.id));
    actions.append(resetButton, deleteButton);
    row.append(identity, actions);
    container.appendChild(row);
  });
}

async function resetStudentPassword(studentId) {
  const accounts = getStudentAccounts();
  const student = accounts.find((item) => item.id === studentId);
  if (!student) return;
  try {
    const temporaryPassword = makeTemporaryPassword();
    const credential = await hashStudentPassword(temporaryPassword);
    student.salt = credential.salt;
    student.passwordHash = credential.hash;
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    const status = document.getElementById('student-account-admin-status');
    const notice = document.createElement('div');
    notice.className = 'temporary-password-notice';
    const message = document.createElement('span');
    message.textContent = `Mật khẩu tạm của ${student.name}`;
    const password = document.createElement('code');
    password.className = 'temporary-password-value';
    password.textContent = temporaryPassword;
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'copy-temporary-password-btn';
    copyButton.textContent = 'Sao chép';
    copyButton.setAttribute('aria-label', `Sao chép mật khẩu tạm của ${student.name}`);
    copyButton.addEventListener('click', async () => {
      try {
        if (navigator.clipboard?.writeText && window.isSecureContext) {
          await navigator.clipboard.writeText(temporaryPassword);
        } else {
          const temporaryInput = document.createElement('textarea');
          temporaryInput.value = temporaryPassword;
          temporaryInput.style.position = 'fixed';
          temporaryInput.style.opacity = '0';
          document.body.appendChild(temporaryInput);
          temporaryInput.select();
          const copied = document.execCommand('copy');
          temporaryInput.remove();
          if (!copied) throw new Error('Không thể sao chép tự động. Hãy chọn mã và copy thủ công.');
        }
        copyButton.textContent = 'Đã sao chép!';
        copyButton.classList.add('copied');
      } catch (error) {
        copyButton.textContent = 'Chọn mã để copy';
        password.tabIndex = 0;
        password.focus();
        const range = document.createRange();
        range.selectNodeContents(password);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    });
    const deliveryNote = document.createElement('small');
    deliveryNote.textContent = 'Mã chỉ hiện lần này. Hãy gửi riêng cho học sinh.';
    notice.append(message, password, copyButton, deliveryNote);
    status.replaceChildren(notice);
  } catch (error) {
    document.getElementById('student-account-admin-status').textContent = error.message;
  }
}

function deleteStudentAccount(studentId) {
  const student = getStudentAccounts().find((item) => item.id === studentId);
  if (!student || !window.confirm(`Xóa tài khoản của ${student.name}? Bài nộp cũ vẫn được giữ để theo dõi.`)) return;
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(getStudentAccounts().filter((item) => item.id !== studentId)));
  if (sessionStorage.getItem(SESSION_KEY) === studentId) sessionStorage.removeItem(SESSION_KEY);
  document.getElementById('student-account-admin-status').textContent = `Đã xóa tài khoản ${student.name}.`;
  renderStudentAccounts();
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const status = document.getElementById('password-change-status');
  const student = getActiveStudent();
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const repeatedPassword = document.getElementById('repeat-new-password').value;
  status.textContent = '';
  if (!student) {
    status.textContent = 'Em cần đăng nhập lại trước.';
    return;
  }
  if (newPassword.length < 6) {
    status.textContent = 'Mật khẩu mới cần có ít nhất 6 ký tự.';
    return;
  }
  if (newPassword !== repeatedPassword) {
    status.textContent = 'Hai lần nhập mật khẩu mới chưa khớp.';
    return;
  }

  try {
    const currentCredential = await hashStudentPassword(currentPassword, student.salt);
    if (currentCredential.hash !== student.passwordHash) {
      status.textContent = 'Mật khẩu hiện tại chưa đúng.';
      return;
    }
    const nextCredential = await hashStudentPassword(newPassword);
    const accounts = getStudentAccounts();
    const account = accounts.find((item) => item.id === student.id);
    account.salt = nextCredential.salt;
    account.passwordHash = nextCredential.hash;
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    document.getElementById('password-change-form').reset();
    status.textContent = 'Đã đổi mật khẩu.';
  } catch (error) {
    status.textContent = error.message || 'Chưa thể đổi mật khẩu.';
  }
}

function closeTeacherGate() {
  passcodeModal.classList.add('hidden');
  passcodeInput.value = '';
  passcodeInput.disabled = false;
  unlockBtn.disabled = false;
  errorMsg.classList.add('hidden');
  attemptCount = 0;
  isLocked = false;
  const student = getActiveStudent();
  if (student) showStudentDesk(student);
  else showAccountGate(getStudentAccounts().length ? 'login' : 'register');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function getYouTubeEmbedUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let videoId = '';
    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      videoId = url.pathname === '/watch'
        ? (url.searchParams.get('v') || '')
        : (url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1] || '');
    }
    return /^[\w-]{11}$/.test(videoId)
      ? `https://www.youtube-nocookie.com/embed/${videoId}?controls=1&playsinline=1&rel=0`
      : '';
  } catch (error) {
    return '';
  }
}

function buildListeningMediaMarkup(question) {
  const embedUrl = getYouTubeEmbedUrl(question.video || '');
  if (embedUrl) {
    return `
      <div class="question-media">
        <iframe src="${embedUrl}" title="Listening question video" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      </div>
    `;
  }
  if (question.audio) {
    try {
      const audioUrl = new URL(question.audio);
      if (['https:', 'http:'].includes(audioUrl.protocol)) {
        return `<audio class="question-audio" controls preload="metadata" src="${escapeHtml(audioUrl.href)}">Your browser does not support audio playback.</audio>`;
      }
    } catch (error) {
      return '';
    }
  }
  return '';
}

function buildQuestionMarkup(skill, question, index) {
  const q = { ...question, type: question.type || 'multiple-choice', points: Number(question.points || 1) };
  const media = skill === 'listening' ? buildListeningMediaMarkup(q) : '';

  if (q.type === 'matching') {
    const pairList = q.pairs && q.pairs.length ? q.pairs : [{ left: 'cat', right: 'mèo' }, { left: 'dog', right: 'chó' }];
    const answerOptions = pairList.map((pair) => pair.right);
    if (answerOptions.length > 1) answerOptions.unshift(answerOptions.pop());

    return `
      <div class="question-card" data-skill="${skill}" data-id="${q.id}" data-type="matching" data-attempts="0" data-resolved="false">
        <h4>Question ${index + 1}</h4>
        ${media}
        <p>${q.prompt}</p>
        <div class="match-grid">
          <strong class="match-column-heading">Word</strong>
          <strong class="match-column-heading">Drag the match</strong>
          ${pairList.map((pair, pairIndex) => `
            <div class="match-drop-zone" data-left="${escapeHtml(pair.left)}" data-value="">
              <span class="match-prompt">${escapeHtml(pair.left)}</span>
              <span class="match-drop-placeholder">Drop here</span>
            </div>
            <button class="match-option" type="button" draggable="true" data-value="${escapeHtml(answerOptions[pairIndex])}">${escapeHtml(answerOptions[pairIndex])}</button>
          `).join('')}
        </div>
        <div class="question-hint" hidden></div>
        <button type="button" class="check-answer-btn" disabled>Check answer</button>
        <div class="result-box"></div>
      </div>
    `;
  }

  if (q.type === 'fill-blank') {
    const answerInput = '<input class="answer-input fill-blank-input" type="text" autocomplete="off" placeholder="Type or drop your answer" />';
    const prompt = escapeHtml(q.prompt || 'Fill in the blank: ___');
    const promptMarkup = /_{3,}/.test(prompt) ? prompt.replace(/_{3,}/, answerInput) : `${prompt} ${answerInput}`;
    return `
      <div class="question-card" data-skill="${skill}" data-id="${q.id}" data-type="fill-blank" data-attempts="0" data-resolved="false">
        <h4>Question ${index + 1}</h4>
        ${media}
        <p class="fill-blank-prompt">${promptMarkup}</p>
        <div class="fill-blank-bank">
          ${(q.choices || []).map((choice) => `<button class="fill-blank-choice" type="button" draggable="true" data-value="${escapeHtml(choice)}">${escapeHtml(choice)}</button>`).join('')}
        </div>
        <div class="question-hint" hidden></div>
        <button type="button" class="check-answer-btn" disabled>Check answer</button>
        <div class="result-box"></div>
      </div>
    `;
  }

  if (q.type === 'true-false') {
    return `
      <div class="question-card" data-skill="${skill}" data-id="${q.id}" data-type="true-false" data-attempts="0" data-resolved="false">
        <h4>Question ${index + 1}</h4>
        ${media}
        <p>${q.prompt}</p>
        <div class="option-list">
          ${['True', 'False'].map((choice) => `
            <label class="option-item"><input type="radio" name="${skill}-${q.id}" value="${choice}" /> ${choice}</label>
          `).join('')}
        </div>
        <div class="question-hint" hidden></div>
        <button type="button" class="check-answer-btn" disabled>Check answer</button>
        <div class="result-box"></div>
      </div>
    `;
  }

  return `
    <div class="question-card" data-skill="${skill}" data-id="${q.id}" data-type="multiple-choice" data-attempts="0" data-resolved="false">
      <h4>Question ${index + 1}</h4>
      ${media}
      <p>${q.prompt}</p>
      <div class="option-list">
        ${(q.choices || []).map((choice) => `
          <label class="option-item"><input type="radio" name="${skill}-${q.id}" value="${choice}" /> ${choice}</label>
        `).join('')}
      </div>
      <div class="question-hint" hidden></div>
      <button type="button" class="check-answer-btn" disabled>Check answer</button>
      <div class="result-box"></div>
    </div>
  `;
}

function scoreQuestion(questionCard) {
  if (questionCard.dataset.resolved === 'true') return;
  const skill = questionCard.dataset.skill;
  const questionId = Number(questionCard.dataset.id);
  const question = (getLessonData()[skill] || []).find((item) => Number(item.id) === questionId) || {};
  const questionType = questionCard.dataset.type || question.type || 'multiple-choice';
  const points = Number(question.points || 1);
  let isCorrect = false;
  let userAnswer = '';

  if (questionType === 'fill-blank') {
    userAnswer = questionCard.querySelector('.answer-input')?.value || '';
    isCorrect = normalizeText(userAnswer) === normalizeText(question.answer);
  }

  if (questionType === 'multiple-choice' || questionType === 'true-false') {
    const selected = questionCard.querySelector('input[type="radio"]:checked');
    userAnswer = selected ? selected.value : '';
    isCorrect = normalizeText(userAnswer) === normalizeText(question.answer);
  }

  if (questionType === 'matching') {
    const expectedMap = Object.fromEntries((question.pairs || []).map((pair) => [pair.left, pair.right]));
    const selectedMap = {};
    questionCard.querySelectorAll('.match-drop-zone').forEach((zone) => {
      if (zone.dataset.value) selectedMap[zone.dataset.left] = zone.dataset.value;
    });
    if (Object.keys(selectedMap).length !== Object.keys(expectedMap).length) {
      questionCard.querySelector('.result-box').textContent = 'Hãy điền đủ các cặp trước khi kiểm tra.';
      return;
    }
    userAnswer = JSON.stringify(selectedMap);
    isCorrect = JSON.stringify(selectedMap) === JSON.stringify(expectedMap);
  }

  if (!String(userAnswer).trim()) {
    questionCard.querySelector('.result-box').textContent = 'Hãy nhập hoặc chọn đáp án trước khi kiểm tra.';
    return;
  }

  const attempts = Number(questionCard.dataset.attempts || 0) + 1;
  questionCard.dataset.attempts = String(attempts);
  const resultBox = questionCard.querySelector('.result-box');
  const hintBox = questionCard.querySelector('.question-hint');
  if (isCorrect) {
    questionCard.classList.add('correct');
    questionCard.classList.remove('wrong');
    resultBox.textContent = `✓ Correct! +${points} point${points > 1 ? 's' : ''}`;
    resultBox.className = 'result-box correct';
    questionCard.dataset.resolved = 'true';
    hintBox?.setAttribute('hidden', '');
    window.__toyboxScore = window.__toyboxScore || {};
    window.__toyboxScore[`${skill}-${questionId}`] = points;
  } else {
    questionCard.classList.add('wrong');
    resultBox.textContent = attempts === 1
      ? 'Chưa đúng. Em xem gợi ý rồi thử lại nhé.'
      : 'Sai lần thứ hai. Câu này được tính sai.';
    resultBox.className = 'result-box wrong';
    if (attempts === 1) {
      const fallbackHint = questionType === 'fill-blank'
        ? 'Thử kéo một từ trong khung đáp án vào chỗ trống.'
        : questionType === 'matching'
          ? 'Đọc từng từ ở cột trái rồi tìm nghĩa phù hợp ở cột phải.'
          : 'Đọc kỹ đề và loại trừ đáp án chưa phù hợp.';
      if (hintBox) {
        hintBox.textContent = `Gợi ý: ${question.hint || fallbackHint}`;
        hintBox.hidden = false;
      }
    } else {
      questionCard.dataset.resolved = 'true';
    }
    window.__toyboxScore = window.__toyboxScore || {};
    window.__toyboxScore[`${skill}-${questionId}`] = 0;
  }

  const checkButton = questionCard.querySelector('.check-answer-btn');
  if (questionCard.dataset.resolved === 'true') {
    questionCard.querySelectorAll('input, select, .fill-blank-choice, .match-option').forEach((control) => {
      if ('disabled' in control) control.disabled = true;
      control.draggable = false;
    });
    if (checkButton) checkButton.disabled = true;
  }
  updateScorePanel();
  updateExamCompletion();
}

function updateScorePanel() {
  const scorePanel = document.querySelector('.score-panel');
  const lesson = getLessonData();
  const total = [...(lesson.listening || []), ...(lesson.reading || [])]
    .reduce((sum, question) => sum + Number(question.points || 1), 0);
  const earned = Object.values(window.__toyboxScore || {}).reduce((sum, item) => sum + Number(item || 0), 0);
  const scoreText = `Score: ${earned} / ${total}`;
  if (scorePanel) {
    scorePanel.textContent = scoreText;
  }
}

function updateExamCompletion() {
  const questions = [...document.querySelectorAll('.question-card[data-skill="listening"], .question-card[data-skill="reading"]')];
  const submitButton = document.getElementById('submit-exam-btn');
  if (!submitButton) return;
  const resolvedCount = questions.filter((card) => card.dataset.resolved === 'true').length;
  const complete = questions.length > 0 && resolvedCount === questions.length;
  submitButton.disabled = !complete;
  if (examStarted) {
    document.getElementById('exam-status').textContent = complete
      ? 'Đã hoàn thành câu hỏi. Em có thể nộp bài.'
      : `Đã hoàn thành ${resolvedCount}/${questions.length} câu.`;
  }
}

function renderStudentSkills() {
  const data = getLessonData();
  const scorePanel = document.querySelector('.score-panel') || document.createElement('div');
  scorePanel.className = 'score-panel';
  scorePanel.textContent = 'Score: 0 / 0';
  const canvas = document.getElementById('student-canvas');
  if (canvas && !document.querySelector('.score-panel')) {
    canvas.insertBefore(scorePanel, canvas.firstChild.nextSibling);
  }

  const listeningWrap = document.getElementById('student-listening-questions');
  if (listeningWrap) {
    listeningWrap.innerHTML = (data.listening || []).map((q, index) => buildQuestionMarkup('listening', q, index)).join('');
  }

  const readingWrap = document.getElementById('student-reading-questions');
  if (readingWrap) {
    readingWrap.innerHTML = (data.reading || []).map((q, index) => buildQuestionMarkup('reading', q, index)).join('');
  }

  const speakingWrap = document.getElementById('student-speaking-prompts');
  if (speakingWrap) {
    speakingWrap.innerHTML = (data.speaking || []).map((q, index) => `
      <div class="question-card">
        <h4>Prompt ${index + 1}</h4>
        <p>${q.prompt}</p>
      </div>
    `).join('');
  }

  const writingWrap = document.getElementById('student-writing-prompts');
  if (writingWrap) {
    writingWrap.innerHTML = (data.writing || []).map((q, index) => `
      <div class="question-card">
        <h4>Task ${index + 1}</h4>
        <p>${q.prompt}</p>
      </div>
    `).join('');
  }

  renderPublishedQuizzes();
  renderStudentPdfLibrary();

  updateScorePanel();
}

function openPdfDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Trình duyệt không hỗ trợ lưu PDF.'));
  if (!pdfDatabasePromise) {
    pdfDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(PDF_DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('pdfs')) request.result.createObjectStore('pdfs', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return pdfDatabasePromise;
}

function getPdfMetadata() {
  try {
    const metadata = JSON.parse(localStorage.getItem('vo-nho-pdf-metadata') || '[]');
    return Array.isArray(metadata) ? metadata : [];
  } catch (error) {
    return [];
  }
}

function savePdfMetadata(metadata) {
  localStorage.setItem('vo-nho-pdf-metadata', JSON.stringify(metadata));
}

function renderPdfCards(container, documents, teacherView) {
  if (!container) return;
  container.replaceChildren();
  if (!documents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-account-list';
    empty.textContent = teacherView ? 'Chưa có PDF. Tải tài liệu đầu tiên lên nhé.' : 'Chưa có tài liệu được chia sẻ.';
    container.appendChild(empty);
    return;
  }

  documents.forEach((documentInfo) => {
    const card = document.createElement('article');
    card.className = 'pdf-library-card';
    const icon = document.createElement('span');
    icon.className = 'pdf-file-icon';
    icon.textContent = 'PDF';
    const detail = document.createElement('div');
    detail.className = 'pdf-library-detail';
    const title = document.createElement('strong');
    title.textContent = documentInfo.name;
    const subtitle = document.createElement('span');
    const sizeKb = Math.max(1, Math.round(documentInfo.size / 1024));
    subtitle.textContent = `${sizeKb} KB · ${documentInfo.shared ? 'Đang chia sẻ' : 'Riêng tư'}`;
    detail.append(title, subtitle);
    card.append(icon, detail);

    if (teacherView) {
      const controls = document.createElement('div');
      controls.className = 'pdf-library-actions';
      const accessLabel = document.createElement('label');
      accessLabel.className = 'library-access-toggle';
      const access = document.createElement('input');
      access.type = 'checkbox';
      access.checked = Boolean(documentInfo.shared);
      access.setAttribute('aria-label', `Chia sẻ ${documentInfo.name} với học sinh`);
      access.addEventListener('change', () => {
        const metadata = getPdfMetadata();
        const target = metadata.find((item) => item.id === documentInfo.id);
        if (!target) return;
        target.shared = access.checked;
        savePdfMetadata(metadata);
        renderTeacherPdfLibrary();
        renderStudentPdfLibrary();
      });
      accessLabel.append(access, document.createTextNode('Mở quyền'));
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'account-delete-btn';
      deleteButton.textContent = 'Xóa';
      deleteButton.addEventListener('click', () => deletePdfDocument(documentInfo.id));
      controls.append(accessLabel, deleteButton);
      card.appendChild(controls);
    } else {
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'secondary-btn';
      openButton.textContent = 'Mở PDF';
      openButton.addEventListener('click', () => openPdfDocument(documentInfo.id));
      card.appendChild(openButton);
    }
    container.appendChild(card);
  });
}

function renderTeacherPdfLibrary() {
  renderPdfCards(document.getElementById('teacher-pdf-library'), getPdfMetadata(), true);
}

function renderStudentPdfLibrary() {
  renderPdfCards(document.getElementById('student-pdf-library'), getPdfMetadata().filter((item) => item.shared), false);
}

async function saveUploadedPdf(file) {
  const status = document.getElementById('teacher-pdf-status');
  if (!file || file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    status.textContent = 'Hãy chọn một file PDF.';
    return;
  }
  try {
    const database = await openPdfDatabase();
    const documentInfo = { id: window.crypto.randomUUID(), name: file.name, size: file.size, shared: false, addedAt: new Date().toISOString() };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('pdfs', 'readwrite');
      transaction.objectStore('pdfs').put({ ...documentInfo, file });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    const metadata = getPdfMetadata();
    metadata.push(documentInfo);
    savePdfMetadata(metadata);
    renderTeacherPdfLibrary();
    status.textContent = `Đã tải ${file.name}. Bật Mở quyền để học sinh xem.`;
  } catch (error) {
    status.textContent = error.message || 'Chưa lưu được PDF trong trình duyệt.';
  }
}

async function openPdfDocument(documentId) {
  try {
    const database = await openPdfDatabase();
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction('pdfs', 'readonly').objectStore('pdfs').get(documentId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!record?.file) throw new Error('Không tìm thấy file PDF trong trình duyệt này.');
    const url = URL.createObjectURL(record.file);
    pdfObjectUrls.push(url);
    window.open(url, '_blank', 'noopener');
  } catch (error) {
    window.alert(error.message);
  }
}

async function deletePdfDocument(documentId) {
  const database = await openPdfDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('pdfs', 'readwrite');
    transaction.objectStore('pdfs').delete(documentId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  savePdfMetadata(getPdfMetadata().filter((item) => item.id !== documentId));
  renderTeacherPdfLibrary();
  renderStudentPdfLibrary();
}

function renderPublishedQuizzes() {
  const container = document.getElementById('published-quiz-list');
  if (!container) return;
  container.replaceChildren();
  const published = getQuizArchive().flatMap((folder) => (folder.quizzes || [])
    .filter((quiz) => quiz.openToStudents).map((quiz) => ({ ...quiz, folderName: folder.name })));
  const label = document.createElement('label');
  label.className = 'published-quiz-select';
  label.textContent = 'Chọn quiz';
  const select = document.createElement('select');
  select.id = 'student-published-quiz-select';
  const current = sessionStorage.getItem(ACTIVE_PRACTICE_KEY) || '';
  const currentOption = document.createElement('option');
  currentOption.value = '';
  currentOption.textContent = 'Bài học hiện tại';
  select.appendChild(currentOption);
  published.forEach((quiz) => {
    const option = document.createElement('option');
    option.value = quiz.id;
    option.textContent = `${quiz.folderName} / ${quiz.name}`;
    option.selected = quiz.id === current;
    select.appendChild(option);
  });
  select.addEventListener('change', () => {
    if (select.value) sessionStorage.setItem(ACTIVE_PRACTICE_KEY, select.value);
    else sessionStorage.removeItem(ACTIVE_PRACTICE_KEY);
    document.getElementById('active-quiz-name').textContent = select.selectedOptions[0].textContent;
    renderStudentSkills();
  });
  label.appendChild(select);
  container.appendChild(label);
  document.getElementById('active-quiz-name').textContent = select.selectedOptions[0]?.textContent || 'Bộ câu hỏi hiện tại';
}

function renderQuizArchive() {
  const archive = getQuizArchive();
  const folderSelect = document.getElementById('archive-quiz-folder');
  const folderContainer = document.getElementById('quiz-archive-folders');
  if (!folderSelect || !folderContainer) return;
  folderSelect.replaceChildren();
  folderContainer.replaceChildren();
  const folderPlaceholder = document.createElement('option');
  folderPlaceholder.value = '';
  folderPlaceholder.textContent = archive.length ? 'Chọn thư mục' : 'Tạo thư mục trước';
  folderPlaceholder.disabled = archive.length > 0;
  folderPlaceholder.selected = archive.length === 0;
  folderSelect.appendChild(folderPlaceholder);

  archive.forEach((folder) => {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.name;
    folderSelect.appendChild(option);

    const folderCard = document.createElement('section');
    folderCard.className = 'quiz-archive-folder';
    folderCard.dataset.folderId = folder.id;
    folderCard.draggable = true;
    folderCard.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('application/x-vo-nho-folder', folder.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    folderCard.addEventListener('dragover', (event) => {
      if (event.dataTransfer.types.includes('application/x-vo-nho-quiz')) {
        event.preventDefault();
        folderCard.classList.add('is-drop-target');
      }
    });
    folderCard.addEventListener('dragleave', (event) => {
      if (!folderCard.contains(event.relatedTarget)) folderCard.classList.remove('is-drop-target');
    });
    folderCard.addEventListener('drop', (event) => {
      const quizId = event.dataTransfer.getData('application/x-vo-nho-quiz');
      if (!quizId) return;
      event.preventDefault();
      folderCard.classList.remove('is-drop-target');
      moveArchivedQuiz(quizId, folder.id);
    });

    const header = document.createElement('div');
    header.className = 'quiz-folder-header';
    const name = document.createElement('h4');
    name.textContent = `📁 ${folder.name}`;
    const count = document.createElement('span');
    count.textContent = `${(folder.quizzes || []).length} quiz`;
    header.append(name, count);
    folderCard.appendChild(header);

    (folder.quizzes || []).forEach((quiz) => {
      const quizCard = document.createElement('article');
      quizCard.className = 'archived-quiz-card';
      quizCard.draggable = true;
      quizCard.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('application/x-vo-nho-quiz', quiz.id);
        event.dataTransfer.effectAllowed = 'move';
      });
      const quizName = document.createElement('strong');
      quizName.textContent = quiz.name;
      const meta = document.createElement('span');
      const countQuestions = (quiz.lesson.listening || []).length + (quiz.lesson.reading || []).length;
      meta.textContent = `${countQuestions} câu · ${quiz.openToStudents ? 'Đang mở' : 'Đóng quyền'}`;
      const controls = document.createElement('div');
      controls.className = 'archive-quiz-controls';
      const accessLabel = document.createElement('label');
      accessLabel.className = 'library-access-toggle';
      const access = document.createElement('input');
      access.type = 'checkbox';
      access.checked = Boolean(quiz.openToStudents);
      access.setAttribute('aria-label', `Cho phép học sinh làm lại quiz ${quiz.name}`);
      access.addEventListener('change', () => setArchivedQuizAccess(quiz.id, access.checked));
      accessLabel.append(access, document.createTextNode('Mở quyền học sinh'));
      const loadButton = document.createElement('button');
      loadButton.type = 'button';
      loadButton.className = 'archive-load-btn';
      loadButton.textContent = 'Dùng làm bài hiện tại';
      loadButton.addEventListener('click', () => loadArchivedQuizIntoBuilder(quiz.id));
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'account-delete-btn';
      deleteButton.textContent = 'Xóa quiz';
      deleteButton.addEventListener('click', () => deleteArchivedQuiz(quiz.id));
      controls.append(accessLabel, loadButton, deleteButton);
      quizCard.append(quizName, meta, controls);
      folderCard.appendChild(quizCard);
    });

    const deleteFolder = document.createElement('button');
    deleteFolder.type = 'button';
    deleteFolder.className = 'delete-folder-btn';
    deleteFolder.textContent = 'Xóa thư mục';
    deleteFolder.addEventListener('click', () => deleteQuizFolder(folder.id));
    folderCard.appendChild(deleteFolder);
    folderContainer.appendChild(folderCard);
  });

  if (!archive.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-account-list';
    empty.textContent = 'Tạo thư mục đầu tiên để bắt đầu lưu quiz.';
    folderContainer.appendChild(empty);
  }
}

function addQuizFolder(name) {
  const archive = getQuizArchive();
  if (archive.some((folder) => normalizeIdentity(folder.name) === normalizeIdentity(name))) {
    throw new Error('Đã có thư mục trùng tên.');
  }
  const folder = { id: window.crypto.randomUUID(), name, quizzes: [] };
  archive.push(folder);
  saveQuizArchive(archive);
  activeArchiveFolderId = folder.id;
}

function setArchivedQuizAccess(quizId, isOpen) {
  const archive = getQuizArchive();
  archive.forEach((folder) => (folder.quizzes || []).forEach((quiz) => {
    if (quiz.id === quizId) quiz.openToStudents = isOpen;
  }));
  saveQuizArchive(archive);
  renderQuizArchive();
  renderPublishedQuizzes();
}

function moveArchivedQuiz(quizId, destinationFolderId) {
  const archive = getQuizArchive();
  let movedQuiz = null;
  archive.forEach((folder) => {
    const index = (folder.quizzes || []).findIndex((quiz) => quiz.id === quizId);
    if (index !== -1) movedQuiz = folder.quizzes.splice(index, 1)[0];
  });
  const destination = archive.find((folder) => folder.id === destinationFolderId);
  if (!movedQuiz || !destination) return;
  destination.quizzes.push(movedQuiz);
  saveQuizArchive(archive);
  renderQuizArchive();
  document.getElementById('quiz-archive-status').textContent = `Đã chuyển quiz vào ${destination.name}.`;
}

function deleteArchivedQuiz(quizId) {
  const archive = getQuizArchive();
  const name = archive.flatMap((folder) => folder.quizzes || []).find((quiz) => quiz.id === quizId)?.name;
  if (!name || !window.confirm(`Xóa quiz "${name}" khỏi kho?`)) return;
  saveQuizArchive(archive.map((folder) => ({ ...folder, quizzes: (folder.quizzes || []).filter((quiz) => quiz.id !== quizId) })));
  renderQuizArchive();
  renderPublishedQuizzes();
}

function deleteQuizFolder(folderId) {
  const archive = getQuizArchive();
  const folder = archive.find((item) => item.id === folderId);
  if (!folder || !window.confirm(`Xóa thư mục "${folder.name}" và các quiz bên trong?`)) return;
  saveQuizArchive(archive.filter((item) => item.id !== folderId));
  renderQuizArchive();
  renderPublishedQuizzes();
}

function loadArchivedQuizIntoBuilder(quizId) {
  const quiz = getQuizArchive().flatMap((folder) => folder.quizzes || []).find((item) => item.id === quizId);
  if (!quiz) return;
  sessionStorage.removeItem(ACTIVE_PRACTICE_KEY);
  const lesson = getBaseLessonData();
  lesson.listening = JSON.parse(JSON.stringify(quiz.lesson.listening || []));
  lesson.reading = JSON.parse(JSON.stringify(quiz.lesson.reading || []));
  saveLessonData(lesson, true);
  document.getElementById('quiz-archive-status').textContent = `Đã nạp "${quiz.name}" vào lesson hiện tại.`;
}

function archiveCurrentQuiz(name, folderId) {
  const archive = getQuizArchive();
  const folder = archive.find((item) => item.id === folderId);
  if (!folder) throw new Error('Hãy tạo hoặc chọn một thư mục trước.');
  folder.quizzes.push({
    id: window.crypto.randomUUID(),
    name,
    openToStudents: false,
    savedAt: new Date().toISOString(),
    lesson: { listening: getBaseLessonData().listening || [], reading: getBaseLessonData().reading || [] }
  });
  saveQuizArchive(archive);
  renderQuizArchive();
}

function createTeacherForm(skill, editingId = null) {
  const formWrap = document.getElementById('teacher-skill-form');
  if (!formWrap) return;

  const items = getLessonData()[skill] || [];
  const editingItem = items.find((item) => String(item.id) === String(editingId));
  const isQuizSkill = skill === 'listening' || skill === 'reading';
  const typeLabels = {
    'multiple-choice': 'Multiple choice',
    'fill-blank': 'Fill blank',
    matching: 'Matching',
    'true-false': 'True / False'
  };

  formWrap.innerHTML = `
    <div class="skill-form-box">
      ${isQuizSkill ? `
        <label>
          Question type
          <select id="teacher-question-type">
            ${QUIZ_TYPES.map((type) => `<option value="${type}" ${editingItem?.type === type || (!editingItem && type === 'multiple-choice') ? 'selected' : ''}>${typeLabels[type]}</option>`).join('')}
          </select>
        </label>
      ` : ''}

      <label>
        ${isQuizSkill ? 'Question prompt' : 'Task prompt'}
        <textarea id="teacher-form-prompt" rows="3" placeholder="Write the prompt for your students">${escapeHtml(editingItem?.prompt || '')}</textarea>
      </label>

      ${isQuizSkill ? `
        <div class="question-fields-grid">
          <label>
            Choices (comma separated)
            <input id="teacher-form-choices" type="text" value="${escapeHtml(editingItem?.choices?.join(', ') || (editingItem?.type === 'true-false' ? 'True, False' : 'Option A, Option B'))}" placeholder="Option A, Option B" />
          </label>
          <label>
            Correct answer
            <input id="teacher-form-answer" type="text" value="${escapeHtml(editingItem?.answer ?? (editingItem?.type === 'true-false' ? 'True' : editingItem?.type ? '' : 'Option A'))}" placeholder="Enter the correct answer" />
          </label>
          <label class="matching-field">
            Matching pairs (left|right; left|right)
            <input id="teacher-form-matching" type="text" value="${escapeHtml(editingItem?.pairs?.map((pair) => `${pair.left}|${pair.right}`).join('; ') || '')}" placeholder="cat|mèo; dog|chó" />
          </label>
          ${skill === 'listening' ? `
            <label>
              YouTube video or audio link
              <input id="teacher-form-media" type="url" value="${escapeHtml(editingItem?.video || editingItem?.audio || '')}" placeholder="https://youtu.be/..." />
            </label>
          ` : ''}
          <label>
            Points
            <input id="teacher-form-points" type="number" min="0.5" step="0.5" value="${Number(editingItem?.points || 1)}" />
          </label>
          <label class="hint-field">
            Hint shown after the first wrong attempt
            <input id="teacher-form-hint" type="text" value="${escapeHtml(editingItem?.hint || '')}" placeholder="A small clue, not the answer" />
          </label>
        </div>
      ` : ''}

      <div class="question-form-actions">
        <button id="add-question-btn" class="primary-btn" type="button">${editingItem ? 'Save changes' : 'Add question'}</button>
        ${editingItem ? '<button id="cancel-edit-btn" class="secondary-btn" type="button">Cancel</button>' : ''}
      </div>
    </div>

    <div class="question-list-heading">
      <h4>${skill[0].toUpperCase()}${skill.slice(1)} questions</h4>
      <span>${items.length} item${items.length === 1 ? '' : 's'}</span>
    </div>
    <div class="form-question-list">
      ${items.map((item, index) => `
        <article class="form-question-item">
          <div class="question-item-heading">
            <strong>${String(index + 1).padStart(2, '0')} / ${escapeHtml(skill.toUpperCase())}</strong>
            <div class="question-item-tags">
              ${item.type ? `<span class="question-type-tag">${escapeHtml(typeLabels[item.type] || item.type)}</span>` : ''}
              ${isQuizSkill ? `<span class="question-points-tag">${Number(item.points || 1)} pt${Number(item.points || 1) === 1 ? '' : 's'}</span>` : ''}
            </div>
          </div>
          <p>${escapeHtml(item.prompt)}</p>
          <div class="question-item-actions">
            <button class="question-action-btn" type="button" data-action="edit" data-id="${escapeHtml(item.id)}" aria-label="Edit question ${index + 1}">Edit</button>
            <button class="question-action-btn delete-question-btn" type="button" data-action="delete" data-id="${escapeHtml(item.id)}" aria-label="Delete question ${index + 1}">Delete</button>
          </div>
        </article>
      `).join('') || '<p class="empty-question-list">No questions yet.</p>'}
    </div>
  `;

  const addBtn = formWrap.querySelector('#add-question-btn');
  const typeSelector = formWrap.querySelector('#teacher-question-type');
  const promptField = formWrap.querySelector('#teacher-form-prompt');
  const updateAddQuestionButtonState = () => {
    if (!addBtn || !promptField) return;
    const isPromptReady = promptField.value.trim().length > 0;
    addBtn.disabled = !isPromptReady;
    addBtn.setAttribute('aria-disabled', String(!isPromptReady));
    addBtn.title = isPromptReady ? 'Add question' : 'Nhập nội dung câu hỏi trước khi lưu';
  };

  typeSelector?.addEventListener('change', () => {
    const choicesField = formWrap.querySelector('#teacher-form-choices');
    const answerField = formWrap.querySelector('#teacher-form-answer');
    const matchingField = formWrap.querySelector('#teacher-form-matching');
    if (typeSelector.value === 'true-false') {
      choicesField.value = 'True, False';
      answerField.value = 'True';
    } else if (typeSelector.value === 'matching') {
      if (!matchingField.value.trim()) matchingField.value = 'cat|mèo; dog|chó';
      answerField.value = '';
    } else if (typeSelector.value === 'fill-blank') {
      if (choicesField.value === 'True, False') choicesField.value = 'Option A, Option B';
      answerField.value = '';
    } else {
      if (choicesField.value === 'True, False' || !choicesField.value.trim()) choicesField.value = 'Option A, Option B';
      if (answerField.value === 'True' || !answerField.value.trim()) answerField.value = 'Option A';
    }
    updateAddQuestionButtonState();
  });

  promptField?.addEventListener('input', updateAddQuestionButtonState);
  updateAddQuestionButtonState();

  addBtn.addEventListener('click', () => {
    const prompt = formWrap.querySelector('#teacher-form-prompt').value.trim();
    if (!prompt) {
      teacherStatus.textContent = 'Enter a prompt before saving.';
      return;
    }

    const entry = { id: editingItem?.id ?? Date.now(), prompt };
    if (isQuizSkill) {
      const selectedType = formWrap.querySelector('#teacher-question-type').value;
      const points = Number(formWrap.querySelector('#teacher-form-points').value);
      const answer = formWrap.querySelector('#teacher-form-answer').value.trim();
      const choices = formWrap.querySelector('#teacher-form-choices').value.split(',').map((value) => value.trim()).filter(Boolean);
      const hint = formWrap.querySelector('#teacher-form-hint').value.trim();
      entry.type = selectedType;
      entry.points = points;
      if (hint) entry.hint = hint;

      if (!Number.isFinite(points) || points <= 0) {
        teacherStatus.textContent = 'Points must be greater than zero.';
        return;
      }
      if (selectedType === 'multiple-choice' && (choices.length < 2 || !choices.includes(answer))) {
        teacherStatus.textContent = 'Add at least two choices and make the correct answer match one.';
        return;
      }
      if (selectedType === 'fill-blank' && !answer) {
        teacherStatus.textContent = 'Enter the correct answer for this fill-in question.';
        return;
      }
      if (selectedType === 'true-false' && !['true', 'false'].includes(answer.toLowerCase())) {
        teacherStatus.textContent = 'For True / False, the answer must be True or False.';
        return;
      }

      if (selectedType === 'matching') {
        entry.pairs = formWrap.querySelector('#teacher-form-matching').value
          .split(';').map((pair) => pair.trim()).filter(Boolean)
          .map((pair) => {
            const [left, right] = pair.split('|').map((value) => value.trim());
            return { left, right };
          }).filter((pair) => pair.left && pair.right);
        if (!entry.pairs.length || new Set(entry.pairs.map((pair) => pair.left)).size !== entry.pairs.length) {
          teacherStatus.textContent = 'Add matching pairs with a unique left side, for example cat|mèo; dog|chó.';
          return;
        }
      } else {
        entry.answer = selectedType === 'true-false' ? (answer.toLowerCase() === 'true' ? 'True' : 'False') : answer;
        if (selectedType === 'multiple-choice' || selectedType === 'fill-blank') entry.choices = choices;
      }

      if (skill === 'listening') {
        const mediaUrl = formWrap.querySelector('#teacher-form-media').value.trim();
        if (mediaUrl) {
          if (getYouTubeEmbedUrl(mediaUrl)) entry.video = mediaUrl;
          else entry.audio = mediaUrl;
        }
      }
    }

    const lesson = getLessonData();
    const updatedItems = [...(lesson[skill] || [])];
    const itemIndex = updatedItems.findIndex((item) => String(item.id) === String(editingItem?.id));
    if (editingItem && itemIndex !== -1) updatedItems[itemIndex] = entry;
    else updatedItems.push(entry);
    lesson[skill] = updatedItems;
    saveLessonData(lesson, true);
    createTeacherForm(skill);
    teacherStatus.textContent = editingItem ? 'Question updated and lesson saved.' : 'Question added and lesson saved.';
  });

  formWrap.querySelector('#cancel-edit-btn')?.addEventListener('click', () => createTeacherForm(skill));
  formWrap.onclick = (event) => {
    const actionButton = event.target.closest('.question-action-btn');
    if (!actionButton) return;

    const questionId = actionButton.dataset.id;
    if (actionButton.dataset.action === 'edit') {
      createTeacherForm(skill, questionId);
      teacherStatus.textContent = 'Editing question. Save or cancel your changes.';
      return;
    }

    const lesson = getLessonData();
    lesson[skill] = (lesson[skill] || []).filter((item) => String(item.id) !== String(questionId));
    saveLessonData(lesson, true);
    createTeacherForm(skill);
    teacherStatus.textContent = 'Question deleted and lesson saved.';
  };
}

function toggleStudentTabs() {
  document.querySelectorAll('.skill-tab').forEach((button) => {
    button.addEventListener('click', () => updateSkillTabs('.skill-tab', button.dataset.skill));
  });
}

function updateSkillTabs(tabSelector, skill) {
  if (examStarted && tabSelector === '.skill-tab') return;
  document.querySelectorAll(tabSelector).forEach((button) => {
    button.classList.toggle('active', button.dataset.skill === skill);
  });
  if (tabSelector === '.skill-tab') {
    document.querySelectorAll('.skill-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${skill}`);
    });
  }
}

async function startStudentExam() {
  if (examStarted) return;

  examStarted = true;
  examExitAttempts = 0;
  examWasHidden = false;
  window.__toyboxScore = {};
  const quizCards = document.querySelectorAll('.question-card[data-skill="listening"], .question-card[data-skill="reading"]');
  quizCards.forEach((card) => {
    card.dataset.attempts = '0';
    card.dataset.resolved = 'false';
    card.querySelectorAll('.match-drop-zone').forEach((zone) => {
      zone.dataset.value = '';
      zone.classList.remove('is-filled');
      zone.querySelector('.match-drop-placeholder').textContent = 'Drop here';
    });
  });
  document.querySelectorAll('.question-card').forEach((card) => {
    card.classList.remove('correct', 'wrong');
    card.querySelectorAll('input').forEach((input) => {
      if (input.type === 'radio' || input.type === 'checkbox') input.checked = false;
      else input.value = '';
    });
    card.querySelectorAll('select').forEach((select) => { select.selectedIndex = 0; });
    const resultBox = card.querySelector('.result-box');
    if (resultBox) {
      resultBox.textContent = '';
      resultBox.className = 'result-box';
    }
    const hintBox = card.querySelector('.question-hint');
    if (hintBox) {
      hintBox.textContent = '';
      hintBox.hidden = true;
    }
  });

  document.body.classList.add('exam-mode');
  document.getElementById('exam-start-bar').classList.add('hidden');
  document.getElementById('exam-toolbar').classList.remove('hidden');
  document.getElementById('exam-status').textContent = 'Đang làm bài';
  document.getElementById('active-quiz-name').textContent = sessionStorage.getItem(ACTIVE_PRACTICE_KEY)
    ? getQuizArchive().flatMap((folder) => folder.quizzes || []).find((quiz) => quiz.id === sessionStorage.getItem(ACTIVE_PRACTICE_KEY))?.name || 'Quiz ôn tập'
    : 'Bộ câu hỏi hiện tại';
  document.querySelectorAll('.skill-panel').forEach((panel) => panel.classList.add('exam-visible'));
  document.querySelectorAll('.check-answer-btn').forEach((button) => { button.disabled = false; });
  updateScorePanel();
  updateExamCompletion();

  try {
    const requestFullscreen = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (!requestFullscreen) throw new Error('Fullscreen is not available.');
    await requestFullscreen.call(document.documentElement);
  } catch (error) {
    document.getElementById('exam-status').textContent = 'Không mở được toàn màn hình. Các tab kỹ năng vẫn bị khóa trong lúc làm bài.';
  }
}

function handleExamExitAttempt() {
  if (!examStarted) return;
  examExitAttempts += 1;
  if (examExitAttempts === 1) {
    window.alert('Bạn đang làm bài. Nhấn dấu X thêm một lần nữa để nộp bài và thoát.');
    return;
  }
  submitStudentExam();
}

function collectExamResponses() {
  return [...document.querySelectorAll('.question-card[data-skill][data-id]')].map((card) => {
    const type = card.dataset.type;
    let response = '';
    if (type === 'matching') {
      response = [...card.querySelectorAll('.match-drop-zone')]
        .map((zone) => `${zone.dataset.left}: ${zone.dataset.value || '—'}`).join('; ');
    } else {
      response = card.querySelector('.answer-input')?.value.trim()
        || card.querySelector('input[type="radio"]:checked')?.value
        || '';
    }
    return {
      skill: card.dataset.skill,
      question: card.querySelector('h4')?.textContent || '',
      prompt: card.querySelector('p')?.textContent || '',
      response: response || 'Chưa trả lời',
      correct: card.classList.contains('correct'),
      points: Number(window.__toyboxScore?.[`${card.dataset.skill}-${card.dataset.id}`] || 0)
    };
  });
}

function getSavedStudentSubmissions() {
  try {
    const saved = JSON.parse(localStorage.getItem(SUBMISSIONS_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    return [];
  }
}

function renderSavedQuizSubmissions() {
  const container = document.getElementById('saved-quiz-submissions');
  if (!container) return;
  container.replaceChildren();

  getSavedStudentSubmissions().slice().reverse().forEach((submission) => {
    const card = document.createElement('article');
    card.className = 'saved-quiz-submission';
    const header = document.createElement('div');
    header.className = 'submission-card-header';
    const title = document.createElement('strong');
    title.textContent = `${submission.studentName || 'Học sinh'}${submission.studentClass ? ` · ${submission.studentClass}` : ''}`;
    const score = document.createElement('strong');
    score.className = 'submission-card-score';
    score.textContent = `${submission.score} / ${submission.maximum} points`;
    header.append(title, score);

    const date = document.createElement('time');
    date.dateTime = submission.submittedAt;
    date.textContent = new Date(submission.submittedAt).toLocaleString('vi-VN');
    const school = document.createElement('p');
    school.className = 'submission-student-school';
    school.textContent = submission.studentSchool || '';
    const quizName = document.createElement('p');
    quizName.className = 'submission-quiz-name';
    quizName.textContent = submission.quizName || 'Bài học hiện tại';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'View answers';
    const answerList = document.createElement('ol');
    (submission.answers || []).forEach((answer) => {
      const item = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = `${answer.skill} · ${answer.question}: `;
      const response = document.createElement('span');
      response.textContent = answer.response;
      const result = document.createElement('span');
      result.className = answer.correct ? 'submission-answer-correct' : 'submission-answer-wrong';
      result.textContent = answer.correct ? ` (${answer.points} pt)` : ' (incorrect)';
      item.append(heading, response, result);
      answerList.appendChild(item);
    });
    details.append(summary, answerList);
    card.append(header, school, quizName, date, details);
    container.appendChild(card);
  });
}

async function submitStudentExam() {
  if (!examStarted) return;
  const lesson = getLessonData();
  const maximum = [...(lesson.listening || []), ...(lesson.reading || [])]
    .reduce((sum, question) => sum + Number(question.points || 1), 0);
  const earned = Object.values(window.__toyboxScore || {}).reduce((sum, points) => sum + Number(points || 0), 0);
  const student = getActiveStudent();
  const submission = {
    submittedAt: new Date().toISOString(),
    quizName: getActivePublishedQuiz()?.name || 'Bài học hiện tại',
    studentId: student?.id || '',
    studentName: student?.name || 'Học sinh',
    studentClass: student?.className || '',
    studentSchool: student?.school || '',
    score: earned,
    maximum,
    answers: collectExamResponses()
  };
  try {
    const submissions = getSavedStudentSubmissions();
    submissions.push(submission);
    localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(submissions.slice(-20)));
  } catch (error) {
  }

  examStarted = false;
  examExitAttempts = 0;
  examWasHidden = false;
  document.body.classList.remove('exam-mode');
  document.getElementById('exam-start-bar').classList.remove('hidden');
  document.getElementById('exam-toolbar').classList.add('hidden');
  document.querySelectorAll('.skill-panel').forEach((panel) => panel.classList.remove('exam-visible'));
  document.querySelectorAll('.check-answer-btn').forEach((button) => { button.disabled = true; });

  try {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (error) {
  }
  window.alert(`Bài làm đã được nộp. Điểm trắc nghiệm: ${earned}/${maximum}.`);
}

document.addEventListener('fullscreenchange', () => {
  if (examStarted && !document.fullscreenElement) handleExamExitAttempt();
});

document.addEventListener('visibilitychange', () => {
  if (!examStarted) return;
  if (document.hidden) {
    examWasHidden = true;
    return;
  }
  if (examWasHidden) {
    examWasHidden = false;
    handleExamExitAttempt();
  }
});

function toggleTeacherTabs() {
  document.querySelectorAll('.teacher-skill-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('teacher-layout')?.classList.remove('hidden');
      document.getElementById('teacher-resources-view').classList.add('hidden');
      document.querySelector('.teacher-resource-tab').classList.remove('active');
      document.querySelectorAll('.teacher-skill-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
      createTeacherForm(button.dataset.skill);
    });
  });
  document.querySelector('.teacher-resource-tab').addEventListener('click', () => {
    document.querySelectorAll('.teacher-skill-tab').forEach((tab) => tab.classList.remove('active'));
    document.querySelector('.teacher-resource-tab').classList.add('active');
    document.getElementById('teacher-layout').classList.add('hidden');
    document.getElementById('teacher-resources-view').classList.remove('hidden');
    showTeacherResourceSection('pdfs');
    renderStudentAccounts();
    renderTeacherPdfLibrary();
    renderQuizArchive();
  });
  document.querySelectorAll('.teacher-resource-subtab').forEach((button) => {
    button.addEventListener('click', () => showTeacherResourceSection(button.dataset.resource));
  });
}

function showTeacherResourceSection(resource) {
  document.querySelectorAll('.teacher-resource-subtab').forEach((button) => {
    button.classList.toggle('active', button.dataset.resource === resource);
  });
  document.querySelectorAll('#teacher-resources-view > .teacher-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `resource-${resource}`);
  });
}

function openTeacherGate() {
  passcodeModal.classList.remove('hidden');
  passcodeInput.focus();
}

function setMascot(kind, message, stars = '') {
  const mascotMap = {
    bumble: '🐻',
    froggo: '🐸',
    octo: '🐙'
  };

  mascotAvatar.textContent = mascotMap[kind] || '🐻';
  mascotMessage.textContent = message;
  starBadge.textContent = stars;
  starBadge.classList.toggle('hidden', !stars);
}

async function checkPasscode() {
  if (isLocked) {
    return;
  }

  const value = passcodeInput.value.trim();

  if (await verifyTeacherPin(value)) {
    const stars = attemptCount === 0 ? '⭐⭐' : '⭐';
    setMascot('froggo', attemptCount === 0 ? 'Froggo says: Great job! Teacher studio unlocked.' : 'Froggo says: Nice try! You are in!', stars);
    passcodeModal.classList.add('hidden');
    accountModal.classList.add('hidden');
    studentCanvas.classList.add('hidden');
    teacherDashboard.classList.remove('hidden');
    sessionStorage.removeItem(ACTIVE_PRACTICE_KEY);
    passcodeInput.value = '';
    errorMsg.classList.add('hidden');
    createTeacherForm('listening');
    renderSavedQuizSubmissions();
    renderStudentAccounts();
    renderTeacherPdfLibrary();
    renderQuizArchive();
    return;
  }

  attemptCount += 1;

  if (attemptCount === 1) {
    setMascot('bumble', 'Kiểm tra lại mật khẩu giáo viên nhé.', '');
    errorMsg.textContent = 'Mật khẩu chưa đúng. Giáo viên hãy thử lại.';
    errorMsg.classList.remove('hidden');
    passcodeInput.classList.add('shake');
    setTimeout(() => passcodeInput.classList.remove('shake'), 500);
    passcodeInput.value = '';
    passcodeInput.focus();
    return;
  }

  if (attemptCount >= 2) {
    isLocked = true;
    setMascot('octo', 'Teacher gate is locked for this turn.', '');
    errorMsg.textContent = 'Sai hai lần. Hãy dùng “Quên mật khẩu?” hoặc quay lại để thử tiếp.';
    errorMsg.classList.remove('hidden');
    passcodeInput.value = '';
    passcodeInput.disabled = true;
    unlockBtn.disabled = true;
    passcodeInput.classList.add('shake');
  }
}

function startSecretGateway() {
  clickCount += 1;
  clearTimeout(clickTimer);

  if (clickCount >= 3) {
    clickCount = 0;
    openTeacherGate();
    return;
  }

  clickTimer = setTimeout(() => {
    clickCount = 0;
  }, 1200);
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportTeacherState() {
  const state = getLessonData();
  const legacy = Object.fromEntries(Object.entries(state).filter(([key]) => !SKILL_KEYS.includes(key)));
  downloadJson('toybox-lesson.json', {
    format: 'toybox-lesson',
    version: 1,
    lesson: Object.fromEntries(SKILL_KEYS.map((skill) => [skill, state[skill]])),
    ...(Object.keys(legacy).length ? { legacy } : {})
  });
  teacherStatus.textContent = 'Lesson exported as JSON.';
}

function downloadLessonTemplate() {
  const template = {
    format: 'toybox-lesson',
    version: 1,
    lesson: {
      listening: [
        {
          id: 1,
          type: 'multiple-choice',
          prompt: 'Listen and choose the animal.',
          choices: ['cat', 'dog', 'bird'],
          answer: 'cat',
          points: 1,
          audio: 'https://example.com/listening-audio.mp3'
        }
      ],
      reading: [
        {
          id: 1,
          type: 'multiple-choice',
          prompt: 'Which word means "mèo"?',
          choices: ['cat', 'dog', 'bird'],
          answer: 'cat',
          points: 1
        },
        {
          id: 2,
          type: 'fill-blank',
          prompt: 'The cat is on the ___.',
          choices: ['mat', 'tree', 'chair'],
          answer: 'mat',
          points: 2
        },
        {
          id: 3,
          type: 'matching',
          prompt: 'Match each animal to its Vietnamese name.',
          pairs: [{ left: 'cat', right: 'mèo' }, { left: 'dog', right: 'chó' }],
          points: 2
        },
        {
          id: 4,
          type: 'true-false',
          prompt: 'A cat is an animal.',
          choices: ['True', 'False'],
          answer: 'True',
          points: 1
        }
      ],
      speaking: [
        { id: 1, prompt: 'Say one sentence about your favorite animal.' }
      ],
      writing: [
        { id: 1, prompt: 'Write three sentences about your favorite animal.' }
      ]
    }
  };

  downloadJson('toybox-lesson-template.json', template);
  teacherStatus.textContent = 'JSON example downloaded.';
}

function validateImportedLesson(parsed) {
  let source = parsed;
  let legacy = {};
  if (parsed?.format !== undefined) {
    if (parsed.format !== 'toybox-lesson' || parsed.version !== 1 || !parsed.lesson) {
      throw new Error('Use a Toybox lesson JSON file with version 1.');
    }
    source = parsed.lesson;
    if (parsed.legacy && typeof parsed.legacy === 'object' && !Array.isArray(parsed.legacy)) legacy = parsed.legacy;
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('The lesson must be a JSON object.');
  }

  if (parsed?.format === undefined) {
    legacy = Object.fromEntries(Object.entries(source).filter(([key]) => !SKILL_KEYS.includes(key)));
  }
  const nextState = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), ...legacy };
  SKILL_KEYS.forEach((skill) => {
    if (source[skill] === undefined) return;
    if (!Array.isArray(source[skill])) throw new Error(`"${skill}" must contain a list of questions.`);
    const isQuizSkill = skill === 'listening' || skill === 'reading';
    nextState[skill] = source[skill].map((question, index) => {
      if (!question || typeof question !== 'object' || Array.isArray(question) || !String(question.prompt || '').trim()) {
        throw new Error(`Question ${index + 1} in "${skill}" needs a prompt.`);
      }
      const item = {
        ...question,
        id: Number.isSafeInteger(Number(question.id)) ? Number(question.id) : Date.now() + index,
        prompt: String(question.prompt).trim()
      };
      if (!isQuizSkill) return item;

      item.type = question.type || 'multiple-choice';
      if (!QUIZ_TYPES.includes(item.type)) throw new Error(`Question ${index + 1} in "${skill}" has an unsupported type.`);
      item.points = Number(question.points ?? 1);
      if (!Number.isFinite(item.points) || item.points <= 0) throw new Error(`Question ${index + 1} in "${skill}" needs points greater than zero.`);

      if (item.type === 'matching') {
        if (!Array.isArray(question.pairs) || !question.pairs.length || question.pairs.some((pair) => !pair?.left || !pair?.right)) {
          throw new Error(`Matching question ${index + 1} in "${skill}" needs left/right pairs.`);
        }
        item.pairs = question.pairs.map((pair) => ({ left: String(pair.left).trim(), right: String(pair.right).trim() }));
        if (new Set(item.pairs.map((pair) => pair.left)).size !== item.pairs.length) {
          throw new Error(`Matching question ${index + 1} in "${skill}" needs unique left-side values.`);
        }
        delete item.answer;
        delete item.choices;
        return item;
      }

      item.choices = Array.isArray(question.choices) ? question.choices.map((choice) => String(choice).trim()).filter(Boolean) : [];
      item.answer = String(question.answer ?? '').trim();
      if (item.type === 'multiple-choice' && (item.choices.length < 2 || !item.choices.includes(item.answer))) {
        throw new Error(`Multiple-choice question ${index + 1} in "${skill}" needs at least two choices and a matching answer.`);
      }
      if (item.type === 'fill-blank' && !item.answer) throw new Error(`Fill-in question ${index + 1} in "${skill}" needs an answer.`);
      if (item.type === 'true-false') {
        if (!['true', 'false'].includes(item.answer.toLowerCase())) throw new Error(`True / False question ${index + 1} in "${skill}" needs a True or False answer.`);
        item.answer = item.answer.toLowerCase() === 'true' ? 'True' : 'False';
        item.choices = ['True', 'False'];
      }
      if (skill === 'listening' && question.audio) item.audio = String(question.audio).trim();
      return item;
    });
  });
  return nextState;
}

function importTeacherState(file) {
  const reader = new FileReader();
  reader.onload = () => {
    importTeacherJsonText(reader.result);
  };
  reader.onerror = () => {
    teacherStatus.textContent = 'Import failed: the file could not be read.';
  };
  reader.readAsText(file);
}

function importTeacherJsonText(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    const nextState = validateImportedLesson(parsed);
    saveLessonData(nextState, true);
    const activeSkill = document.querySelector('.teacher-skill-tab.active')?.dataset.skill || 'listening';
    createTeacherForm(activeSkill);
    teacherStatus.textContent = 'Lesson imported locally; Firebase sync started.';
    return true;
  } catch (error) {
    teacherStatus.textContent = `Import failed: ${error.message}`;
    return false;
  }
}

function placeMatchingAnswer(zone, answer) {
  zone.dataset.value = answer;
  zone.classList.add('is-filled');
  zone.querySelector('.match-drop-placeholder').textContent = answer;
}

document.addEventListener('dragstart', (event) => {
  const source = event.target.closest('.fill-blank-choice, .match-option');
  if (!source || !event.dataTransfer) return;
  const card = source.closest('.question-card');
  event.dataTransfer.setData('text/plain', source.dataset.value);
  event.dataTransfer.setData('application/x-toybox-question', `${card.dataset.skill}:${card.dataset.id}`);
  event.dataTransfer.setData('application/x-toybox-kind', source.classList.contains('match-option') ? 'matching' : 'fill-blank');
});

document.addEventListener('dragover', (event) => {
  if (event.target.closest('.match-drop-zone, .fill-blank-input')) event.preventDefault();
});

document.addEventListener('drop', (event) => {
  const dropZone = event.target.closest('.match-drop-zone');
  const fillBlankInput = event.target.closest('.fill-blank-input');
  if (!dropZone && !fillBlankInput) return;
  event.preventDefault();
  const questionKey = event.dataTransfer.getData('application/x-toybox-question');
  const kind = event.dataTransfer.getData('application/x-toybox-kind');
  const card = (dropZone || fillBlankInput).closest('.question-card');
  if (questionKey !== `${card.dataset.skill}:${card.dataset.id}`) return;
  const value = event.dataTransfer.getData('text/plain');
  if (!value) return;
  if (dropZone && kind === 'matching') placeMatchingAnswer(dropZone, value);
  if (fillBlankInput && kind === 'fill-blank') fillBlankInput.value = value;
});

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  uploadPreview.innerHTML = `<img src="${url}" alt="Uploaded handwritten page" />`;
  uploadPreview.classList.remove('hidden');
}

function clearRecordedAudio() {
  if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
  recordedAudioUrl = null;
  document.getElementById('recording-playback').replaceChildren();
}

function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Microphone is not available in this browser.');
    return;
  }

  if (!recording) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      clearRecordedAudio();
      mediaStream = stream;
      recorder = new MediaRecorder(stream);
      const chunks = [];

      recorder.ondataavailable = (event) => {
        chunks.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        if (!blob.size) return;
        recordedAudioUrl = URL.createObjectURL(blob);
        const audio = document.createElement('audio');
        audio.src = recordedAudioUrl;
        audio.controls = true;
        audio.setAttribute('aria-label', 'Your speaking recording');
        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-recording-btn';
        deleteButton.type = 'button';
        deleteButton.textContent = 'Xóa bản ghi';
        deleteButton.addEventListener('click', clearRecordedAudio);
        document.getElementById('recording-playback').append(audio, deleteButton);
      };

      recorder.start();
      recording = true;
      recordBtn.textContent = '■ Stop';
      recordBtn.style.background = '#2ec27e';
    }).catch(() => {
      alert('Please allow microphone access to record your voice.');
    });
  } else {
    recorder.stop();
    mediaStream.getTracks().forEach((track) => track.stop());
    recording = false;
    recordBtn.textContent = '● Record';
    recordBtn.style.background = '#FF6B6B';
  }
}

document.addEventListener('click', (event) => {
  const filledMatchZone = event.target.closest('.match-drop-zone.is-filled');
  if (filledMatchZone && examStarted && filledMatchZone.closest('.question-card').dataset.resolved !== 'true') {
    filledMatchZone.dataset.value = '';
    filledMatchZone.classList.remove('is-filled');
    filledMatchZone.querySelector('.match-drop-placeholder').textContent = 'Drop here';
    return;
  }

  const fillChoice = event.target.closest('.fill-blank-choice');
  if (fillChoice) {
    const card = fillChoice.closest('.question-card');
    const input = card.querySelector('.fill-blank-input');
    if (card.dataset.resolved !== 'true' && input) input.value = fillChoice.dataset.value;
  }

  const matchOption = event.target.closest('.match-option');
  if (matchOption) {
    const card = matchOption.closest('.question-card');
    if (card.dataset.resolved !== 'true') {
      const emptyZone = [...card.querySelectorAll('.match-drop-zone')].find((zone) => !zone.dataset.value);
      if (emptyZone) placeMatchingAnswer(emptyZone, matchOption.dataset.value);
    }
  }

  if (examStarted && event.target.closest('.check-answer-btn')) {
    const card = event.target.closest('.question-card');
    if (card) scoreQuestion(card);
  }
});

function bindEvents() {
  secretTrigger.addEventListener('click', startSecretGateway);
  document.addEventListener('keydown', (event) => {
    if (!examStarted && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      accountModal.classList.add('hidden');
      openTeacherGate();
    }
    const isTeacherStudioOpen = !teacherDashboard.classList.contains('hidden');
    const isJsonEditor = event.target.id === 'teacher-json-input';
    const isAccountForm = event.target.closest('#student-auth-form, #password-change-form');
    if (!isTeacherStudioOpen && !isJsonEditor && !isAccountForm && (event.ctrlKey || event.metaKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      alert('Toybox không cho phép copy-paste trong phần làm bài.');
    }
  });

  document.getElementById('account-register-tab').addEventListener('click', () => setAccountMode('register'));
  document.getElementById('account-login-tab').addEventListener('click', () => setAccountMode('login'));
  studentAuthForm.addEventListener('submit', handleStudentAuth);
  document.getElementById('teacher-login-link').addEventListener('click', () => {
    accountModal.classList.add('hidden');
    openTeacherGate();
  });
  document.getElementById('student-logout-btn').addEventListener('click', () => {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(ACTIVE_PRACTICE_KEY);
    studentAuthForm.reset();
    showAccountGate(getStudentAccounts().length ? 'login' : 'register');
  });
  document.getElementById('teacher-gate-cancel').addEventListener('click', closeTeacherGate);
  document.getElementById('teacher-forgot-password').addEventListener('click', openTeacherRecovery);
  document.getElementById('teacher-recovery-code-form').addEventListener('submit', handleTeacherRecoveryCode);
  document.getElementById('teacher-recovery-reset-form').addEventListener('submit', handleTeacherRecoveryReset);
  document.getElementById('teacher-recovery-cancel').addEventListener('click', closeTeacherRecovery);
  document.getElementById('student-change-password-btn').addEventListener('click', () => {
    document.getElementById('password-change-form').reset();
    document.getElementById('password-change-status').textContent = '';
    document.getElementById('password-change-modal').classList.remove('hidden');
  });
  document.getElementById('password-change-form').addEventListener('submit', handlePasswordChange);
  document.getElementById('teacher-pin-form').addEventListener('submit', updateTeacherPin);
  document.getElementById('quiz-folder-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = document.getElementById('quiz-folder-name').value.trim();
    const status = document.getElementById('quiz-archive-status');
    try {
      if (!name) throw new Error('Nhập tên thư mục trước nhé.');
      addQuizFolder(name);
      document.getElementById('quiz-folder-form').reset();
      renderQuizArchive();
      status.textContent = `Đã tạo thư mục ${name}.`;
    } catch (error) {
      status.textContent = error.message;
    }
  });
  document.getElementById('archive-quiz-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = document.getElementById('archive-quiz-name').value.trim();
    const folderId = document.getElementById('archive-quiz-folder').value;
    const status = document.getElementById('quiz-archive-status');
    try {
      if (!name) throw new Error('Nhập tên quiz trước nhé.');
      archiveCurrentQuiz(name, folderId);
      document.getElementById('archive-quiz-form').reset();
      status.textContent = `Đã lưu quiz ${name}. Mở quyền khi muốn học sinh làm lại.`;
    } catch (error) {
      status.textContent = error.message;
    }
  });
  document.getElementById('teacher-pdf-upload').addEventListener('change', async (event) => {
    await saveUploadedPdf(event.target.files[0]);
    event.target.value = '';
  });
  document.getElementById('cancel-password-change').addEventListener('click', () => {
    document.getElementById('password-change-modal').classList.add('hidden');
  });

  unlockBtn.addEventListener('click', checkPasscode);
  passcodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      checkPasscode();
    }
  });

  exitTeacher.addEventListener('click', () => {
    teacherDashboard.classList.add('hidden');
    passcodeModal.classList.add('hidden');
    const student = getActiveStudent();
    if (student) showStudentDesk(student);
    else showAccountGate(getStudentAccounts().length ? 'login' : 'register');
  });

  recordBtn.addEventListener('click', startRecording);
  writingUpload.addEventListener('change', handleFileUpload);
  uploadZone.addEventListener('click', () => writingUpload.click());
  document.getElementById('start-exam-btn').addEventListener('click', startStudentExam);
  document.getElementById('exit-exam-btn').addEventListener('click', handleExamExitAttempt);
  document.getElementById('submit-exam-btn').addEventListener('click', submitStudentExam);

  document.getElementById('save-teacher').addEventListener('click', () => {
    saveLessonData(getLessonData());
    teacherStatus.textContent = 'Lesson saved locally; Firebase sync started.';
  });

  document.getElementById('export-json').addEventListener('click', exportTeacherState);
  document.getElementById('download-template').addEventListener('click', downloadLessonTemplate);
  document.getElementById('import-pasted-json').addEventListener('click', () => {
    const jsonText = document.getElementById('teacher-json-input').value.trim();
    if (!jsonText) {
      teacherStatus.textContent = 'Paste lesson JSON before importing.';
      return;
    }
    importTeacherJsonText(jsonText);
  });
  const importInput = document.getElementById('import-json');
  importInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) importTeacherState(file);
    importInput.value = '';
  });

  document.addEventListener('contextmenu', (event) => event.preventDefault());

  toggleStudentTabs();
  toggleTeacherTabs();
  createTeacherForm('listening');
  renderSavedQuizSubmissions();
  renderStudentAccounts();
  const activeStudent = getActiveStudent();
  if (activeStudent) showStudentDesk(activeStudent);
  else showAccountGate(getStudentAccounts().length ? 'login' : 'register');
  startLessonSync();
}

window.__toyboxScore = {};
renderStudentSkills();
bindEvents();
