"""
Video Downloader App - تطبيق تحميل الفيديوهات المتطور
Flask backend with WebSocket, batch downloads, and advanced features.
"""

# eventlet removed due to monkey_patching breaking subprocess (yt-dlp/ffmpeg)

import os
import sys
import subprocess
import platform
import logging
from datetime import datetime, timedelta

import mimetypes
import re
from flask import Flask, render_template, request, jsonify, send_from_directory, Response, abort, send_file
from flask_socketio import SocketIO
from cachetools import TTLCache, cached
from downloader import DownloadManager, detect_platform
import qrcode
import yt_dlp
from io import BytesIO
import telegram_bot

# ─── Settings ─────────────────────────────────────────────────────────

# Logger setup
logging.basicConfig(
    filename='app.log',
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('VideoDownloader')

app = Flask(__name__)
app.config['SECRET_KEY'] = 'video-dl-secret-2026'

# Allow CORS for Chrome Extension and other origins
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response

# Threading mode is required since Eventlet was removed to fix FFmpeg crashes
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

DOWNLOAD_DIR = os.path.abspath('downloads')
if not os.path.exists(DOWNLOAD_DIR):
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    
manager = DownloadManager(download_dir=DOWNLOAD_DIR, max_workers=4, socketio=socketio)

# Initialize Telegram Bot
telegram_bot.init_telegram_bot(manager, manager.db_path)

# Caches to prevent API bans and improve performance
info_cache = TTLCache(maxsize=100, ttl=300) # 5 minutes cache
search_cache = TTLCache(maxsize=100, ttl=600) # 10 minutes cache

# ─── Auto Cleanup Task ────────────────────────────────────────────────

def auto_cleanup(days_old=7):
    """Deletes downloaded files older than X days"""
    while True:
        try:
            now = datetime.now()
            for filename in os.listdir(DOWNLOAD_DIR):
                filepath = os.path.join(DOWNLOAD_DIR, filename)
                if os.path.isfile(filepath) and filename != 'history.json':
                    file_modified = datetime.fromtimestamp(os.path.getmtime(filepath))
                    if now - file_modified > timedelta(days=days_old):
                        os.remove(filepath)
                        logger.info(f"Auto-cleaned old file: {filename}")
        except Exception as e:
            logger.error(f"Error in auto-cleanup: {e}")
        import time
        time.sleep(86400) # Check once a day

# Start the cleanup thread
import threading
threading.Thread(target=auto_cleanup, args=(7,), daemon=True).start()

# ─── Pages ────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/admin')
def admin_dashboard():
    return render_template('admin.html')

@app.route('/api/admin/stats')
def api_admin_stats():
    """Admin stats endpoint for the dashboard"""
    return jsonify(manager.get_admin_stats())


@app.route('/api/settings', methods=['GET', 'POST'])
def api_settings():
    """Endpoint view and update global application settings"""
    if request.method == 'POST':
        data = request.get_json() or {}
        for key, value in data.items():
            manager.set_setting(key, value)
        return jsonify({'status': 'success', 'settings': manager.settings})
    
    return jsonify(manager.settings)


# ─── API ──────────────────────────────────────────────────────────────

@app.route('/api/detect', methods=['POST'])
def api_detect_platform():
    data = request.get_json() or {}
    url = data.get('url', '')
    platform = detect_platform(url)
    return jsonify({'platform': platform, 'url': url})


@app.route('/api/info', methods=['POST'])
def api_video_info():
    data = request.get_json() or {}
    url = data.get('url', '').strip()
    if not url:
        return jsonify({'error': 'الرجاء إدخال رابط صالح'}), 400
    
    # Check cache
    if url in info_cache:
        logger.info(f"Serving info from cache for: {url}")
        return jsonify(info_cache[url])
        
    info = manager.get_video_info(url)
    if 'error' in info:
        logger.error(f"Error fetching info for {url}: {info['error']}")
        return jsonify(info), 400
        
    info_cache[url] = info
    return jsonify(info)


@app.route('/api/search', methods=['POST'])
def api_search():
    data = request.get_json() or {}
    query = data.get('query', '').strip()
    max_results = min(data.get('max_results', 15), 30)
    if not query:
        return jsonify({'error': 'الرجاء إدخال كلمة بحث'}), 400
        
    cache_key = f"{query}_{max_results}"
    if cache_key in search_cache:
        logger.info(f"Serving search from cache for: {query}")
        return jsonify({'results': search_cache[cache_key], 'query': query})
        
    try:
        results = manager.search_youtube(query, max_results=max_results)
        search_cache[cache_key] = results
        return jsonify({'results': results, 'query': query})
    except Exception as e:
        logger.error(f"Search error for '{query}': {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/download', methods=['POST'])
def api_download():
    data = request.json
    url = data.get('url')
    format_id = data.get('format_id', 'best')
    audio_only = data.get('audio_only', False)
    custom_filename = data.get('custom_filename', '').strip()
    download_subtitles = data.get('download_subtitles', False)
    enqueue_only = data.get('enqueue_only', False)
    
    # Time cropping
    try:
        start_time = int(data.get('start_time', 0))
    except (ValueError, TypeError):
        start_time = 0
        
    try:
        end_time = int(data.get('end_time', 0))
    except (ValueError, TypeError):
        end_time = 0

    audio_format = data.get('audio_format', 'mp3')
    video_format = data.get('video_format', 'none')
    schedule_time = data.get('schedule_time', '')

    if not url:
        return jsonify({'error': 'رابط الفيديو مطلوب'}), 400

    item = manager.add_download(
        url, 
        format_id=format_id, 
        audio_only=audio_only, 
        custom_filename=custom_filename,
        download_subtitles=download_subtitles,
        start_time=start_time,
        end_time=end_time,
        audio_format=audio_format,
        video_format=video_format,
        enqueue_only=enqueue_only,
        schedule_time=schedule_time
    )
    return jsonify({
        'message': 'تمت الإضافة بنجاح',
        'id': item.id,
        'item': item.to_dict(),
    })


@app.route('/api/download/batch', methods=['POST'])
def api_download_batch():
    data = request.json
    urls = data.get('urls', [])
    audio_only = data.get('audio_only', False)
    enqueue_only = data.get('enqueue_only', False)

    if not urls:
        return jsonify({'error': 'قائمة الروابط فارغة'}), 400

    # Filter valid URLs
    valid_urls = [u.strip() for u in urls if u.strip().startswith('http')]
    if not valid_urls:
        return jsonify({'error': 'لا توجد روابط صالحة'}), 400

    items = manager.add_batch_downloads(valid_urls, format_id='best', audio_only=audio_only, enqueue_only=enqueue_only)
    return jsonify({
        'message': f'تمت إضافة {len(items)} تحميل',
        'count': len(items),
        'items': [i.to_dict() for i in items],
    })

@app.route('/api/queue/start', methods=['POST'])
def api_start_queue():
    started_count = manager.start_queue()
    return jsonify({
        'message': f'تم بدء تحميل {started_count} عنصر من القائمة',
        'count': started_count
    })

@app.route('/api/settings/concurrency', methods=['POST'])
def api_set_concurrency():
    data = request.json
    mode = data.get('mode', 'parallel')  # 'parallel' or 'sequential'
    manager.set_concurrency_mode(mode)
    return jsonify({'message': f'تم تغيير وضع التحميل إلى {mode}'})


@app.route('/api/queue')
def api_get_queue():
    return jsonify({
        'queue': manager.get_queue(),
        'stats': manager.get_stats(),
    })


@app.route('/api/stats')
def api_get_stats():
    return jsonify(manager.get_stats())


@app.route('/api/cancel/<download_id>', methods=['POST'])
def api_cancel_download(download_id):
    if manager.cancel_download(download_id):
        return jsonify({'message': 'تم إلغاء التحميل', 'id': download_id})
    return jsonify({'error': 'لم يتم العثور على التحميل'}), 404


@app.route('/api/retry/<download_id>', methods=['POST'])
def api_retry_download(download_id):
    if manager.retry_download(download_id):
        return jsonify({'message': 'تمت إعادة التحميل', 'id': download_id})
    return jsonify({'error': 'لم يتم العثور على التحميل'}), 404


@app.route('/api/remove/<download_id>', methods=['DELETE'])
def api_remove_download(download_id):
    if manager.remove_download(download_id):
        return jsonify({'message': 'تم حذف التحميل', 'id': download_id})
    return jsonify({'error': 'لم يتم العثور على التحميل'}), 404


@app.route('/api/clear', methods=['POST'])
def api_clear_queue():
    count = manager.clear_completed()
    return jsonify({'message': f'تم تنظيف {count} عنصر', 'count': count})


@app.route('/api/download/thumbnail', methods=['POST'])
def api_download_thumbnail():
    import urllib.request
    from urllib.parse import urlparse
    import re
    
    data = request.json
    thumb_url = data.get('thumbnail_url')
    title = data.get('title', 'thumbnail')
    
    if not thumb_url:
        return jsonify({'error': 'رابط الصورة غير متوفر'}), 400
        
    try:
        # Generate safe filename
        safe_title = re.sub(r'[\\/:*?"<>|]', '', title)[:50]
        ext = 'jpg'
        if 'webp' in thumb_url:
            ext = 'webp'
        elif 'png' in thumb_url:
            ext = 'png'
            
        filename = f"{safe_title}_thumb.{ext}"
        filepath = os.path.join(manager.download_dir, filename)
        
        # Download the image
        req = urllib.request.Request(thumb_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response, open(filepath, 'wb') as out_file:
            out_file.write(response.read())
            
        return send_file(filepath, as_attachment=True, download_name=filename)
    except Exception as e:
        return jsonify({'error': f'فشل تحميل الصورة: {str(e)}'}), 500

@app.route('/downloads/<path:filename>')
def serve_download(filename):
    # Handle possible double encoding from UI
    import urllib.parse
    decoded_name = urllib.parse.unquote(filename)
    filepath = os.path.join(DOWNLOAD_DIR, decoded_name)
    
    logger.info(f"Serve request: {filename} -> Decoded: {decoded_name}")
    
    if not os.path.exists(filepath):
        logger.error(f"File not found: {filepath}")
        # Log all files to see if there is an encoding mismatch
        try:
            files = os.listdir(DOWNLOAD_DIR)
            logger.info(f"Available files in downloads: {files}")
            # Try to find a fuzzy match (case-insensitive or normalized)
            for f in files:
                if f.lower() == decoded_name.lower():
                    logger.info(f"Found fuzzy match: {f}")
                    return send_from_directory(DOWNLOAD_DIR, f, as_attachment=False)
        except Exception as e:
            logger.error(f"Error listing dir: {e}")
        return jsonify({'error': 'الملف غير موجود'}), 404
        
    return send_from_directory(DOWNLOAD_DIR, decoded_name, as_attachment=False)


@app.route('/api/history')
def api_get_history():
    return jsonify({'history': manager.get_history()})


@app.route('/api/history/clear', methods=['POST'])
def api_clear_history():
    count = manager.clear_history()
    return jsonify({'message': f'تم مسح {count} عنصر من السجل', 'count': count})


@app.route('/api/open-folder', methods=['POST'])
def api_open_folder():
    try:
        if platform.system() == 'Windows':
            os.startfile(DOWNLOAD_DIR)
        elif platform.system() == 'Darwin':
            subprocess.Popen(['open', DOWNLOAD_DIR])
        else:
            subprocess.Popen(['xdg-open', DOWNLOAD_DIR])
        return jsonify({'message': 'تم فتح مجلد التحميلات'})
    except Exception as e:
        return jsonify({'error': f'فشل فتح المجلد: {str(e)}'}), 500

@app.route('/api/update-engine', methods=['POST'])
def api_update_engine():
    try:
        # Run pip install -U yt-dlp
        result = subprocess.run([sys.executable, '-m', 'pip', 'install', '-U', 'yt-dlp'], capture_output=True, text=True)
        if result.returncode == 0:
            return jsonify({'message': 'تم تحديث المحرك بنجاح!'})
        else:
            return jsonify({'error': f'فشل التحديث: {result.stderr}'}), 500
    except Exception as e:
        return jsonify({'error': f'حدث خطأ غير متوقع: {str(e)}'}), 500


@app.route('/api/quick-download', methods=['POST'])
def api_quick_download():
    """Quick download without fetching info first (for Shorts/Reels/Stories)"""
    data = request.json
    url = data.get('url', '').strip()
    audio_only = data.get('audio_only', False)
    if not url:
        return jsonify({'error': 'رابط الفيديو مطلوب'}), 400
    item = manager.add_download(url, format_id='best', audio_only=audio_only)
    return jsonify({'message': 'تم بدء التحميل السريع!', 'id': item.id, 'item': item.to_dict()})


@app.route('/api/convert/gif', methods=['POST'])
def api_convert_gif():
    """Convert a downloaded video to GIF using FFmpeg"""
    data = request.json
    filename = data.get('filename', '')
    start = int(data.get('start', 0))
    duration = int(data.get('duration', 5))
    
    if not filename:
        return jsonify({'error': 'اسم الملف مطلوب'}), 400
    
    source = os.path.join(DOWNLOAD_DIR, os.path.basename(filename))
    if not os.path.exists(source):
        return jsonify({'error': 'الملف غير موجود'}), 404
    
    gif_name = os.path.splitext(os.path.basename(filename))[0] + '.gif'
    gif_path = os.path.join(DOWNLOAD_DIR, gif_name)
    
    try:
        cmd = [
            'ffmpeg', '-y', '-ss', str(start), '-t', str(min(duration, 15)),
            '-i', source,
            '-vf', 'fps=12,scale=480:-1:flags=lanczos',
            '-loop', '0', gif_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            return jsonify({'error': 'فشل التحويل: ' + result.stderr[:200]}), 500
        return jsonify({'message': 'تم إنشاء ال GIF بنجاح!', 'filename': gif_name})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'استغرق التحويل وقتاً طويلاً'}), 500
    except Exception as e:
        return jsonify({'error': f'خطأ: {str(e)}'}), 500


@app.route('/api/qrcode', methods=['POST'])
def api_qrcode():
    """Generate QR code for a download URL"""
    data = request.json
    filename = data.get('filename', '')
    if not filename:
        return jsonify({'error': 'اسم الملف مطلوب'}), 400
    
    # Get server IP for LAN access
    import socket as _socket
    try:
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = '127.0.0.1'
    
    download_url = f'http://{ip}:5000/downloads/{filename}'
    
    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(download_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color='#16213e', back_color='white')
    
    buf = BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    
    import base64
    qr_b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
    
    return jsonify({'qr_image': f'data:image/png;base64,{qr_b64}', 'download_url': download_url})


@app.route('/api/history/stats')
def api_history_stats():
    """Smart history statistics"""
    return jsonify(manager.get_history_stats())


# ─── WebSocket ────────────────────────────────────────────────────────

@socketio.on('connect')
def handle_connect():
    socketio.emit('queue_update', {
        'queue': manager.get_queue(),
        'stats': manager.get_stats(),
    })


@socketio.on('request_queue')
def handle_request_queue():
    socketio.emit('queue_update', {
        'queue': manager.get_queue(),
        'stats': manager.get_stats(),
    })


# ─── Run ──────────────────────────────────────────────────────────────

def open_browser():
    import webbrowser
    webbrowser.open_new('http://localhost:5000')

@app.route('/api/stream/<path:filename>')
def stream_file(filename):
    file_path = os.path.join(DOWNLOAD_DIR, filename)
    if not os.path.exists(file_path):
        abort(404)
        
    range_header = request.headers.get('Range', None)
    if not range_header:
        return send_from_directory(DOWNLOAD_DIR, filename)
        
    size = os.path.getsize(file_path)
    byte1, byte2 = 0, None
    
    m = re.search(r'(\d+)-(\d*)', range_header)
    if not m:
        return send_from_directory(DOWNLOAD_DIR, filename)
    g = m.groups()
    
    if g[0]: byte1 = int(g[0])
    if g[1]: byte2 = int(g[1])
    
    length = size - byte1
    if byte2 is not None:
        length = byte2 - byte1 + 1
        
    data = None
    with open(file_path, 'rb') as f:
        f.seek(byte1)
        data = f.read(length)
        
    rv = Response(data, 206, mimetype=mimetypes.guess_type(file_path)[0], direct_passthrough=True)
    rv.headers.add('Content-Range', 'bytes {0}-{1}/{2}'.format(byte1, byte1 + length - 1, size))
    rv.headers.add('Accept-Ranges', 'bytes')
    return rv

@app.route('/api/trim', methods=['POST'])
def trim_media():
    data = request.json
    filename = data.get('filename')
    start = data.get('start', "00:00:00")
    end = data.get('end')
    
    input_path = os.path.join(DOWNLOAD_DIR, filename)
    output_filename = f"trimmed_{filename}"
    output_path = os.path.join(DOWNLOAD_DIR, output_filename)
    
    if not os.path.exists(input_path):
        return jsonify({"error": "File not found"}), 404
        
    try:
        cmd = ['ffmpeg', '-y', '-i', input_path, '-ss', start]
        if end: cmd += ['-to', end]
        cmd += ['-c', 'copy', output_path]
        subprocess.run(cmd, check=True)
        return jsonify({"success": True, "filename": output_filename})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/drive/upload', methods=['POST'])
def drive_upload():
    data = request.json
    filename = data.get('filename')
    file_path = os.path.join(DOWNLOAD_DIR, filename)
    
    if not os.path.exists(file_path):
        return jsonify({"success": False, "error": "File not found"}), 404
        
    # Check for credentials
    if not os.path.exists('credentials.json') and not os.path.exists('token.json'):
        return jsonify({"success": False, "needs_setup": True, "error": "Google Drive setup required"}), 400
        
    # Implement actual upload here using google-api-python-client
    # For now, we return failure to avoid library import errors if not installed
    return jsonify({"success": False, "error": "Google Drive Library Not Installed on Server"}), 501


# ─── Phase 3: Stealth Mode ──────────────────────────────────────────
@app.route('/api/settings/rate-limit', methods=['POST'])
def api_set_rate_limit():
    """Set download speed limit (Stealth Mode)"""
    data = request.json
    enabled = data.get('enabled', False)
    limit_kbps = int(data.get('limit', 500))
    
    if enabled:
        manager.rate_limit = f'{limit_kbps}K'
        logger.info(f"Stealth mode ON: rate limit = {limit_kbps} KB/s")
    else:
        manager.rate_limit = None
        logger.info("Stealth mode OFF")
    
    return jsonify({'message': f'تم {"تفعيل" if enabled else "تعطيل"} وضع التحميل الخفي', 'limit': limit_kbps})


# ─── Phase 3: Auto Categorize ────────────────────────────────────────
@app.route('/api/settings/auto-categorize', methods=['POST'])
def api_set_auto_categorize():
    """Enable/disable auto-categorization of downloads into subfolders"""
    data = request.json
    enabled = data.get('enabled', False)
    mode = data.get('mode', 'platform')  # platform, channel, date
    
    manager.auto_categorize = enabled
    manager.categorize_mode = mode
    logger.info(f"Auto-categorize {'ON' if enabled else 'OFF'}, mode={mode}")
    
    return jsonify({'message': f'تم {"تفعيل" if enabled else "تعطيل"} التصنيف التلقائي', 'mode': mode})


# ─── Phase 5: Notification Settings ──────────────────────────────────
@app.route('/api/settings/notifications', methods=['POST'])
def api_set_notifications():
    """Save Telegram/Discord notification settings"""
    data = request.json
    manager.save_notification_settings({
        'telegram_token': data.get('telegram_token', ''),
        'telegram_chat_id': data.get('telegram_chat_id', ''),
        'discord_webhook': data.get('discord_webhook', ''),
    })
    logger.info("Notification settings updated and saved to DB")
    
    # Restart the telegram bot with new token
    telegram_bot.restart_telegram_bot()
    
    return jsonify({'message': 'تم حفظ إعدادات الإشعارات وتحديث البوت'})


@app.route('/api/settings/notifications/test', methods=['POST'])
def api_test_notifications():
    """Test Telegram/Discord notification connection"""
    results = manager.send_test_notification()
    return jsonify(results)


@app.route('/api/settings/notifications/status', methods=['GET'])
def api_notification_status():
    """Return current notification settings status"""
    ns = manager.notification_settings
    has_telegram = bool(ns.get('telegram_token') and ns.get('telegram_chat_id'))
    has_discord = bool(ns.get('discord_webhook'))
    return jsonify({
        'telegram_configured': has_telegram,
        'discord_configured': has_discord,
        'telegram_token_preview': ns.get('telegram_token', '')[:10] + '...' if ns.get('telegram_token') else '',
        'telegram_chat_id': ns.get('telegram_chat_id', ''),
    })


# ─── Phase 5: Check Subscriptions ────────────────────────────────────
@app.route('/api/subscriptions/check', methods=['POST'])
def api_check_subscriptions():
    """Manually trigger subscription check for new videos"""
    data = request.json
    channels = data.get('channels', [])
    
    if not channels:
        return jsonify({'error': 'لا توجد قنوات للفحص'}), 400
    
    new_videos = []
    for channel_url in channels:
        try:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': True,
                'playlist_items': '1-3',
                'socket_timeout': 10,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(channel_url, download=False)
                if info and 'entries' in info:
                    for entry in list(info['entries'])[:3]:
                        if entry:
                            new_videos.append({
                                'title': entry.get('title', ''),
                                'url': entry.get('url') or entry.get('webpage_url', ''),
                                'channel': info.get('title', channel_url),
                            })
        except Exception as e:
            logger.error(f"Subscription check failed for {channel_url}: {e}")
    
    return jsonify({
        'message': f'تم فحص {len(channels)} قناة',
        'new_videos': new_videos,
        'count': len(new_videos),
    })


if __name__ == '__main__':
    print("\n" + "=" * 55)
    print("  [APP] Advanced Video Downloader Pro")
    print("=" * 55)
    # Use repr to see potential encoding issues in terminal
    print(f"  [DIR] {os.path.abspath(DOWNLOAD_DIR)}")
    print(f"  [URL] http://localhost:5000")
    print("=" * 55 + "\n")
    logger.info("Application started using standard threading.")
    
    # Auto-open browser if running as PyInstaller EXE
    if getattr(sys, 'frozen', False):
        from threading import Timer
        Timer(1.5, open_browser).start()
        
    socketio.run(app, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)

