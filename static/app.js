/**
 * تطبيق تحميل الفيديوهات المتطور - v2.0
 * Advanced Video Downloader - Frontend
 * With: XSS protection, history, drag-drop, auto-fetch, open folder
 */

// ─── Thumbnail Download Helper ─────────────────────────
async function downloadThumbnail(url, title) {
    if (!url) return toast('لا توجد صورة مصغرة', 'err');
    toast('جاري تحميل الصورة...', 'info');
    try {
        const res = await fetch('/api/download/thumbnail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ thumbnail_url: url, title: title })
        });
        if (!res.ok) throw new Error('فشل التحميل');
        
        // Trigger browser download mechanism
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        
        // Extract filename from the content-disposition header if available, else derive from url
        const dispose = res.headers.get('content-disposition');
        let filename = `${title}_thumb.jpg`;
        if (dispose && dispose.indexOf('attachment') !== -1) {
            const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(dispose);
            if (matches != null && matches[1]) { 
                filename = matches[1].replace(/['"]/g, '');
            }
        }
        
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(objUrl);
        a.remove();
        toast('تم تحميل الصورة ✅', 'ok');
    } catch (e) {
        toast('خطأ أثناء تحميل الصورة', 'err');
        console.error(e);
    }
}

// ─── Firebase Setup ─────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyBGfChrA7kGigpSSp3yiZwXvUvNN-z56i0",
    authDomain: "video-downloader-910a3.firebaseapp.com",
    projectId: "video-downloader-910a3",
    storageBucket: "video-downloader-910a3.firebasestorage.app",
    messagingSenderId: "700471384610",
    appId: "1:700471384610:web:7f3afc81b5ae42ff1b6dab"
};

let auth = null, db = null, storage = null;
let currentUser = null;

if (typeof firebase !== 'undefined' && firebaseConfig.apiKey !== "YOUR_API_KEY") {
    try {
        firebase.initializeApp(firebaseConfig);
        auth = firebase.auth();
        db = firebase.firestore();
        storage = firebase.storage();
        
        auth.onAuthStateChanged(user => {
            currentUser = user;
            updateAuthUI(user);
            if (user) {
                toast('تم ربط السحابة بنجاح! ☁️', 'ok');
                fetchHistory();
                loadAutoSubs();
            } else {
                fetchHistory();
            }
        });
    } catch (e) {
        console.error("Firebase Initialization Error:", e);
    }
} else {
    console.warn("⚠️ Firebase is not configured! Please replace 'YOUR_API_KEY' in app.js with valid configuration keys.");
}

// ─── Auth Logic ─────────────────────────────────────
function authAction() {
    if (currentUser) {
        if(confirm('هل تريد تسجيل الخروج حقاً؟')) {
            firebase.auth().signOut().then(() => {
                toast('تم تسجيل الخروج', 'info');
                S.history = [];
                renderHistory();
            });
        }
    } else {
        openAuthModal();
    }
}

function updateAuthUI(user) {
    const btn = $('#btnAuthStatus');
    if (!btn) return;
    if (user) {
        btn.innerHTML = `👤 ${user.email.split('@')[0]} (خروج)`;
        btn.classList.remove('btn--ghost');
        btn.classList.add('btn--success');
    } else {
        btn.innerHTML = `👤 تسجيل الدخول`;
        btn.classList.add('btn--ghost');
        btn.classList.remove('btn--success');
    }
}

function openAuthModal() {
    $('#authModal').classList.add('open');
    $('#authEmail').focus();
}

function closeAuthModal() {
    $('#authModal').classList.remove('open');
}

function signInEmail() {
    if(!firebase.apps || !firebase.apps.length) return toast('Firebase غير مهيأ بعد! يرجى إضافة المفاتيح في الكود.', 'err');
    const email = $('#authEmail').value.trim();
    const pass = $('#authPassword').value;
    if(!email || !pass) return toast('يرجى ادخال الايميل وكلمة السر', 'err');
    
    const btn = $('#btnSignIn');
    btn.innerHTML = 'جاري الدخول...';
    btn.disabled = true;
    
    firebase.auth().signInWithEmailAndPassword(email, pass)
        .then(() => closeAuthModal())
        .catch(err => toast('خطأ: ' + err.message, 'err'))
        .finally(() => { btn.innerHTML = 'تسجيل الدخول'; btn.disabled = false; });
}

function signUpEmail() {
    if(!firebase.apps || !firebase.apps.length) return toast('Firebase غير مهيأ بعد!', 'err');
    const email = $('#authEmail').value.trim();
    const pass = $('#authPassword').value;
    if(!email || !pass) return toast('يرجى ادخال الايميل وكلمة السر', 'err');
    
    const btn = $('#btnSignUp');
    btn.innerHTML = 'جاري الإنشاء...';
    btn.disabled = true;
    
    firebase.auth().createUserWithEmailAndPassword(email, pass)
        .then(() => { toast('تم إنشاء الحساب! 🎉', 'ok'); closeAuthModal(); })
        .catch(err => toast('خطأ: ' + err.message, 'err'))
        .finally(() => { btn.innerHTML = 'إنشاء حساب جديد'; btn.disabled = false; });
}

function signInWithGoogle() {
    if(!firebase.apps || !firebase.apps.length) return toast('Firebase غير مهيأ بعد!', 'err');
    
    const btn = $('#btnGoogleSignIn');
    if (!btn) return;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = 'جاري المعالجة...';
    btn.disabled = true;

    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider)
        .then(() => { toast('تم الدخول بحساب Google بنجاح! 🎉', 'ok'); closeAuthModal(); })
        .catch(err => {
            if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
                toast('خطأ: ' + err.message, 'err');
            }
        })
        .finally(() => { btn.innerHTML = oldHtml; btn.disabled = false; });
}

// ─── Cloud Sync ─────────────────────────────────────
async function saveToCloudHistory(data) {
    if (!currentUser || !db || data.status !== 'completed') return;
    try {
        await db.collection('users').doc(currentUser.uid).collection('history').doc(String(data.id)).set({
            ...data,
            cloud_saved_at: new Date().toISOString()
        });
    } catch(err) {
        console.error('Failed to save to cloud', err);
    }
}

async function fetchCloudHistory() {
    if (!currentUser || !db) return [];
    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('history').orderBy('completed_at', 'desc').limit(500).get();
        return snap.docs.map(doc => doc.data());
    } catch(err) {
        console.error('Failed to fetch cloud history', err);
        return [];
    }
}

// ─── State ──────────────────────────────────────────
const S = {
    tab: 'download',
    videoInfo: null,
    selectedFormat: null,
    queue: [],
    stats: { total: 0, completed: 0, active: 0, queued: 0, errors: 0 },
    searchResults: [],
    history: [],
    loading: false,
    searching: false,
};

// ─── DOM Helpers ────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Analytics Chart ────────────────────────────────
let analyticsChart = null;

function renderAnalytics(history) {
    const el = $('#analyticsChart');
    if (!el) return;

    // Get last 7 days
    const last7Days = Array.from({length: 7}, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' });
    }).reverse();

    // Count downloads per day
    const counts = new Array(7).fill(0);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    
    history.forEach(item => {
        if (!item.completed_at) return;
        const d = new Date(item.completed_at);
        const diffTime = Math.abs(today - d);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays < 7 && diffDays >= 0) {
            counts[6 - diffDays]++;
        }
    });

    const ctx = el.getContext('2d');
    const isDark = document.body.classList.contains('theme-dark');
    const textColor = isDark ? '#a0aec0' : '#4a5568';
    const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const accentColor = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#8b5cf6';

    if (analyticsChart) analyticsChart.destroy();

    analyticsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: last7Days,
            datasets: [{
                label: 'عدد التحميلات',
                data: counts,
                backgroundColor: accentColor,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { rtl: true }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { stepSize: 1, color: textColor },
                    grid: { color: gridColor }
                },
                x: {
                    ticks: { color: textColor },
                    grid: { display: false }
                }
            }
        }
    });
}

// ─── XSS Protection ────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// ─── Socket ─────────────────────────────────────────
let socket = null;

function initSocket() {
    socket = io();
    socket.on('connect', () => console.log('✅ WebSocket connected'));

    socket.on('download_progress', (d) => {
        updateQueueItem(d);
    });

    socket.on('download_complete', (d) => {
        updateQueueItem(d);
        saveToCloudHistory(d);
        saveToTrending(d);
        toast('تم التحميل بنجاح! 🎉', 'ok');
        playNotifSound('success');
        showDesktopNotif('اكتمل التحميل ✅', d.title || 'تم تحميل الملف بنجاح');
        refreshStats();
        // Refresh history if on history tab
        if (S.tab === 'history') fetchHistory();
    });

    socket.on('download_error', (d) => {
        updateQueueItem(d);
        const msg = escapeHtml(d.error) || 'فشل التحميل';
        toast(`خطأ: ${msg}`, 'err');
        playNotifSound('error');
        showDesktopNotif('فشل التحميل ❌', msg);
        refreshStats();
    });

    socket.on('download_added', (d) => {
        mergeQueueItem(d);
        if (d.status !== 'scheduled') playNotifSound('start');
        refreshStats();
        if (S.tab === 'queue') renderQueue();
    });

    socket.on('download_cancelled', (d) => {
        updateQueueItem(d);
        refreshStats();
    });

    socket.on('queue_update', (data) => {
        S.queue = data.queue || [];
        S.stats = data.stats || S.stats;
        renderQueue();
        renderStats();
        updateBadge();
    });
}

// ─── Tabs ───────────────────────────────────────────
// Tab switching
document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelectorAll('.nav__tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            switchTab(target);
        });
    });
});

async function switchTab(tabId) {
    S.tab = tabId; // Keep S.tab updated for other logic
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('tab-content--active'));
    document.querySelectorAll('.nav__tab').forEach(nt => nt.classList.remove('nav__tab--active'));
    
    const targetTab = document.getElementById('tab-' + tabId);
    if (targetTab) {
        targetTab.classList.add('tab-content--active');
        const navBtn = document.querySelector(`.nav__tab[data-tab="${tabId}"]`);
        if (navBtn) navBtn.classList.add('nav__tab--active');
    }
    
    if (tabId === 'history') fetchHistory();
    if (tabId === 'collections') fetchCollections();
    if (tabId === 'discover') fetchTrending();
}

// ─── Platform Detection ─────────────────────────────
function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
    if (/tiktok\.com|vm\.tiktok\.com/i.test(url)) return 'tiktok';
    if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return 'facebook';
    if (/twitter\.com|x\.com/i.test(url)) return 'twitter';
    return '';
}

function updatePlatformUI(url) {
    const bar = $('#urlBar');
    const icon = $('#platformIcon');
    const p = detectPlatform(url);

    ['youtube', 'instagram', 'tiktok', 'facebook', 'twitter'].forEach(cls => bar.classList.remove(`is-${cls}`));
    
    const pEmoji = { youtube: '▶️', instagram: '📷', tiktok: '🎵', facebook: '📘', twitter: '🐦' };
    icon.innerHTML = pEmoji[p] || '🔗';
    if (p) {
        bar.classList.add(`is-${p}`);
    }
}

// ─── Clipboard Auto-detect ──────────────────────────
window.addEventListener('focus', async () => {
    if (localStorage.getItem('vd_prefClipboard') !== 'true') return;
    try {
        const text = await navigator.clipboard.readText();
        if (text && text.startsWith('http') && detectPlatform(text)) {
            const input = $('#urlInput');
            if (input.value !== text) {
                input.value = text;
                updatePlatformUI(text);
                toast('تم لصق الرابط من الحافظة تلقائياً 📋', 'info');
                // Optional: auto fetch
                // fetchInfo();
            }
        }
    } catch (e) { /* Ignore permissions errors silently */ }
});
// ─── URL Input ──────────────────────────────────────
let autoFetchTimer = null;

function onUrlInput(e) {
    const val = e.target.value.trim();
    updatePlatformUI(val);

    // Auto-fetch when a valid URL is pasted/typed
    clearTimeout(autoFetchTimer);
    if (val.startsWith('http') && detectPlatform(val)) {
        autoFetchTimer = setTimeout(() => fetchInfo(), 600);
    }
}

async function pasteUrl() {
    try {
        const text = await navigator.clipboard.readText();
        const inp = $('#urlInput');
        inp.value = text;
        updatePlatformUI(text);
        if (text.startsWith('http')) fetchInfo();
    } catch { toast('لا يمكن الوصول للحافظة', 'err'); }
}

// ─── Drag & Drop ────────────────────────────────────
function initDragDrop() {
    const zone = $('#urlBar');
    if (!zone) return;

    zone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => {
        zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list') || '';
        if (text) {
            const inp = $('#urlInput');
            inp.value = text.trim();
            updatePlatformUI(text);
            if (text.trim().startsWith('http')) fetchInfo();
        }
    });
}

// ─── Fetch Video Info ───────────────────────────────
async function fetchInfo() {
    const url = $('#urlInput').value.trim();
    if (!url) return toast('الرجاء إدخال رابط الفيديو', 'err');

    S.loading = true;
    const btn = $('#btnFetch');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> جاري الجلب...';
    
    // Skeleton Loader for Info
    const previewEl = $('#videoPreview');
    previewEl.innerHTML = `
        <div class="video-preview__thumb skeleton" style="height:300px; border-radius:var(--radius-lg) var(--radius-lg) 0 0;"></div>
        <div class="video-preview__info">
            <div class="skeleton" style="height:24px; width:70%; margin-bottom:15px;"></div>
            <div style="display:flex; gap:10px;">
                <div class="skeleton" style="height:16px; width:100px;"></div>
                <div class="skeleton" style="height:16px; width:80px;"></div>
                <div class="skeleton" style="height:16px; width:60px;"></div>
            </div>
            <div class="skeleton" style="height:40px; width:100%; margin-top:20px;"></div>
            <div class="skeleton" style="height:40px; width:100%; margin-top:10px;"></div>
        </div>
    `;
    previewEl.classList.add('visible');
    $('#downloadHint').style.display = 'none';

    try {
        const res = await fetch('/api/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل في جلب المعلومات');
        S.videoInfo = data;
        
        if (data.is_playlist) {
            renderPlaylist(data);
        } else {
            renderPreview(data);
        }
        
        toast('تم جلب المعلومات بنجاح ✅', 'ok');
    } catch (e) {
        toast(e.message, 'err');
        $('#downloadHint').style.display = '';
    } finally {
        S.loading = false;
        btn.disabled = false;
        btn.innerHTML = '⚡ جلب';
    }
}

// ─── Render Preview ─────────────────────────────────
function renderPreview(info) {
    const el = $('#videoPreview');
    const pLabels = { youtube: 'يوتيوب', instagram: 'انستغرام', tiktok: 'تيك توك', facebook: 'فيسبوك', twitter: 'تويتر / X' };
    const dur = fmtDur(info.duration);
    const views = info.view_count ? fmtNum(info.view_count) : '';
    const likes = info.like_count ? fmtNum(info.like_count) : '';
    const safeTitle = escapeHtml(info.title);
    const safeUploader = escapeHtml(info.uploader);
    const safeDesc = escapeHtml(info.description || '');
    const uploadDate = info.upload_date ? formatDate(info.upload_date) : '';

    // Build embedded player (YouTube) or large thumbnail (others)
    let mediaHTML = '';
    if (info.platform === 'youtube' && info.video_id) {
        mediaHTML = `
            <div class="video-preview__player" id="videoPlayerWrap">
                <div class="video-preview__thumb-overlay" id="thumbOverlay" onclick="playEmbed('${escapeHtml(info.video_id)}')">
                    <img src="${escapeHtml(info.thumbnail)}" alt="${safeTitle}" onerror="this.style.display='none'">
                    <div class="video-preview__play-btn">▶</div>
                    ${dur ? `<span class="video-preview__dur">${dur}</span>` : ''}
                    <span class="video-preview__badge youtube">${pLabels.youtube}</span>
                </div>
            </div>`;
    } else {
        mediaHTML = `
            <div class="video-preview__thumb">
                <img src="${escapeHtml(info.thumbnail)}" alt="${safeTitle}" onerror="this.style.display='none'">
                ${dur ? `<span class="video-preview__dur">${dur}</span>` : ''}
                <span class="video-preview__badge ${info.platform}">${pLabels[info.platform] || escapeHtml(info.platform)}</span>
            </div>`;
    }

    // Build format picker
    let fmtHTML = '';
    if (info.formats?.length) {
        fmtHTML = info.formats.map((f, i) => {
            const sz = f.filesize ? fmtSize(f.filesize) : '';
            const fid = escapeHtml(f.format_id);
            return `
                <div class="fmt-opt ${i === 0 ? 'active' : ''}"
                     data-fid="${fid}" data-audio="${!!f.audio_only}"
                     onclick="pickFormat(this,'${fid}',${!!f.audio_only})">
                    <div class="fmt-opt__q">${f.audio_only ? '🎵 ' : ''}${escapeHtml(f.label)}</div>
                    <div class="fmt-opt__ext">${escapeHtml(f.ext)}</div>
                    ${sz ? `<div class="fmt-opt__size">${sz}</div>` : ''}
                </div>`;
        }).join('');
        S.selectedFormat = { format_id: info.formats[0].format_id, audio_only: !!info.formats[0].audio_only };
    }

    // Build description section
    let descHTML = '';
    if (safeDesc) {
        const shortDesc = safeDesc.length > 150 ? safeDesc.substring(0, 150) + '...' : safeDesc;
        const needsExpand = safeDesc.length > 150;
        descHTML = `
            <div class="video-preview__desc">
                <div class="video-preview__desc-title">📝 الوصف</div>
                <div class="video-preview__desc-text" id="descText">${shortDesc}</div>
                ${needsExpand ? `<button class="video-preview__desc-toggle" onclick="toggleDesc(this)" data-full="${safeDesc}" data-short="${shortDesc}">عرض المزيد ↓</button>` : ''}
            </div>`;
    }

    el.innerHTML = `
        ${mediaHTML}
        <div class="video-preview__info">
            <h3 class="video-preview__title">${safeTitle}</h3>
            <div class="video-preview__meta">
                ${safeUploader ? `<span>👤 ${safeUploader}</span>` : ''}
                ${views ? `<span>👁️ ${views} مشاهدة</span>` : ''}
                ${likes ? `<span>❤️ ${likes} إعجاب</span>` : ''}
                ${dur ? `<span>⏱️ ${dur}</span>` : ''}
                ${uploadDate ? `<span>📅 ${uploadDate}</span>` : ''}
            </div>
            <div class="video-preview__actions-bar" style="flex-wrap:wrap;">
                <button class="btn btn--ghost btn--sm" onclick="copyLink('${escapeHtml(info.webpage_url || info.url)}')">📋 نسخ الرابط</button>
                <button class="btn btn--ghost btn--sm" onclick="window.open('${escapeHtml(info.webpage_url || info.url)}','_blank')">🔗 فتح المصدر</button>
                <button class="btn btn--ghost btn--sm" onclick="downloadThumbnail('${escapeHtml(info.thumbnail)}', '${escapeHtml(info.title).replace(/'/g, "\\'")}')">🖼️ تحميل الصورة المصغرة</button>
            </div>
            ${descHTML}
            ${fmtHTML ? `
                <div class="format-picker">
                    <div class="format-picker__label">📐 اختر الجودة</div>
                    <div class="format-grid">${fmtHTML}</div>
                </div>` : ''}
            
            <div class="settings-group" style="margin-top:20px;margin-bottom:14px;background:var(--bg-glass);padding:10px;border-radius:8px;">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="dlSubtitles" style="width:18px;height:18px;accent-color:var(--accent)">
                    <span style="font-size:0.9rem;color:var(--text-primary)">💬 تحميل ملفات الترجمة (إن وجدت)</span>
                </label>
            </div>

            <div class="format-picker">
                <div class="format-picker__label">📝 اسم الملف (اختياري)</div>
                <input type="text" id="customFileName" class="custom-name-field" placeholder="اكتب اسماً مخصصاً (أو اتركه فارغاً للاسم الأصلي)">
            </div>
            
            <div class="settings-group" style="background:var(--bg-glass);padding:10px;border-radius:8px;margin-bottom:20px;">
                <div class="format-picker__label">✂️ قص الفيديو (اختياري - بالثواني)</div>
                <div style="display:flex; gap:10px;">
                    <div style="flex:1">
                        <label style="font-size:0.8rem;color:var(--text-secondary)">وقت البدء</label>
                        <input type="number" id="cropStart" class="custom-name-field" placeholder="0" min="0" style="margin-top:4px;">
                    </div>
                    <div style="flex:1">
                        <label style="font-size:0.8rem;color:var(--text-secondary)">وقت الانتهاء</label>
                        <input type="number" id="cropEnd" class="custom-name-field" placeholder="${info.duration || parseInt(dur) || 0}" min="0" style="margin-top:4px;">
                    </div>
                </div>
                <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:5px;">ملاحظة: القص يعمل أفضل مع الفيديوهات القصيرة وقد يستغرق وقتاً أطول.</div>
            </div>

            <div class="download-actions">
                <button class="btn btn--accent btn--full" onclick="startDL(false, false)">⬇️ تحميل فيديو</button>
                <button class="btn btn--success btn--full" onclick="startDL(true, false)">🎵 صوت MP3</button>
            </div>
            <div class="download-actions" style="margin-top:10px;">
                <button class="btn btn--ghost btn--full" onclick="startDL(false, true)">➕ إضافة للقائمة (فيديو)</button>
                <button class="btn btn--ghost btn--full" onclick="startDL(true, true)">➕ إضافة للقائمة (صوت)</button>
            </div>
        </div>`;
    el.classList.add('visible');

    // Auto-fill filename based on preference
    const pref = localStorage.getItem('vd_prefFileNaming') || 'default';
    if (pref === 'prefix_channel' && info.uploader) {
        $('#customFileName').value = `${info.uploader} - ${info.title}`;
    }
}

// ─── Render Playlist ────────────────────────────────
function renderPlaylist(info) {
    const el = $('#videoPreview');
    const safeTitle = escapeHtml(info.title);
    
    // Build list of entries
    let entriesHTML = info.entries.map((e, i) => {
        const dur = fmtDur(e.duration);
        const safeUrl = escapeHtml(e.url);
        return `
        <label style="display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid var(--border-color);font-size:0.85rem;cursor:pointer;transition:background 0.2s;" onmouseover="this.style.background='var(--bg-card-hover)'" onmouseout="this.style.background='transparent'">
            <div style="display:flex;align-items:center;gap:10px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:10px;">
                <input type="checkbox" class="pl-checkbox" value="${safeUrl}" checked style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;">
                <span>${i+1}. ${escapeHtml(e.title)}</span>
            </div>
            ${dur ? `<div style="color:var(--text-secondary)">⏱️ ${dur}</div>` : ''}
        </label>`;
    }).join('');

    el.innerHTML = `
        <div style="padding:20px;background:var(--bg-card);border-radius:var(--radius-lg);border:1px solid var(--border-color);">
            <div style="display:flex;align-items:center;gap:15px;margin-bottom:20px;">
                <div style="font-size:2.5rem;">🗂️</div>
                <div>
                    <h3 style="margin-bottom:5px;">${safeTitle}</h3>
                    <div style="color:var(--text-secondary);font-size:0.9rem;">قائمة تشغيل - ${info.count} فيديو</div>
                </div>
            </div>
            
            <div style="margin-bottom:10px; padding:0 5px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;cursor:pointer;">
                    <input type="checkbox" checked onchange="document.querySelectorAll('.pl-checkbox').forEach(cb => cb.checked = this.checked)" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;">
                    <strong>تحديد الكل</strong>
                </label>
            </div>

            <div style="max-height:200px;overflow-y:auto;background:var(--bg-glass);border-radius:var(--radius-md);margin-bottom:20px;border:1px solid var(--border-color);">
                ${entriesHTML}
            </div>

            <div class="download-actions">
                <button class="btn btn--accent btn--full" onclick="startPlaylistDL(false, false)">📦 تحميل المحدد (فيديو)</button>
                <button class="btn btn--success btn--full" onclick="startPlaylistDL(true, false)">🎵 تحميل المحدد (صوت)</button>
            </div>
            <div class="download-actions" style="margin-top:10px;">
                <button class="btn btn--ghost btn--full" onclick="startPlaylistDL(false, true)">➕ إضافة للقائمة (فيديو)</button>
                <button class="btn btn--ghost btn--full" onclick="startPlaylistDL(true, true)">➕ إضافة للقائمة (صوت)</button>
            </div>
        </div>
    `;
    el.classList.add('visible');
}

// ─── Embed Player (YouTube) ─────────────────────────
function playEmbed(videoId) {
    const wrap = $('#videoPlayerWrap');
    if (!wrap) return;
    wrap.innerHTML = `
        <iframe class="video-preview__iframe"
                src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0"
                frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen>
        </iframe>`;
}

// ─── Toggle Description ─────────────────────────────
function toggleDesc(btn) {
    const textEl = $('#descText');
    if (!textEl) return;
    const isExpanded = btn.dataset.expanded === 'true';
    if (isExpanded) {
        textEl.textContent = btn.dataset.short;
        btn.textContent = 'عرض المزيد ↓';
        btn.dataset.expanded = 'false';
    } else {
        textEl.textContent = btn.dataset.full;
        btn.textContent = 'عرض أقل ↑';
        btn.dataset.expanded = 'true';
    }
}

// ─── Copy Link ──────────────────────────────────────
async function copyLink(url) {
    try {
        await navigator.clipboard.writeText(url);
        toast('تم نسخ الرابط 📋', 'ok');
    } catch {
        toast('فشل نسخ الرابط', 'err');
    }
}

// ─── Format Date ────────────────────────────────────
function formatDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) return '';
    const y = dateStr.substring(0, 4);
    const m = dateStr.substring(4, 6);
    const d = dateStr.substring(6, 8);
    try {
        return new Date(`${y}-${m}-${d}`).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return `${d}/${m}/${y}`; }
}

// ─── Notification Sound ─────────────────────────────
function playNotifSound(type = 'success') {
    if (localStorage.getItem('vd_prefNotifications') === 'false') return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        let freq = 880;
        let duration = 0.4;
        
        if (type === 'start') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
        } else if (type === 'error') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(220, ctx.currentTime);
            osc.frequency.setValueAtTime(110, ctx.currentTime + 0.2);
            duration = 0.5;
        } else { // success / complete
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
            osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.2);
        }
        
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + duration);
    } catch {}
}

function pickFormat(el, fid, audio) {
    $$('.fmt-opt').forEach(o => o.classList.remove('active'));
    el.classList.add('active');
    S.selectedFormat = { format_id: fid, audio_only: audio };
}

// ─── Start Download ─────────────────────────────────
async function startDL(audioOnly = false, enqueueOnly = false) {
    if (!S.videoInfo || S.videoInfo.is_playlist) return toast('الرجاء جلب معلومات فيديو مفرد أولاً', 'err');
    const fid = audioOnly ? 'best' : (S.selectedFormat?.format_id || 'best');
    const customName = $('#customFileName')?.value.trim() || '';
    const dlSubs = $('#dlSubtitles')?.checked || false;
    
    // Format preferences
    const audioFmt = localStorage.getItem('vd_prefAudioFormat') || 'mp3';
    const videoFmt = localStorage.getItem('vd_prefVideoFormat') || 'none';
    
    const cropStart = parseInt($('#cropStart')?.value) || 0;
    const cropEnd = parseInt($('#cropEnd')?.value) || 0;

    if (cropEnd > 0 && cropStart > cropEnd) {
        return toast('وقت الانتهاء يجب أن يكون أكبر من وقت البدء', 'err');
    }

    if (!enqueueOnly) {
        // Direct Memory Streaming Mode (Vercel Compatibility)
        const params = new URLSearchParams({
            url: S.videoInfo.url,
            format_id: fid,
            audio_only: audioOnly
        });
        toast('بدأ التحميل المباشر 🚀', 'ok');
        window.location.href = `/api/stream_direct?${params.toString()}`;
        return;
    }

    try {
        const res = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                url: S.videoInfo.url, 
                format_id: fid, 
                audio_only: audioOnly, 
                custom_filename: customName,
                download_subtitles: dlSubs,
                start_time: cropStart,
                end_time: cropEnd,
                audio_format: audioFmt,
                video_format: videoFmt,
                enqueue_only: enqueueOnly
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل بدء التحميل');
        $('#urlInput').value = '';
        S.videoInfo = null;
        $('#videoPreview').classList.remove('visible');
        $('#downloadHint').style.display = '';
        toast('تمت إضافته لقائمة الانتظار ⏳', 'info');
    } catch (e) { toast(e.message, 'err'); }
}

async function startPlaylistDL(audioOnly = false, enqueueOnly = false) {
    if (!S.videoInfo || !S.videoInfo.is_playlist) return toast('الرجاء جلب رابط قائمة تشغيل أولاً', 'err');
    
    // Gather selected URLs from checkboxes
    const checkboxes = document.querySelectorAll('.pl-checkbox:checked');
    const urls = Array.from(checkboxes).map(cb => cb.value).filter(Boolean);
    
    if (!urls.length) return toast('الرجاء تحديد فيديو واحد على الأقل للتحميل', 'warning');

    try {
        const res = await fetch('/api/download/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                urls: urls, 
                audio_only: audioOnly,
                enqueue_only: enqueueOnly
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل بدء تحميل القائمة');
        
        $('#urlInput').value = '';
        S.videoInfo = null;
        $('#videoPreview').classList.remove('visible');
        $('#downloadHint').style.display = '';
        if (enqueueOnly) {
            toast(`تمت إضافة ${urls.length} فيديو في قائمة الانتظار ⏳`, 'info');
        } else {
            toast(`بدأ تحميل ${urls.length} فيديو 🚀`, 'ok');
            switchTab('queue');
        }
    } catch (e) { toast(e.message, 'err'); }
}

function downloadFromSearch(url) {
    $('#urlInput').value = url;
    updatePlatformUI(url);
    switchTab('download');
    fetchInfo();
}

// ─── Batch Download ─────────────────────────────────
function openBatchModal() {
    $('#batchModal').classList.add('open');
    $('#batchUrls').focus();
}

function closeBatchModal() {
    $('#batchModal').classList.remove('open');
}

async function startBatch(enqueueOnly = false) {
    const text = $('#batchUrls').value.trim();
    if (!text) return toast('الرجاء إدخال الروابط', 'err');

    const urls = text.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
    if (!urls.length) return toast('لا توجد روابط صالحة', 'err');

    const audioOnly = $('#batchAudio').checked;

    try {
        const res = await fetch('/api/download/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls, audio_only: audioOnly, enqueue_only: enqueueOnly })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل التحميل الجماعي');
        
        closeBatchModal();
        if (enqueueOnly) {
            toast(`تمت إضافة ${data.count} تحميل لقائمة الانتظار ⏳`, 'info');
        } else {
            toast(`بدأ ${data.count} تحميل 🚀`, 'ok');
            switchTab('queue');
        }
    } catch (e) { toast(e.message, 'err'); }
}

// ─── Search Filters & YouTube Search ─────────────────
function toggleSearchFilters() {
    const filters = $('#searchFilters');
    if (filters) {
        filters.style.display = filters.style.display === 'none' ? 'block' : 'none';
    }
}

async function doSearch() {
    let q = $('#searchInput').value.trim();
    if (!q) return toast('الرجاء إدخال كلمة البحث', 'err');

    // Apply search filters
    const filterDur = $('#filterDuration')?.value;
    const filterDate = $('#filterDate')?.value;
    if (filterDur === 'short') q += ' short';
    if (filterDur === 'long') q += ' long';
    if (filterDate === 'today') q += ' today';
    if (filterDate === 'week') q += ' this week';
    if (filterDate === 'month') q += ' this month';

    S.searching = true;
    const btn = $('#btnSearch');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> بحث...';

    const container = $('#searchResults');
    // Skeleton Loader for Search
    container.innerHTML = Array(8).fill(0).map(() => `
        <div class="s-card skeleton-card" style="border-color:transparent; background:transparent;">
            <div class="s-card__thumb skeleton" style="border-radius:var(--radius-md);"></div>
            <div class="s-card__body">
                <div class="s-card__title skeleton"></div>
                <div class="s-card__ch skeleton"></div>
            </div>
        </div>
    `).join('');

    try {
        const res = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: q, max_results: 15 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل البحث');
        S.searchResults = data.results || [];
        renderResults(S.searchResults);
    } catch (e) {
        container.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty__ico">❌</div><div class="empty__title">${escapeHtml(e.message)}</div></div>`;
        toast(e.message, 'err');
    } finally {
        S.searching = false;
        btn.disabled = false;
        btn.innerHTML = '🔍 بحث';
    }
}

function renderResults(vids) {
    const c = $('#searchResults');
    if (!vids.length) {
        c.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty__ico">🔍</div><div class="empty__title">لا توجد نتائج</div></div>';
        return;
    }

    c.innerHTML = vids.map(v => {
        const dur = fmtDur(v.duration);
        const views = v.view_count ? fmtNum(v.view_count) : '';
        const safeUrl = escapeHtml(v.url);
        const videoData = JSON.stringify({
            id: v.id,
            url: v.url,
            title: v.title,
            thumbnail: v.thumbnail,
            platform: 'youtube', // Search is currently YT only
            duration: v.duration
        }).replace(/"/g, '&quot;');
        
        return `
            <div class="s-card" data-url="${safeUrl}">
                <div class="s-card__thumb" onclick="downloadFromSearch('${safeUrl}')">
                    <img src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'">
                    ${dur ? `<span class="s-card__dur">${dur}</span>` : ''}
                    <div class="s-card__play">▶</div>
                </div>
                <div class="s-card__body">
                    <div class="s-card__title" onclick="downloadFromSearch('${safeUrl}')">${escapeHtml(v.title)}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:5px;">
                         ${v.uploader ? `<div class="s-card__ch">👤 ${escapeHtml(v.uploader)}</div>` : ''}
                         <button class="btn btn--ghost btn--sm" onclick="showAddToListMenuDirect(${videoData})" title="أضف للقائمة" style="padding:2px 8px; font-size:0.7rem;">➕ قائمة</button>
                    </div>
                </div>
            </div>`;
    }).join('');
}

async function showAddToListMenuDirect(itemData) {
    if (!currentUser || !db) return toast('سجل دخولك أولاً', 'info');
    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('collections').get();
        if (snap.empty) return toast('أنشئ قائمة أولاً من تبويب "قائمتي"', 'info');
        
        let html = '<div style="padding:20px; text-align:center;">';
        html += '<h3 style="margin-bottom:15px;">أضف للقائمة:</h3>';
        html += '<div style="display:flex; flex-direction:column; gap:10px;">';
        snap.forEach(doc => {
            html += `<button class="btn btn--ghost" onclick="addToCollection('${doc.id}', ${JSON.stringify(itemData).replace(/"/g, '&quot;')}); closePlayerModal();">${escapeHtml(doc.data().name)}</button>`;
        });
        html += '</div></div>';
        
        const modal = $('#playerModal');
        const container = $('#playerContainer');
        container.innerHTML = html;
        modal.classList.add('open');
    } catch(err) {
        toast('خطأ في جلب القوائم', 'err');
    }
}

async function fetchQueue() {
    try {
        const res = await fetch('/api/queue');
        const data = await res.json();
        S.queue = data.queue || [];
        S.stats = data.stats || S.stats;
        renderQueue();
        renderStats();
        updateBadge();
    } catch (e) { console.error('Queue fetch failed:', e); }
}

async function refreshStats() {
    try {
        const res = await fetch('/api/stats');
        S.stats = await res.json();
        renderStats();
        updateBadge();
    } catch {}
}

function renderStats() {
    const s = S.stats;
    const set = (id, v) => { const e = $(`#${id}`); if (e) animateNumber(e, v); };
    set('statTotal', s.total);
    set('statActive', s.active + s.queued);
    set('statDone', s.completed);
    set('statErr', s.errors);
}

// Animated number count-up
function animateNumber(el, target) {
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;
    el.textContent = target;
    el.style.transform = 'scale(1.3)';
    el.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
    setTimeout(() => { el.style.transform = 'scale(1)'; }, 200);
}

function updateBadge() {
    const b = $('#queueBadge');
    const n = S.stats.active + S.stats.queued;
    if (b) { b.textContent = n; b.style.display = n > 0 ? 'inline' : 'none'; }
}

// ─── Queue Actions ──────────────────────────────────
async function startQueue() {
    try {
        const res = await fetch('/api/queue/start', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            toast(data.message || 'تم بدء القائمة 🚀', 'ok');
            fetchQueue();
        } else {
            toast(data.error || 'فشل بدء القائمة', 'err');
        }
    } catch { toast('فشل الاتصال بالسيرفر', 'err'); }
}

function setConcurrencyMode(mode) {
    fetch('/api/settings/concurrency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
    }).then(res => res.json())
      .then(data => toast(mode === 'parallel' ? 'وضع التحميل المتعدد (أسرع) ⚡' : 'وضع التحميل الفردي (مرتب) 📋', 'ok'))
      .catch(() => toast('فشل تغيير الوضع', 'err'));
}

async function clearHistory() {
    if (!confirm('هل تريد مسح سجل التحميلات بالكامل؟')) return;
    try {
        const res = await fetch('/api/history/clear', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            toast(data.message || 'تم مسح السجل', 'ok');
            S.history = [];
            renderHistory();
            renderAnalytics(S.history);
        } else {
            toast(data.error || 'فشل مسح السجل', 'err');
        }
    } catch { toast('فشل الاتصال بالسيرفر', 'err'); }
}

function renderQueue() {
    const c = $('#queueList');
    if (!c) return; // Fail safe if looking for wrong element

    const countLabel = $('#queueCount');
    if (countLabel) countLabel.textContent = `${S.queue.length} تحميل`;

    // Filter to hide completed/error items if you have a separate history tab.
    // However, since the user expects to see active downloads here:
    const visibleItems = S.queue;

    if (!visibleItems.length) {
        c.innerHTML = `<div class="empty">
            <div class="empty__ico">📋</div>
            <div class="empty__title">القائمة فارغة</div>
            <div class="empty__text">قم بإضافة فيديوهات للتحميل لتظهر هنا</div>
        </div>`;
        return;
    }

    c.innerHTML = visibleItems.map(renderQItem).join('');
}

function renderQItem(item) {
    const sLabels = { queued: '⏳ انتظار', downloading: '⬇️ تحميل', completed: '✅ مكتمل', error: '❌ خطأ', cancelled: '🚫 ملغي' };
    const sCls = { queued: 'badge-s--wait', downloading: 'badge-s--dl', completed: 'badge-s--ok', error: 'badge-s--err', cancelled: 'badge-s--cancel' };
    const pCls = item.status === 'completed' ? 'done' : (item.status === 'error' ? 'err' : '');
    const showProg = item.status === 'downloading' || item.status === 'completed';
    const pEmoji = { youtube: '▶️', instagram: '📷', tiktok: '🎵', facebook: '📘', twitter: '🐦' }[item.platform] || '🔗';
    const activeClass = item.status === 'downloading' ? 'q-item--active' : '';
    const safeTitle = escapeHtml(item.title || item.url);
    const safeError = escapeHtml(item.error);
    const safeFilename = escapeHtml(item.filename);
    const typeIcon = item.audio_only ? '🎵' : '🎞️';

    return `
        <div class="q-item ${activeClass}" id="q-${item.id}">
            <div class="q-item__top">
                <div class="q-item__thumb">
                    ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.1rem">🎬</div>'}
                </div>
                <div class="q-item__info">
                    <div class="q-item__title">${safeTitle}</div>
                    <div class="q-item__meta">
                        <span class="badge-s ${sCls[item.status] || ''}">${sLabels[item.status] || item.status}</span>
                        <span>${typeIcon} ${pEmoji} ${escapeHtml(item.platform_label || item.platform)}</span>
                        ${item.mode === 'batch' ? '<span>📦 جماعي</span>' : ''}
                    </div>
                </div>
                <div class="q-item__btns">
                    ${item.status === 'completed' && safeFilename ? `<button class="btn-icon btn-icon--accent" onclick="openPlayer('${encodeURIComponent(item.filename.split(/[\\/]/).pop())}', '${safeTitle}')" title="تشغيل">▶️</button>` : ''}
                    ${item.status === 'completed' && safeFilename ? `<a class="btn-icon btn-icon--success" href="/downloads/${encodeURIComponent(item.filename.split(/[\\/]/).pop())}" download title="تحميل الملف">💾</a>` : ''}
                    ${item.status === 'error' || item.status === 'cancelled' ? `<button class="btn-icon btn-icon--success" onclick="retryDL('${item.id}')" title="إعادة">🔄</button>` : ''}
                    ${item.status === 'downloading' ? `<button class="btn-icon btn-icon--danger" onclick="cancelDL('${item.id}')" title="إلغاء">✕</button>` : ''}
                    ${item.status === 'queued' ? `<button class="btn-icon btn-icon--danger" onclick="cancelDL('${item.id}')" title="حذف من القائمة">✕</button>` : ''}
                    ${item.status === 'completed' || item.status === 'error' || item.status === 'cancelled' ? `<button class="btn-icon btn-icon--danger" onclick="removeDL('${item.id}')" title="حذف">🗑</button>` : ''}
                </div>
            </div>
            ${showProg ? `
                <div class="progress"><div class="progress__bar ${pCls}" style="width:${item.progress}%"></div></div>
                <div class="q-item__pinfo">
                    <span>${Math.round(item.progress)}%</span>
                    <span>${escapeHtml(item.speed) || ''}${item.eta ? ' • ' + escapeHtml(item.eta) : ''}</span>
                </div>` : ''}
            ${item.status === 'error' ? `<div style="color:var(--error);font-size:0.78rem;margin-top:6px">⚠️ ${safeError}</div>` : ''}
        </div>`;
}

function mergeQueueItem(d) {
    const i = S.queue.findIndex(q => q.id === d.id);
    if (i >= 0) S.queue[i] = d; else S.queue.push(d);
}

function updateQueueItem(d) {
    mergeQueueItem(d);
    const el = $(`#q-${d.id}`);
    if (el) el.outerHTML = renderQItem(d);
    renderStats();
    updateBadge();
}

async function cancelDL(id) {
    try { await fetch(`/api/cancel/${id}`, { method: 'POST' }); toast('تم إلغاء التحميل', 'info'); } catch { toast('فشل الإلغاء', 'err'); }
}

async function retryDL(id) {
    try {
        const res = await fetch(`/api/retry/${id}`, { method: 'POST' });
        if (res.ok) toast('تمت إعادة التحميل 🔄', 'ok');
        else toast('فشل إعادة التحميل', 'err');
    } catch { toast('فشل إعادة التحميل', 'err'); }
}

async function removeDL(id) {
    try {
        await fetch(`/api/remove/${id}`, { method: 'DELETE' });
        S.queue = S.queue.filter(q => q.id !== id);
        renderQueue();
        refreshStats();
        toast('تم الحذف', 'info');
    } catch { toast('فشل الحذف', 'err'); }
}

async function clearDone() {
    try {
        const res = await fetch('/api/clear', { method: 'POST' });
        const data = await res.json();
        toast(`تم حذف ${data.count} تحميل`, 'info');
        fetchQueue();
    } catch { toast('فشل التنظيف', 'err'); }
}

// ─── Video Player ───────────────────────────────────
let dpInstance = null;

function openPlayer(filename, title) {
    const modal = document.getElementById('playerModal');
    const container = document.getElementById('playerContainer');
    const meta = document.getElementById('playerMeta');
    
    if (!modal || !container) return toast('خطأ في فتح المشغل', 'err');
    
    // Store current file for trimmer
    S.currentPlayingFile = decodeURIComponent(filename);
    
    // Clean up previous player
    if (dpInstance) {
        try { dpInstance.destroy(); } catch(e) {}
        dpInstance = null;
    }
    container.innerHTML = '';
    
    // Build streaming URL
    const streamUrl = `/api/stream/${filename}`;
    
    // Show modal
    modal.classList.add('open');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    
    // Initialize DPlayer
    try {
        dpInstance = new DPlayer({
            container: container,
            autoplay: true,
            theme: '#8b5cf6',
            lang: 'en',
            video: {
                url: streamUrl,
                type: 'auto',
            },
            contextmenu: [
                { text: 'Video Downloader Pro', link: '/' }
            ]
        });
        
        // Reset speed buttons to 1x
        document.querySelectorAll('.pc-speed').forEach(b => b.classList.remove('active'));
        const btn1x = document.querySelector('.pc-speed[data-speed="1"]');
        if (btn1x) btn1x.classList.add('active');
        
    } catch(e) {
        // Fallback: use native HTML5 video if DPlayer fails
        console.error('DPlayer init failed, using native video:', e);
        container.innerHTML = `
            <video controls autoplay style="width:100%;max-height:70vh;background:#000;">
                <source src="${streamUrl}" type="video/mp4">
                متصفحك لا يدعم تشغيل الفيديو
            </video>`;
    }
    
    // Set meta title
    if (meta) {
        meta.innerHTML = `<div style="font-weight:700;font-size:0.95rem;color:var(--text-primary);">🎬 ${escapeHtml(decodeURIComponent(title || filename))}</div>`;
    }
}

function closePlayerModal() {
    const modal = document.getElementById('playerModal');
    if (modal) {
        modal.classList.remove('open');
        modal.style.display = 'none';
    }
    document.body.style.overflow = '';
    
    // Close trimmer panel
    const trimPanel = document.getElementById('trimmerPanel');
    if (trimPanel) trimPanel.style.display = 'none';
    
    // Destroy player to stop playback and free memory
    if (dpInstance) {
        try { dpInstance.destroy(); } catch(e) {}
        dpInstance = null;
    }
    const container = document.getElementById('playerContainer');
    if (container) container.innerHTML = '';
}

// Close player on ESC key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('playerModal');
        if (modal && (modal.classList.contains('open') || modal.style.display === 'flex')) {
            closePlayerModal();
        }
    }
});

// Close player on backdrop click
document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'playerModal') {
        closePlayerModal();
    }
});

// ─── Open Downloads Folder ──────────────────────────
async function openFolder() {
    try {
        const res = await fetch('/api/open-folder', { method: 'POST' });
        const data = await res.json();
        if (res.ok) toast('تم فتح مجلد التحميلات 📂', 'ok');
        else toast(data.error || 'فشل فتح المجلد', 'err');
    } catch { toast('فشل فتح المجلد', 'err'); }
}

// ─── History ────────────────────────────────────────
async function fetchHistory() {
    try {
        const res = await fetch('/api/history');
        const data = await res.json();
        let localHistory = data.history || [];
        
        // Fetch Cloud History if logged in
        if (currentUser && db) {
            const cloudHistory = await fetchCloudHistory();
            
            // Merge local and cloud avoiding duplicates
            const mergedMap = new Map();
            localHistory.forEach(item => mergedMap.set(String(item.id), item));
            cloudHistory.forEach(item => mergedMap.set(String(item.id), item));
            
            S.history = Array.from(mergedMap.values());
        } else {
            S.history = localHistory;
        }
        
        S.history.sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
        renderHistory();
        renderAnalytics(S.history);
    } catch (e) { console.error('History fetch failed:', e); }
}

function renderHistory() {
    const c = $('#historyList');
    const cnt = $('#historyCount');
    
    // Get search and sort values
    const searchVal = $('#historySearch')?.value.trim().toLowerCase() || '';
    const sortVal = $('#historySort')?.value || 'newest';

    // Apply filtering
    let filtered = S.history;
    if (searchVal) {
        filtered = filtered.filter(item => 
            (item.title && item.title.toLowerCase().includes(searchVal)) ||
            (item.uploader && item.uploader.toLowerCase().includes(searchVal)) ||
            (item.url && item.url.toLowerCase().includes(searchVal))
        );
    }

    // Apply sorting
    if (sortVal === 'newest') {
        filtered.sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
    } else if (sortVal === 'oldest') {
        filtered.sort((a, b) => new Date(a.completed_at || 0) - new Date(b.completed_at || 0));
    } else if (sortVal === 'size') {
        filtered.sort((a, b) => (b.filesize || 0) - (a.filesize || 0));
    }

    cnt.textContent = `${filtered.length} عنصر`;

    if (!filtered.length) {
        if (searchVal) {
            c.innerHTML = `<div class="empty"><div class="empty__ico">🔍</div><div class="empty__title">لا توجد نتائج مطابقة لبحثك</div></div>`;
        } else {
            c.innerHTML = `<div class="empty"><div class="empty__ico">📜</div><div class="empty__title">لا يوجد سجل بعد</div><div class="empty__text">التحميلات المكتملة ستظهر هنا تلقائياً</div></div>`;
        }
        return;
    }

    c.innerHTML = filtered.map(item => {
        const pEmoji = { youtube: '▶️', instagram: '📷', tiktok: '🎵', facebook: '📘', twitter: '🐦' }[item.platform] || '🔗';
        const dur = fmtDur(item.duration);
        const date = item.completed_at ? new Date(item.completed_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        const safeTitle = escapeHtml(item.title || item.url);
        const safeFilename = escapeHtml(item.filename);
        const typeIcon = item.audio_only ? '🎵 صوت' : '🎞️ فيديو';

        return `
            <div class="h-item">
                <div class="h-item__thumb">
                    ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.1rem">🎬</div>'}
                </div>
                <div class="h-item__info">
                    <div class="h-item__title">${safeTitle}</div>
                    <div class="h-item__meta">
                        <span>${pEmoji} ${escapeHtml(item.platform_label || item.platform)}</span>
                        ${dur ? `<span>⏱️ ${dur}</span>` : ''}
                        <span>${typeIcon}</span>
                        ${date ? `<span>📅 ${date}</span>` : ''}
                    </div>
                </div>
                <div class="h-item__btns">
                    ${safeFilename ? `<button class="btn-icon btn-icon--accent" onclick="openPlayer('${encodeURIComponent(item.filename.split(/[\\/]/).pop())}', '${safeTitle}')" title="تشغيل في التطبيق">▶️</button>` : ''}
                    ${safeFilename ? `<button class="btn-icon btn-icon--outline" onclick="openTrimmer('${encodeURIComponent(item.filename.split(/[\\/]/).pop())}')" title="قص وتعديل">✂️</button>` : ''}
                    ${safeFilename ? `<button class="btn-icon btn-icon--primary" onclick="uploadToCloud('${encodeURIComponent(item.filename.split(/[\\/]/).pop())}')" title="حفظ سحابي (فايربيست)">☁️</button>` : ''}
                    ${safeFilename ? `<button class="btn-icon" onclick="uploadToDrive('${encodeURIComponent(item.filename.split(/[\\/]/).pop())}')" title="إرسال لجوجل درايف">📤</button>` : ''}
                    ${safeFilename ? `<a class="btn-icon btn-icon--success" href="/downloads/${encodeURIComponent(item.filename)}" download title="تحميل الملف">💾</a>` : ''}
                    <button class="btn-icon btn-icon--success" onclick="redownload('${escapeHtml(item.url)}')" title="إعادة التحميل">🔄</button>
                    ${currentUser ? `<button class="btn-icon" onclick="showAddToListMenu('${item.id}')" title="أضف إلى قوائمي">📂</button>` : ''}
                </div>
            </div>`;
    }).join('');
}

async function uploadToCloud(filename) {
    if (!currentUser) return toast('سجل دخولك أولاً لإستخدام السحاب', 'err');
    toast('جاري تحضير الملف للرفع السحابي... ☁️', 'info');
    
    try {
        // Step 1: Fetch the file blob from the server
        const res = await fetch(`/api/stream/${encodeURIComponent(filename)}`);
        const blob = await res.blob();
        
        // Step 2: Upload to Firebase Storage
        const storageRef = storage.ref(`users/${currentUser.uid}/media/${filename}`);
        const uploadTask = storageRef.put(blob);
        
        uploadTask.on('state_changed', 
            (snapshot) => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                if (progress % 20 === 0) toast(`جاري الرفع... ${Math.round(progress)}%`, 'info');
            }, 
            (error) => {
                console.error(error);
                toast('فشل الرفع السحابي: ' + error.message, 'err');
            }, 
            () => {
                toast('تم الحفظ في سحاب فايربيست بنجاح! ✅', 'ok');
            }
        );
    } catch(e) { 
        console.error(e);
        toast('خطأ في العملية السحابية', 'err'); 
    }
}

async function uploadToDrive(filename) {
    toast('جاري إرسال الملف لجوجل درايف... ☁️', 'info');
    try {
        const res = await fetch('/api/drive/upload', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ filename })
        });
        const data = await res.json();
        if (data.success) {
            toast('تم الرفع لجوجل درايف بنجاح! ✅', 'ok');
        } else {
            if (data.needs_setup) {
                alert('تنبيه: ميزة جوجل درايف تتطلب إعداد ملف credentials.json في مجلد البرنامج. يرجى مراجعة التعليمات في الإعدادات.');
            }
            toast('فشل الرفع: ' + (data.error || 'خطأ غير معروف'), 'err');
        }
    } catch(e) { toast('خطأ في الاتصال بالسيرفر', 'err'); }
}

// ─── In-App Media Player ──────────────────────────
async function openTrimmer(filename) {
    const start = prompt('أدخل وقت البدء (صيغة 00:00:00):', '00:00:00');
    if (start === null) return;
    const end = prompt('أدخل وقت الانتهاء (أو اتركه فارغاً للنهاية):', '');
    if (end === null) return;
    
    toast('جاري قص الملف... يرجى الانتظار ⏳', 'info');
    try {
        const res = await fetch('/api/trim', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ filename, start, end })
        });
        const data = await res.json();
        if (data.success) {
            toast('تم القص بنجاح! الملف الجديد: ' + data.filename, 'ok');
            fetchHistory(); // Refresh history to show new file
        } else {
            toast('فشل القص: ' + data.error, 'err');
        }
    } catch(e) { toast('خطأ في العملية', 'err'); }
}

let dp = null; // DPlayer instance

function openPlayer(filename, title = '') {
    const modal = document.getElementById('playerModal');
    const container = document.getElementById('playerContainer');
    const meta = document.getElementById('playerMeta');
    
    modal.classList.add('open');
    meta.innerHTML = `<h3 style="margin-top:10px;">${escapeHtml(title || filename)}</h3>`;
    
    // Cleanup old player
    if (dp) {
        dp.destroy();
        dp = null;
    }
    
    container.innerHTML = `<div id="dplayer-el"></div>`;
    
    dp = new DPlayer({
        container: document.getElementById('dplayer-el'),
        autoplay: true,
        video: {
            url: `/api/stream/${encodeURIComponent(filename)}`,
            type: 'auto'
        },
        contextmenu: [
            {
                text: 'فتح في نافذة جديدة',
                link: `/api/stream/${encodeURIComponent(filename)}`
            }
        ]
    });
}

function closePlayerModal() {
    if (dp) {
        dp.pause();
        dp.destroy();
        dp = null;
    }
    document.getElementById('playerModal').classList.remove('open');
}

function exportHistoryCSV() {
    if (!S.history || !S.history.length) {
        return toast('السجل فارغ، لا يوجد ما يمكن تصديره', 'err');
    }

    // CSV Header (with BOM for UTF-8 Excel support)
    let csv = '\uFEFF';
    csv += 'العنوان,الرابط,المنصة,النوع,التاريخ\n';
    
    // Rows
    S.history.forEach(item => {
        const title = (item.title || item.url).replace(/"/g, '""'); // Escape quotes
        const url = item.url || '';
        const platform = item.platform_label || item.platform || '';
        const type = item.audio_only ? 'صوت' : 'فيديو';
        const date = item.completed_at ? new Date(item.completed_at).toLocaleString('en-US') : '';
        
        csv += `"${title}","${url}","${platform}","${type}","${date}"\n`;
    });

    try {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `video_downloads_history_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(url);
        a.remove();
        toast('تم تصدير السجل بنجاح 💾', 'ok');
    } catch (e) {
        toast('خطأ أثناء التصدير', 'err');
    }
}

function redownload(url) {
    $('#urlInput').value = url;
    updatePlatformUI(url);
    switchTab('download');
    fetchInfo();
}

async function clearHistory() {
    try {
        const res = await fetch('/api/history/clear', { method: 'POST' });
        const data = await res.json();
        toast(`تم مسح ${data.count} عنصر من السجل`, 'info');
        S.history = [];
        renderHistory();
    } catch { toast('فشل مسح السجل', 'err'); }
}

// ─── Helpers ────────────────────────────────────────
function fmtDur(s) {
    if (!s) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function fmtNum(n) {
    if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
    if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
    if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
    return String(n);
}
function fmtSize(b) {
    if (!b) return '';
    if (b >= 1e9) return (b/1e9).toFixed(1)+' GB';
    if (b >= 1e6) return (b/1e6).toFixed(1)+' MB';
    if (b >= 1e3) return (b/1e3).toFixed(0)+' KB';
    return b+' B';
}

// ─── Toast ──────────────────────────────────────────
function toast(msg, type = 'info') {
    const c = $('#toastBox');
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('toast--exit'); setTimeout(() => t.remove(), 250); }, 3500);
}

// ─── Queue Control ───────────────────────────────────
async function startQueue() {
    try {
        const res = await fetch('/api/queue/start', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل بدء القائمة');
        toast(`تم البدء: ${data.count} تحميل سينطلق الآن 🚀`, 'ok');
        fetchQueue();
    } catch (e) { toast(e.message, 'err'); }
}

async function setConcurrencyMode(mode) {
    try {
        const res = await fetch('/api/settings/concurrency', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'فشل تغيير وضع التحميل');
        toast(data.message, 'ok');
    } catch (e) { toast(e.message, 'err'); }
}

// ─── Settings & Preferences ─────────────────────
async function updateEngine() {
    const btn = $('#btnUpdateEngine');
    if (!btn) return;
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;margin-left:5px;vertical-align:middle;"></span> <span style="vertical-align:middle;">جاري التحديث...</span>';
    try {
        const res = await fetch('/api/update-engine', { method: 'POST' });
        const data = await res.json();
        if (res.ok) toast(data.message, 'ok');
        else toast(data.error || 'فشل التحديث', 'err');
    } catch (e) {
        toast('فشل الاتصال الخادم: ' + e.message, 'err');
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
    }
}

async function loadPrefs() {
    const theme = localStorage.getItem('vd_theme') || 'dark';
    const accent = localStorage.getItem('vd_accent') || 'purple';
    const naming = localStorage.getItem('vd_prefFileNaming') || 'default';
    const notifs = localStorage.getItem('vd_prefNotifications') === 'true';
    const clip = localStorage.getItem('vd_prefClipboard') === 'true';
    const aFmt = localStorage.getItem('vd_prefAudioFormat') || 'mp3';
    const vFmt = localStorage.getItem('vd_prefVideoFormat') || 'none';

    setTheme(theme);
    setAccent(accent);
    
    if ($('#prefFileNaming')) $('#prefFileNaming').value = naming;
    if ($('#prefNotifications')) $('#prefNotifications').checked = notifs;
    if ($('#prefClipboard')) $('#prefClipboard').checked = clip;
    if ($('#prefAudioFormat')) $('#prefAudioFormat').value = aFmt;
    if ($('#prefVideoFormat')) $('#prefVideoFormat').value = vFmt;

    // Load server-side settings (Multi-threading)
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.max_threads) {
            const slider = $('#maxThreads');
            const valLabel = $('#threadsVal');
            if (slider && valLabel) {
                slider.value = data.max_threads;
                valLabel.textContent = data.max_threads;
            }
        }
    } catch (e) { console.error('Failed to load server settings:', e); }
}

async function saveThreadSetting() {
    const slider = $('#maxThreads');
    const valLabel = $('#threadsVal');
    if (!slider || !valLabel) return;

    const val = parseInt(slider.value);
    valLabel.textContent = val;

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_threads: val })
        });
        const data = await res.json();
        if (res.ok) {
            toast(`تم رفع سرعة التحميل إلى ${val} مسار ⚡`, 'ok');
        } else {
            toast(data.error || 'فشل حفظ الإعدادات', 'err');
        }
    } catch (e) {
        toast('خطأ في الاتصال بالسيرفر', 'err');
    }
}

function savePrefs() {
    if ($('#prefFileNaming')) localStorage.setItem('vd_prefFileNaming', $('#prefFileNaming').value);
    if ($('#prefClipboard')) localStorage.setItem('vd_prefClipboard', $('#prefClipboard').checked);
    if ($('#prefAudioFormat')) localStorage.setItem('vd_prefAudioFormat', $('#prefAudioFormat').value);
    if ($('#prefVideoFormat')) localStorage.setItem('vd_prefVideoFormat', $('#prefVideoFormat').value);
    toast('تم حفظ الإعدادات ✅', 'ok');
}

function setTheme(t) {
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(`theme-${t}`);
    localStorage.setItem('vd_theme', t);
    
    $$('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
    
    // Refresh chart colors if rendered
    if (analyticsChart) renderAnalytics(S.history);
}

function setAccent(c) {
    ['purple', 'blue', 'green', 'red'].forEach(cls => document.body.classList.remove(`accent-${cls}`));
    document.body.classList.add(`accent-${c}`);
    localStorage.setItem('vd_accent', c);
    $$('.color-opt').forEach(b => {
        b.classList.toggle('active', b.classList.contains(`color-opt--${c}`));
    });
    
    // Refresh chart colors if rendered
    if (analyticsChart) renderAnalytics(S.history);
}

// ─── Desktop Notifications ──────────────────────────
async function toggleNotifications() {
    const chk = $('#prefNotifications');
    if (chk && chk.checked) {
        if (!("Notification" in window)) {
            toast('المتصفح لا يدعم إشعارات سطح المكتب', 'err');
            chk.checked = false;
            return;
        }
        if (Notification.permission !== "granted") {
            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
                toast('تم رفض إذن الإشعارات', 'err');
                chk.checked = false;
                return;
            }
        }
    }
    localStorage.setItem('vd_prefNotifications', chk ? chk.checked : false);
    savePrefs();
}

function showDesktopNotif(title, body) {
    if (localStorage.getItem('vd_prefNotifications') !== 'true') return;
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, icon: '/static/favicon.ico' });
    }
}

// ─── Re-download from URL ─────────────────────
function redownload(url) {
    if (!url) return;
    document.querySelector('#urlInput').value = url;
    switchTab('download');
    fetchInfo();
}

// ─── Trending Discovery ───────────────────────
async function saveToTrending(data) {
    if (!db || data.status !== 'completed') return;
    try {
        const docId = btoa(data.url || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 50);
        const ref = db.collection('trending').doc(docId);
        const doc = await ref.get();
        if (doc.exists) {
            await ref.update({ count: firebase.firestore.FieldValue.increment(1), last_downloaded: new Date().toISOString() });
        } else {
            await ref.set({
                title: data.title || '',
                url: data.url || '',
                thumbnail: data.thumbnail || '',
                platform: data.platform || detectPlatform(data.url || '') || '',
                platform_label: data.platform_label || '',
                duration: data.duration || 0,
                count: 1,
                last_downloaded: new Date().toISOString()
            });
        }
    } catch(err) { console.error('Failed to save trending', err); }
}

async function fetchTrending() {
    const c = $('#trendingList');
    if (!c) return;
    if (!db) {
        c.innerHTML = `<div class="empty"><div class="empty__ico">⚠️</div><div class="empty__title">يجب إعداد Firebase لعرض الشائع</div></div>`;
        return;
    }
    c.innerHTML = `<div class="empty"><div class="empty__ico"><span class="spinner" style="width:30px;height:30px;"></span></div><div class="empty__title">جاري التحميل...</div></div>`;
    try {
        const snap = await db.collection('trending').orderBy('count', 'desc').limit(20).get();
        if (snap.empty) {
            c.innerHTML = `<div class="empty"><div class="empty__ico">📈</div><div class="empty__title">لا توجد بيانات بعد</div><div class="empty__text">ابدأ بتحميل الفيديوهات وستظهر الأكثر شعبية هنا</div></div>`;
            return;
        }
        const pEmoji = { youtube: '▶️', instagram: '📷', tiktok: '🎵', facebook: '📘', twitter: '🐦' };
        c.innerHTML = snap.docs.map((doc, i) => {
            const d = doc.data();
            return `
            <div class="h-item" style="cursor:pointer;" onclick="document.querySelector('#urlInput').value='${escapeHtml(d.url)}';switchTab('download');fetchInfo();">
                <div class="h-item__thumb">
                    ${d.thumbnail ? `<img src="${escapeHtml(d.thumbnail)}" alt="">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.2rem">🎬</div>'}
                </div>
                <div class="h-item__info">
                    <div class="h-item__title">${escapeHtml(d.title || d.url)}</div>
                    <div class="h-item__meta">
                        <span>${pEmoji[d.platform] || '🔗'} ${escapeHtml(d.platform_label || d.platform || '')}</span>
                        <span>🔥 ${d.count} تحميل</span>
                        ${d.duration ? `<span>⏱️ ${fmtDur(d.duration)}</span>` : ''}
                    </div>
                </div>
                <div style="font-size:1.5rem;font-weight:800;color:var(--accent);padding:0 10px;">#${i+1}</div>
            </div>`;
        }).join('');
    } catch(err) {
        console.error('Trending fetch error', err);
        c.innerHTML = `<div class="empty"><div class="empty__ico">❌</div><div class="empty__title">خطأ في جلب البيانات</div></div>`;
    }
}

// ─── Cloud Collections ───────────────────────
function openNewCollectionModal() {
    if (!currentUser) return toast('سجل دخولك أولاً لإنشاء قوائم', 'err');
    const name = prompt('ادخل اسم القائمة الجديدة:');
    if (!name || !name.trim()) return;
    createCollection(name.trim());
}

async function createCollection(name) {
    if (!currentUser || !db) return;
    try {
        await db.collection('users').doc(currentUser.uid).collection('collections').add({
            name,
            created_at: new Date().toISOString(),
            items: [],
            is_public: false,
            share_code: null
        });
        toast(`تم إنشاء القائمة "${name}" بنجاح 📁`, 'ok');
        fetchCollections();
    } catch(err) {
        toast('خطأ في إنشاء القائمة', 'err');
    }
}

async function fetchCollections() {
    const c = $('#collectionsList');
    if (!c) return;
    if (!currentUser || !db) {
        c.innerHTML = `<div class="empty"><div class="empty__ico">👤</div><div class="empty__title">سجل دخولك لعرض قوائمك</div></div>`;
        return;
    }
    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('collections').orderBy('created_at', 'desc').get();
        if (snap.empty) {
            c.innerHTML = `<div class="empty"><div class="empty__ico">📂</div><div class="empty__title">لا توجد قوائم بعد</div><div class="empty__text">اضغط "➕ قائمة جديدة" لإنشاء أول قائمة</div></div>`;
            return;
        }
        c.innerHTML = snap.docs.map(doc => {
            const d = doc.data();
            const itemCount = (d.items || []).length;
            const isPublic = d.is_public || false;
            return `
            <div class="h-item" style="cursor:pointer;" onclick="viewCollection('${doc.id}')">
                <div class="h-item__thumb" style="display:flex;align-items:center;justify-content:center;font-size:2rem;background:var(--bg-glass);">📁</div>
                <div class="h-item__info">
                    <div class="h-item__title">${escapeHtml(d.name)}</div>
                    <div class="h-item__meta">
                        <span>🎬 ${itemCount} عنصر</span>
                        <span>📅 ${new Date(d.created_at).toLocaleDateString('ar-EG')}</span>
                        ${isPublic ? `
                            <span style="color:var(--accent); font-weight:bold;">🌐 عام (الرمز: ${d.share_code})</span>
                            <button class="btn btn--ghost btn--sm" style="padding:2px 6px; font-size:0.6rem; vertical-align:middle; margin-right:5px;" onclick="event.stopPropagation(); copyToClipboard('${d.share_code}')">📋 نسخ الرمز</button>
                        ` : '<span>🔒 خاصة</span>'}
                    </div>
                </div>
                <div class="h-item__btns">
                    <button class="btn btn--ghost btn--sm" onclick="event.stopPropagation();toggleCollectionShare('${doc.id}', ${!isPublic})" style="font-size:0.7rem;">
                        ${isPublic ? '🔒 اجعلها خاصة' : '🌐 اجعلها عامة'}
                    </button>
                    <button class="btn-icon" onclick="event.stopPropagation();deleteCollection('${doc.id}')" title="حذف">🗑️</button>
                </div>
            </div>`;
        }).join('');
    } catch(err) {
        console.error('Collections fetch error', err);
    }
}

async function viewCollection(colId) {
    if (!currentUser || !db) return;
    try {
        const doc = await db.collection('users').doc(currentUser.uid).collection('collections').doc(colId).get();
        if (!doc.exists) return toast('القائمة غير موجودة', 'err');
        const data = doc.data();
        const items = data.items || [];
        const c = $('#collectionsList');
        
        // Deep Sync: If list is public, ensure shared doc is updated
        if (data.is_public && data.share_code) {
            db.collection('shared_collections').doc(data.share_code).set({
                name: data.name,
                items: items,
                owner_id: currentUser.uid,
                last_sync: new Date().toISOString()
            }, { merge: true }).catch(e => console.error('Deep Sync Error', e));
        }

        if (!items.length) {
            c.innerHTML = `
                <div style="padding:15px">
                    <button class="btn btn--ghost btn--sm" onclick="fetchCollections()">⬅️ رجوع</button>
                    <h3 style="margin:15px 0">📁 ${escapeHtml(data.name)}</h3>
                    <div class="empty"><div class="empty__ico">📦</div><div class="empty__title">القائمة فارغة</div><div class="empty__text">أضف فيديوهات من السجل إلى هذه القائمة</div></div>
                </div>`;
            return;
        }
        const pEmoji = { youtube: '▶️', instagram: '📷', tiktok: '🎵', facebook: '📘', twitter: '🐦' };
        
        c.innerHTML = `
            <div style="padding:15px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px; flex-wrap:wrap; gap:10px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <button class="btn btn--ghost btn--sm" onclick="fetchCollections()">⬅️ رجوع</button>
                        <h3 style="margin:0">📁 ${escapeHtml(data.name)}</h3>
                    </div>
                    <div style="display:flex; gap:8px;">
                        ${data.is_public ? `<button class="btn btn--outline btn--sm" onclick="syncSharedCollection('${colId}', true)" title="نشر التعديلات فوراً للسحاب">🔄 تحديث السحاب</button>` : ''}
                        <button class="btn btn--success btn--sm" onclick="downloadAllFromList('${colId}', 'best')">📥 تحميل الكل (جودة عالية)</button>
                        <button class="btn btn--primary btn--sm" onclick="downloadSelectedFromList('${colId}')" id="btnDlSelected" disabled>📥 تحميل المختار</button>
                    </div>
                </div>

                <div style="background:var(--bg-glass); padding:10px; border-radius:10px; margin-bottom:15px; display:flex; justify-content:space-between; align-items:center;">
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.9rem;">
                        <input type="checkbox" id="selectAllItems" onchange="toggleSelectAllItems(this.checked)"> تحديد الكل
                    </label>
                    <div style="font-size:0.8rem; color:var(--text-secondary);">
                        الجودة الافتراضية للكل: 
                        <select id="globalListQuality" style="background:transparent; color:var(--accent); border:none; outline:none; cursor:pointer; font-weight:bold;">
                            <option value="best">أفضل جودة</option>
                            <option value="720">720p</option>
                            <option value="480">480p</option>
                            <option value="audio">صوت فقط (MP3)</option>
                        </select>
                    </div>
                </div>

                <div id="listItemsContainer">
                ${items.map((item, idx) => `
                    <div class="h-item" data-url="${escapeHtml(item.url)}" data-index="${idx}">
                        <div style="padding:0 10px;">
                            <input type="checkbox" class="list-item-check" data-index="${idx}" onchange="updateSelectedCount()">
                        </div>
                        <div class="h-item__thumb">
                            ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">🎬</div>'}
                        </div>
                        <div class="h-item__info">
                            <div class="h-item__title">${escapeHtml(item.title || item.url)}</div>
                            <div class="h-item__meta" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                                <span>${pEmoji[item.platform] || '🔗'} ${escapeHtml(item.platform || '')}</span>
                                <div style="display:flex; align-items:center; gap:5px;">
                                    <select class="item-quality-select" id="q_${colId}_${idx}" style="font-size:0.7rem; padding:2px; border-radius:4px; background:rgba(255,255,255,0.05); color:var(--text-secondary); border:1px solid rgba(255,255,255,0.1);">
                                        <option value="default">الجودة التلقائية</option>
                                        <option value="best">أفضل جودة</option>
                                        <option value="720">720p</option>
                                        <option value="480">480p</option>
                                        <option value="audio">صوت MP3</option>
                                    </select>
                                    <button class="btn btn--ghost btn--sm" style="padding:1px 4px; font-size:0.6rem;" onclick="fetchItemQualities('${colId}', ${idx}, '${escapeHtml(item.url)}')">🔍 جلب الخيارات</button>
                                </div>
                            </div>
                        </div>
                        <div class="h-item__btns">
                            <button class="btn-icon btn-icon--success" onclick="redownload('${escapeHtml(item.url)}')" title="تحميل سريع">⬇️</button>
                            <button class="btn-icon" onclick="removeFromCollection('${colId}',${idx})" title="إزالة">❌</button>
                        </div>
                    </div>
                `).join('')}
                </div>
            </div>`;
    } catch(err) {
        console.error('View col error', err);
    }
}

function toggleSelectAllItems(checked) {
    $$('.list-item-check').forEach(ck => ck.checked = checked);
    updateSelectedCount();
}

function updateSelectedCount() {
    const selected = $$('.list-item-check:checked').length;
    const btn = $('#btnDlSelected');
    if (btn) {
        btn.disabled = selected === 0;
        btn.textContent = selected > 0 ? `📥 تحميل المختار (${selected})` : '📥 تحميل المختار';
    }
}

async function downloadSelectedFromList(colId) {
    const checks = $$('.list-item-check:checked');
    if (!checks.length) return;
    
    // Get item indices to download
    const indices = Array.from(checks).map(ck => parseInt(ck.dataset.index));
    executeBatchDownload(colId, indices);
}

async function downloadAllFromList(colId, qualityOverride = null) {
    const container = $('#listItemsContainer');
    if (!container) return;
    const items = container.querySelectorAll('.h-item');
    const indices = Array.from(items).map((_, i) => i);
    executeBatchDownload(colId, indices, qualityOverride);
}

async function executeBatchDownload(colId, indices, qualityOverride = null) {
    if (!currentUser || !db) return;
    try {
        const doc = await db.collection('users').doc(currentUser.uid).collection('collections').doc(colId).get();
        const allItems = doc.data().items || [];
        const globalQuality = qualityOverride || $('#globalListQuality')?.value || 'best';
        
        toast(`جاري تحضير ${indices.length} فيديو للتحميل... 🚀`, 'ok');
        
        for (const idx of indices) {
            const item = allItems[idx];
            if (!item) continue;
            
            // Per-item quality (check the select element in the UI)
            const itemUI = $(`.h-item[data-index="${idx}"]`);
            let finalQuality = globalQuality;
            let audioOnly = globalQuality === 'audio';
            
            if (itemUI) {
                const itemQ = itemUI.querySelector('.item-quality-select').value;
                if (itemQ !== 'default') {
                    finalQuality = itemQ;
                    audioOnly = (itemQ === 'audio');
                }
            }
            
            await new Promise(r => setTimeout(r, 500));
            fetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    url: item.url, 
                    format_id: audioOnly ? 'best' : finalQuality,
                    audio_only: audioOnly 
                })
            });
        }
        
        switchTab('queue');
    } catch(err) {
        toast('خطأ في معالجة القائمة', 'err');
    }
}

async function showAddToListMenu(itemId) {
    if (!currentUser || !db) return;
    const historyItem = S.history.find(h => h.id == itemId);
    if (!historyItem) return;

    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('collections').get();
        if (snap.empty) return toast('ليس لديك قوائم بعد. أنشئ قائمة أولاً من تبويب "قائمتي"', 'info');
        
        let html = '<div style="padding:20px; text-align:center;">';
        html += '<h3 style="margin-bottom:15px;">اختر القائمة للإضافة:</h3>';
        html += '<div style="display:flex; flex-direction:column; gap:10px;">';
        snap.forEach(doc => {
            html += `<button class="btn btn--ghost" onclick="addToCollection('${doc.id}', ${JSON.stringify(historyItem).replace(/"/g, '&quot;')}); closePlayerModal();">${escapeHtml(doc.data().name)}</button>`;
        });
        html += '</div></div>';
        
        const modal = $('#playerModal');
        const container = $('#playerContainer');
        container.innerHTML = html;
        modal.classList.add('open');
    } catch(err) {
        toast('خطأ في جلب القوائم', 'err');
    }
}

async function syncSharedCollection(colId, manual = false) {
    if (!currentUser || !db) return;
    try {
        const ref = db.collection('users').doc(currentUser.uid).collection('collections').doc(colId);
        const snap = await ref.get();
        if (!snap.exists) return;
        const data = snap.data();
        
        if (data.is_public && data.share_code) {
            console.log('Force Syncing to Cloud...', data.share_code);
            // Full overwrite to ensure it's NOT empty
            await db.collection('shared_collections').doc(data.share_code).set({
                name: data.name,
                items: data.items || [],
                owner_id: currentUser.uid,
                last_sync: new Date().toISOString()
            });
            console.log('Cloud Sync Success ✅');
            if (manual) toast('🚀 تم نشر التحديثات للسحاب بنجاح!', 'ok');
        }
    } catch(e) { 
        console.error('CRITICAL SYNC ERROR:', e); 
        if (manual) toast('فشل في الوصول للسحاب: ' + (e.message || 'خطأ غير معروف'), 'err');
    }
}

async function addToCollection(colId, itemData) {
    if (!currentUser || !db) return;
    try {
        const ref = db.collection('users').doc(currentUser.uid).collection('collections').doc(colId);
        await ref.update({
            items: firebase.firestore.FieldValue.arrayUnion(itemData)
        });
        
        await syncSharedCollection(colId);
        toast('تمت الإضافة للقائمة بنجاح ✨', 'ok');
    } catch(err) {
        toast('خطأ في إضافة العنصر', 'err');
    }
}

async function removeFromCollection(colId, idx) {
    if (!currentUser || !db) return;
    try {
        const ref = db.collection('users').doc(currentUser.uid).collection('collections').doc(colId);
        const doc = await ref.get();
        const items = doc.data().items || [];
        items.splice(idx, 1);
        await ref.update({ items });
        await syncSharedCollection(colId);
        
        toast('تمت إزالة العنصر', 'info');
        viewCollection(colId);
    } catch(err) {
        toast('خطأ', 'err');
    }
}

async function deleteCollection(colId) {
    if (!confirm('هل تريد حذف هذه القائمة نهائياً؟')) return;
    if (!currentUser || !db) return;
    try {
        const ref = db.collection('users').doc(currentUser.uid).collection('collections').doc(colId);
        const d = (await ref.get()).data();
        if (d.share_code) await db.collection('shared_collections').doc(d.share_code).delete();
        await ref.delete();
        toast('تم حذف القائمة', 'info');
        fetchCollections();
    } catch(err) {
        toast('خطأ في حذف القائمة', 'err');
    }
}

async function toggleCollectionShare(colId, isPublic) {
    if (!currentUser || !db) return;
    try {
        const ref = db.collection('users').doc(currentUser.uid).collection('collections').doc(colId);
        const snap = await ref.get();
        const data = snap.data();
        
        if (isPublic) {
             const code = Math.random().toString(36).substring(2, 8).toUpperCase();
             await db.collection('shared_collections').doc(code).set({
                 name: data.name,
                 items: data.items,
                 owner_id: currentUser.uid,
                 created_at: new Date().toISOString()
             });
             await ref.update({ is_public: true, share_code: code });
             toast(`القائمة الآن عامة! الرمز: ${code} 🌐`, 'ok');
        } else {
             if (data.share_code) await db.collection('shared_collections').doc(data.share_code).delete();
             await ref.update({ is_public: false, share_code: null });
             toast('القائمة الآن خاصة 🔒', 'info');
        }
        fetchCollections();
    } catch(err) {
        console.error('Share Toggle Error:', err);
        toast('خطأ في إعدادات المشاركة: ' + (err.message || 'خطأ غير معروف'), 'err');
    }
}

async function fetchItemQualities(colId, idx, url) {
    const select = document.getElementById(`q_${colId}_${idx}`);
    if (!select) return;
    
    const originalHtml = select.innerHTML;
    select.innerHTML = '<option>جاري الجلب...</option>';
    
    try {
        const res = await fetch('/api/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (res.ok && data.formats) {
            select.innerHTML = '<option value="default">الجودة التلقائية</option>';
            data.formats.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.format_id;
                const size = f.filesize ? (f.filesize/1024/1024).toFixed(1)+'MB' : '';
                opt.textContent = `${f.label || f.format_id} (${f.ext}) ${size}`;
                select.appendChild(opt);
            });
            toast('تم جلب الجودات المتاحة لهذا الفيديو ✅', 'ok');
        } else {
            throw new Error('لم يتم العثور على جودات');
        }
    } catch(err) {
        select.innerHTML = originalHtml;
        toast('تعذر جلب خيارات الجودة', 'err');
    }
}

async function loadSharedCollection() {
    const code = $('#shareCodeInput').value.trim().toUpperCase();
    if (!code) return toast('يرجى إدخال رمز صحيح', 'err');
    if (!db) return;
    
    // Clear old unsubs if any
    if (window._sharedUnsub) { window._sharedUnsub(); window._sharedUnsub = null; }

    toast('جاري جلب القائمة المشتركة... ⏳', 'info');
    
    window._sharedUnsub = db.collection('shared_collections').doc(code).onSnapshot(doc => {
        if (!doc.exists) return toast('هذا الرمز غير موجود أو انتهت صلاحيته', 'err');
        
        const data = doc.data();
        const items = data.items || [];
        const c = $('#collectionsList');
        const pEmoji = { youtube: '▶️', instagram: '📷', tiktok: '🎵', facebook: '📘', twitter: '🐦' };
        
        c.innerHTML = `
            <div style="padding:15px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;">
                    <button class="btn btn--ghost btn--sm" onclick="if(window._sharedUnsub)window._sharedUnsub(); fetchCollections()">⬅️ رجوع</button>
                    <h3 style="color:var(--accent);">🌐 قائمة عامة: ${escapeHtml(data.name)}</h3>
                </div>
                <div style="margin-bottom:20px; padding:10px; background:var(--bg-glass); border-radius:8px; border:1px solid var(--accent); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-weight:bold;">${escapeHtml(data.name)}</span>
                        <span style="font-size:0.75rem;">تحتوي على ${items.length} فيديوهات (تحديث مباشر ⚡)</span>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button class="btn btn--outline btn--sm" onclick="forceRefreshSharedView('${code}')">🔄 تحديث البيانات</button>
                        <button class="btn btn--success btn--sm" onclick="importCollection('${code}')">📥 حفظ في قوائمي</button>
                    </div>
                </div>
                ${items.length === 0 ? '<div class="empty">القائمة فارغة حالياً</div>' : items.map((item) => `
                    <div class="h-item">
                        <div class="h-item__thumb">
                             ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">🎬</div>'}
                        </div>
                        <div class="h-item__info">
                             <div class="h-item__title">${escapeHtml(item.title || item.url)}</div>
                             <div class="h-item__meta"><span>${pEmoji[item.platform] || '🔗'} ${escapeHtml(item.platform || '')}</span></div>
                        </div>
                        <div class="h-item__btns">
                             <button class="btn-icon btn-icon--accent" onclick="redownload('${escapeHtml(item.url)}')" title="تحميل">⬇️</button>
                        </div>
                    </div>
                `).join('')}
            </div>`;
        $('#shareCodeInput').value = '';
    }, err => {
        console.error('Shared collection error', err);
        toast('خطأ في جلب القائمة المشتركة: ' + err.message, 'err');
    });
}

async function forceRefreshSharedView(code) {
    if (!db) return;
    try {
        toast('جاري تنشيط البيانات من السحاب... 🔎', 'info');
        const doc = await db.collection('shared_collections').doc(code).get({ source: 'server' });
        if (doc.exists) {
            toast('تم تحديث البيانات بنجاح ⚡', 'ok');
            // Re-trigger load shared UI will happen via current listener or just manually if needed
        }
    } catch(e) { toast('خطأ في التنسيق', 'err'); }
}

async function importCollection(code) {
    if (!currentUser) return toast('سجل دخولك لحفظ القائمة', 'err');
    try {
        const doc = await db.collection('shared_collections').doc(code).get();
        const data = doc.data();
        await db.collection('users').doc(currentUser.uid).collection('collections').add({
            name: `${data.name} (نسخة)`,
            created_at: new Date().toISOString(),
            items: data.items,
            is_public: false,
            share_code: null
        });
        toast('تم حفظ القائمة في قوائمك بنجاح! ✅', 'ok');
        fetchCollections();
    } catch(err) {
        toast('خطأ في استيراد القائمة', 'err');
    }
}

// ─── Auto-Subscribe ────────────────────────
async function addAutoSub() {
    if (!currentUser || !db) return toast('سجل دخولك أولاً', 'err');
    const url = $('#autoSubUrl')?.value.trim();
    if (!url || !url.startsWith('http')) return toast('ادخل رابطاً صحيحاً', 'err');
    try {
        await db.collection('users').doc(currentUser.uid).collection('subscriptions').add({
            url,
            platform: detectPlatform(url) || 'unknown',
            added_at: new Date().toISOString(),
            last_checked: null
        });
        toast('تم الاشتراك! سيتم فحص القناة تلقائياً 🔔', 'ok');
        $('#autoSubUrl').value = '';
        loadAutoSubs();
    } catch(err) {
        toast('خطأ في إضافة الاشتراك', 'err');
    }
}

async function loadAutoSubs() {
    const c = $('#autoSubList');
    if (!c || !currentUser || !db) return;
    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('subscriptions').orderBy('added_at', 'desc').get();
        if (snap.empty) {
            c.innerHTML = '<div style="font-size:0.8rem;color:var(--text-secondary);">لا توجد اشتراكات بعد</div>';
            return;
        }
        const pEmoji = { youtube: '▶️', tiktok: '🎵', instagram: '📷' };
        c.innerHTML = snap.docs.map(doc => {
            const d = doc.data();
            return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--bg-glass);border-radius:8px;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:8px;font-size:0.85rem;overflow:hidden;">
                    <span>${pEmoji[d.platform] || '🔗'}</span>
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px;">${escapeHtml(d.url)}</span>
                </div>
                <button class="btn-icon" onclick="removeAutoSub('${doc.id}')" title="إلغاء">❌</button>
            </div>`;
        }).join('');
    } catch(err) {
        console.error('Load subs error', err);
    }
}

async function removeAutoSub(docId) {
    if (!currentUser || !db) return;
    try {
        await db.collection('users').doc(currentUser.uid).collection('subscriptions').doc(docId).delete();
        toast('تم إلغاء الاشتراك', 'info');
        loadAutoSubs();
    } catch(err) {
        toast('خطأ', 'err');
    }
}


// ─── Auto-Checker System ───────────────────
let subCheckInterval = null;

async function checkSubscriptions() {
    if (!currentUser || !db) return;
    if (localStorage.getItem('vd_prefAutoDownloader') !== 'true') return;

    try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('subscriptions').get();
        for (const doc of snap.docs) {
            const sub = doc.data();
            const now = new Date();
            const lastChecked = sub.last_checked ? new Date(sub.last_checked) : new Date(0);
            
            // Check every 2 hours
            if (now - lastChecked > 2 * 60 * 60 * 1000) {
                console.log('Checking sub:', sub.url);
                const info = await fetch('/api/info', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: sub.url })
                }).then(r => r.json());
                
                if (info && !info.error) {
                    // If it's a playlist/channel, we check the first entry
                    const targetUrl = info.is_playlist ? info.entries[0]?.url : sub.url;
                    if (targetUrl) {
                        await fetch('/api/download', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: targetUrl, format_id: 'best', audio_only: false, enqueue_only: false })
                        });
                    }
                }
                
                await db.collection('users').doc(currentUser.uid).collection('subscriptions').doc(doc.id).update({
                    last_checked: now.toISOString()
                });
            }
        }
    } catch(err) { console.error('Auto-Sub check failed', err); }
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
        } else {
            const el = document.createElement('textarea');
            el.value = text;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
        }
        toast('تم نسخ الرابط بنجاح! 🔗', 'ok');
    } catch (err) {
        toast('تعذر نسخ الرابط', 'err');
    }
}

// ─── Keyboard ───────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (S.tab === 'search' && document.activeElement.id === 'searchInput') doSearch();
        else if (S.tab === 'download' && document.activeElement.id === 'urlInput') fetchInfo();
    }
    if (e.key === 'Escape') closeBatchModal();
});

// ─── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadPrefs();
    initSocket();
    initDragDrop();
    fetchQueue();
    $$('.nav__tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    
    // Check for "Add to List" request from extension or search
    const params = new URLSearchParams(window.location.search);
    const addUrl = params.get('add_url');
    const addTitle = params.get('add_title');
    
    if (addUrl) {
        const checkAuth = setInterval(() => {
            if (currentUser && db) {
                clearInterval(checkAuth);
                showAddToListMenuDirect({
                    url: addUrl,
                    title: addTitle || 'فيديو من الإضافة',
                    thumbnail: '',
                    platform: 'youtube'
                });
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }, 1000);
        setTimeout(() => clearInterval(checkAuth), 10000);
    }

    const searchInp = $('#historySearch');
    if (searchInp) {
        searchInp.addEventListener('input', () => {
            renderHistory();
        });
    }

    // Start Auto-Checker
    setTimeout(checkSubscriptions, 5000); // 5s after load
    subCheckInterval = setInterval(checkSubscriptions, 15 * 60 * 1000); // every 15 mins
});

// ─── PWA Service Worker ──────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/static/sw.js')
            .then(reg => console.log('Service Worker registered!'))
            .catch(err => console.log('SW registration failed:', err));
    });
}

// ─── PWA Install Banner ──────────────────────────────
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Show install banner
    let banner = document.getElementById('pwaBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'pwaBanner';
        banner.className = 'pwa-banner';
        banner.textContent = '📲 تثبيت التطبيق على جهازك';
        banner.onclick = () => {
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then(r => {
                if (r.outcome === 'accepted') toast('تم تثبيت التطبيق! 🎉', 'ok');
                banner.style.display = 'none';
                deferredPrompt = null;
            });
        };
        document.body.appendChild(banner);
    }
    banner.style.display = 'block';
});

// ════════════════════════════════════════════════════════════
// ─── Phase 2: Enhanced Player Controls ─────────────────────
// ════════════════════════════════════════════════════════════

function playerSkip(seconds) {
    const vid = document.querySelector('#playerContainer video');
    if (vid) vid.currentTime = Math.max(0, vid.currentTime + seconds);
}

// Speed control buttons
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pc-speed');
    if (!btn) return;
    const speed = parseFloat(btn.dataset.speed);
    const vid = document.querySelector('#playerContainer video');
    if (vid) vid.playbackRate = speed;
    document.querySelectorAll('.pc-speed').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
});

function captureScreenshot() {
    const vid = document.querySelector('#playerContainer video');
    if (!vid) return toast('لا يوجد فيديو قيد التشغيل', 'err');
    const canvas = document.createElement('canvas');
    canvas.width = vid.videoWidth;
    canvas.height = vid.videoHeight;
    canvas.getContext('2d').drawImage(vid, 0, 0);
    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `screenshot_${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
        toast('📸 تم حفظ لقطة الشاشة!', 'ok');
    });
}

// ════════════════════════════════════════════════════════════
// ─── Phase 2: Visual Trimmer ───────────────────────────────
// ════════════════════════════════════════════════════════════

let trimState = { start: 0, end: 1, duration: 0, dragging: null };

function openVisualTrimmer() {
    const vid = document.querySelector('#playerContainer video');
    if (!vid || !vid.duration) return toast('شغّل فيديو أولاً', 'err');
    trimState.duration = vid.duration;
    trimState.start = 0;
    trimState.end = 1;
    updateTrimmerUI();
    document.getElementById('trimmerPanel').style.display = 'block';
    
    // Setup drag handlers
    const track = document.getElementById('trimmerTrack');
    const startH = document.getElementById('trimHandleStart');
    const endH = document.getElementById('trimHandleEnd');
    
    const onMove = (e) => {
        if (!trimState.dragging) return;
        const rect = track.getBoundingClientRect();
        let pct = (e.clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        if (trimState.dragging === 'start') {
            trimState.start = Math.min(pct, trimState.end - 0.02);
        } else {
            trimState.end = Math.max(pct, trimState.start + 0.02);
        }
        updateTrimmerUI();
    };
    
    const onUp = () => { trimState.dragging = null; };
    
    startH.onmousedown = (e) => { e.preventDefault(); trimState.dragging = 'start'; };
    endH.onmousedown = (e) => { e.preventDefault(); trimState.dragging = 'end'; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    
    // Touch support
    startH.ontouchstart = (e) => { e.preventDefault(); trimState.dragging = 'start'; };
    endH.ontouchstart = (e) => { e.preventDefault(); trimState.dragging = 'end'; };
    document.addEventListener('touchmove', (e) => {
        if (!trimState.dragging) return;
        onMove({ clientX: e.touches[0].clientX });
    });
    document.addEventListener('touchend', onUp);
}

function closeTrimmer() {
    document.getElementById('trimmerPanel').style.display = 'none';
}

function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function updateTrimmerUI() {
    const sel = document.getElementById('trimmerSelected');
    const startH = document.getElementById('trimHandleStart');
    const endH = document.getElementById('trimHandleEnd');
    
    sel.style.left = (trimState.start * 100) + '%';
    sel.style.width = ((trimState.end - trimState.start) * 100) + '%';
    startH.style.left = (trimState.start * 100) + '%';
    endH.style.left = (trimState.end * 100 - 2) + '%';
    
    const startSec = trimState.start * trimState.duration;
    const endSec = trimState.end * trimState.duration;
    document.getElementById('trimStartTime').textContent = formatTime(startSec);
    document.getElementById('trimEndTime').textContent = formatTime(endSec);
    document.getElementById('trimDuration').textContent = formatTime(endSec - startSec);
    
    // Sync video position to trim start for preview
    const vid = document.querySelector('#playerContainer video');
    if (vid && trimState.dragging === 'start') vid.currentTime = startSec;
}

async function executeTrimFromVisual() {
    const startSec = Math.floor(trimState.start * trimState.duration);
    const endSec = Math.floor(trimState.end * trimState.duration);
    
    if (!S.currentPlayingFile) return toast('لا يوجد ملف للقص', 'err');
    
    toast('✂️ جاري قص الفيديو...', 'info');
    try {
        const res = await fetch('/api/trim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: S.currentPlayingFile, start: startSec, end: endSec })
        });
        const data = await res.json();
        if (data.success) {
            toast(`✅ تم القص بنجاح: ${data.output}`, 'ok');
            closeTrimmer();
        } else {
            toast(`❌ خطأ في القص: ${data.error}`, 'err');
        }
    } catch (e) {
        toast('❌ خطأ في الاتصال بالخادم', 'err');
    }
}


// ════════════════════════════════════════════════════════════
// ─── Phase 3: Stealth Mode ─────────────────────────────────
// ════════════════════════════════════════════════════════════

function toggleStealth() {
    const on = document.getElementById('prefStealth').checked;
    document.getElementById('stealthControls').style.display = on ? 'block' : 'none';
    if (!on) applyRateLimit(false);
}

async function applyRateLimit(enabled = true) {
    const limit = document.getElementById('rateLimitSlider')?.value || 500;
    try {
        const res = await fetch('/api/settings/rate-limit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, limit })
        });
        const data = await res.json();
        toast(data.message, 'ok');
    } catch { toast('خطأ في حفظ الإعداد', 'err'); }
}


// ════════════════════════════════════════════════════════════
// ─── Phase 3: Auto-Categorize ──────────────────────────────
// ════════════════════════════════════════════════════════════

function toggleAutoCategorize() {
    const on = document.getElementById('prefAutoCat').checked;
    document.getElementById('autoCatControls').style.display = on ? 'block' : 'none';
    applyAutoCategorize();
}

async function applyAutoCategorize() {
    const enabled = document.getElementById('prefAutoCat').checked;
    const mode = document.getElementById('autoCatMode')?.value || 'platform';
    try {
        const res = await fetch('/api/settings/auto-categorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, mode })
        });
        const data = await res.json();
        if (enabled) toast(data.message, 'ok');
    } catch { toast('خطأ في حفظ الإعداد', 'err'); }
}


// ════════════════════════════════════════════════════════════
// ─── Phase 5: Notification Settings ────────────────────────
// ════════════════════════════════════════════════════════════

function updateNotifStatusBadges() {
    const tToken = document.getElementById('telegramBotToken')?.value || '';
    const tChat = document.getElementById('telegramChatId')?.value || '';
    const dWebhook = document.getElementById('discordWebhook')?.value || '';
    
    const tgStatus = document.getElementById('telegramStatus');
    const dcStatus = document.getElementById('discordStatus');
    
    if (tgStatus) {
        if (tToken && tChat) {
            tgStatus.textContent = '✅ مُعد';
            tgStatus.style.background = 'rgba(0,208,132,0.15)';
            tgStatus.style.color = '#00d084';
        } else {
            tgStatus.textContent = 'غير مُعد';
            tgStatus.style.background = 'rgba(255,255,255,0.05)';
            tgStatus.style.color = 'var(--text-secondary)';
        }
    }
    if (dcStatus) {
        if (dWebhook) {
            dcStatus.textContent = '✅ مُعد';
            dcStatus.style.background = 'rgba(0,208,132,0.15)';
            dcStatus.style.color = '#00d084';
        } else {
            dcStatus.textContent = 'غير مُعد';
            dcStatus.style.background = 'rgba(255,255,255,0.05)';
            dcStatus.style.color = 'var(--text-secondary)';
        }
    }
}

async function saveNotificationSettings() {
    const telegram_token = document.getElementById('telegramBotToken')?.value || '';
    const telegram_chat_id = document.getElementById('telegramChatId')?.value || '';
    const discord_webhook = document.getElementById('discordWebhook')?.value || '';
    
    // Save locally
    localStorage.setItem('vd_telegramToken', telegram_token);
    localStorage.setItem('vd_telegramChatId', telegram_chat_id);
    localStorage.setItem('vd_discordWebhook', discord_webhook);
    
    const btn = document.getElementById('btnSaveNotif');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري الحفظ...'; }
    
    try {
        const res = await fetch('/api/settings/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegram_token, telegram_chat_id, discord_webhook })
        });
        const data = await res.json();
        toast(data.message || 'تم حفظ الإعدادات ✅', 'ok');
        updateNotifStatusBadges();
    } catch { toast('خطأ في حفظ الإعدادات', 'err'); }
    
    if (btn) { btn.disabled = false; btn.textContent = '💾 حفظ الإعدادات'; }
}

async function testNotificationSettings() {
    const telegram_token = document.getElementById('telegramBotToken')?.value || '';
    const telegram_chat_id = document.getElementById('telegramChatId')?.value || '';
    const discord_webhook = document.getElementById('discordWebhook')?.value || '';
    
    if (!telegram_token && !discord_webhook) {
        toast('أدخل بيانات Telegram أو Discord أولاً', 'err');
        return;
    }
    
    // Save first before testing
    localStorage.setItem('vd_telegramToken', telegram_token);
    localStorage.setItem('vd_telegramChatId', telegram_chat_id);
    localStorage.setItem('vd_discordWebhook', discord_webhook);
    
    const btn = document.getElementById('btnTestNotif');
    const resultDiv = document.getElementById('notifTestResult');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري الاختبار...'; }
    if (resultDiv) { resultDiv.style.display = 'none'; }
    
    try {
        // Save to server first
        await fetch('/api/settings/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegram_token, telegram_chat_id, discord_webhook })
        });
        
        // Then test
        const res = await fetch('/api/settings/notifications/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        
        let html = '';
        let hasSuccess = false;
        let hasError = false;
        
        // Telegram result
        if (data.telegram) {
            if (data.telegram.success) {
                hasSuccess = true;
                html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                    <span style="font-size:1.2rem;">✅</span>
                    <div>
                        <div style="font-weight:600; color:#00d084;">Telegram متصل بنجاح!</div>
                        <div style="font-size:0.78rem; color:var(--text-secondary);">البوت: ${data.telegram.bot_name || ''} ${data.telegram.bot_username ? '(@' + data.telegram.bot_username + ')' : ''}</div>
                    </div>
                </div>`;
                
                // Update status badge
                const tgStatus = document.getElementById('telegramStatus');
                if (tgStatus) {
                    tgStatus.textContent = '🟢 متصل';
                    tgStatus.style.background = 'rgba(0,208,132,0.15)';
                    tgStatus.style.color = '#00d084';
                }
            } else if (data.telegram.error !== 'لم يتم إدخال بيانات Telegram') {
                hasError = true;
                html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                    <span style="font-size:1.2rem;">❌</span>
                    <div>
                        <div style="font-weight:600; color:#ff4444;">Telegram فشل الاتصال</div>
                        <div style="font-size:0.78rem; color:var(--text-secondary);">${data.telegram.error}</div>
                    </div>
                </div>`;
            }
        }
        
        // Discord result
        if (data.discord) {
            if (data.discord.success) {
                hasSuccess = true;
                html += `<div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:1.2rem;">✅</span>
                    <div style="font-weight:600; color:#00d084;">Discord متصل بنجاح!</div>
                </div>`;
                
                const dcStatus = document.getElementById('discordStatus');
                if (dcStatus) {
                    dcStatus.textContent = '🟢 متصل';
                    dcStatus.style.background = 'rgba(0,208,132,0.15)';
                    dcStatus.style.color = '#00d084';
                }
            } else if (data.discord.error !== 'لم يتم إدخال Discord Webhook') {
                hasError = true;
                html += `<div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:1.2rem;">❌</span>
                    <div>
                        <div style="font-weight:600; color:#ff4444;">Discord فشل الاتصال</div>
                        <div style="font-size:0.78rem; color:var(--text-secondary);">${data.discord.error}</div>
                    </div>
                </div>`;
            }
        }
        
        if (resultDiv && html) {
            resultDiv.innerHTML = html;
            resultDiv.style.display = 'block';
            if (hasSuccess && !hasError) {
                resultDiv.style.background = 'rgba(0,208,132,0.08)';
                resultDiv.style.border = '1px solid rgba(0,208,132,0.2)';
                toast('تم إرسال رسالة تجريبية بنجاح! افحص التلقرام 📩', 'ok');
            } else if (hasError) {
                resultDiv.style.background = 'rgba(255,68,68,0.08)';
                resultDiv.style.border = '1px solid rgba(255,68,68,0.2)';
                toast('فشل في اختبار الإشعارات — تحقق من البيانات', 'err');
            }
        } else if (!html) {
            toast('لم يتم إدخال أي بيانات للاختبار', 'info');
        }
    } catch { toast('خطأ في الاتصال بالخادم', 'err'); }
    
    if (btn) { btn.disabled = false; btn.textContent = '🧪 اختبار'; }
}

// ─── Restore notification settings on page load ─────────────
document.addEventListener('DOMContentLoaded', () => {
    const tToken = localStorage.getItem('vd_telegramToken');
    const tChat = localStorage.getItem('vd_telegramChatId');
    const dWebhook = localStorage.getItem('vd_discordWebhook');
    if (tToken) { const el = document.getElementById('telegramBotToken'); if (el) el.value = tToken; }
    if (tChat) { const el = document.getElementById('telegramChatId'); if (el) el.value = tChat; }
    if (dWebhook) { const el = document.getElementById('discordWebhook'); if (el) el.value = dWebhook; }
    
    // Send saved settings to server
    if (tToken || dWebhook) {
        fetch('/api/settings/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegram_token: tToken||'', telegram_chat_id: tChat||'', discord_webhook: dWebhook||'' })
        }).catch(() => {});
    }
    
    // Update status badges
    setTimeout(updateNotifStatusBadges, 500);
    
    // Listen for changes to update badges live
    ['telegramBotToken', 'telegramChatId', 'discordWebhook'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateNotifStatusBadges);
    });
});

