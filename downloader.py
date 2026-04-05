"""
Download Manager - محرك التحميل المتطور
Advanced video downloading engine with yt-dlp, queue management,
batch downloads, and real-time progress tracking.
"""

import os
import uuid
import threading
import time
import re
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import sqlite3
import json

import yt_dlp
from cachetools import TTLCache, cached


# ─── Platform Detection ───────────────────────────────────────────────

PLATFORM_PATTERNS = {
    'youtube': [r'(youtube\.com|youtu\.be)'],
    'instagram': [r'(instagram\.com|instagr\.am)'],
    'tiktok': [r'(tiktok\.com|vm\.tiktok\.com)'],
    'facebook': [r'(facebook\.com|fb\.watch|fb\.com)'],
    'twitter': [r'(twitter\.com|x\.com)'],
}

PLATFORM_LABELS = {
    'youtube': 'يوتيوب',
    'instagram': 'انستغرام',
    'tiktok': 'تيك توك',
    'facebook': 'فيسبوك',
    'twitter': 'تويتر / X',
    'unknown': 'غير معروف',
}


def detect_platform(url: str) -> str:
    for platform, patterns in PLATFORM_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, url, re.IGNORECASE):
                return platform
    return 'unknown'


# ─── Download Item ─────────────────────────────────────────────────────

@dataclass
class DownloadItem:
    id: str
    url: str
    format_id: str
    status: str = 'queued'  # queued, downloading, completed, error, cancelled
    progress: float = 0.0
    speed: str = ''
    eta: str = ''
    title: str = ''
    thumbnail: str = ''
    duration: int = 0
    filename: str = ''
    error: str = ''
    platform: str = field(default_factory=lambda: 'unknown')
    audio_only: bool = False
    mode: str = 'single'  # single, batch
    completed_at: str = ''
    filesize: int = 0
    downloaded_bytes: int = 0
    custom_filename: str = ''
    download_subtitles: bool = False
    start_time: int = 0
    end_time: int = 0
    audio_format: str = 'mp3'
    video_format: str = 'none'
    schedule_time: str = ''  # ISO format datetime for scheduled downloads
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    
    # Telegram Bot specific fields
    tg_chat_id: str = ''
    tg_msg_id: str = ''


    def to_dict(self):
        return {
            'id': self.id,
            'url': self.url,
            'format_id': self.format_id,
            'audio_only': self.audio_only,
            'mode': self.mode,
            'platform': self.platform,
            'platform_label': PLATFORM_LABELS.get(self.platform, 'غير معروف'),
            'title': self.title or self.url,
            'thumbnail': self.thumbnail,
            'duration': self.duration,
            'filesize': self.filesize,
            'downloaded_bytes': self.downloaded_bytes,
            'filename': self.filename,
            'status': self.status,
            'progress': self.progress,
            'speed': self.speed,
            'eta': self.eta,
            'tg_chat_id': self.tg_chat_id,
            'tg_msg_id': self.tg_msg_id,
            'error': self.error,
            'created_at': self.created_at,
            'completed_at': self.completed_at,
            'custom_filename': self.custom_filename,
            'download_subtitles': self.download_subtitles,
            'start_time': self.start_time,
            'end_time': self.end_time,
            'audio_format': self.audio_format,
            'video_format': self.video_format,
            'schedule_time': self.schedule_time,
        }


# ─── Download Manager ─────────────────────────────────────────────────

class DownloadManager:
    def __init__(self, download_dir='downloads', max_workers=4, socketio=None):
        self.download_dir = os.path.abspath(download_dir)
        os.makedirs(self.download_dir, exist_ok=True)
        self.max_workers = max_workers
        self.socketio = socketio

        self.queue = {}
        self.lock = threading.Lock()
        self.db_lock = threading.Lock()  # Separate lock for DB operations to prevent deadlock
        
        # Phase 3: Stealth mode
        self.rate_limit = None  # e.g. '500K'
        
        # Phase 3: Auto-categorize
        self.auto_categorize = False
        self.categorize_mode = 'platform'  # platform, channel, date
        
        # Phase 5: Notification settings
        self.notification_settings = {
            'telegram_token': '',
            'telegram_chat_id': '',
            'discord_webhook': '',
        }
        
        self.db_path = os.path.join(self.download_dir, 'database.db')
        self._init_db()
        self._load_settings()
        self._load_notification_settings()

        # Download Executor
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.active_tasks = {}
        
        # External Callbacks (e.g., Telegram Bot)
        self.progress_callbacks = []
        self.completion_callbacks = []

        # Resume any pending downloads from previous session
        self._resume_pending()

        # Start scheduler thread for scheduled downloads
        self._scheduler_running = True
        self._scheduler_thread = threading.Thread(target=self._run_scheduler, daemon=True)
        self._scheduler_thread.start()

        # Start subscription worker thread
        self._subscription_running = True
        self._subscription_thread = threading.Thread(target=self._run_subscription_worker, daemon=True)
        self._subscription_thread.start()

    def register_progress_callback(self, cb):
        self.progress_callbacks.append(cb)

    def register_completion_callback(self, cb):
        self.completion_callbacks.append(cb)

    def _emit(self, event, data):
        if self.socketio:
            try:
                self.socketio.emit(event, data)
            except Exception:
                pass

    def _load_settings(self):
        """تحميل كافة الإعدادات من قاعدة البيانات إلى الذاكرة"""
        self.settings = {
            'max_threads': 4,
            'rate_limit': None,
            'auto_subtitle': False,
        }
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                # Check if table exists (should be created in _init_db)
                c.execute("SELECT key, value FROM app_settings")
                rows = c.fetchall()
                for key, value in rows:
                    if value.isdigit():
                        self.settings[key] = int(value)
                    elif value.lower() in ['true', 'false']:
                        self.settings[key] = value.lower() == 'true'
                    else:
                        self.settings[key] = value
                conn.close()
        except Exception as e:
            print(f"Error loading settings: {e}")

    def get_setting(self, key, default=None):
        return self.settings.get(key, default)

    def set_setting(self, key, value):
        self.settings[key] = value
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                c.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", (key, str(value)))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"Error saving setting {key}: {e}")

    def _make_progress_hook(self, item: DownloadItem):
        last_emit = [0]

        def hook(d):
            if item.status == 'cancelled':
                raise yt_dlp.utils.DownloadCancelled('Download cancelled by user')

            if d['status'] == 'downloading':
                item.status = 'downloading'
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                downloaded = d.get('downloaded_bytes', 0)

                if total > 0:
                    item.progress = round((downloaded / total) * 100, 1)
                    item.filesize = total
                    item.downloaded_bytes = downloaded
                else:
                    pct_str = d.get('_percent_str', '0%').strip().replace('%', '')
                    try:
                        item.progress = min(float(pct_str), 99.9)
                    except ValueError:
                        pass

                item.speed = d.get('_speed_str', '').strip()
                item.eta = d.get('_eta_str', '').strip()

                # Throttle WebSocket emissions to every 500ms
                now = time.time()
                if now - last_emit[0] > 0.5:
                    last_emit[0] = now
                    self._emit('download_progress', item.to_dict())
                
                # Throttle Telegram/External progress to every 3 seconds to avoid API bans
                if hasattr(item, 'tg_chat_id') and item.tg_chat_id:
                    if not hasattr(self, '_last_tg_emit'): self._last_tg_emit = {}
                    if now - self._last_tg_emit.get(item.id, 0) > 3.0:
                        self._last_tg_emit[item.id] = now
                        for cb in self.progress_callbacks:
                            try: cb(item)
                            except Exception: pass

            elif d['status'] == 'finished':
                item.progress = 100
                item.filename = d.get('filename', '')
                self._emit('download_progress', item.to_dict())
                
                # We do NOT call completion_callbacks here because post_processor might be running.
                # It is called at the end of _execute_download.

        return hook

    def get_video_info(self, url: str) -> dict:
        try:
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'extract_flat': 'in_playlist',
                'socket_timeout': 15,
                'nocheckcertificate': True,
                'cookiefile': 'cookies.txt',
            }

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    return {'error': 'لم يتم العثور على معلومات للفيديو'}
                
                # Check if it's a playlist
                if 'entries' in info:
                    entries = list(info['entries'])
                    return {
                        'is_playlist': True,
                        'title': info.get('title', 'قائمة تشغيل'),
                        'count': len(entries),
                        'entries': [
                            {
                                'title': e.get('title', 'بدون عنوان'),
                                'url': e.get('url') or e.get('webpage_url'),
                                'duration': e.get('duration', 0),
                            } for e in entries if e.get('title') and (e.get('url') or e.get('webpage_url'))
                        ]
                    }

                # If not a playlist, proceed with single video info
                formats = self._parse_formats(info)
                duration = info.get('duration') or 0
                title = info.get('title', 'بدون عنوان')
                thumb = info.get('thumbnail', '')

                # Extract video ID for embed player
                video_id = info.get('id', '')

                return {
                    'url': url,
                    'video_id': video_id,
                    'title': info.get('title', 'بدون عنوان'),
                    'thumbnail': info.get('thumbnail', ''),
                    'duration': duration,
                    'uploader': info.get('uploader', info.get('channel', '')),
                    'view_count': info.get('view_count', 0),
                    'like_count': info.get('like_count', 0),
                    'upload_date': info.get('upload_date', ''),
                    'description': (info.get('description', '') or '')[:800],
                    'platform': detect_platform(url),
                    'platform_label': PLATFORM_LABELS.get(detect_platform(url), ''),
                    'formats': formats,
                    'webpage_url': info.get('webpage_url', url),
                }
        except yt_dlp.utils.DownloadError as e:
            err_msg = str(e)
            if 'urlopen error' in err_msg or 'timed out' in err_msg:
                return {'error': 'خطأ في الاتصال. تأكد من اتصالك بالإنترنت'}
            if 'Video unavailable' in err_msg:
                return {'error': 'الفيديو غير متاح أو تمت إزالته'}
            if 'Private video' in err_msg:
                return {'error': 'هذا الفيديو خاص ولا يمكن الوصول إليه'}
            return {'error': f'خطأ: {err_msg[:200]}'}
        except Exception as e:
            return {'error': f'خطأ غير متوقع: {str(e)[:200]}'}

    def _parse_formats(self, info):
        formats = []
        seen = set()

        for f in info.get('formats', []):
            height = f.get('height')
            ext = f.get('ext', 'mp4')
            format_id = f.get('format_id', '')
            vcodec = f.get('vcodec', 'none')
            acodec = f.get('acodec', 'none')
            filesize = f.get('filesize') or f.get('filesize_approx') or 0
            tbr = f.get('tbr', 0) or 0

            if vcodec not in ('none', None):
                label = f"{height}p" if height else (format_id or "قياسية")
                key = label
                if key not in seen:
                    seen.add(key)
                    formats.append({
                        'format_id': format_id,
                        'label': label,
                        'ext': ext,
                        'filesize': filesize,
                        'has_audio': acodec not in ('none', None),
                        'quality': height or 0,
                        'audio_only': False,
                        'bitrate': tbr,
                    })


        # Add audio-only option
        if 'audio' not in seen:
            formats.append({
                'format_id': 'bestaudio',
                'label': 'صوت فقط (MP3)',
                'ext': 'mp3',
                'filesize': 0,
                'has_audio': True,
                'quality': 0,
                'audio_only': True,
                'bitrate': 0,
            })

        formats.sort(key=lambda x: x.get('quality', 0), reverse=True)
        return formats[:12]

    def search_youtube(self, query: str, max_results: int = 15) -> list:
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True,
            'default_search': 'ytsearch',
            'socket_timeout': 15,
            'cookiefile': 'cookies.txt',
        }

        search_query = f"ytsearch{max_results}:{query}"

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(search_query, download=False)
                entries = result.get('entries', []) if result else []

                videos = []
                for entry in entries:
                    if not entry:
                        continue
                    video_id = entry.get('id', '')
                    url = entry.get('url') or f"https://www.youtube.com/watch?v={video_id}"
                    thumb = entry.get('thumbnail') or entry.get('thumbnails', [{}])[-1].get('url', '') or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
                    videos.append({
                        'id': video_id,
                        'title': entry.get('title', 'بدون عنوان'),
                        'url': url,
                        'thumbnail': thumb,
                        'duration': entry.get('duration') or 0,
                        'uploader': entry.get('uploader') or entry.get('channel', ''),
                        'view_count': entry.get('view_count', 0),
                    })
                return videos
        except Exception as e:
            raise Exception(f'فشل البحث: {str(e)[:200]}')

    def _process_queue(self):
        with self.lock:
            # Check if we should use sequential or parallel mode
            # If sequential, max_workers is effectively 1 for processing the queue
            concurrency = self.executor._max_workers
            
            # Find items that are queued
            queued_items = [item for item in self.queue.values() if item.status == 'queued']
            
        for item in queued_items:
            # We submit them to the executor. If max_workers=1, they run sequentially.
            self.executor.submit(self._execute_download, item)


    def set_concurrency_mode(self, mode: str):
        with self.lock:
            workers = 1 if mode == 'sequential' else 4
            if getattr(self, 'executor', None):
                self.executor.shutdown(wait=False)
            self.executor = ThreadPoolExecutor(max_workers=workers)
            self.max_workers = workers


    def start_queue(self):
        self._process_queue()
        return len([item for item in self.queue.values() if item.status == 'queued'])

    def add_batch_downloads(self, urls, format_id='best', audio_only=False, enqueue_only=False):
        items = []
        for url in urls:
            url = url.strip()
            if not url:
                continue
            item = self.add_download(url, format_id, audio_only=audio_only, mode='batch', enqueue_only=enqueue_only)
            items.append(item)
        return items

    def _execute_download(self, item: DownloadItem):
        try:
            item.status = 'downloading'
            self._emit('download_progress', item.to_dict())

            # Build yt-dlp options - optimized for merged output
            outtmpl = os.path.join(self.download_dir, '%(title).80s.%(ext)s')
            if item.custom_filename:
                # Sanitize the custom filename to avoid path issues
                safe_name = re.sub(r'[\\/:*?"<>|]', '', item.custom_filename)
                outtmpl = os.path.join(self.download_dir, f"{safe_name}.%(ext)s")
            
            import shutil
            
            # Detect FFmpeg location
            ffmpeg_path = shutil.which('ffmpeg')

            # Auto-categorize: create subfolders
            if self.auto_categorize:
                sub = ''
                if self.categorize_mode == 'platform':
                    sub = detect_platform(item.url) or 'other'
                elif self.categorize_mode == 'channel':
                    sub = '%(uploader).50s'
                elif self.categorize_mode == 'date':
                    sub = '%(upload_date>%Y-%m)s'
                if sub:
                    outtmpl = os.path.join(self.download_dir, sub, os.path.basename(outtmpl))
                    # Ensure static subfolder exists for platform mode
                    if self.categorize_mode == 'platform':
                        os.makedirs(os.path.join(self.download_dir, sub), exist_ok=True)

            ydl_opts = {
                'outtmpl': outtmpl,
                'progress_hooks': [self._make_progress_hook(item)],
                'quiet': True,
                'no_warnings': True,
                'concurrent_fragment_downloads': self.get_setting('max_threads', 4),
                'windowsfilenames': True,
                'cookiefile': 'cookies.txt',
            }

            # Stealth mode: rate limiting
            if self.rate_limit:
                ydl_opts['ratelimit'] = self.rate_limit
            
            if ffmpeg_path:
                ydl_opts['ffmpeg_location'] = ffmpeg_path

            if item.download_subtitles:
                ydl_opts['writesubtitles'] = True
                ydl_opts['writeautomaticsub'] = True
                ydl_opts['subtitleslangs'] = ['ar', 'en', 'all']
                ydl_opts['subtitlesformat'] = 'srt/vtt/best'

            if item.start_time > 0 or item.end_time > 0:
                s_time = item.start_time
                e_time = item.end_time if item.end_time > 0 else 999999
                ydl_opts['download_ranges'] = yt_dlp.utils.download_range_func(None, [(s_time, e_time)])
                ydl_opts['force_keyframes_at_cuts'] = True

            if item.audio_only:
                ydl_opts['format'] = 'bestaudio/best'
                codec = item.audio_format if item.audio_format in ['mp3', 'm4a', 'wav'] else 'mp3'
                
                # Spotify/Music Metadata Embedding + Smart Organization
                if 'spotify.com' in item.url or 'soundcloud.com' in item.url:
                    safe_title = item.custom_filename if item.custom_filename else '%(title).80s'
                    ydl_opts['outtmpl'] = os.path.join(self.download_dir, 'Music', '%(artist,uploader|Unknown)s', f"{safe_title}.%(ext)s")
                elif self.auto_categorize and not sub:
                    safe_title = item.custom_filename if item.custom_filename else '%(title).80s'
                    ydl_opts['outtmpl'] = os.path.join(self.download_dir, 'Audio', f"{safe_title}.%(ext)s")
                    
                ydl_opts['postprocessors'] = [
                    {
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': codec,
                        'preferredquality': '192',
                    },
                    {'key': 'FFmpegMetadata'},
                    {'key': 'EmbedThumbnail'},
                ]
                ydl_opts['writethumbnail'] = True
            else:
                if item.format_id and item.format_id != 'best':
                    if item.format_id in ['1080', '720', '480', '360']:
                        # Handle generic resolution requests from the Chrome Extension
                        ydl_opts['format'] = f"bestvideo[height<={item.format_id}][ext=mp4]+bestaudio[ext=m4a]/best[height<={item.format_id}]/best"
                    else:
                        # Handle specific format_id from the main web UI
                        ydl_opts['format'] = f"{item.format_id}+bestaudio[ext=m4a]/best"
                else:
                    # Force maximum download speed by preferring pre-merged single files (720p).
                    # Bypasses YouTube DASH chunk throttling and completely skips FFmpeg merging.
                    ydl_opts['format'] = 'best[ext=mp4]/best'
                
                ydl_opts['merge_output_format'] = 'mp4'
                # Automatic remuxing of any non-MP4 to MP4 for maximum browser compatibility
                # (Fast container swap, not a slow re-encode)
                if 'postprocessors' not in ydl_opts:
                    ydl_opts['postprocessors'] = []
                ydl_opts['postprocessors'].append({
                    'key': 'FFmpegVideoConvertor',
                    'preferedformat': 'mp4',
                })

            # Add postprocessor for video remuxing if requested format differs from merged format
            if not item.audio_only and item.video_format and item.video_format != 'none':
                if 'postprocessors' not in ydl_opts:
                    ydl_opts['postprocessors'] = []
                ydl_opts['postprocessors'].append({
                    'key': 'FFmpegVideoConvertor',
                    'preferedformat': item.video_format,
                })

            # Thumbnail downloading disabled per user request to maximize speed

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(item.url, download=True)
                if info:
                    item.title = info.get('title', 'بدون عنوان')
                    item.thumbnail = info.get('thumbnail', '')
                    item.duration = info.get('duration', 0)
                    if not item.filename:
                        # Find the actual final filename by applying the codec extension
                        base_filename = ydl.prepare_filename(info)
                        if item.audio_only:
                            item.filename = os.path.splitext(base_filename)[0] + '.' + codec
                        else:
                            item.filename = base_filename

                    # AI Auto-Converter: Remove silence for mp3 files
                    if item.audio_only and codec == 'mp3':
                        try:
                            from pydub import AudioSegment
                            from pydub.silence import split_on_silence
                            self._emit('download_progress', {**item.to_dict(), 'status': 'processing_audio', 'speed': 'جاري إزالة الصمت الذكي...', 'eta': '...'})
                            
                            audio_path = item.filename
                            if os.path.exists(audio_path):
                                sound = AudioSegment.from_mp3(audio_path)
                                # Remove silence chunks
                                chunks = split_on_silence(sound, min_silence_len=2000, silence_thresh=-45, keep_silence=500)
                                if chunks and len(chunks) > 0:
                                    processed = chunks[0]
                                    for chunk in chunks[1:]:
                                        processed += chunk
                                    processed.export(audio_path, format="mp3", bitrate="192k")
                                    print(f"Successfully removed silence from {audio_path}")
                        except Exception as e:
                            print(f"Silence removal skipped: {e}")

            item.status = 'completed'
            item.progress = 100
            item.speed = ''
            item.eta = ''
            item.completed_at = datetime.now().isoformat()
            self._save_to_history(item)
            self._remove_pending(item.id)
            self._emit('download_complete', item.to_dict())
            self._send_notification(item)
            
            # Trigger external completion hooks
            for cb in self.completion_callbacks:
                try: cb(item)
                except Exception: pass

        except yt_dlp.utils.DownloadCancelled:
            item.status = 'cancelled'
            self._remove_pending(item.id)
            self._emit('download_cancelled', item.to_dict())
        except Exception as e:
            if item.status != 'cancelled':
                item.status = 'error'
                err_msg = str(e)
                if 'urlopen error' in err_msg or 'timed out' in err_msg:
                    item.error = 'خطأ في الاتصال بالإنترنت'
                elif 'Video unavailable' in err_msg:
                    item.error = 'الفيديو غير متاح'
                elif 'Private video' in err_msg:
                    item.error = 'فيديو خاص'
                elif 'format' in err_msg.lower():
                    item.error = 'الصيغة المطلوبة غير متوفرة'
                else:
                    item.error = err_msg[:150]
                self._remove_pending(item.id)
                self._emit('download_error', item.to_dict())
                self._send_notification(item, is_error=True)
                
                # Trigger external hooks for failure too
                for cb in self.completion_callbacks:
                    try: cb(item)
                    except Exception: pass

    def _send_notification(self, item, is_error=False):
        """Send rich Telegram/Discord notification on download completion or error"""
        def _notify():
            import urllib.request, json as _json
            ns = self.notification_settings
            title = item.title or 'بدون عنوان'
            platform_label = PLATFORM_LABELS.get(item.platform, 'غير معروف')
            platform_emoji = {'youtube': '▶️', 'instagram': '📷', 'tiktok': '🎵', 'facebook': '📘', 'twitter': '🐦'}.get(item.platform, '🔗')
            
            # Format duration
            dur_str = ''
            if item.duration:
                mins = item.duration // 60
                secs = item.duration % 60
                dur_str = f"{mins}:{secs:02d}"
            
            # Format filesize
            size_str = ''
            if item.filesize:
                if item.filesize > 1024 * 1024 * 1024:
                    size_str = f"{item.filesize / (1024*1024*1024):.1f} GB"
                elif item.filesize > 1024 * 1024:
                    size_str = f"{item.filesize / (1024*1024):.1f} MB"
                elif item.filesize > 1024:
                    size_str = f"{item.filesize / 1024:.0f} KB"
            
            # Escape HTML special chars
            def esc(t): return str(t).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
            safe_title = esc(title)
            safe_error = esc(item.error or 'خطأ غير معروف')
            
            # Build rich message (HTML format)
            if is_error:
                tg_text = f"❌ <b>فشل التحميل</b>\n\n"
                tg_text += f"📹 <b>{safe_title}</b>\n"
                tg_text += f"{platform_emoji} المنصة: {platform_label}\n"
                tg_text += f"⚠️ الخطأ: {safe_error}\n"
                tg_text += f'🔗 <a href="{item.url}">الرابط الأصلي</a>'
                discord_text = f"❌ **فشل التحميل**\n📹 **{title}**\n{platform_emoji} {platform_label}\n⚠️ {item.error or 'خطأ غير معروف'}"
            else:
                tg_text = f"✅ <b>تحميل مكتمل!</b>\n\n"
                tg_text += f"📹 <b>{safe_title}</b>\n"
                tg_text += f"{platform_emoji} المنصة: {platform_label}\n"
                if dur_str:
                    tg_text += f"⏱ المدة: {dur_str}\n"
                if size_str:
                    tg_text += f"💾 الحجم: {size_str}\n"
                if item.audio_only:
                    tg_text += f"🎵 النوع: صوت فقط ({item.audio_format.upper()})\n"
                else:
                    tg_text += f"🎬 النوع: فيديو\n"
                tg_text += f'🔗 <a href="{item.url}">الرابط الأصلي</a>'
                discord_text = f"✅ **تحميل مكتمل!**\n📹 **{title}**\n{platform_emoji} {platform_label}"
                if dur_str:
                    discord_text += f" | ⏱ {dur_str}"
                if size_str:
                    discord_text += f" | 💾 {size_str}"
            
            # Telegram - send with photo if available
            if ns.get('telegram_token') and ns.get('telegram_chat_id'):
                token = ns['telegram_token']
                chat_id = ns['telegram_chat_id']
                sent = False
                
                # Try sending with thumbnail photo first
                if item.thumbnail and not is_error:
                    try:
                        api_url = f"https://api.telegram.org/bot{token}/sendPhoto"
                        payload = {
                            'chat_id': chat_id,
                            'photo': item.thumbnail,
                            'caption': tg_text,
                            'parse_mode': 'HTML',
                            'disable_web_page_preview': False
                        }
                        data = _json.dumps(payload).encode()
                        req = urllib.request.Request(api_url, data, {'Content-Type': 'application/json'})
                        urllib.request.urlopen(req, timeout=15)
                        sent = True
                    except Exception as e:
                        print(f"  [TG] Photo send failed, falling back to text: {e}")
                
                # Fallback to text-only message
                if not sent:
                    try:
                        api_url = f"https://api.telegram.org/bot{token}/sendMessage"
                        payload = {
                            'chat_id': chat_id,
                            'text': tg_text,
                            'parse_mode': 'HTML',
                            'disable_web_page_preview': False
                        }
                        data = _json.dumps(payload).encode()
                        req = urllib.request.Request(api_url, data, {'Content-Type': 'application/json'})
                        urllib.request.urlopen(req, timeout=15)
                    except Exception as e:
                        print(f"  [TG] Text send failed: {e}")
            
            # Discord - send with embed
            if ns.get('discord_webhook'):
                try:
                    embed = {
                        'title': '✅ تحميل مكتمل!' if not is_error else '❌ فشل التحميل',
                        'description': discord_text,
                        'color': 0x00d084 if not is_error else 0xff4444,
                    }
                    if item.thumbnail and not is_error:
                        embed['thumbnail'] = {'url': item.thumbnail}
                    payload = {'embeds': [embed]}
                    data = _json.dumps(payload).encode()
                    req = urllib.request.Request(ns['discord_webhook'], data, {'Content-Type': 'application/json'})
                    urllib.request.urlopen(req, timeout=15)
                except Exception as e:
                    print(f"  [DISCORD] Send failed: {e}")
        
        # Fire and forget in background thread
        threading.Thread(target=_notify, daemon=True).start()

    def send_test_notification(self) -> dict:
        """Send a test notification to verify Telegram/Discord settings"""
        import urllib.request, json as _json
        ns = self.notification_settings
        results = {'telegram': None, 'discord': None}
        
        # Test Telegram
        if ns.get('telegram_token') and ns.get('telegram_chat_id'):
            try:
                token = ns['telegram_token']
                chat_id = ns['telegram_chat_id']
                
                # First verify the bot token
                verify_url = f"https://api.telegram.org/bot{token}/getMe"
                req = urllib.request.Request(verify_url)
                resp = urllib.request.urlopen(req, timeout=10)
                bot_info = _json.loads(resp.read().decode())  
                bot_name = bot_info.get('result', {}).get('first_name', 'Bot')
                bot_username = bot_info.get('result', {}).get('username', '')
                
                # Send test message (HTML format to avoid Markdown issues)
                test_msg = (
                    f"🧪 <b>رسالة تجريبية</b>\n\n"
                    f"✅ تم الاتصال بنجاح!\n\n"
                    f"🤖 البوت: {bot_name} (@{bot_username})\n"
                    f"💬 Chat ID: <code>{chat_id}</code>\n\n"
                    f"📥 <b>Video Downloader Pro</b>\n"
                    f"ستصلك إشعارات هنا عند اكتمال أو فشل أي تحميل."
                )
                api_url = f"https://api.telegram.org/bot{token}/sendMessage"
                payload = {
                    'chat_id': chat_id,
                    'text': test_msg,
                    'parse_mode': 'HTML'
                }
                data = _json.dumps(payload).encode()
                req = urllib.request.Request(api_url, data, {'Content-Type': 'application/json'})
                resp = urllib.request.urlopen(req, timeout=10)
                resp_data = _json.loads(resp.read().decode())
                
                if resp_data.get('ok'):
                    results['telegram'] = {'success': True, 'bot_name': bot_name, 'bot_username': bot_username}
                else:
                    results['telegram'] = {'success': False, 'error': resp_data.get('description', 'خطأ غير معروف')}
            except urllib.error.HTTPError as e:
                error_body = e.read().decode()
                try:
                    err_data = _json.loads(error_body)
                    err_msg = err_data.get('description', str(e))
                except Exception:
                    err_msg = str(e)
                results['telegram'] = {'success': False, 'error': err_msg}
            except Exception as e:
                results['telegram'] = {'success': False, 'error': str(e)[:200]}
        else:
            results['telegram'] = {'success': False, 'error': 'لم يتم إدخال بيانات Telegram'}
        
        # Test Discord
        if ns.get('discord_webhook'):
            try:
                embed = {
                    'title': '🧪 رسالة تجريبية',
                    'description': '✅ تم الاتصال بنجاح!\n\n📥 **Video Downloader Pro**\nستصلك إشعارات هنا عند اكتمال أو فشل أي تحميل.',
                    'color': 0x7c6df0,
                }
                payload = {'embeds': [embed]}
                data = _json.dumps(payload).encode()
                req = urllib.request.Request(ns['discord_webhook'], data, {'Content-Type': 'application/json'})
                urllib.request.urlopen(req, timeout=10)
                results['discord'] = {'success': True}
            except Exception as e:
                results['discord'] = {'success': False, 'error': str(e)[:200]}
        else:
            results['discord'] = {'success': False, 'error': 'لم يتم إدخال Discord Webhook'}
        
        return results

    def save_notification_settings(self, settings: dict):
        """Save notification settings to DB and memory"""
        self.notification_settings = {
            'telegram_token': settings.get('telegram_token', ''),
            'telegram_chat_id': settings.get('telegram_chat_id', ''),
            'discord_webhook': settings.get('discord_webhook', ''),
        }
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                c.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
                          ('notification_settings', json.dumps(self.notification_settings)))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"Error saving notification settings: {e}")

    def _load_notification_settings(self):
        """Load notification settings from DB on startup"""
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                c.execute("SELECT value FROM app_settings WHERE key = ?", ('notification_settings',))
                row = c.fetchone()
                conn.close()
                if row:
                    self.notification_settings = json.loads(row[0])
                    token = self.notification_settings.get('telegram_token', '')[:10]
                    if token:
                        print(f"  [NOTIFY] Loaded Telegram settings (token: {token}...)")
        except Exception as e:
            print(f"  [NOTIFY] No saved notification settings: {e}")

    def cancel_download(self, download_id):
        with self.lock:
            item = self.queue.get(download_id)
            if item:
                if item.status == 'queued':
                    del self.queue[download_id]
                    self._emit('download_cancelled', item.to_dict())
                    return True
                elif item.status == 'downloading':
                    item.status = 'cancelled'
                    self._emit('download_cancelled', item.to_dict())
                    return True
        return False

    def remove_download(self, download_id):
        with self.lock:
            if download_id in self.queue:
                del self.queue[download_id]
                return True
        return False

    def clear_completed(self):
        with self.lock:
            to_remove = [k for k, v in self.queue.items()
                        if v.status in ('completed', 'error', 'cancelled')]
            for k in to_remove:
                del self.queue[k]
            return len(to_remove)

    def retry_download(self, download_id):
        with self.lock:
            item = self.queue.get(download_id)
            if item and item.status in ('error', 'cancelled'):
                item.status = 'queued'
                item.progress = 0
                item.speed = ''
                item.eta = ''
                item.error = ''
                self._emit('download_added', item.to_dict())
                self.executor.submit(self._execute_download, item)
                return True
        return False

    def get_queue(self):
        with self.lock:
            return [item.to_dict() for item in self.queue.values()]

    def get_stats(self):
        with self.lock:
            total = len(self.queue)
            completed = sum(1 for i in self.queue.values() if i.status == 'completed')
            active = sum(1 for i in self.queue.values() if i.status == 'downloading')
            queued = sum(1 for i in self.queue.values() if i.status == 'queued')
            errors = sum(1 for i in self.queue.values() if i.status == 'error')
            return {
                'total': total,
                'completed': completed,
                'active': active,
                'queued': queued,
                'errors': errors,
            }

    # ─── History Persistence ──────────────────────────────

    def _init_db(self):
        """تهيئة قاعدة البيانات ونقل البيانات من json إن وجدت"""
        with self.db_lock:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute('''CREATE TABLE IF NOT EXISTS history (
                            id TEXT PRIMARY KEY,
                            title TEXT,
                            url TEXT,
                            platform TEXT,
                            platform_label TEXT,
                            thumbnail TEXT,
                            duration INTEGER,
                            filename TEXT,
                            filesize INTEGER DEFAULT 0,
                            audio_only BOOLEAN,
                            completed_at TEXT
                        )''')
            c.execute('''CREATE TABLE IF NOT EXISTS pending_downloads (
                            id TEXT PRIMARY KEY,
                            url TEXT,
                            format_id TEXT,
                            audio_only BOOLEAN,
                            custom_filename TEXT,
                            schedule_time TEXT,
                            created_at TEXT
                        )''')
            c.execute('''CREATE TABLE IF NOT EXISTS app_settings (
                            key TEXT PRIMARY KEY,
                            value TEXT
                        )''')
            c.execute('''CREATE TABLE IF NOT EXISTS subscriptions (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            url TEXT UNIQUE,
                            title TEXT,
                            platform TEXT,
                            last_check TEXT,
                            last_video_url TEXT,
                            tg_chat_id TEXT
                        )''')
            
            # Add filesize column if missing (migration)
            try:
                c.execute("ALTER TABLE history ADD COLUMN filesize INTEGER DEFAULT 0")
                conn.commit()
            except Exception:
                pass  # Column already exists
            
            # Check for old JSON migration
            old_json = os.path.join(self.download_dir, 'history.json')
            if os.path.exists(old_json):
                try:
                    with open(old_json, 'r', encoding='utf-8') as f:
                        old_data = json.load(f)
                    for item in old_data:
                        c.execute('''INSERT OR IGNORE INTO history 
                                     (id, title, url, platform, platform_label, thumbnail, duration, filename, audio_only, completed_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                                  (item.get('id'), item.get('title'), item.get('url'), item.get('platform'), 
                                   item.get('platform_label'), item.get('thumbnail'), item.get('duration'), 
                                   item.get('filename'), item.get('audio_only', False), item.get('completed_at')))
                    conn.commit()
                    os.rename(old_json, old_json + '.bak')
                except Exception:
                    pass
            conn.close()

    def _save_to_history(self, item: DownloadItem):
        """إضافة تحميل مكتمل إلى قاعدة البيانات"""
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                completed_at = item.completed_at or datetime.now().isoformat()
                filename = os.path.basename(item.filename) if item.filename else ''
                c.execute('''INSERT OR REPLACE INTO history 
                             (id, title, url, platform, platform_label, thumbnail, duration, filename, filesize, audio_only, completed_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                          (item.id, item.title, item.url, item.platform, 
                           PLATFORM_LABELS.get(item.platform, 'غير معروف'), 
                           item.thumbnail, item.duration, filename, 
                           item.filesize, item.audio_only, completed_at))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"Error saving to DB: {e}")

    def get_history(self) -> list:
        """إرجاع سجل التحميلات من قاعدة البيانات مرتباً من الأحدث"""
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                conn.row_factory = sqlite3.Row
                c = conn.cursor()
                c.execute("SELECT * FROM history ORDER BY completed_at DESC LIMIT 500")
                rows = c.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception:
            return []

    def clear_history(self) -> int:
        """مسح سجل التحميلات من قاعدة البيانات"""
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                c.execute("SELECT COUNT(*) FROM history")
                res = c.fetchone()
                count = res[0] if res else 0
                c.execute("DELETE FROM history")
                conn.commit()
                conn.close()
                return count
        except Exception:
            return 0

    # ─── Pending Downloads (Auto-Resume) ──────────────

    def _save_pending(self, item: DownloadItem):
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute('''INSERT OR REPLACE INTO pending_downloads 
                         (id, url, format_id, audio_only, custom_filename, schedule_time, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)''',
                      (item.id, item.url, item.format_id, item.audio_only,
                       item.custom_filename, item.schedule_time, item.created_at))
            conn.commit()
            conn.close()
        except Exception:
            pass

    def _remove_pending(self, item_id: str):
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute("DELETE FROM pending_downloads WHERE id = ?", (item_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass

    def _resume_pending(self):
        """Resume downloads that were not completed in previous session"""
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute("SELECT * FROM pending_downloads")
            rows = c.fetchall()
            conn.close()

            for row in rows:
                row = dict(row)
                # Skip scheduled downloads that are in the future
                if row.get('schedule_time'):
                    try:
                        sched = datetime.fromisoformat(row['schedule_time'])
                        if sched > datetime.now():
                            # Re-add as scheduled
                            self.add_download(
                                row['url'], format_id=row.get('format_id', 'best'),
                                audio_only=row.get('audio_only', False),
                                custom_filename=row.get('custom_filename', ''),
                                schedule_time=row['schedule_time'],
                                enqueue_only=True
                            )
                            continue
                    except Exception:
                        pass
                # Resume immediately
                self.add_download(
                    row['url'], format_id=row.get('format_id', 'best'),
                    audio_only=row.get('audio_only', False),
                    custom_filename=row.get('custom_filename', '')
                )
                self._remove_pending(row['id'])

            if rows:
                print(f"  [RESUME] Resumed {len(rows)} pending downloads from previous session")
        except Exception as e:
            print(f"  [RESUME] No pending downloads to resume: {e}")

    # ─── Scheduled Downloads ──────────────────────────

    def _run_scheduler(self):
        """Background thread that checks for scheduled downloads every 30 seconds"""
        while self._scheduler_running:
            try:
                now = datetime.now()
                with self.lock:
                    for item in list(self.queue.values()):
                        if item.status == 'scheduled' and item.schedule_time:
                            try:
                                sched = datetime.fromisoformat(item.schedule_time)
                                if now >= sched:
                                    item.status = 'queued'
                                    self._emit('download_added', item.to_dict())
                                    self.executor.submit(self._execute_download, item)
                            except Exception:
                                pass
            except Exception:
                pass
            time.sleep(30)

    def add_download(self, url: str, format_id: str = 'best', audio_only: bool = False, mode: str = 'single', custom_filename: str = '', download_subtitles: bool = False, start_time: int = 0, end_time: int = 0, audio_format: str = 'mp3', video_format: str = 'none', enqueue_only: bool = False, schedule_time: str = '', tg_chat_id: str = '', tg_msg_id: str = '') -> DownloadItem:
        item = DownloadItem(
            id=str(uuid.uuid4())[:8],
            url=url,
            format_id=format_id,
            platform=detect_platform(url),
            audio_only=audio_only,
            mode=mode,
            custom_filename=custom_filename,
            download_subtitles=download_subtitles,
            start_time=start_time,
            end_time=end_time,
            audio_format=audio_format,
            video_format=video_format,
            schedule_time=schedule_time,
            tg_chat_id=tg_chat_id,
            tg_msg_id=tg_msg_id
        )

        # Handle scheduled downloads
        if schedule_time:
            try:
                sched = datetime.fromisoformat(schedule_time)
                if sched > datetime.now():
                    item.status = 'scheduled'
                    with self.lock:
                        self.queue[item.id] = item
                    self._save_pending(item)
                    self._emit('download_added', item.to_dict())
                    return item
            except Exception:
                pass

        with self.lock:
            self.queue[item.id] = item
        self._save_pending(item)
        self._emit('download_added', item.to_dict())
        
        if not enqueue_only:
            self.executor.submit(self._execute_download, item)
            
        return item

    # ─── Admin Stats ──────────────────────────────────

    def get_admin_stats(self) -> dict:
        """Aggregate stats for admin dashboard"""
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()

            # Total downloads
            c.execute("SELECT COUNT(*) FROM history")
            total_downloads = c.fetchone()[0] or 0

            # Total filesize
            c.execute("SELECT COALESCE(SUM(filesize), 0) FROM history")
            total_size = c.fetchone()[0] or 0

            # Per-platform count
            c.execute("SELECT platform, COUNT(*) as cnt FROM history GROUP BY platform ORDER BY cnt DESC")
            platform_breakdown = [{'platform': r[0], 'label': PLATFORM_LABELS.get(r[0], r[0]), 'count': r[1]} for r in c.fetchall()]

            # Daily downloads (last 7 days)
            c.execute("""SELECT DATE(completed_at) as day, COUNT(*) as cnt 
                         FROM history 
                         WHERE completed_at >= DATE('now', '-7 days')
                         GROUP BY day ORDER BY day""")
            daily = [{'date': r[0], 'count': r[1]} for r in c.fetchall()]

            # Storage on disk
            storage_used = 0
            try:
                for f in os.listdir(self.download_dir):
                    fp = os.path.join(self.download_dir, f)
                    if os.path.isfile(fp):
                        storage_used += os.path.getsize(fp)
            except Exception:
                pass

            conn.close()
            return {
                'total_downloads': total_downloads,
                'total_size': total_size,
                'storage_used': storage_used,
                'platform_breakdown': platform_breakdown,
                'daily': daily,
            }
        except Exception:
            return {'total_downloads': 0, 'total_size': 0, 'storage_used': 0, 'platform_breakdown': [], 'daily': []}

    def get_history_stats(self) -> dict:
        """Smart history statistics"""
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()

            c.execute("SELECT COUNT(*) FROM history")
            total = c.fetchone()[0] or 0

            c.execute("SELECT COALESCE(SUM(filesize), 0) FROM history")
            total_size = c.fetchone()[0] or 0

            c.execute("SELECT SUM(CASE WHEN audio_only=1 THEN 1 ELSE 0 END), SUM(CASE WHEN audio_only=0 THEN 1 ELSE 0 END) FROM history")
            row = c.fetchone()
            audio_count = row[0] or 0
            video_count = row[1] or 0

            c.execute("SELECT platform, COUNT(*) as cnt FROM history GROUP BY platform ORDER BY cnt DESC LIMIT 3")
            top_platforms = [{'platform': r[0], 'label': PLATFORM_LABELS.get(r[0], r[0]), 'count': r[1]} for r in c.fetchall()]

            conn.close()
            return {
                'total': total,
                'total_size': total_size,
                'audio_count': audio_count,
                'video_count': video_count,
                'top_platforms': top_platforms,
            }
        except Exception:
            return {'total': 0, 'total_size': 0, 'audio_count': 0, 'video_count': 0, 'top_platforms': []}

    # ─── Auto-Subscriptions ──────────────────────────

    def add_subscription(self, url: str, tg_chat_id: str = '') -> dict:
        """Add a new channel subscription"""
        try:
            platform = detect_platform(url)
            # Basic info extraction to get channel title
            ydl_opts = {'quiet': True, 'extract_flat': True}
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                title = info.get('title', url)
            
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                c.execute("INSERT OR REPLACE INTO subscriptions (url, title, platform, tg_chat_id, last_check) VALUES (?, ?, ?, ?, ?)",
                          (url, title, platform, tg_chat_id, datetime.now().isoformat()))
                conn.commit()
                conn.close()
            return {'success': True, 'title': title}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_subscriptions(self) -> list:
        """Get all active subscriptions"""
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                conn.row_factory = sqlite3.Row
                c = conn.cursor()
                c.execute("SELECT * FROM subscriptions")
                rows = c.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception:
            return []

    def remove_subscription(self, sub_id: int):
        """Remove a subscription by ID"""
        try:
            with self.db_lock:
                conn = sqlite3.connect(self.db_path)
                c = conn.cursor()
                c.execute("DELETE FROM subscriptions WHERE id = ?", (sub_id,))
                conn.commit()
                conn.close()
            return True
        except Exception:
            return False

    def _run_subscription_worker(self):
        """Background thread that checks for new videos in subscribed channels every 2 hours"""
        while self._subscription_running:
            try:
                subs = self.get_subscriptions()
                for sub in subs:
                    try:
                        url = sub['url']
                        # Extract only the latest entry
                        ydl_opts = {
                            'quiet': True, 
                            'extract_flat': True, 
                            'playlist_items': '1', 
                            'no_warnings': True
                        }
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            info = ydl.extract_info(url, download=False)
                            if 'entries' in info and info['entries']:
                                latest = info['entries'][0]
                                video_url = latest.get('url') or latest.get('webpage_url')
                                
                                # Check if it's a new video
                                if video_url and video_url != sub.get('last_video_url'):
                                    # Trigger download
                                    self.add_download(
                                        video_url, 
                                        tg_chat_id=sub.get('tg_chat_id', ''),
                                        audio_only=False # Default to video for auto-subs
                                    )
                                    
                                    # Update last_video_url in DB
                                    with self.db_lock:
                                        conn = sqlite3.connect(self.db_path)
                                        c = conn.cursor()
                                        c.execute("UPDATE subscriptions SET last_video_url = ?, last_check = ? WHERE id = ?",
                                                  (video_url, datetime.now().isoformat(), sub['id']))
                                        conn.commit()
                                        conn.close()
                    except Exception as e:
                        print(f"Subscription worker error for {sub.get('url')}: {e}")
            except Exception as e:
                print(f"Main subscription worker error: {e}")
            
            # Wait for 2 hours (7200 seconds)
            time.sleep(7200)
