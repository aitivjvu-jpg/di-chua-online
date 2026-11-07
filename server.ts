import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// TikTok LIVE Integration State
interface TikTokStats {
  isConnected: boolean;
  isConnecting: boolean;
  username: string;
  roomId: string;
  viewerCount: number;
  totalLikes: number;
  error?: string;
}

let activeTikTokConn: InstanceType<typeof TikTokLiveConnection> | null = null;
let activeTikTokSession = 0;
let sseClients: express.Response[] = [];
let liveStats: TikTokStats = {
  isConnected: false,
  isConnecting: false,
  username: '',
  roomId: '',
  viewerCount: 0,
  totalLikes: 0,
  error: '',
};

function broadcastSSE(eventType: string, data: unknown) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => {
    try {
      client.write(payload);
    } catch {
      // client disconnected
    }
  });
}

// TikTok Live SSE Stream
app.get('/api/tiktok/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send current status right away
  res.write(`event: status\ndata: ${JSON.stringify(liveStats)}\n\n`);
  if (lastRateControl) res.write(`event: control\ndata: ${JSON.stringify(lastRateControl)}\n\n`);

  for (const c of settingsControls()) res.write(`event: control\ndata: ${JSON.stringify(c)}\n\n`);
  sseClients.push(res);

  // Keep-alive heartbeat every 20s
  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// TikTok Live Current Status
app.get('/api/tiktok/status', (_req, res) => {
  return res.json({ success: true, data: liveStats });
});

// Connect to TikTok Live room by username
app.post('/api/tiktok/connect', async (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ success: false, error: 'Thiếu tên tài khoản TikTok (username)' });
  }

  const cleanUser = username.replace(/^@/, '').trim();
  if (!cleanUser) {
    return res.status(400).json({ success: false, error: 'Tên tài khoản không hợp lệ' });
  }

  try {
    // Invalidate the previous connection before disconnecting it.
    const sessionId = ++activeTikTokSession;
    // If already connected to another room, disconnect first
    if (activeTikTokConn) {
      try {
        activeTikTokConn.disconnect();
      } catch {
        // ignore
      }
      activeTikTokConn = null;
    }

    liveStats = {
      isConnected: false,
      isConnecting: true,
      username: cleanUser,
      roomId: '',
      viewerCount: 0,
      totalLikes: 0,
      error: '',
    };
    broadcastSSE('status', liveStats);

    const conn = new TikTokLiveConnection(cleanUser, {
      processInitialData: true,
      // The gift-list fetch behind this option needs a paid Euler Stream plan; gift events already carry name and diamonds
      enableExtendedGiftInfo: false,
    });

    conn.on(ControlEvent.CONNECTED, (state: { roomId?: string }) => {
      if (sessionId !== activeTikTokSession) return;
      console.log(`[TikTok LIVE] Connected to @${cleanUser}, room ID: ${state?.roomId}`);
      liveStats = {
        isConnected: true,
        isConnecting: false,
        username: cleanUser,
        roomId: state?.roomId || '',
        viewerCount: liveStats.viewerCount,
        totalLikes: liveStats.totalLikes,
        error: '',
      };
      broadcastSSE('status', liveStats);
      broadcastSSE('connected', { username: cleanUser, roomId: state?.roomId });
    });

    conn.on(ControlEvent.DISCONNECTED, () => {
      if (sessionId !== activeTikTokSession) return;
      console.log(`[TikTok LIVE] Disconnected from @${cleanUser}`);
      liveStats.isConnected = false;
      liveStats.isConnecting = false;
      broadcastSSE('status', liveStats);
      broadcastSSE('disconnected', { username: cleanUser });
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      if (sessionId !== activeTikTokSession) return;
      console.log(`[TikTok LIVE] Stream ended for @${cleanUser}`);
      liveStats.isConnected = false;
      liveStats.isConnecting = false;
      liveStats.error = 'Phiên Live trên TikTok đã kết thúc';
      broadcastSSE('status', liveStats);
      broadcastSSE('streamEnd', { username: cleanUser });
    });

    conn.on(WebcastEvent.CHAT, (data: any) => {
      if (sessionId !== activeTikTokSession) return;
      const chatEvent = {
        username: data?.user?.displayId || data?.user?.uniqueId || data?.uniqueId || 'devotee',
        nickname: data?.user?.nickname || data?.nickname || data?.uniqueId || 'Phật tử',
        // tiktok-live-proto v3 puts the text in `content` (v1 used `comment`)
        comment: data?.content || data?.comment || '',
        avatar: data?.user?.avatarThumb?.urlList?.[0] || "",
        timestamp: Date.now(),
      };
      broadcastSSE('chat', chatEvent);
    });

    // TikTok resends streak gifts with a cumulative repeatCount; only forward the new units
    const streakCounts = new Map<string, number>();

    conn.on(WebcastEvent.GIFT, (data: any) => {
      if (sessionId !== activeTikTokSession) return;
      const username = data?.user?.displayId || data?.user?.uniqueId || data?.uniqueId || 'devotee';
      const giftId = data?.giftId || 0;
      const streakKey = `${username}_${giftId}`;
      const total = data?.repeatCount || 1;
      const delta = total - (streakCounts.get(streakKey) || 0);
      const isStreakable = (data?.gift?.type ?? data?.giftDetails?.giftType ?? data?.giftType) === 1;
      if (isStreakable && !data?.repeatEnd) streakCounts.set(streakKey, total);
      else streakCounts.delete(streakKey);
      if (delta <= 0) return;

      const giftEvent = {
        username,
        nickname: data?.user?.nickname || data?.nickname || data?.uniqueId || 'Thí chủ',
        giftName: data?.gift?.name || data?.giftDetails?.giftName || data?.giftName || 'Hoa Sen',
        giftId,
        diamondCount: data?.gift?.diamondCount || data?.diamondCount || data?.giftDetails?.diamondCount || 1,
        repeatCount: delta,
        repeatEnd: data?.repeatEnd ?? 1,
        avatar: data?.user?.avatarThumb?.urlList?.[0] || "",
        timestamp: Date.now(),
      };
      broadcastSSE('gift', giftEvent);
    });

    conn.on(WebcastEvent.MEMBER, (data: any) => {
      if (sessionId !== activeTikTokSession) return;
      const memberEvent = {
        username: data?.user?.displayId || data?.user?.uniqueId || data?.uniqueId || 'devotee',
        nickname: data?.user?.nickname || data?.nickname || data?.uniqueId || 'Phật tử',
        avatar: data?.user?.avatarThumb?.urlList?.[0] || "",
        timestamp: Date.now(),
      };
      broadcastSSE('member', memberEvent);
    });

    conn.on(WebcastEvent.FOLLOW, (data: any) => {
      if (sessionId !== activeTikTokSession) return;
      broadcastSSE('follow', {
        username: data?.user?.displayId || data?.user?.uniqueId || data?.uniqueId || 'devotee',
        nickname: data?.user?.nickname || data?.nickname || data?.uniqueId || 'Phật tử',
        timestamp: Date.now(),
      });
    });

    conn.on(WebcastEvent.ROOM_USER, (data: any) => {
      if (sessionId !== activeTikTokSession) return;
      if (typeof data?.viewerCount === 'number') {
        liveStats.viewerCount = data.viewerCount;
        broadcastSSE('roomUser', { viewerCount: data.viewerCount });
      }
    });

    conn.on(WebcastEvent.LIKE, (data: any) => {
      if (sessionId !== activeTikTokSession) return;
      if (typeof data?.totalLikeCount === 'number') {
        liveStats.totalLikes = data.totalLikeCount;
      }
      broadcastSSE('like', {
        username: data?.user?.displayId || data?.user?.uniqueId || data?.uniqueId || '',
        nickname: data?.user?.nickname || data?.nickname || '',
        likeCount: data?.likeCount || 1,
        totalLikes: liveStats.totalLikes,
      });
    });

    conn.on(ControlEvent.ERROR, (err: unknown) => {
      if (sessionId !== activeTikTokSession) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[TikTok LIVE] Error for @${cleanUser}:`, errMsg);
      liveStats.error = errMsg;
      broadcastSSE('status', liveStats);
    });

    activeTikTokConn = conn;

    // Connect to room (note: user might not be live right now)
    conn
      .connect()
      .then((state: { roomId?: string }) => {
        if (sessionId !== activeTikTokSession) return res.status(409).json({ success: false, error: 'Yêu cầu kết nối đã được thay thế bởi phiên mới' });
        return res.json({
          success: true,
          message: `Đang kết nối phòng live @${cleanUser}`,
          roomId: state.roomId,
        });
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (sessionId !== activeTikTokSession) return res.status(409).json({ success: false, error: 'Yêu cầu kết nối đã được thay thế bởi phiên mới' });
        console.error(`[TikTok LIVE] Connect error for @${cleanUser}:`, errMsg);
        liveStats.isConnecting = false;
        liveStats.isConnected = false;
        liveStats.error = errMsg;
        broadcastSSE('status', liveStats);
        return res.status(400).json({
          success: false,
          error: `Không thể kết nối với @${cleanUser}: ${errMsg}. Hãy đảm bảo tài khoản đang bấm Phát trực tiếp (LIVE) trên TikTok!`,
        });
      });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    liveStats.isConnecting = false;
    liveStats.isConnected = false;
    liveStats.error = errMsg;
    broadcastSSE('status', liveStats);
    return res.status(500).json({ success: false, error: errMsg });
  }
});

// Streamer commands from the dashboard, relayed to the live stage page(s) that make the sound
const CONTROL_ACTIONS = ['speak', 'shareReminder', 'bell', 'setRate', 'setName', 'setTopBoard', 'setKeyword', 'setBoardTitle'];

// Dashboard settings that survive restarts, in settings.json next to this file: channel name (title + what the
// voice says), TOP board on/off, the comment keyword that sends someone up, the board's title and a custom
// background. Replayed to every page when it connects.
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
let settings: {
  channelName?: string;
  showTopBoard?: boolean;
  keyword?: string;
  boardTitle?: string;
  background?: string;
} = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  // no settings yet: the app's defaults are used
}
const settingsControls = () => {
  const list: Array<{ action: string; text: string }> = [];
  if (settings.channelName) list.push({ action: 'setName', text: settings.channelName });
  if (typeof settings.showTopBoard === 'boolean') list.push({ action: 'setTopBoard', text: settings.showTopBoard ? '1' : '0' });
  if (settings.keyword) list.push({ action: 'setKeyword', text: settings.keyword });
  if (settings.boardTitle) list.push({ action: 'setBoardTitle', text: settings.boardTitle });
  if (settings.background) list.push({ action: 'setBackground', text: settings.background });
  return list;
};
// Plain text only: no control characters, trimmed to `max` characters
const cleanText = (text: string | undefined, max: number) => (text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
const saveSettings = () => {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings.json:', err);
  }
};
// Last voice speed from the dashboard, replayed to stage pages that (re)load later
let lastRateControl: { action: string; text: string } | null = null;
app.post('/api/control', (req, res) => {
  const { action, text } = req.body || {};
  if (!CONTROL_ACTIONS.includes(action)) {
    return res.status(400).json({ success: false, error: 'Lệnh không hợp lệ' });
  }
  if (action === 'speak' && (typeof text !== 'string' || !text.trim())) {
    return res.status(400).json({ success: false, error: 'Chưa nhập nội dung cần đọc' });
  }
  const payload = { action, text: typeof text === 'string' ? text.trim().slice(0, 1000) : undefined };
  if (action === 'setRate' && payload.text) lastRateControl = { action, text: payload.text };
  if (action === 'setName') {
    const name = cleanText(payload.text, 40);
    if (!name) return res.status(400).json({ success: false, error: 'Chưa nhập tên kênh' });
    payload.text = settings.channelName = name;
    saveSettings();
  }
  if (action === 'setTopBoard') {
    payload.text = payload.text === '0' ? '0' : '1';
    settings.showTopBoard = payload.text === '1';
    saveSettings();
  }
  if (action === 'setKeyword') {
    const keyword = cleanText(payload.text, 30);
    if (!keyword) return res.status(400).json({ success: false, error: 'Chưa nhập từ khóa' });
    payload.text = settings.keyword = keyword;
    saveSettings();
  }
  if (action === 'setBoardTitle') {
    const title = cleanText(payload.text, 24);
    if (!title) return res.status(400).json({ success: false, error: 'Chưa nhập tên bảng' });
    payload.text = settings.boardTitle = title;
    saveSettings();
  }
  broadcastSSE('control', payload);
  return res.json({ success: true, stages: sseClients.length });
});

// Custom background: the dashboard uploads one image (JPG, PNG or WebP, up to 15 MB). It is kept in uploads/
// next to this file (gitignored), replaces the previous custom one, and every page switches to it.
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
app.use('/uploads', express.static(UPLOAD_DIR));
const removeCustomBackground = () => {
  if (!settings.background) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(settings.background)));
  } catch {
    // already gone
  }
};
app.post('/api/background', express.raw({ type: Object.keys(IMAGE_TYPES), limit: '15mb' }), (req, res) => {
  const ext = IMAGE_TYPES[(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ success: false, error: 'Chỉ nhận ảnh JPG, PNG hoặc WebP' });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  removeCustomBackground();
  const file = `background-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
  settings.background = `/uploads/${file}`;
  saveSettings();
  broadcastSSE('control', { action: 'setBackground', text: settings.background });
  return res.json({ success: true, url: settings.background });
});
app.post('/api/background/reset', (_req, res) => {
  removeCustomBackground();
  delete settings.background;
  saveSettings();
  broadcastSSE('control', { action: 'setBackground', text: '' });
  return res.json({ success: true });
});

// Disconnect route
app.post('/api/tiktok/disconnect', (_req, res) => {
  try {
    activeTikTokSession += 1;
    if (activeTikTokConn) {
      activeTikTokConn.disconnect();
      activeTikTokConn = null;
    }
    liveStats = {
      isConnected: false,
      isConnecting: false,
      username: '',
      roomId: '',
      viewerCount: 0,
      totalLikes: 0,
      error: '',
    };
    broadcastSSE('status', liveStats);
    return res.json({ success: true, message: 'Đã ngắt kết nối TikTok LIVE' });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: errMsg });
  }
});


// Split at sentence/comma/space boundaries into pieces of at most `max` chars
function splitTtsText(text: string, max = 190): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    if (cut < max / 2) cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Natural Vietnamese neural voice; rate 1 = normal speed. Samples to compare are in giong-mau/
const TTS_VOICE = 'vi-VN-NamMinhNeural'; // male voice, chosen from giong-mau/4
const TTS_PITCH = '-4%'; // slightly deeper, calmer
// The text goes inside SSML, so names with & < > must be escaped
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function edgeTts(text: string, rate: number): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text), { rate: `${Math.round((rate - 1) * 100)}%`, pitch: TTS_PITCH });
    const chunks: Buffer[] = [];
    const read = (async () => {
      for await (const c of audioStream) chunks.push(c as Buffer);
    })();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Edge TTS timeout')), 20000));
    await Promise.race([read, timeout]);
    if (chunks.length === 0) throw new Error('Edge TTS returned no audio');
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
}

// Fallback: Google Translate TTS caps each request near 200 chars, so fetch in chunks and join the MP3s
async function googleTts(text: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const chunk of splitTtsText(text)) {
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    const response = await fetch(googleTtsUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://translate.google.com/',
      },
    });
    if (!response.ok) throw new Error(`TTS upstream error: ${response.status}`);
    parts.push(Buffer.from(await response.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

// Repeated lines (share reminders, lecture paragraphs) are served from memory
const ttsCache = new Map<string, Buffer>();

app.get('/api/tts', async (req, res) => {
  try {
    const text = ((req.query.text as string) || '').trim().slice(0, 1500);
    if (!text) {
      return res.status(400).send('Missing text parameter');
    }
    const rate = Math.min(1.5, Math.max(0.5, Number(req.query.rate) || 1));
    const cacheKey = `${rate}|${text}`;
    let audio = ttsCache.get(cacheKey);
    if (!audio) {
      try {
        audio = await edgeTts(text, rate);
      } catch (err) {
        console.warn('Edge TTS failed, falling back to Google:', err instanceof Error ? err.message : err);
        audio = await googleTts(text);
      }
      ttsCache.set(cacheKey, audio);
      if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value!);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(audio);
  } catch (err) {
    console.error('TTS error:', err);
    return res.status(500).json({ error: 'TTS failed' });
  }
});

// API Route: AI Real-Time Prayer & Trend Analysis

// Setup Vite middleware in dev or static files in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      // LIVE_MODE=1 (BAT-LIVE.bat): no hot reload, so editing code or a dropped dev socket never reloads the
      // stage page mid-live. Refresh the Link source by hand to pick up changes.
      server: { middlewareMode: true, hmr: process.env.LIVE_MODE === '1' ? false : undefined },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  // Loopback only: the dashboard, the stage page and LIVE Studio all run on this computer (lvh.me resolves to
  // 127.0.0.1). Listening on every interface let anyone on the same Wi-Fi make the live voice say anything via
  // /api/control, switch the TikTok room, or use the TTS route. The API has no login, so keep it local.
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Chùa Online LIVE server running on http://localhost:${PORT}`);
  });
}

startServer();