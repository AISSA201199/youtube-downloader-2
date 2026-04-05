/**
 * Popup Script for Legendary DL GOLD
 * Arabic Version + Improved Robustness
 */

document.addEventListener('DOMContentLoaded', async () => {
    const tabs = {
        page: document.getElementById('tabPage'),
        streams: document.getElementById('tabStreams')
    };

    const buttons = {
        current: document.getElementById('btnCurrent'),
        streams: document.getElementById('btnStreams'),
        download: document.getElementById('downloadCurrent'),
        audio: document.getElementById('downloadAudio'),
        batch: document.getElementById('downloadBatch')
    };

    const statusBadge = document.getElementById('statusCircle');
    const statusText = document.getElementById('statusText');
    const pageTitle = document.getElementById('pageTitle');
    const scrapeCount = document.getElementById('scrapeCount');
    const streamList = document.getElementById('streamList');

    // 1. Check Server Status
    try {
        const response = await fetch("http://localhost:5000/api/stats");
        if (response.ok) {
            statusBadge.style.backgroundColor = "#22c55e";
            statusText.innerText = "السيرفر متصل ✅";
        } else { throw new Error(); }
    } catch (e) {
        statusBadge.style.backgroundColor = "#ef4444";
        statusText.innerText = "السيرفر غير متصل ❌";
    }

    // 2. Get Current Tab Info
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab) {
        pageTitle.innerText = activeTab.title;
        
        // 3. Request Scrape (Only if it's a web page, not chrome://)
        if (activeTab.url.startsWith('http')) {
            chrome.tabs.sendMessage(activeTab.id, { action: "scrapeLinks" }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log("Could not communicate with content script.");
                    return;
                }
                if (response && response.links) {
                    scrapeCount.innerText = response.links.length;
                    if (response.links.length > 0) {
                        buttons.batch.disabled = false;
                        buttons.batch.dataset.links = JSON.stringify(response.links);
                    }
                }
            });
        }

        // 4. Get Captured Streams from Background
        chrome.runtime.sendMessage({ action: "getStreams", tabId: activeTab.id }, (response) => {
            if (response && response.streams) {
                const streams = response.streams;
                buttons.streams.innerText = `الروابط المصطادة (${streams.length})`;
                if (streams.length > 0) {
                    streamList.innerHTML = "";
                    streams.forEach(url => {
                        const li = document.createElement('li');
                        li.className = "stream-item";
                        const name = url.split('/').pop().split('?')[0] || "رابط مجهول";
                        li.innerHTML = `<span>${name}</span> <button class="stream-dl" data-url="${url}">تحميل</button>`;
                        streamList.appendChild(li);
                    });
                }
            }
        });
    }

    // Tab Switching
    buttons.current.onclick = () => {
        buttons.current.classList.add('active');
        buttons.streams.classList.remove('active');
        tabs.page.style.display = 'block';
        tabs.streams.style.display = 'none';
    };

    buttons.streams.onclick = () => {
        buttons.streams.classList.add('active');
        buttons.current.classList.remove('active');
        tabs.streams.style.display = 'block';
        tabs.page.style.display = 'none';
    };

    // Actions
    buttons.download.onclick = () => sendDownload({ url: activeTab.url });
    buttons.audio.onclick = () => sendDownload({ url: activeTab.url, audio_only: true });

    buttons.batch.onclick = () => {
        const links = JSON.parse(buttons.batch.dataset.links);
        fetch("http://localhost:5000/api/download/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: links })
        }).then(r => r.json()).then(showSuccess);
    };

    streamList.addEventListener('click', (e) => {
        if (e.target.classList.contains('stream-dl')) {
            sendDownload({ url: e.target.dataset.url });
        }
    });

    function sendDownload(data) {
        chrome.runtime.sendMessage({ action: "download", data: data }, (response) => {
            if (response && response.success) showSuccess();
        });
    }

    function showSuccess() {
        const originalText = buttons.download.innerText;
        buttons.download.innerText = "✅ تمت الإضافة!";
        setTimeout(() => buttons.download.innerText = originalText, 2000);
    }
});
