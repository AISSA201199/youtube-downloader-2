/**
 * Content Script for Legendary Downloader
 * Enhanced with YouTube Quality Selection - Fixed Filtering Logic
 */

function injectYoutubeButton() {
    const actionBar = document.querySelector('#top-level-buttons-computed');
    if (!actionBar || document.getElementById('legendary-yt-btn')) return;

    console.log("Legendary: Injecting YouTube Button...");

    // Create Button
    const btn = document.createElement('button');
    btn.id = 'legendary-yt-btn';
    btn.className = 'yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m yt-spec-button-shape-next--icon-leading';
    btn.style.marginRight = '8px';
    btn.innerHTML = `
        <div class="yt-spec-button-shape-next__icon" style="width:24px;height:24px;fill:currentColor">
            <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" style="pointer-events: none; display: block; width: 100%; height: 100%;">
                <g><path d="M17 18v1H6v-1h11zm-5.5-11.6l4.7 4.7-.7.7-3.5-3.5V17h-1V8.3L7.5 11.8l-.7-.7 4.7-4.7z"></path></g>
            </svg>
        </div>
        <div class="yt-spec-button-shape-next__button-text-content">تحميل</div>
    `;

    // Create Menu
    let menu = document.getElementById('legendary-quality-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'legendary-quality-menu';
        menu.className = 'legendary-quality-menu';
        document.body.appendChild(menu);
    }

    btn.onclick = (e) => {
        e.stopPropagation();
        if (menu.classList.contains('show')) {
            menu.classList.remove('show');
            return;
        }

        const rect = btn.getBoundingClientRect();
        menu.style.top = `${rect.top + window.scrollY - 10}px`;
        menu.style.left = `${rect.left + window.scrollX}px`;
        menu.style.transform = 'translateY(-100%)';

        if (menu.innerHTML === "" || menu.dataset.url !== window.location.href) {
            menu.dataset.url = window.location.href;
            fetchQualities(menu, btn);
        } else {
            menu.classList.add('show');
        }
    };

    actionBar.insertBefore(btn, actionBar.firstChild);
}

async function fetchQualities(menu, btn) {
    const textNode = btn.querySelector('.yt-spec-button-shape-next__button-text-content');
    const originalText = textNode.innerText;
    
    textNode.innerHTML = '<span class="legendary-spinner"></span> جاري الجلب...';
    
    try {
        const response = await fetch("http://localhost:5000/api/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: window.location.href })
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        const formats = data.formats || [];
        const uniqueQualities = [];
        const seen = new Set();
        
        // Show all video formats returned by the backend
        formats.forEach(f => {
            const q = f.label; 
            if (q && !f.audio_only && !seen.has(q)) {
                uniqueQualities.push({ id: f.format_id, label: q, size: f.filesize });
                seen.add(q);
            }
        });

        // Add MP3 option at the end
        uniqueQualities.push({ id: 'bestaudio', label: 'صوت فقط (MP3)', size: null });

        menu.innerHTML = uniqueQualities.map(q => `
            <div class="legendary-quality-item" data-id="${q.id}">
                <span class="label">${q.label}</span>
                <span class="size">${q.size ? formatBytes(q.size) : ''}</span>
            </div>
        `).join('');

        menu.querySelectorAll('.legendary-quality-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                startDownload(item.dataset.id, item.querySelector('.label').innerText);
                menu.classList.remove('show');
            };
        });

        menu.classList.add('show');
        textNode.innerText = originalText;

    } catch (err) {
        console.error("Legendary: Fetch Error:", err);
        textNode.innerText = "خطأ! ❌";
        setTimeout(() => textNode.innerText = originalText, 3000);
    }
}

function startDownload(formatId, qualityLabel) {
    chrome.runtime.sendMessage({
        action: "download",
        data: { 
            url: window.location.href,
            format_id: formatId,
            quality: qualityLabel
        }
    });
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

document.addEventListener('click', () => {
    const menu = document.getElementById('legendary-quality-menu');
    if (menu) menu.classList.remove('show');
});

const observer = new MutationObserver(() => injectYoutubeButton());
observer.observe(document.body, { childList: true, subtree: true });
injectYoutubeButton();
