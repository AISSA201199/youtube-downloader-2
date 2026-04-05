// Background script for Legendary Video Downloader
// Catches media stream URLs (.m3u8, .mp4, etc)

let capturedStreams = {};

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.mpd')) {
      const tabId = details.tabId;
      if (tabId < 0) return;

      if (!capturedStreams[tabId]) {
        capturedStreams[tabId] = new Set();
      }
      
      if (!capturedStreams[tabId].has(url)) {
        capturedStreams[tabId].add(url);
        console.log("Captured Media Stream:", url);
        
        // Update badge
        chrome.action.setBadgeText({
          text: capturedStreams[tabId].size.toString(),
          tabId: tabId
        });
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// Cleanup on tab closing
chrome.tabs.onRemoved.addListener((tabId) => {
  delete capturedStreams[tabId];
});

// Communication with Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getStreams") {
    const tabId = request.tabId;
    sendResponse({ streams: Array.from(capturedStreams[tabId] || []) });
  }
  
  if (request.action === "download") {
    // Forward to local server
    fetch("http://localhost:5000/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.data)
    })
    .then(r => r.json())
    .then(data => {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Legendary Downloader',
        message: 'Download started successfully! 🚀'
      });
      sendResponse({ success: true, data });
    })
    .catch(err => {
      console.error("Server Error:", err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // async
  }
});
