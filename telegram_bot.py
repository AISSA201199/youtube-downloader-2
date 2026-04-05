import os
import sqlite3
import threading
import time
import json
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, InputMediaPhoto
import yt_dlp
from downloader import detect_platform, DownloadManager

def get_setting(db_path, key, default=None):
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT value FROM app_settings WHERE key = 'notification_settings'")
        row = c.fetchone()
        conn.close()
        if row:
            settings = json.loads(row[0])
            return settings.get(key, default)
        return default
    except Exception as e:
        print(f"[TG Bot] Error loading setting: {e}")
        return default

class TelegramBotManager:
    def __init__(self, manager: DownloadManager, db_path: str):
        self.manager = manager
        self.db_path = db_path
        self.bot = None
        self.running = False
        self.search_cache = {}  # chat_id -> search results list
        self.url_cache = {}  # uuid -> {url, title, thumbnail} for callbacks
        
        # Hooks mapping
        self.manager.register_progress_callback(self.on_download_progress)
        self.manager.register_completion_callback(self.on_download_complete)
        
        self._thread = None
        
    def start(self):
        token = get_setting(self.db_path, 'telegram_token')
        if not token:
            print("[TG Bot] Token not configured. Waiting for configuration.")
            return

        print("[TG Bot] Starting legendary bot instance...")
        self.bot = telebot.TeleBot(token, parse_mode='HTML')
        self.setup_handlers()
        
        self.running = True
        self._thread = threading.Thread(target=self._poll, daemon=True)
        self._thread.start()

    def _poll(self):
        while self.running:
            try:
                if self.bot:
                    self.bot.infinity_polling(timeout=10, long_polling_timeout=5)
            except Exception as e:
                time.sleep(5)
                
    def stop(self):
        self.running = False
        if self.bot:
            self.bot.stop_polling()
            
    # -------------- Hooks --------------
    def on_download_progress(self, item):
        if not self.bot or not item.tg_chat_id or not item.tg_msg_id:
            return
            
        try:
            pct = item.progress
            # Fancy block progress bar
            filled_len = int(20 * pct // 100)
            bar = '🟩' * filled_len + '⬜' * (20 - filled_len)
            
            text = f"🔄 <b>جاري التحميل...</b>\n"
            text += f"🎬 <b>{item.title}</b>\n\n"
            text += f"{bar}\n"
            text += f"📈 <b>النسبة:</b> {pct:.1f}%\n"
            text += f"⚡ <b>السرعة:</b> {item.speed or '...'}\n"
            text += f"⏳ <b>الوقت المتبقي:</b> {item.eta or '...'}\n"
            
            markup = InlineKeyboardMarkup()
            markup.add(InlineKeyboardButton("❌ إلغاء التحميل", callback_data=f"cancel|{item.id}"))
            
            self.bot.edit_message_text(text, chat_id=item.tg_chat_id, message_id=item.tg_msg_id, reply_markup=markup)
        except Exception as e:
            pass

    def on_download_complete(self, item):
        if not self.bot or not item.tg_chat_id or not item.tg_msg_id:
            return
            
        try:
            if item.status == 'error':
                text = f"❌ <b>فشل التحميل!</b>\n"
                text += f"🎬 {item.title}\n"
                text += f"⚠️ <b>السبب:</b> {item.error or 'خطأ غير معروف'}"
                self.bot.edit_message_text(text, chat_id=item.tg_chat_id, message_id=item.tg_msg_id)
                return

            text = f"✅ <b>اكتمل التحميل بنجاح!</b>\n"
            text += f"🎬 {item.title}\n\n"
            text += f"🚀 <i>يتم الآن تجهيز الملف لإرساله إليك...</i>"
            self.bot.edit_message_text(text, chat_id=item.tg_chat_id, message_id=item.tg_msg_id)
            
            if os.path.exists(item.filename):
                file_size = os.path.getsize(item.filename)
                if file_size > 50 * 1024 * 1024:
                    text_large = f"⚠️ <b>الملف كبير جداً!</b>\n"
                    text_large += f"🗂 حجم الملف أكبر من 50MB (الحد الأقصى للتلقرام).\n\n"
                    text_large += f"✅ <i>لكنه محفوظ في الخادم الخاص بك ومتاح للمشاهدة!</i>"
                    self.bot.edit_message_text(text_large, chat_id=item.tg_chat_id, message_id=item.tg_msg_id)
                else:
                    self.bot.send_chat_action(item.tg_chat_id, 'upload_video' if not item.audio_only else 'upload_audio')
                    with open(item.filename, 'rb') as f:
                        if item.audio_only or item.filename.endswith('.mp3'):
                            self.bot.send_audio(item.tg_chat_id, f, title=item.title, caption=f"🎵 {item.title}\n✨ مُحمل عبر سيرفرك الخاص")
                        else:
                            self.bot.send_video(item.tg_chat_id, f, caption=f"🎬 {item.title}\n✨ مُحمل عبر سيرفرك الخاص")
                    
                    text_done = f"🎉 <b>تم الإرسال بنجاح!</b>\n🎬 {item.title}"
                    self.bot.edit_message_text(text_done, chat_id=item.tg_chat_id, message_id=item.tg_msg_id)
            else:
                self.bot.edit_message_text("⚠️ خطأ تعذّر العثور على الملف للإرسال.", chat_id=item.tg_chat_id, message_id=item.tg_msg_id)
                
        except Exception as e:
            try:
                self.bot.send_message(item.tg_chat_id, f"⚠️ خطأ أثناء إرسال الملف: {str(e)[:100]}")
            except: pass

    # -------------- Utility --------------
    def is_auth(self, chat_id):
        owner_id = get_setting(self.db_path, 'telegram_chat_id')
        if not owner_id: return True
        return str(chat_id) == str(owner_id)

    # -------------- Main Handlers --------------
    def setup_handlers(self):
        bot = self.bot

        def get_dashboard_markup():
            markup = InlineKeyboardMarkup(row_width=2)
            markup.add(
                InlineKeyboardButton("🔍 بحث يوتيوب", callback_data="dash|search"),
                InlineKeyboardButton("📥 قائمة التحميلات", callback_data="dash|queue")
            )
            markup.add(
                InlineKeyboardButton("📊 الإحصائيات", callback_data="dash|stats"),
                InlineKeyboardButton("⚙️ الإعدادات", callback_data="dash|settings")
            )
            markup.add(
                InlineKeyboardButton("📡 الاشتراكات التلقائية", callback_data="dash|subs")
            )
            return markup

        @bot.message_handler(commands=['start', 'help', 'dashboard'])
        def send_welcome(message):
            if not self.is_auth(message.chat.id):
                bot.reply_to(message, "⛔ عذراً، هذا البوت خاص بك فقط.")
                return
            
            text = (
                "👋 <b>أهلاً بك في Video Downloader Pro</b>\n\n"
                "أنا بوت تحميل <b>احترافي، سريع، وخالي من الإعلانات!</b> 🔥\n\n"
                "📌 <b>كيف أعمل؟</b>\n"
                "1️⃣ أرسل لي أي رابط (يوتيوب، تيك توك، إلخ).\n"
                "2️⃣ اختر الجودة التي تريدها من الأزرار.\n"
                "3️⃣ سأحمل المقطع بسرعة فائقة في سيرفرك وأرسله لك!\n\n"
                "👇 <b>أو استخدم لوحة التحكم المتقدمة:</b>"
            )
            bot.send_message(message.chat.id, text, reply_markup=get_dashboard_markup())

        @bot.callback_query_handler(func=lambda call: call.data.startswith('dash|'))
        def dash_callback(call):
            if not self.is_auth(call.message.chat.id): return
            action = call.data.split('|')[1]
            
            if action == 'queue':
                stats = self.manager.get_stats()
                queue_items = [i for i in self.manager.queue.values() if i.status in ('downloading', 'queued')]
                
                if not queue_items:
                    bot.answer_callback_query(call.id, "📭 لا يوجد تحميلات جارية حالياً.", show_alert=True)
                    return
                    
                text = f"📊 <b>التحميلات الحالية ({stats['active']} نشط، {stats['queued']} انتظار)</b>\n\n"
                markup = InlineKeyboardMarkup()
                for i in queue_items:
                    status_icon = "🟢" if i.status == 'downloading' else "🟡"
                    text += f"{status_icon} <b>{i.title or 'جاري تجهيز التحميل'}</b>\n"
                    if i.status == 'downloading':
                        text += f"   التقدم: {i.progress}% | السرعة: {i.speed}\n\n"
                    markup.add(InlineKeyboardButton(f"❌ إلغاء {i.title[:15]}...", callback_data=f"cancel|{i.id}"))
                
                markup.add(InlineKeyboardButton("⬅️ العودة للرئيسية", callback_data="dash|home"))
                bot.edit_message_text(text, chat_id=call.message.chat.id, message_id=call.message.message_id, reply_markup=markup)
                
            elif action == 'stats':
                admin = self.manager.get_admin_stats()
                size_mb = admin.get('total_size', 0) / (1024 * 1024)
                text = (
                    "📈 <b>إحصائيات الخادم الخاص بك</b>\n\n"
                    f"📥 <b>إجمالي التحميلات:</b> {admin.get('total_downloads', 0)}\n"
                    f"💾 <b>مساحة التخزين المستهلكة:</b> {size_mb:.1f} MB\n\n"
                    f"🔥 <i>كل شيء يعمل بسرعة وكفاءة عالية.</i>"
                )
                markup = InlineKeyboardMarkup().add(InlineKeyboardButton("⬅️ العودة للرئيسية", callback_data="dash|home"))
                bot.edit_message_text(text, chat_id=call.message.chat.id, message_id=call.message.message_id, reply_markup=markup)
            
            elif action == 'search':
                text = "🔎 <b>للبحث في يوتيوب</b>\n\nقم بكتابة الأمر التالي:\n<code>/search [كلمة البحث]</code>\n\nأو ببساطة أرسل لي رابط الفيديو المباشر."
                markup = InlineKeyboardMarkup().add(InlineKeyboardButton("⬅️ العودة للرئيسية", callback_data="dash|home"))
                bot.edit_message_text(text, chat_id=call.message.chat.id, message_id=call.message.message_id, reply_markup=markup)
                
            elif action == 'settings':
                text = "⚙️ <b>الإعدادات المتقدمة</b>\n\nهذه الميزات (كالاشتراكات والجدولة التلقائية) قيد التطوير وستتوفر قريباً! 🚀"
                markup = InlineKeyboardMarkup().add(InlineKeyboardButton("⬅️ العودة للرئيسية", callback_data="dash|home"))
                bot.edit_message_text(text, chat_id=call.message.chat.id, message_id=call.message.message_id, reply_markup=markup)
            
            elif action == 'home':
                text = "👋 <b>أهلاً بك في Video Downloader Pro</b>\nاختر من لوحة التحكم:"
                bot.edit_message_text(text, chat_id=call.message.chat.id, message_id=call.message.message_id, reply_markup=get_dashboard_markup())

        @bot.callback_query_handler(func=lambda call: call.data.startswith('cancel|'))
        def cancel_dl_callback(call):
            if not self.is_auth(call.message.chat.id): return
            dl_id = call.data.split('|')[1]
            item = self.manager.queue.get(dl_id)
            if item:
                item.status = 'cancelled'
                bot.answer_callback_query(call.id, "🚫 تم إيقاف وإلغاء التحميل بنجاح!", show_alert=True)
                bot.edit_message_text(f"❌ <b>تم الإلغاء</b>\nالتحميل: {item.title}", chat_id=call.message.chat.id, message_id=call.message.message_id)
            else:
                bot.answer_callback_query(call.id, "⚠️ لم يتم العثور على هذا التحميل, قد يكون منتهي.", show_alert=True)

        @bot.message_handler(commands=['search'])
        def handle_search(message):
            if not self.is_auth(message.chat.id): return
            query = message.text.replace('/search', '').strip()
            if not query:
                bot.reply_to(message, "🔍 أرسل الكلمة مع الأمر، مثال:\n`/search القرآن الكريم`", parse_mode='Markdown')
                return
                
            msg = bot.reply_to(message, "⏳ <b>جاري البحث في يوتيوب...</b> 🔎")
            
            def do_search():
                results = self.manager.search_youtube(query, max_results=10)
                if not results:
                    bot.edit_message_text("❌ لم يتم العثور على أي نتائج، جرب عبارة أخرى.", chat_id=msg.chat.id, message_id=msg.message_id)
                    return
                
                # Save results to cache for pagination
                self.search_cache[message.chat.id] = results
                
                show_search_page(message.chat.id, msg.message_id, 0, query)
                
            threading.Thread(target=do_search).start()

        def show_subscriptions(chat_id, message_id=None):
            subs = self.manager.get_subscriptions()
            text = "📡 <b>قائمة الاشتراكات التلقائية</b>\n\n"
            text += "يقوم البوت بمراقبة هذه القنوات وتحميل أي فيديو جديد فور صدوره! 🔥\n\n"
            
            markup = InlineKeyboardMarkup(row_width=1)
            
            if not subs:
                text += "<i>لا توجد اشتراكات حالياً.</i>\n\n💡 لأضافة قناة، أرسل رابط القناة مباشرة هنا."
            else:
                for sub in subs:
                    btn_text = f"❌ {sub['title']} ({sub['platform']})"
                    markup.add(InlineKeyboardButton(btn_text, callback_data=f"subdel|{sub['id']}"))
                text += "👇 اضغط على اسم القناة لإلغاء الاشتراك:"

            markup.add(InlineKeyboardButton("🔙 العودة للقائمة", callback_data="dash|back"))
            
            if message_id:
                bot.edit_message_text(text, chat_id=chat_id, message_id=message_id, reply_markup=markup)
            else:
                bot.send_message(chat_id, text, reply_markup=markup)

        @bot.callback_query_handler(func=lambda call: call.data.startswith('subdel|'))
        def handle_sub_delete(call):
            if not self.is_auth(call.message.chat.id): return
            sub_id = int(call.data.split('|')[1])
            if self.manager.remove_subscription(sub_id):
                bot.answer_callback_query(call.id, "✅ تم إلغاء الاشتراك بنجاح!")
                show_subscriptions(call.message.chat.id, call.message.message_id)
            else:
                bot.answer_callback_query(call.id, "❌ حدث خطأ أثناء الحذف.", show_alert=True)

        def show_search_page(chat_id, message_id, page_index, query):
            results = self.search_cache.get(chat_id, [])
            if not results: return
            
            item = results[page_index]
            total = len(results)
            
            text = f"🔍 <b>نتيجة البحث ({page_index+1}/{total})</b>\n\n"
            text += f"🎬 <b>{item['title']}</b>\n"
            text += f"⏱ المدة: {item.get('duration_str', 'غير متوفر')}\n"
            text += f"👁 المشاهدات: {item.get('view_count_str', 'غير متوفر')}\n\n"
            text += f"🔗 الرابط: <a href='{item['url']}'>اضغط هنا</a>"
            
            # Save url for callback download
            import uuid
            uid = str(uuid.uuid4())[:8]
            self.url_cache[uid] = {'url': item['url'], 'title': item['title']}
            
            markup = InlineKeyboardMarkup()
            markup.row(
                InlineKeyboardButton("🎬 تحميل فيديو", callback_data=f"fastdl|{uid}|vid|best"),
                InlineKeyboardButton("🎵 تحميل MP3", callback_data=f"fastdl|{uid}|aud|bestaudio")
            )
            
            # Nav buttons
            nav = []
            if page_index > 0:
                nav.append(InlineKeyboardButton("⬅️ السابق", callback_data=f"nav|{page_index-1}"))
            if page_index < total - 1:
                nav.append(InlineKeyboardButton("التالي ➡️", callback_data=f"nav|{page_index+1}"))
            
            if nav: markup.row(*nav)
            markup.add(InlineKeyboardButton("❌ إغلاق البحث", callback_data="nav|close"))
            
            bot.edit_message_text(text, chat_id=chat_id, message_id=message_id, reply_markup=markup, disable_web_page_preview=True)

        @bot.callback_query_handler(func=lambda call: call.data.startswith('nav|'))
        def nav_callback(call):
            if not self.is_auth(call.message.chat.id): return
            action = call.data.split('|')[1]
            if action == 'close':
                bot.delete_message(call.message.chat.id, call.message.message_id)
                return
            page = int(action)
            # Query is lost in pagination but we don't need it just to show UI if we have cache
            show_search_page(call.message.chat.id, call.message.message_id, page, "")

        # ----------------- VOICE SEARCH -----------------
        @bot.message_handler(content_types=['voice'])
        def handle_voice_search(message):
            if not self.is_auth(message.chat.id): return
            
            msg = bot.reply_to(message, "🎙️ <b>جاري الاستماع وتحليل الصوت...</b> ⏳")
            
            def process_voice():
                try:
                    import speech_recognition as sr
                    from pydub import AudioSegment
                    import tempfile
                    
                    # Download voice file
                    file_info = bot.get_file(message.voice.file_id)
                    downloaded_file = bot.download_file(file_info.file_path)
                    
                    with tempfile.NamedTemporaryFile(delete=False, suffix=".ogg") as ogg_file:
                        ogg_file.write(downloaded_file)
                        ogg_path = ogg_file.name
                        
                    wav_path = ogg_path.replace(".ogg", ".wav")
                    
                    # Convert OGG to WAV
                    audio = AudioSegment.from_file(ogg_path, format="ogg")
                    audio.export(wav_path, format="wav")
                    
                    # Recognize speech
                    r = sr.Recognizer()
                    with sr.AudioFile(wav_path) as source:
                        audio_data = r.record(source)
                        try:
                            # Try Arabic first, fallback to English
                            text = r.recognize_google(audio_data, language='ar-SA')
                        except sr.UnknownValueError:
                            try:
                                text = r.recognize_google(audio_data, language='en-US')
                            except sr.UnknownValueError:
                                text = ""
                    
                    # Cleanup temp files
                    try:
                        os.remove(ogg_path)
                        os.remove(wav_path)
                    except: pass
                    
                    if not text:
                        bot.edit_message_text("❌ <b>عذراً، لم أتمكن من فهم الصوت بوضوح.</b>", chat_id=msg.chat.id, message_id=msg.message_id)
                        return
                    
                    bot.edit_message_text(f"🗣️ <b>فهمت بحثك:</b> <i>{text}</i>\n🔍 جاري البحث في يوتيوب...", chat_id=msg.chat.id, message_id=msg.message_id)
                    
                    import yt_dlp
                    ydl_opts = {
                        'default_search': 'ytsearch10',
                        'quiet': True,
                        'extract_flat': True
                    }
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(text, download=False)
                        if 'entries' in info and info['entries']:
                            results = list(info['entries'])
                            for r in results:
                                if r.get('view_count'):
                                    r['view_count_str'] = f"{r['view_count']:,}"
                                if r.get('duration'):
                                    r['duration_str'] = f"{int(r['duration'])//60}:{int(r['duration'])%60:02d}"
                            
                            self.search_cache[message.chat.id] = results
                            show_search_page(message.chat.id, msg.message_id, 0, text)
                        else:
                            bot.edit_message_text("❌ لم يتم العثور على أي نتائج للبحث الصوتي.", chat_id=msg.chat.id, message_id=msg.message_id)

                except Exception as e:
                    bot.edit_message_text(f"❌ <b>حدث خطأ أثناء معالجة الصوت:</b>\n{str(e)[:100]}", chat_id=msg.chat.id, message_id=msg.message_id)
            
            threading.Thread(target=process_voice).start()

        # ----------------- SMART LINK PARSING -----------------
        @bot.message_handler(func=lambda msg: msg.text and ('http://' in msg.text or 'https://' in msg.text))
        def handle_link_smart(message):
            if not self.is_auth(message.chat.id): return
            
            url = None
            for word in message.text.split():
                if word.startswith('http://') or word.startswith('https://'):
                    url = word
                    break
            if not url: return

            msg = bot.reply_to(message, "⏳ <b>جاري تحليل الرابط بذكاء...</b> 🔍")

            def extract_info():
                try:
                    info = self.manager.get_video_info(url)
                    if 'error' in info:
                        bot.edit_message_text(f"❌ <b>أوبس!</b>\n{info['error']}", chat_id=msg.chat.id, message_id=msg.message_id)
                        return
                    
                    title = info.get('title', 'Unknown Title')
                    duration = info.get('duration', 0)
                    mins, secs = divmod(duration, 60)
                    formats = info.get('formats', [])
                    import uuid
                    uid = str(uuid.uuid4())[:8]
                    self.url_cache[uid] = {'url': url, 'title': title}

                    text = f"✨ <b>تم تحليل الفيديو بنجاح!</b>\n\n"
                    text += f"🎬 <b>العنوان:</b> {title}\n"
                    text += f"⏱ <b>المدة:</b> {mins}:{secs:02d}\n"
                    text += f"🌍 <b>المصدر:</b> {info.get('platform_label', 'Unknown')}\n\n"
                    text += f"👇 <i>اختر صيغة وجودة التحميل التي تناسبك:</i>"
                    
                    is_channel = info.get('is_playlist', False) or 'channel' in url or 'user' in url or 'c/' in url
                    
                    if is_channel:
                        text = f"📡 <b>تم اكتشاف قناة:</b> {title}\n\n"
                        text += "هل تريد الاشتراك التلقائي؟ سيقوم البوت بتحميل أي فيديو جديد ينزل في هذه القناة فوراً! 🚀"
                        markup.add(InlineKeyboardButton("🔔 اشتراك تلقائي للمستقبل", callback_data=f"subscr|{uid}"))
                    else:
                        added_formats = 0
                        for f in formats:
                            if added_formats >= 4: break
                            if f.get('audio_only'): continue
                            
                            f_id = f.get('format_id', 'best')
                            label = f.get('label', 'أفضل جودة')
                            size = f.get('filesize', 0)
                            size_str = f"{size / (1024*1024):.1f}MB" if size else "مجهول"
                            
                            # Use a shorter format_id format string if the format ID is already exact to save space in callback
                            safe_f_id = f_id if len(f_id) < 30 else 'best'
                            btn_text = f"🎬 {label} - {size_str}"
                            markup.add(InlineKeyboardButton(btn_text, callback_data=f"fastdl|{uid}|vid|{safe_f_id}"))
                            added_formats += 1

                        audio_fmt = next((f for f in formats if f.get('audio_only')), None)
                        if audio_fmt:
                            size = audio_fmt.get('filesize', 0)
                            size_str = f"{size / (1024*1024):.1f}MB" if size else "مجهول"
                            markup.add(InlineKeyboardButton(f"🎵 صوت فقط (MP3) - {size_str} 🎧", callback_data=f"fastdl|{uid}|aud|bestaudio"))
                        else:
                            markup.add(InlineKeyboardButton("🎵 تحميل صوت فقط (MP3) 🎧", callback_data=f"fastdl|{uid}|aud|bestaudio"))
                        
                    markup.add(InlineKeyboardButton("❌ إلغاء", callback_data="nav|close"))
                    
                    thumb = info.get('thumbnail')
                    if thumb:
                        try:
                            bot.delete_message(msg.chat.id, msg.message_id) # delete loading text
                        except: pass
                        bot.send_photo(message.chat.id, thumb, caption=text, reply_markup=markup, parse_mode='HTML')
                    else:
                        bot.edit_message_text(text, chat_id=msg.chat.id, message_id=msg.message_id, reply_markup=markup)
                        
                except Exception as e:
                    bot.edit_message_text(f"❌ <b>عذراً، لم أتمكن من تحليل هذا الرابط.</b>\nالسبب: {str(e)[:100]}", 
                                          chat_id=msg.chat.id, message_id=msg.message_id)
            
            threading.Thread(target=extract_info).start()

        @bot.callback_query_handler(func=lambda call: call.data.startswith('subscr|'))
        def handle_subscribe_callback(call):
            if not self.is_auth(call.message.chat.id): return
            uid = call.data.split('|')[1]
            cache_info = self.url_cache.get(uid)
            if not cache_info:
                bot.answer_callback_query(call.id, "⚠️ الجلسة منتهية.")
                return
            
            res = self.manager.add_subscription(cache_info['url'], tg_chat_id=str(call.message.chat.id))
            if res.get('success'):
                bot.edit_message_text(f"✅ <b>تم الاشتراك بنجاح!</b>\nسيتم تحميل أي فيديو جديد من <i>{res['title']}</i> وإرساله لك هنا.", 
                                      chat_id=call.message.chat.id, message_id=call.message.message_id)
            else:
                bot.answer_callback_query(call.id, f"❌ فشل الاشتراك: {res.get('error')}", show_alert=True)

        @bot.callback_query_handler(func=lambda call: call.data.startswith('fastdl|'))
        def handle_download_callback(call):
            if not self.is_auth(call.message.chat.id): return
            
            parts = call.data.split('|')
            uid = parts[1]
            dl_type = parts[2]
            f_id = parts[3] if len(parts) > 3 else 'best'
            
            cache_info = self.url_cache.get(uid)
            if not cache_info:
                bot.answer_callback_query(call.id, "⚠️ الجلسة منتهية، يرجى إرسال الرابط مجدداً.", show_alert=True)
                return
                
            url = cache_info['url']
            audio_only = (dl_type == 'aud')
            
            # Start download
            try:
                # If message is caption of photo
                if call.message.content_type == 'photo':
                    bot.edit_message_caption("⏳ <b>يتم إضافته لطابور التحميل...</b>", 
                                             chat_id=call.message.chat.id, 
                                             message_id=call.message.message_id)
                    # We have to keep using edit_message_caption instead of edit_message_text
                    bot.delete_message(call.message.chat.id, call.message.message_id)
                    msg = bot.send_message(call.message.chat.id, "⏳ <b>جاري بدء التحميل...</b>")
                else:
                    msg = bot.edit_message_text("⏳ <b>يتم إضافته لطابور التحميل...</b>", 
                                                chat_id=call.message.chat.id, 
                                                message_id=call.message.message_id)
            except Exception as e:
                # Fallback if error editing photo caption
                msg = bot.send_message(call.message.chat.id, "⏳ <b>جاري التجهيز...</b>")
                                        
            item = self.manager.add_download(
                url=url,
                format_id=f_id,
                audio_only=audio_only,
                tg_chat_id=str(call.message.chat.id),
                tg_msg_id=str(msg.message_id)
            )


# global instance
_tg_manager = None

def init_telegram_bot(manager, db_path):
    global _tg_manager
    if _tg_manager:
        _tg_manager.stop()
    
    _tg_manager = TelegramBotManager(manager, db_path)
    _tg_manager.start()

def restart_telegram_bot():
    global _tg_manager
    if _tg_manager:
        _tg_manager.stop()
        _tg_manager.start()
