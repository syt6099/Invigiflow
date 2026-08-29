// ============================================================
//  app.js – Invigiflow (Full Backend API Integration)
// ============================================================

// ---------- API Configuration ----------
const API_BASE = 'https://invigiflow.onrender.com/api';

// ---------- Helper: get JWT token ----------
function getToken() {
    return localStorage.getItem('token');
}

// ---------- Helper: authenticated fetch ----------
async function apiFetch(endpoint, options = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...options.headers,
    };
    const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'API request failed');
    }
    return response.json();
}

// ---------- Global state ----------
let STORE = {
    teachers: [],
    examWeeks: [],
    currentExamWeekId: null,
    currentExam: [],
    availability: {},
    parsedExams: [],
    allocated: null,
    finalAllocations: null,
    editingAlloc: false,
    finalMode: 'exam',
    allocMode: 'exam',
    dbTempTeachers: [],
    nextId: 1,
    _tempSettings: null,
    isLoggedIn: false,
};
let currentUser = null;
let currentUsername = '';

// ---------- Load user data from API ----------
async function loadUserData() {
    try {
        const [teachers, examWeeks] = await Promise.all([
            apiFetch('/teachers'),
            apiFetch('/exam-weeks'),
        ]);
        STORE.teachers = teachers;
        STORE.examWeeks = examWeeks;
        STORE.isLoggedIn = true;
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        currentUser = user.email;
        currentUsername = user.username || 'User';
        return true;
    } catch (err) {
        console.error('Failed to load user data:', err);
        return false;
    }
}

// ---------- Helpers ----------
function getTeacher(id) {
    if (!id) return null;
    return STORE.teachers.find(t => t.id === id);
}
function getTeacherName(id) {
    const t = getTeacher(id);
    return t ? t.name : 'Unknown';
}
function getTeacherEmail(id) { const t = getTeacher(id); return t ? t.email : ''; }
function getExamWeek(id) { return STORE.examWeeks.find(w => w.id === id); }
function getCurrentExamWeek() { return getExamWeek(STORE.currentExamWeekId); }

function getAllSubjects() {
    const subjects = new Set();
    STORE.teachers.forEach(t => {
        if (t.subjects) t.subjects.forEach(s => subjects.add(s.trim()));
    });
    return Array.from(subjects).sort();
}
function getAllSubjectsWithOthers() {
    const subjects = getAllSubjects();
    if (!subjects.includes('Others')) subjects.push('Others');
    return subjects;
}

// ---------- Toast ----------
let toastTimeout;
function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove('show'), 3000);
}

// ---------- Date/time formatting ----------
function formatLocalDateTime(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------- Allocation Algorithm ----------
function runAllocation(exams, teachers, availability = {}) {
    const sections = [];
    exams.forEach(exam => {
        const start = new Date(exam.startTime);
        const end = new Date(exam.endTime);
        const duration = (end - start) / (1000 * 60);
        if (duration > 90) {
            let current = new Date(start);
            let sectionIndex = 1;
            while (current < end) {
                let sectionEnd = new Date(current.getTime() + 60 * 60 * 1000);
                if (sectionEnd > end) sectionEnd = end;
                sections.push({
                    id: `${exam.id}-${sectionIndex}`,
                    originalId: exam.id,
                    subject: exam.subject,
                    name: exam.name || exam.subject,
                    type: exam.type || 'internal',
                    studentCount: exam.studentCount,
                    startTime: formatLocalDateTime(current),
                    endTime: formatLocalDateTime(sectionEnd),
                    section: sectionIndex,
                });
                current = sectionEnd;
                sectionIndex++;
            }
        } else {
            sections.push({
                ...exam,
                id: exam.id,
                originalId: exam.id,
                startTime: formatLocalDateTime(start),
                endTime: formatLocalDateTime(end),
                section: 1,
            });
        }
    });

    const result = {};
    const teacherHours = {};
    const teacherLoad = {};
    teachers.forEach(t => {
        teacherHours[t.id] = 0;
        teacherLoad[t.id] = t.teachingHours || 0;
    });

    sections.forEach((exam, idx) => {
        const examId = exam.id || idx;
        let required = Math.max(1, Math.ceil(exam.studentCount / 30));
        required = Math.min(required, teachers.length);

        let eligible = teachers.filter(t => {
            if (exam.type === 'external' && t.subjects && t.subjects.includes(exam.subject)) return false;
            const avail = availability[t.id] || [];
            const hasConflict = avail.some(slot => {
                const slotStart = new Date(slot.start);
                const slotEnd = new Date(slot.end);
                const examStart = new Date(exam.startTime);
                const examEnd = new Date(exam.endTime);
                return (examStart < slotEnd && examEnd > slotStart);
            });
            if (hasConflict) return false;
            return true;
        });

        eligible.sort((a, b) => {
            const loadA = teacherLoad[a.id] || 0;
            const loadB = teacherLoad[b.id] || 0;
            return loadA - loadB;
        });

        const assigned = [];
        const picked = eligible.slice(0, required);
        picked.forEach(t => {
            assigned.push(t.id);
            const hours = (new Date(exam.endTime) - new Date(exam.startTime)) / (1000 * 60 * 60);
            teacherHours[t.id] = (teacherHours[t.id] || 0) + hours;
            teacherLoad[t.id] = (teacherLoad[t.id] || 0) + hours;
        });

        const hasExperienced = assigned.some(id => {
            const t = teachers.find(tt => tt.id === id);
            return t && t.yearsAtSchool >= 2;
        });
        if (!hasExperienced && assigned.length > 0) {
            const experienced = teachers.filter(t =>
                t.yearsAtSchool >= 2 &&
                !assigned.includes(t.id) &&
                !(exam.type === 'external' && t.subjects && t.subjects.includes(exam.subject)) &&
                !(availability[t.id] || []).some(slot => {
                    const slotStart = new Date(slot.start);
                    const slotEnd = new Date(slot.end);
                    const examStart = new Date(exam.startTime);
                    const examEnd = new Date(exam.endTime);
                    return (examStart < slotEnd && examEnd > slotStart);
                })
            );
            if (experienced.length > 0) {
                const replaceIdx = assigned.length - 1;
                const oldId = assigned[replaceIdx];
                const newId = experienced[0].id;
                const hours = (new Date(exam.endTime) - new Date(exam.startTime)) / (1000 * 60 * 60);
                teacherHours[oldId] = (teacherHours[oldId] || 0) - hours;
                teacherLoad[oldId] = (teacherLoad[oldId] || 0) - hours;
                teacherHours[newId] = (teacherHours[newId] || 0) + hours;
                teacherLoad[newId] = (teacherLoad[newId] || 0) + hours;
                assigned[replaceIdx] = newId;
            }
        }
        result[examId] = assigned;
    });

    return {
        assignments: result,
        teacherHours: teacherHours,
        sections: sections,
    };
}

// ---------- Bar chart ----------
function renderBarChart(containerId, data) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const max = Math.max(...data.map(d => d.hours), 1);
    container.innerHTML = data.map(d => `
        <div class="bar-row">
            <span class="label" title="${d.name}">${d.name}</span>
            <div class="track">
                <div class="fill" style="width:${(d.hours/max)*100}%;"></div>
            </div>
            <span class="hours">${d.hours.toFixed(1)}</span>
        </div>
    `).join('');
}

// ============================================================
//  PAGE-SPECIFIC INIT FUNCTIONS
// ============================================================

// ---------- LOGIN ----------
function initLogin() {
    document.getElementById('login-form')?.addEventListener('submit', async function(e) {
        e.preventDefault();
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value.trim();
        try {
            const data = await apiFetch('/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password }),
            });
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            showToast('Logged in!');
            window.location.href = 'dashboard.html';
        } catch (err) {
            showToast(err.message);
        }
    });
}

// ---------- SIGNUP ----------
function initSignup() {
    document.getElementById('signup-form')?.addEventListener('submit', async function(e) {
        e.preventDefault();
        const username = document.getElementById('signup-username').value.trim();
        const email = document.getElementById('signup-email').value.trim();
        const password = document.getElementById('signup-password').value.trim();
        const confirm = document.getElementById('signup-confirm').value.trim();
        if (password !== confirm) {
            showToast('Passwords do not match.');
            return;
        }
        try {
            await apiFetch('/auth/signup', {
                method: 'POST',
                body: JSON.stringify({ username, email, password }),
            });
            showToast('Account created! Please log in.');
            window.location.href = 'login.html';
        } catch (err) {
            showToast(err.message);
        }
    });
}

// ---------- FORGOT PASSWORD ----------
function initForgotPassword() {
    document.getElementById('forgot-form')?.addEventListener('submit', async function(e) {
        e.preventDefault();
        const email = document.getElementById('forgot-email').value.trim();
        const code = document.getElementById('forgot-code').value.trim();
        const newPass = document.getElementById('forgot-new-password').value.trim();
        const confirm = document.getElementById('forgot-confirm').value.trim();
        if (newPass !== confirm) {
            showToast('Passwords do not match.');
            return;
        }
        try {
            await apiFetch('/auth/reset-password', {
                method: 'POST',
                body: JSON.stringify({ email, code, newPassword: newPass }),
            });
            showToast('Password reset successfully.');
            window.location.href = 'login.html';
        } catch (err) {
            showToast(err.message);
        }
    });
    document.getElementById('forgot-send-code-btn')?.addEventListener('click', async function() {
        const email = document.getElementById('forgot-email').value.trim();
        if (!email) { showToast('Enter email first.'); return; }
        try {
            await apiFetch('/auth/forgot-password', {
                method: 'POST',
                body: JSON.stringify({ email }),
            });
            showToast('Code sent to your email.');
        } catch (err) {
            showToast(err.message);
        }
    });
}

// ---------- DASHBOARD ----------
async function initDashboard() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    const welcome = document.getElementById('welcome-msg');
    if (welcome) welcome.textContent = `Welcome back, ${currentUsername}`;
    renderDashboard();
}

function renderDashboard() {
    const container = document.getElementById('exam-week-list');
    const countEl = document.getElementById('exam-count');
    const weeks = STORE.examWeeks;
    if (weeks.length === 0) {
        container.innerHTML = '<div class="empty-state">No exam weeks created yet.</div>';
        if (countEl) countEl.textContent = '0 records';
        return;
    }
    if (countEl) countEl.textContent = weeks.length + ' records';
    container.innerHTML = weeks.map(w => `
        <div class="exam-item">
            <div onclick="openExamWeek('${w.id}')" style="flex:1; cursor:pointer;">
                <div class="name">${w.name}</div>
                <div class="date">${w.startDate} — ${w.endDate} (${w.timezone})</div>
            </div>
            <span class="badge">${w.exams ? w.exams.length : 0} exams</span>
            <button class="btn btn-danger btn-sm" onclick="deleteExamWeek('${w.id}')" style="margin-left:8px;">🗑</button>
        </div>
    `).join('');
}

// ---------- openExamWeek ----------
window.openExamWeek = function(id) {
    const w = getExamWeek(id);
    if (!w) {
        showToast('Exam week not found.');
        return;
    }
    STORE.currentExamWeekId = id;
    if (w.finalAllocations) {
        STORE.finalAllocations = w.finalAllocations;
        window.location.href = `final.html?weekId=${id}`;
    } else if (w.allocations) {
        STORE.allocated = w.allocations;
        window.location.href = `allocation.html?weekId=${id}`;
    } else {
        window.location.href = `settings.html?weekId=${id}`;
    }
};

// ---------- deleteExamWeek ----------
window.deleteExamWeek = async function(id) {
    if (!confirm('Delete this exam week permanently?')) return;
    try {
        await apiFetch(`/exam-weeks/${id}`, { method: 'DELETE' });
        STORE.examWeeks = STORE.examWeeks.filter(w => w.id !== id);
        if (STORE.currentExamWeekId === id) STORE.currentExamWeekId = null;
        renderDashboard();
        showToast('Exam week deleted.');
    } catch (err) {
        showToast('Failed to delete: ' + err.message);
    }
};

window.startNewExamWeek = function() {
    STORE.currentExamWeekId = null;
    STORE.currentExam = [];
    STORE.parsedExams = [];
    STORE.allocated = null;
    STORE.finalAllocations = null;
    STORE.availability = {};
    STORE._tempSettings = null;
    window.location.href = 'settings.html';
};

window.logout = function() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    STORE.isLoggedIn = false;
    currentUser = null;
    currentUsername = '';
    showToast('Logged out.');
    window.location.href = 'login.html';
};

// ---------- SETTINGS ----------
async function initSettings() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const weekId = urlParams.get('weekId');
    if (weekId) {
        STORE.currentExamWeekId = weekId;
    }
    const week = getCurrentExamWeek();
    if (week) {
        document.getElementById('ew-name').value = week.name || '';
        document.getElementById('ew-start').value = week.startDate || '';
        document.getElementById('ew-end').value = week.endDate || '';
        document.getElementById('ew-timezone').value = week.timezone || 'UTC+8';
    }
    document.getElementById('exam-settings-form')?.addEventListener('submit', async function(e) {
        e.preventDefault();
        const name = document.getElementById('ew-name').value.trim();
        const start = document.getElementById('ew-start').value;
        const end = document.getElementById('ew-end').value;
        const tz = document.getElementById('ew-timezone').value;
        if (!name || !start || !end) { showToast('Please fill in all fields.'); return false; }

        try {
            let weekIdToUse = STORE.currentExamWeekId;
            if (weekIdToUse) {
                await apiFetch(`/exam-weeks/${weekIdToUse}`, {
                    method: 'PUT',
                    body: JSON.stringify({ name, startDate: start, endDate: end, timezone: tz }),
                });
                const weeks = await apiFetch('/exam-weeks');
                STORE.examWeeks = weeks;
                showToast('Exam week updated!');
                window.location.href = `availability.html?weekId=${weekIdToUse}`;
                return;
            } else {
                const newWeek = await apiFetch('/exam-weeks', {
                    method: 'POST',
                    body: JSON.stringify({ name, startDate: start, endDate: end, timezone: tz }),
                });
                STORE.currentExamWeekId = newWeek.id;
                STORE._tempSettings = { name, start, end, timezone: tz };
                const weeks = await apiFetch('/exam-weeks');
                STORE.examWeeks = weeks;
                showToast('Exam week created!');
                window.location.href = `availability.html?weekId=${newWeek.id}`;
            }
        } catch (err) {
            showToast(err.message);
        }
    });
}

// ---------- AVAILABILITY ----------
async function initAvailability() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const weekId = urlParams.get('weekId');
    if (weekId) {
        STORE.currentExamWeekId = weekId;
    }
    populateTeacherSelects();
    renderAvailability();
    document.getElementById('add-avail-btn')?.addEventListener('click', addAvailability);
    document.getElementById('confirm-avail-btn')?.addEventListener('click', function() {
        window.location.href = `upload.html?weekId=${STORE.currentExamWeekId}`;
    });
}

function populateTeacherSelects() {
    const sel = document.getElementById('avail-teacher-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select teacher</option>' +
        STORE.teachers.map(t =>
            `<option value="${t.id}">${t.name}</option>`
        ).join('');
}

function renderAvailability() {
    const container = document.getElementById('avail-list');
    if (!container) return;
    container.innerHTML = '<p class="text-muted text-sm">Availability slots will be stored per teacher.</p>';
}

window.addAvailability = async function() {
    const sel = document.getElementById('avail-teacher-select');
    const start = document.getElementById('avail-start').value;
    const end = document.getElementById('avail-end').value;
    if (!sel.value || !start || !end) { showToast('Select teacher and enter a time range.'); return; }
    const teacherId = sel.value;
    try {
        await apiFetch('/availabilities', {
            method: 'POST',
            body: JSON.stringify({ teacherId, start, end }),
        });
        showToast('Availability slot added.');
        document.getElementById('avail-start').value = '';
        document.getElementById('avail-end').value = '';
    } catch (err) {
        showToast(err.message);
    }
};

window.removeAvailability = function(tid, start, end) {
    showToast('Remove availability not yet implemented in backend.');
};

// ---------- UPLOAD ----------
async function initUpload() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const weekId = urlParams.get('weekId');
    if (weekId) {
        STORE.currentExamWeekId = weekId;
    }
    const subjects = getAllSubjectsWithOthers();
    const datalist = document.getElementById('subject-list');
    if (datalist) {
        datalist.innerHTML = subjects.map(s => `<option value="${s}">`).join('');
    }
    document.querySelectorAll('.tab-bar button').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('#upload-csv, #upload-manual').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.tab-bar button').forEach(b => b.classList.remove('active'));
            if (this.dataset.tab === 'csv') {
                document.getElementById('upload-csv').classList.remove('hidden');
                this.classList.add('active');
            } else {
                document.getElementById('upload-manual').classList.remove('hidden');
                this.classList.add('active');
            }
        });
    });
    document.getElementById('add-manual-btn')?.addEventListener('click', addManualExam);
    document.getElementById('confirm-upload-btn')?.addEventListener('click', confirmExamList);
    document.getElementById('download-template-btn')?.addEventListener('click', downloadTemplate);
    document.getElementById('parse-csv-btn')?.addEventListener('click', parseCSV);
    renderManualExamList();
}

function downloadTemplate() {
    const csv = 'Subject,ExamName,Type,StudentCount,StartTime,EndTime\nMathematics,Math Final,internal,45,2026-06-01 09:00,2026-06-01 11:00\nPhysics,Physics Midterm,external,32,2026-06-01 13:00,2026-06-01 15:00\nEnglish,English Quiz,internal,38,2026-06-02 09:00,2026-06-02 11:00';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'exam_template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
}

async function parseCSV() {
    const fileInput = document.getElementById('csv-file');
    if (!fileInput.files || fileInput.files.length === 0) {
        showToast('Please select a CSV file.');
        return;
    }
    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = async function(e) {
        const text = e.target.result;
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) { showToast('CSV must have a header row and data.'); return; }
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const idxSubject = headers.findIndex(h => h.includes('subject'));
        const idxName = headers.findIndex(h => h.includes('examname') || h.includes('name'));
        const idxType = headers.findIndex(h => h.includes('type'));
        const idxStudents = headers.findIndex(h => h.includes('student') || h.includes('count'));
        const idxStart = headers.findIndex(h => h.includes('start'));
        const idxEnd = headers.findIndex(h => h.includes('end'));
        if (idxSubject === -1 || idxStudents === -1 || idxStart === -1 || idxEnd === -1) {
            showToast('CSV must have columns: Subject, ExamName (optional), Type (optional), StudentCount, StartTime, EndTime');
            return;
        }
        const allSubjects = getAllSubjects();
        const exams = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim());
            if (cols.length < 4) continue;
            let subject = cols[idxSubject] || 'Unknown';
            if (!allSubjects.includes(subject)) subject = '';
            const type = (idxType >= 0 && cols[idxType]) ? cols[idxType].toLowerCase() : 'internal';
            exams.push({
                subject: subject,
                name: (idxName >= 0 && cols[idxName]) ? cols[idxName] : cols[idxSubject] || 'Exam',
                type: (type === 'external' ? 'external' : 'internal'),
                studentCount: parseInt(cols[idxStudents]) || 0,
                startTime: cols[idxStart] || '',
                endTime: cols[idxEnd] || '',
            });
        }
        if (exams.length === 0) { showToast('No valid exam data found.'); return; }
        STORE.parsedExams = exams;
        sessionStorage.setItem('parsedExams', JSON.stringify(exams));
        window.location.href = `parse-confirm.html?weekId=${STORE.currentExamWeekId}`;
    };
    reader.readAsText(file);
}

async function addManualExam() {
    const subject = document.getElementById('manual-subject').value.trim();
    const name = document.getElementById('manual-name').value.trim() || subject;
    const type = document.getElementById('manual-type').value;
    const students = parseInt(document.getElementById('manual-students').value);
    const start = document.getElementById('manual-start').value;
    const end = document.getElementById('manual-end').value;
    if (!subject || !students || !start || !end) {
        showToast('Please fill in all required fields.');
        return;
    }
    let weekId = STORE.currentExamWeekId;
    if (!weekId) {
        try {
            const newWeek = await apiFetch('/exam-weeks', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'Default Week',
                    startDate: new Date().toISOString().split('T')[0],
                    endDate: new Date(Date.now()+7*86400000).toISOString().split('T')[0],
                    timezone: 'UTC+8'
                }),
            });
            weekId = newWeek.id;
            STORE.currentExamWeekId = weekId;
            const weeks = await apiFetch('/exam-weeks');
            STORE.examWeeks = weeks;
        } catch (err) {
            showToast('Failed to create exam week: ' + err.message);
            return;
        }
    }
    const examData = {
        examWeekId: weekId,
        subject,
        name,
        type,
        studentCount: students,
        start: start,
        end: end,
    };
    try {
        await apiFetch('/exams', {
            method: 'POST',
            body: JSON.stringify(examData),
        });
        showToast('Exam added.');
        const exams = await apiFetch(`/exam-weeks/${weekId}/exams`);
        STORE.currentExam = exams;
        renderManualExamList();
        document.getElementById('manual-subject').value = '';
        document.getElementById('manual-name').value = '';
        document.getElementById('manual-students').value = '';
        document.getElementById('manual-start').value = '';
        document.getElementById('manual-end').value = '';
    } catch (err) {
        showToast(err.message);
    }
}

function renderManualExamList() {
    const container = document.getElementById('manual-exam-list');
    if (!container) return;
    const exams = STORE.currentExam || [];
    if (exams.length === 0) {
        container.innerHTML = '<p class="text-muted text-sm">No exams added yet.</p>';
        return;
    }
    container.innerHTML = `<table>
        <thead><tr><th>Subject</th><th>Exam Name</th><th>Type</th><th>Students</th><th>Start</th><th>End</th><th></th></tr></thead>
        <tbody>${exams.map((e, i) => `
            <tr><td>${e.subject}</td><td>${e.name}</td><td>${e.type}</td><td>${e.studentCount}</td><td>${e.startTime}</td><td>${e.endTime}</td>
            <td><button class="btn btn-danger btn-sm" onclick="removeManualExam('${e.id}')">×</button></td></tr>
        `).join('')}</tbody>
    </table>`;
}

window.removeManualExam = function(id) {
    STORE.currentExam = STORE.currentExam.filter(e => e.id !== id);
    renderManualExamList();
};

function confirmExamList() {
    if (STORE.parsedExams.length > 0) {
        window.location.href = `parse-confirm.html?weekId=${STORE.currentExamWeekId}`;
        return;
    }
    if (STORE.currentExam.length === 0) {
        showToast('No exams to confirm. Add some first.');
        return;
    }
    STORE.parsedExams = [...STORE.currentExam];
    window.location.href = `parse-confirm.html?weekId=${STORE.currentExamWeekId}`;
}

// ---------- PARSE CONFIRM ----------
async function initParseConfirm() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const weekId = urlParams.get('weekId');
    if (weekId) {
        STORE.currentExamWeekId = weekId;
    }
    const subjects = getAllSubjectsWithOthers();
    let datalist = document.getElementById('subject-list-parse');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'subject-list-parse';
        document.body.appendChild(datalist);
    }
    datalist.innerHTML = subjects.map(s => `<option value="${s}">`).join('');

    let exams = STORE.parsedExams;
    if (!exams || exams.length === 0) {
        const parsed = sessionStorage.getItem('parsedExams');
        if (parsed) {
            exams = JSON.parse(parsed);
            STORE.parsedExams = exams;
            sessionStorage.removeItem('parsedExams');
        } else {
            const week = getCurrentExamWeek();
            if (week && week.exams) {
                exams = week.exams;
                STORE.parsedExams = exams;
            }
        }
    }
    renderParseTable(exams);

    document.getElementById('parse-add-exam-btn')?.addEventListener('click', async function() {
        const subject = document.getElementById('parse-add-subject').value.trim();
        const name = document.getElementById('parse-add-name').value.trim() || subject;
        const type = document.getElementById('parse-add-type').value;
        const students = parseInt(document.getElementById('parse-add-students').value);
        const start = document.getElementById('parse-add-start').value;
        const end = document.getElementById('parse-add-end').value;
        if (!subject || !students || !start || !end) {
            showToast('Please fill in all fields.');
            return;
        }
        let weekId = STORE.currentExamWeekId;
        if (!weekId) {
            try {
                const newWeek = await apiFetch('/exam-weeks', {
                    method: 'POST',
                    body: JSON.stringify({
                        name: 'Default Week',
                        startDate: new Date().toISOString().split('T')[0],
                        endDate: new Date(Date.now()+7*86400000).toISOString().split('T')[0],
                        timezone: 'UTC+8'
                    }),
                });
                weekId = newWeek.id;
                STORE.currentExamWeekId = weekId;
                const weeks = await apiFetch('/exam-weeks');
                STORE.examWeeks = weeks;
            } catch (err) {
                showToast('Failed to create exam week: ' + err.message);
                return;
            }
        }
        const examData = {
            examWeekId: weekId,
            subject,
            name,
            type,
            studentCount: students,
            start: start,
            end: end,
        };
        try {
            await apiFetch('/exams', {
                method: 'POST',
                body: JSON.stringify(examData),
            });
            showToast('Exam added.');
            const exams = await apiFetch(`/exam-weeks/${weekId}/exams`);
            STORE.parsedExams = exams;
            renderParseTable(exams);
            document.getElementById('parse-add-subject').value = '';
            document.getElementById('parse-add-name').value = '';
            document.getElementById('parse-add-students').value = '';
            document.getElementById('parse-add-start').value = '';
            document.getElementById('parse-add-end').value = '';
        } catch (err) {
            showToast(err.message);
        }
    });

    document.getElementById('confirm-parse-btn')?.addEventListener('click', async function() {
        const inputs = document.querySelectorAll('.parse-edit');
        inputs.forEach(inp => {
            const idx = parseInt(inp.dataset.idx);
            const field = inp.dataset.field;
            const val = inp.value;
            if (STORE.parsedExams[idx]) {
                if (field === 'studentCount') STORE.parsedExams[idx][field] = parseInt(val) || 0;
                else if (field === 'type') STORE.parsedExams[idx][field] = val;
                else STORE.parsedExams[idx][field] = val;
            }
        });
        const exams = STORE.parsedExams;
        if (!exams || exams.length === 0) { showToast('No exams to confirm.'); return; }
        const teachers = STORE.teachers;
        const alloc = runAllocation(exams, teachers, STORE.availability);
        STORE.allocated = alloc;
        
        // Get the week (existing or new)
        let week = getCurrentExamWeek();
        
        try {
            if (week) {
                // --- UPDATE EXISTING WEEK: KEEP NAME/DATE UNCHANGED ---
                // Update exams and allocations only
                week.exams = exams.map(e => ({ ...e }));
                week.allocations = {
                    assignments: alloc.assignments,
                    sections: alloc.sections,
                    teacherHours: alloc.teacherHours,
                };
                week.finalAllocations = null;
                
                // Save the week with its original name/date (do not overwrite)
                await apiFetch(`/exam-weeks/${week.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        name: week.name,          // keep existing
                        startDate: week.startDate,
                        endDate: week.endDate,
                        timezone: week.timezone,
                        exams: week.exams,
                    }),
                });
                
                // Save allocations
                const allocData = {
                    examWeekId: week.id,
                    allocations: {
                        assignments: alloc.assignments,
                        sections: alloc.sections,
                        teacherHours: alloc.teacherHours,
                    },
                };
                await apiFetch('/allocations', {
                    method: 'POST',
                    body: JSON.stringify(allocData),
                });
                
                // Reload weeks to sync STORE
                const updatedWeeks = await apiFetch('/exam-weeks');
                STORE.examWeeks = updatedWeeks;
                STORE.allocated = alloc;
                showToast('Allocation saved!');
                window.location.href = `allocation.html?weekId=${week.id}`;
            } else {
                // --- CREATE NEW WEEK (use settings from _tempSettings) ---
                const settings = STORE._tempSettings || { name: 'Exam Week', start: '', end: '', timezone: 'UTC+8' };
                const newWeek = await apiFetch('/exam-weeks', {
                    method: 'POST',
                    body: JSON.stringify({
                        name: settings.name || 'Exam Week',
                        startDate: settings.start || '',
                        endDate: settings.end || '',
                        timezone: settings.timezone || 'UTC+8',
                    }),
                });
                STORE.currentExamWeekId = newWeek.id;
                for (const exam of exams) {
                    await apiFetch('/exams', {
                        method: 'POST',
                        body: JSON.stringify({ ...exam, examWeekId: newWeek.id }),
                    });
                }
                const allocData = {
                    examWeekId: newWeek.id,
                    allocations: {
                        assignments: alloc.assignments,
                        sections: alloc.sections,
                        teacherHours: alloc.teacherHours,
                    },
                };
                await apiFetch('/allocations', {
                    method: 'POST',
                    body: JSON.stringify(allocData),
                });
                const weeks = await apiFetch('/exam-weeks');
                STORE.examWeeks = weeks;
                STORE.allocated = alloc;
                showToast('Allocation saved!');
                window.location.href = `allocation.html?weekId=${newWeek.id}`;
            }
        } catch (err) {
            console.error('Allocation save error:', err);
            showToast('Failed to save allocation: ' + err.message);
            return;
        }
    });
}

function renderParseTable(exams) {
    const tbody = document.getElementById('parse-table-body');
    if (!tbody) return;
    if (!exams || exams.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No exams.</td></tr>';
        return;
    }
    tbody.innerHTML = exams.map((e, i) => `
        <tr>
            <td>${i+1}</td>
            <td>
                <input type="text" value="${e.subject}" data-idx="${i}" data-field="subject" class="parse-edit" list="subject-list-parse" style="width:100%;">
            </td>
            <td><input type="text" value="${e.name || ''}" data-idx="${i}" data-field="name" class="parse-edit" style="width:100%;"></td>
            <td>
                <select data-idx="${i}" data-field="type" class="parse-edit">
                    <option value="internal" ${e.type==='internal'?'selected':''}>Internal</option>
                    <option value="external" ${e.type==='external'?'selected':''}>External</option>
                </select>
            </td>
            <td><input type="number" value="${e.studentCount}" data-idx="${i}" data-field="studentCount" class="parse-edit" style="width:70px;"></td>
            <td><input type="text" value="${e.startTime}" data-idx="${i}" data-field="startTime" class="parse-edit" style="width:140px;"></td>
            <td><input type="text" value="${e.endTime}" data-idx="${i}" data-field="endTime" class="parse-edit" style="width:140px;"></td>
            <td><button class="btn btn-danger btn-sm" onclick="removeParsedExam(${i})">×</button></td>
        </tr>
    `).join('');
}

window.removeParsedExam = function(idx) {
    STORE.parsedExams.splice(idx, 1);
    renderParseTable(STORE.parsedExams);
};

// ============================================================
//  ALLOCATION PAGE
// ============================================================
async function initAllocation() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const weekId = urlParams.get('weekId');
    if (weekId) {
        STORE.currentExamWeekId = weekId;
    }
    
    // Try to get allocation data from server if not in STORE
    if (!STORE.allocated) {
        try {
            const allocData = await apiFetch(`/allocations/${weekId}`);
            if (allocData && allocData.allocations && allocData.allocations.assignments) {
                STORE.allocated = allocData.allocations;
            }
        } catch (e) {
            // ignore
        }
    }
    
    if (!STORE.allocated) {
        showToast('No allocation data found for this week.');
        if (confirm('No allocations found. Would you like to generate them?')) {
            window.location.href = `parse-confirm.html?weekId=${weekId}`;
        } else {
            window.location.href = 'dashboard.html';
        }
        return;
    }

    STORE.editingAlloc = false;
    renderAllocationPage();

    // Mode toggle
    document.querySelectorAll('.mode-toggle button').forEach((btn, idx) => {
        btn.removeEventListener('click', handleModeToggle);
        btn.addEventListener('click', handleModeToggle);
    });
    function handleModeToggle() {
        const mode = this.textContent.trim().toLowerCase().includes('exam') ? 'exam' : 'teacher';
        setAllocMode(mode);
    }
    
    document.getElementById('final-confirm-btn')?.addEventListener('click', finalConfirmAllocation);
    document.getElementById('back-to-parse-btn')?.addEventListener('click', function() {
        window.location.href = `parse-confirm.html?weekId=${STORE.currentExamWeekId}`;
    });
    document.getElementById('edit-alloc-btn')?.addEventListener('click', function() {
        STORE.editingAlloc = !STORE.editingAlloc;
        showToast(STORE.editingAlloc ? 'Edit mode enabled (you can add/remove teachers)' : 'Edit mode disabled');
        renderAllocationPage();
    });
    
    // Add teacher dropdown - use event delegation
    document.removeEventListener('change', handleTeacherAdd);
    document.addEventListener('change', handleTeacherAdd);
    function handleTeacherAdd(e) {
        if (e.target.classList.contains('add-teacher-select')) {
            const examId = e.target.dataset.examId;
            const teacherId = e.target.value;
            if (!teacherId) return;
            addTeacherToExam(examId, teacherId);
            e.target.value = '';
        }
    }
    
    // Remove teacher - use event delegation
    document.removeEventListener('click', handleTeacherRemove);
    document.addEventListener('click', handleTeacherRemove);
    function handleTeacherRemove(e) {
        if (e.target.classList.contains('remove-teacher-btn')) {
            const examId = e.target.dataset.examId;
            const teacherId = e.target.dataset.teacherId;
            if (examId && teacherId) {
                removeTeacherFromExam(examId, teacherId);
            }
        }
    }
    
    setAllocMode('exam');
}

// ---- Allocation helper functions ----
function addTeacherToExam(examId, teacherId) {
    const alloc = STORE.allocated;
    if (!alloc) return;
    if (!alloc.assignments[examId]) alloc.assignments[examId] = [];
    if (alloc.assignments[examId].includes(teacherId)) {
        showToast('Teacher already assigned.');
        return;
    }
    alloc.assignments[examId].push(teacherId);
    const section = alloc.sections.find(s => String(s.id || s.originalId) === String(examId));
    if (section) {
        const hours = (new Date(section.endTime) - new Date(section.startTime)) / (1000 * 60 * 60);
        alloc.teacherHours[teacherId] = (alloc.teacherHours[teacherId] || 0) + hours;
    }
    renderAllocationPage();
}

function removeTeacherFromExam(examId, teacherId) {
    const alloc = STORE.allocated;
    if (!alloc) return;
    if (!alloc.assignments[examId]) return;
    const idx = alloc.assignments[examId].indexOf(teacherId);
    if (idx === -1) return;
    alloc.assignments[examId].splice(idx, 1);
    const section = alloc.sections.find(s => String(s.id || s.originalId) === String(examId));
    if (section) {
        const hours = (new Date(section.endTime) - new Date(section.startTime)) / (1000 * 60 * 60);
        alloc.teacherHours[teacherId] = (alloc.teacherHours[teacherId] || 0) - hours;
    }
    renderAllocationPage();
}

function renderAllocationPage() {
    const alloc = STORE.allocated;
    if (!alloc) return;
    const sections = alloc.sections || [];
    const assignments = alloc.assignments || {};
    const teacherHours = alloc.teacherHours || {};

    const examBody = document.getElementById('alloc-exam-body');
    if (examBody) {
        examBody.innerHTML = sections.map((e, idx) => {
            const eid = e.id || idx;
            const assigned = assignments[eid] || [];
            const tags = assigned.map(id => {
                const name = getTeacherName(id);
                return `<span class="avail-tag">
                    ${name}
                    ${STORE.editingAlloc ? `<span class="remove remove-teacher-btn" data-exam-id="${eid}" data-teacher-id="${id}" style="cursor:pointer;" title="Remove Teacher">×</span>` : ''}
                </span>`;
            }).join('');
            const dropdown = STORE.editingAlloc ? `
                <select class="add-teacher-select" data-exam-id="${eid}">
                    <option value="">Add teacher...</option>
                    ${STORE.teachers.filter(t => !assigned.includes(t.id)).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                </select>
            ` : '<span class="text-muted text-sm"><i>Edit mode disabled</i></span>';
            return `<tr class="exam-alloc-row" data-exam-id="${eid}">
                <td>${e.subject}</td>
                <td>${e.name}</td>
                <td>${e.type}</td>
                <td>${e.studentCount}</td>
                <td>${e.startTime}</td>
                <td>${e.endTime}</td>
                <td class="alloc-tags">${tags}</td>
                <td class="alloc-add">${dropdown}</td>
            </tr>`;
        }).join('');
        const header = document.querySelector('#alloc-exam-view table thead tr');
        if (header) header.innerHTML = '<th>Subject</th><th>Exam Name</th><th>Type</th><th>Students</th><th>Start</th><th>End</th><th>Invigilators</th><th>Actions</th>';
    }

    const teacherBody = document.getElementById('alloc-teacher-body');
    if (teacherBody) {
        const sorted = STORE.teachers.map(t => ({
            ...t,
            hours: teacherHours[t.id] || 0,
            sessions: Object.entries(assignments)
                .filter(([eid, tids]) => tids.includes(t.id))
                .map(([eid]) => {
                    const sec = sections.find(s => (s.id || sections.indexOf(s)) == eid);
                    return sec ? sec.name : '?';
                })
                .join(', ')
        })).sort((a, b) => b.hours - a.hours);
        teacherBody.innerHTML = sorted.map(t =>
            `<tr><td>${t.name}</td><td>${t.hours.toFixed(1)}</td><td>${t.sessions || '—'}</td></tr>`
        ).join('');
        renderBarChart('bar-chart-container', sorted);
    }
}

function setAllocMode(mode) {
    STORE.allocMode = mode;
    document.querySelectorAll('#alloc-exam-view, #alloc-teacher-view').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.mode-toggle button').forEach(b => b.classList.remove('active'));
    if (mode === 'exam') {
        document.getElementById('alloc-exam-view').classList.remove('hidden');
        document.querySelector('.mode-toggle button:first-child').classList.add('active');
    } else {
        document.getElementById('alloc-teacher-view').classList.remove('hidden');
        document.querySelector('.mode-toggle button:last-child').classList.add('active');
        const alloc = STORE.allocated;
        if (alloc) {
            const sections = alloc.sections || [];
            const assignments = alloc.assignments || {};
            const sorted = STORE.teachers.map(t => ({
                ...t,
                hours: alloc.teacherHours[t.id] || 0,
                sessions: Object.entries(assignments)
                    .filter(([eid, tids]) => tids.includes(t.id))
                    .map(([eid]) => {
                        const sec = sections.find(s => (s.id || sections.indexOf(s)) == eid);
                        return sec ? sec.name : '?';
                    })
                    .join(', ')
            })).sort((a, b) => b.hours - a.hours);
            renderBarChart('bar-chart-container', sorted);
        }
    }
}

window.finalConfirmAllocation = function() {
    const alloc = STORE.allocated;
    if (!alloc) { showToast('No allocations to confirm.'); return; }
    
    // Save final allocations to the week
    const week = getCurrentExamWeek();
    if (week) {
        week.finalAllocations = JSON.parse(JSON.stringify(alloc));
        week.allocations = JSON.parse(JSON.stringify(alloc));
        // Also save to server via PUT
        apiFetch(`/exam-weeks/${week.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: week.name,
                startDate: week.startDate,
                endDate: week.endDate,
                timezone: week.timezone,
                finalAllocations: alloc,
            })
        }).catch(err => console.error('Failed to save final allocations:', err));
    }
    STORE.finalAllocations = JSON.parse(JSON.stringify(alloc));
    window.location.href = `final.html?weekId=${STORE.currentExamWeekId}`;
};

// ============================================================
//  FINAL PAGE
// ============================================================
async function initFinal() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const weekId = urlParams.get('weekId');
    if (weekId) {
        STORE.currentExamWeekId = weekId;
    }
    
    // Try to get final allocations from the week
    const week = getCurrentExamWeek();
    if (week && week.finalAllocations) {
        STORE.finalAllocations = week.finalAllocations;
    }
    
    if (!STORE.finalAllocations) {
        showToast('No final allocations for this week.');
        window.location.href = 'dashboard.html';
        return;
    }
    renderFinalPage();
    // Mode toggle
    document.querySelectorAll('#final-mode-toggle button').forEach((btn, idx) => {
        btn.addEventListener('click', function() {
            const mode = idx === 0 ? 'exam' : 'teacher';
            setFinalMode(mode);
        });
    });
    document.getElementById('print-exam-btn')?.addEventListener('click', function() {
        setFinalMode('exam');
        setTimeout(() => window.print(), 300);
    });
    document.getElementById('print-teacher-btn')?.addEventListener('click', function() {
        setFinalMode('teacher');
        setTimeout(() => window.print(), 300);
    });
    document.getElementById('email-alloc-btn')?.addEventListener('click', emailAllocations);
    document.getElementById('edit-final-btn')?.addEventListener('click', function() {
        window.location.href = `allocation.html?weekId=${STORE.currentExamWeekId}`;
    });
    document.getElementById('back-to-dashboard')?.addEventListener('click', function() {
        window.location.href = 'dashboard.html';
    });
    setFinalMode('exam');
}

function renderFinalPage() {
    const alloc = STORE.finalAllocations;
    if (!alloc) return;
    const sections = alloc.sections || [];
    const assignments = alloc.assignments || {};
    const teacherHours = alloc.teacherHours || {};

    const examBody = document.getElementById('final-exam-body');
    if (examBody) {
        examBody.innerHTML = sections.map((e, idx) => {
            const eid = e.id || idx;
            const assigned = assignments[eid] || [];
            const names = assigned.map(id => getTeacherName(id)).filter(Boolean).join(', ') || 'None';
            return `<tr>
                <td>${e.subject}</td>
                <td>${e.name}</td>
                <td>${e.type}</td>
                <td>${e.studentCount}</td>
                <td>${e.startTime}</td>
                <td>${e.endTime}</td>
                <td>${names}</td>
            </tr>`;
        }).join('');
        const header = document.querySelector('#final-exam-view table thead tr');
        if (header) header.innerHTML = '<th>Subject</th><th>Exam Name</th><th>Type</th><th>Students</th><th>Start</th><th>End</th><th>Invigilators</th>';
    }

    const teacherBody = document.getElementById('final-teacher-body');
    if (teacherBody) {
        const sorted = STORE.teachers.map(t => ({
            ...t,
            hours: teacherHours[t.id] || 0,
            sessions: Object.entries(assignments)
                .filter(([eid, tids]) => tids.includes(t.id))
                .map(([eid]) => {
                    const sec = sections.find(s => (s.id || sections.indexOf(s)) == eid);
                    return sec ? sec.name : '?';
                })
                .join(', ')
        })).sort((a, b) => b.hours - a.hours);
        teacherBody.innerHTML = sorted.map(t =>
            `<tr><td>${t.name}</td><td>${t.hours.toFixed(1)}</td><td>${t.sessions || '—'}</td></tr>`
        ).join('');
        renderBarChart('final-bar-chart', sorted);
    }
}

function setFinalMode(mode) {
    STORE.finalMode = mode;
    document.querySelectorAll('#final-exam-view, #final-teacher-view').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('#final-mode-toggle button').forEach(b => b.classList.remove('active'));
    if (mode === 'exam') {
        document.getElementById('final-exam-view').classList.remove('hidden');
        document.querySelector('#final-mode-toggle button:first-child').classList.add('active');
    } else {
        document.getElementById('final-teacher-view').classList.remove('hidden');
        document.querySelector('#final-mode-toggle button:last-child').classList.add('active');
        const alloc = STORE.finalAllocations;
        if (alloc) {
            const sections = alloc.sections || [];
            const assignments = alloc.assignments || {};
            const sorted = STORE.teachers.map(t => ({
                ...t,
                hours: alloc.teacherHours[t.id] || 0,
                sessions: Object.entries(assignments)
                    .filter(([eid, tids]) => tids.includes(t.id))
                    .map(([eid]) => {
                        const sec = sections.find(s => (s.id || sections.indexOf(s)) == eid);
                        return sec ? sec.name : '?';
                    })
                    .join(', ')
            })).sort((a, b) => b.hours - a.hours);
            renderBarChart('final-bar-chart', sorted);
        }
    }
}

function emailAllocations() {
    const emails = STORE.teachers.map(t => t.email).filter(Boolean);
    if (emails.length === 0) { showToast('No teacher emails found.'); return; }
    showToast(`📧 Sending allocations to ${emails.length} teachers... (simulated)`);
}

// ============================================================
//  DATABASE PAGE
// ============================================================
async function initDatabase() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    renderDatabase();
}

function renderDatabase() {
    const tbody = document.getElementById('db-table-body');
    const empty = document.getElementById('db-empty');
    if (!tbody) return;
    if (STORE.teachers.length === 0) {
        tbody.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = STORE.teachers.map(t => `
        <tr>
            <td>${t.name}</td>
            <td>${t.email || '—'}</td>
            <td>${(t.subjects || []).join(', ')}</td>
            <td>${t.yearsAtSchool || 0}</td>
            <td>${t.teachingHours || 0}</td>
        </tr>
    `).join('');
}

// ============================================================
//  DATABASE UPLOAD
// ============================================================
async function initDatabaseUpload() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    document.getElementById('db-template-btn')?.addEventListener('click', downloadDbTemplate);
    document.getElementById('db-parse-btn')?.addEventListener('click', parseDbCSV);
    document.getElementById('db-add-manual-btn')?.addEventListener('click', addManualTeacher);
    document.getElementById('db-save-btn')?.addEventListener('click', confirmDbUpload);
    renderDbUploadPreview(STORE.dbTempTeachers);
}

function downloadDbTemplate() {
    const csv = 'Name,Email,Subjects,YearsAtSchool,TeachingHours\nJane Doe,jane@school.edu,"Math, Physics",2,18\nBob Smith,bob@school.edu,English,3,20';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'teacher_template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
}

// --- FIXED: parseDbCSV – deduplicate ONLY by email, keep all rows without email ---
async function parseDbCSV() {
    const fileInput = document.getElementById('db-csv');
    if (!fileInput.files || fileInput.files.length === 0) {
        showToast('Please select a CSV file.');
        return;
    }
    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) { showToast('CSV must have a header row and data.'); return; }
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const idxName = headers.findIndex(h => h.includes('name'));
        const idxEmail = headers.findIndex(h => h.includes('email'));
        const idxSubjects = headers.findIndex(h => h.includes('subject'));
        const idxYears = headers.findIndex(h => h.includes('year'));
        const idxHours = headers.findIndex(h => h.includes('hour') || h.includes('teaching'));
        if (idxName === -1) { showToast('CSV must have a "Name" column.'); return; }
        
        const emailMap = new Map(); // key: email (lowercase), value: teacher object
        const noEmailList = [];     // teachers without email – keep all
        
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim());
            if (cols.length < 2) continue;
            const name = cols[idxName] || 'Unknown';
            const email = idxEmail >= 0 ? cols[idxEmail] : '';
            const subjects = idxSubjects >= 0 ? cols[idxSubjects].split(';').map(s => s.trim()).filter(Boolean) : [];
            const years = idxYears >= 0 ? parseInt(cols[idxYears]) || 0 : 0;
            const hours = idxHours >= 0 ? parseInt(cols[idxHours]) || 0 : 18;
            
            const teacher = {
                id: Date.now() + i,
                name,
                email,
                subjects,
                yearsAtSchool: years,
                teachingHours: hours
            };
            
            if (email) {
                const key = email.toLowerCase().trim();
                emailMap.set(key, teacher); // overwrites previous with same email → keeps last
            } else {
                noEmailList.push(teacher);
            }
        }
        
        const teachers = [...emailMap.values(), ...noEmailList];
        
        if (teachers.length === 0) { showToast('No valid teacher data found.'); return; }
        STORE.dbTempTeachers = teachers;
        renderDbUploadPreview(teachers);
        showToast(`Parsed ${teachers.length} teachers. Click "Save to Database" to store.`);
    };
    reader.readAsText(file);
}

function renderDbUploadPreview(teachers) {
    const container = document.getElementById('db-upload-preview');
    if (!container) return;
    if (!teachers || teachers.length === 0) {
        container.innerHTML = '<p class="text-muted text-sm">No teachers added yet.</p>';
        return;
    }
    container.innerHTML = `<table>
        <thead><tr><th>Name</th><th>Email</th><th>Subjects</th><th>Years</th><th>Hours</th></tr></thead>
        <tbody>${teachers.map(t => `
            <tr><td>${t.name}</td><td>${t.email||'—'}</td><td>${(t.subjects||[]).join(', ')}</td>
            <td>${t.yearsAtSchool}</td><td>${t.teachingHours}</td></tr>
        `).join('')}</tbody>
    </table>`;
}

function addManualTeacher() {
    const name = document.getElementById('db-manual-name').value.trim();
    const email = document.getElementById('db-manual-email').value.trim();
    const subjects = document.getElementById('db-manual-subjects').value.trim().split(',').map(s => s.trim()).filter(Boolean);
    const years = parseInt(document.getElementById('db-manual-years').value) || 0;
    const hours = parseInt(document.getElementById('db-manual-hours').value) || 18;
    if (!name) { showToast('Name is required.'); return; }
    if (!STORE.dbTempTeachers) STORE.dbTempTeachers = [];
    STORE.dbTempTeachers.push({
        id: Date.now() + Math.random() * 1000,
        name,
        email,
        subjects,
        yearsAtSchool: years,
        teachingHours: hours,
    });
    renderDbUploadPreview(STORE.dbTempTeachers);
    document.getElementById('db-manual-name').value = '';
    document.getElementById('db-manual-email').value = '';
    document.getElementById('db-manual-subjects').value = '';
    document.getElementById('db-manual-years').value = '';
    document.getElementById('db-manual-hours').value = '';
    showToast('Teacher added to preview.');
}

// --- FIXED: confirmDbUpload – skip duplicates ONLY by email, preserve fields ---
async function confirmDbUpload() {
    const teachers = STORE.dbTempTeachers;
    if (!teachers || teachers.length === 0) {
        showToast('No teachers to save. Upload or add some first.');
        return;
    }
    const existingTeachers = await apiFetch('/teachers');
    // Build a Set of existing emails (lowercase, trim)
    const existingEmails = new Set(existingTeachers.map(t => t.email ? t.email.toLowerCase().trim() : ''));
    let added = 0;
    let skipped = 0;
    const toAdd = [];
    for (const t of teachers) {
        if (t.email) {
            const key = t.email.toLowerCase().trim();
            if (existingEmails.has(key)) {
                skipped++;
                continue;
            }
        }
        toAdd.push(t);
    }
    for (const t of toAdd) {
        try {
            await apiFetch('/teachers', {
                method: 'POST',
                body: JSON.stringify({
                    name: t.name,
                    email: t.email || '',
                    subjects: t.subjects || [],
                    yearsAtSchool: t.yearsAtSchool || 0,
                    teachingHours: t.teachingHours || 18,
                }),
            });
            added++;
            if (t.email) existingEmails.add(t.email.toLowerCase().trim());
        } catch (err) {
            console.error('Failed to add teacher:', err);
        }
    }
    STORE.dbTempTeachers = [];
    renderDbUploadPreview([]);
    const newTeachers = await apiFetch('/teachers');
    STORE.teachers = newTeachers;
    let message = `Saved ${added} new teachers to database.`;
    if (skipped > 0) message += ` Skipped ${skipped} duplicates.`;
    showToast(message);
    window.location.href = 'database.html';
}

// ============================================================
//  DATABASE EDIT (with bulk delete – fixed)
// ============================================================
async function initDatabaseEdit() {
    const loaded = await loadUserData();
    if (!loaded || !STORE.isLoggedIn) {
        window.location.href = 'login.html';
        return;
    }
    renderDbEdit();
    document.getElementById('db-edit-save-btn')?.addEventListener('click', function() {
        showToast('Database changes saved.');
        window.location.href = 'database.html';
    });
    document.getElementById('db-edit-add-btn')?.addEventListener('click', async function() {
        const name = document.getElementById('db-edit-name').value.trim();
        const email = document.getElementById('db-edit-email').value.trim();
        const subjects = document.getElementById('db-edit-subjects').value.trim().split(',').map(s => s.trim()).filter(Boolean);
        const years = parseInt(document.getElementById('db-edit-years').value) || 0;
        const hours = parseInt(document.getElementById('db-edit-hours').value) || 18;
        if (!name) { showToast('Name is required.'); return; }
        try {
            await apiFetch('/teachers', {
                method: 'POST',
                body: JSON.stringify({ name, email, subjects, yearsAtSchool: years, teachingHours: hours }),
            });
            showToast('Teacher added.');
            const newTeachers = await apiFetch('/teachers');
            STORE.teachers = newTeachers;
            renderDbEdit();
            document.getElementById('db-edit-name').value = '';
            document.getElementById('db-edit-email').value = '';
            document.getElementById('db-edit-subjects').value = '';
            document.getElementById('db-edit-years').value = '';
            document.getElementById('db-edit-hours').value = '';
        } catch (err) {
            showToast(err.message);
        }
    });
}

function renderDbEdit() {
    const container = document.getElementById('db-edit-container');
    if (!container) return;
    if (STORE.teachers.length === 0) {
        container.innerHTML = '<p class="text-muted">No teachers in database.</p>';
        return;
    }
    let html = `
        <div class="flex gap-2 mb-3">
            <button class="btn btn-outline btn-sm" id="select-all-teachers">Select All</button>
            <button class="btn btn-danger btn-sm" id="delete-selected-teachers">Delete Selected</button>
        </div>
        <div id="teacher-edit-list">
    `;
    STORE.teachers.forEach(t => {
        html += `
            <div style="border-bottom:1px solid var(--border);padding:8px 0; display:flex; align-items:center; gap:4px;">
                <input type="checkbox" class="teacher-select-checkbox" data-id="${t.id}" style="margin:0; width:16px; height:16px; flex-shrink:0;">
                <div style="flex:1;">
                    <div class="form-row">
                        <div class="form-group"><label>Name</label><input type="text" value="${t.name}" data-id="${t.id}" data-field="name" class="db-edit-input"></div>
                        <div class="form-group"><label>Email</label><input type="email" value="${t.email||''}" data-id="${t.id}" data-field="email" class="db-edit-input"></div>
                    </div>
                    <div class="form-row">
                        <div class="form-group"><label>Subjects (comma-separated)</label><input type="text" value="${(t.subjects||[]).join(', ')}" data-id="${t.id}" data-field="subjects" class="db-edit-input"></div>
                        <div class="form-group"><label>Years at School</label><input type="number" value="${t.yearsAtSchool||0}" data-id="${t.id}" data-field="yearsAtSchool" class="db-edit-input"></div>
                    </div>
                    <div class="form-group"><label>Teaching Hours/Week</label><input type="number" value="${t.teachingHours||0}" data-id="${t.id}" data-field="teachingHours" class="db-edit-input"></div>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;

    // Auto-save on input change
    document.querySelectorAll('.db-edit-input').forEach(inp => {
        inp.addEventListener('change', async function() {
            const id = this.dataset.id;
            const field = this.dataset.field;
            let val = this.value;
            const teacher = STORE.teachers.find(t => t.id === id);
            if (!teacher) return;
            let updateData = { ...teacher };
            if (field === 'subjects') {
                updateData.subjects = val.split(',').map(s => s.trim()).filter(Boolean);
            } else if (field === 'yearsAtSchool' || field === 'teachingHours') {
                updateData[field] = parseInt(val) || 0;
            } else {
                updateData[field] = val;
            }
            try {
                await apiFetch(`/teachers/${id}`, {
                    method: 'PUT',
                    body: JSON.stringify(updateData),
                });
                const idx = STORE.teachers.findIndex(t => t.id === id);
                if (idx !== -1) STORE.teachers[idx] = updateData;
            } catch (err) {
                showToast('Failed to update teacher: ' + err.message);
            }
        });
    });

    // Select All button (toggle)
    document.getElementById('select-all-teachers')?.addEventListener('click', function() {
        const checkboxes = document.querySelectorAll('.teacher-select-checkbox');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        checkboxes.forEach(cb => cb.checked = !allChecked);
    });

    // Delete Selected button – fixed to delete ALL selected and refresh properly
    document.getElementById('delete-selected-teachers')?.addEventListener('click', async function() {
        const selected = document.querySelectorAll('.teacher-select-checkbox:checked');
        if (selected.length === 0) {
            showToast('No teachers selected.');
            return;
        }
        if (!confirm(`Delete ${selected.length} teacher(s) permanently?`)) return;
        const ids = Array.from(selected).map(cb => cb.dataset.id);
        let deleted = 0;
        for (const id of ids) {
            try {
                await apiFetch(`/teachers/${id}`, { method: 'DELETE' });
                // Remove from local store immediately
                STORE.teachers = STORE.teachers.filter(t => t.id !== id);
                deleted++;
            } catch (err) {
                console.error('Failed to delete teacher:', err);
            }
        }
        // Refresh the edit page to reflect the new state
        renderDbEdit();
        showToast(`Deleted ${deleted} teacher(s).`);
    });
}

window.deleteTeacher = async function(id) {
    if (!confirm('Delete this teacher permanently?')) return;
    try {
        await apiFetch(`/teachers/${id}`, { method: 'DELETE' });
        STORE.teachers = STORE.teachers.filter(t => t.id !== id);
        renderDbEdit();
        showToast('Teacher deleted.');
    } catch (err) {
        showToast('Failed to delete teacher: ' + err.message);
    }
};

// ============================================================
//  GLOBAL INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    const token = getToken();
    if (token) {
        loadUserData().catch(() => {});
    }
    const path = window.location.pathname;
    const page = path.split('/').pop().split('.')[0];
    switch (page) {
        case 'login': initLogin(); break;
        case 'signup': initSignup(); break;
        case 'forgot-password': initForgotPassword(); break;
        case 'dashboard': initDashboard(); break;
        case 'settings': initSettings(); break;
        case 'availability': initAvailability(); break;
        case 'upload': initUpload(); break;
        case 'parse-confirm': initParseConfirm(); break;
        case 'allocation': initAllocation(); break;
        case 'final': initFinal(); break;
        case 'database': initDatabase(); break;
        case 'database-upload': initDatabaseUpload(); break;
        case 'database-edit': initDatabaseEdit(); break;
        default:
            if (!getToken()) window.location.href = 'login.html';
            break;
    }
    document.getElementById('toast')?.addEventListener('click', function() {
        this.classList.remove('show');
    });
});
