import { useState, useEffect, useRef, useCallback } from 'react';
import { HeaderNav } from './components/HeaderNav';
import { ChanhDienStage } from './components/ChanhDienStage';
import { StreamerDeck } from './components/StreamerDeck';
import {
  StreamConfig,
  Devotee,
  GiftEvent,
  LeaderboardEntry,
  CommentEvent,
  GiftCategory,
  TikTokLiveStatus,
  OfferRequest,
} from './types/temple';
import { soundEngine, formatUsernameForTts } from './services/soundEngine';
import { maskBanned } from './services/bannedWords';
import { detectWish, blessingFor, shouldAnswer } from './services/wishResponder';
import { pickSeat } from './services/seating';
import { LIKES_PER_RAIN } from './services/likeRain';
import { FORTUNES } from './data/fortunes';
import type { FortuneDraw } from './components/FortuneCard';

const SHARE_REMINDER_MS = 5 * 60 * 1000;
const IDLE_BLESSING_MS = 90 * 1000; // voice quiet this long -> blessing + share ask
const WELCOME_CHECK_MS = 2.5 * 1000; // faster greeting so people still online hear it
const MAX_WAITING_JOINERS = 30;
const SEAT_AFTER_JOIN_MS = 10 * 1000;
const DEFAULT_CHANNEL_NAME = 'Tâm Tịnh Tâm An'; // until the owner saves their own in the dashboard
const DEFAULT_KEYWORD = 'adidaphat';
const lettersOnly = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const SPOTLIGHT_COINS = 1; // any gift for now (small channel); raise when gifts get frequent
const POINTS_PER_COIN = 10;
const FORTUNE_LIKES = 99; // hearts from the whole room per quẻ // merit board: a 1-coin rose = 10 comments

const RAIN_MS = 60 * 1000;
// Only the live stage page (Link source in LIVE Studio) makes sound by default; the dashboard stays silent so audio never doubles
const pageParams = new URLSearchParams(window.location.search);
const IS_STAGE_PAGE = pageParams.get('view') === 'stage' || pageParams.get('obs') === 'true';

const ROBE_COLORS = [
  '#38bdf8',
  '#10b981',
  '#a855f7',
  '#3b82f6',
  '#f43f5e',
  '#d97706',
  '#06b6d4',
  '#ec4899',
  '#6366f1',
  '#e2e8f0',
];


export default function App() {
  const [config, setConfig] = useState<StreamConfig>({
    channelName: DEFAULT_CHANNEL_NAME,
    showTopBoard: true,
    liveTitle: 'TÂM TỊNH TÂM AN',
    subTitle: 'Gõ "adidaphat" để vào lễ Phật',
    isConnected: true,
    autoTts: IS_STAGE_PAGE,
    voiceGender: 'female',
    ttsSpeed: 0.85,
    ttsPitch: 1.08,
    bellSoundEnabled: true,
    gongSoundEnabled: true,
    chantAmbientEnabled: false,
    bgmEnabled: IS_STAGE_PAGE,
    bgmVolume: 0.18,
    buddhistMusicTrack: 'chill',
    isDharmaLectureActive: false,
    displayRatio: '9:16',
    viewMode: 'dual',
  });

  // Standalone OBS mode check (?view=stage or ?obs=true)
  const [isStandaloneObs, setIsStandaloneObs] = useState(false);
  const [stageZoom, setStageZoom] = useState(1);
  useEffect(() => {
    if (!isStandaloneObs) return;
    const fit = () => setStageZoom(Math.min(window.innerWidth / 430, window.innerHeight / ((430 * 16) / 9)));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [isStandaloneObs]);

  // TikTok LIVE Connection State
  const [tikTokStatus, setTikTokStatus] = useState<TikTokLiveStatus>({
    isConnected: false,
    isConnecting: false,
    username: '',
    roomId: '',
    viewerCount: 0,
    totalLikes: 0,
    error: '',
  });

  // Empty initial state: floor and leaderboards are clean until people join/donate
  const [devotees, setDevotees] = useState<Devotee[]>([]);
  const [leaderboardDonors, setLeaderboardDonors] = useState<LeaderboardEntry[]>([]);
  // Merit board: 1 point per comment, POINTS_PER_COIN per gift coin; ordered by points (score)
  const addMerit = (username: string, points: number, avatarUrl = '', diamonds = 0) =>
    setLeaderboardDonors((prev) => {
      const key = username.toLowerCase();
      const found = prev.find((d) => d.username.toLowerCase() === key);
      const next = found
        ? prev.map((d) =>
            d === found
              ? { ...d, score: (d.score ?? 0) + points, diamonds: d.diamonds + diamonds, avatarUrl: avatarUrl || d.avatarUrl }
              : d
          )
        : [...prev, { username, displayName: maskBanned(username), diamonds, score: points, rank: prev.length + 1, avatarUrl }];
      return next.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    });

  // Likes fill a bar under the chant: every LIKES_PER_RAIN likes rain flowers for a minute
  const [likeProgress, setLikeProgress] = useState(0);
  const [rainUntil, setRainUntil] = useState(0);
  const likesRef = useRef(0);

  // Gieo quẻ (for fun): every FORTUNE_LIKES hearts from the whole room draws one quẻ for everyone
  const [fortuneDraws, setFortuneDraws] = useState<FortuneDraw[]>([]);
  const [fortuneProgress, setFortuneProgress] = useState(0);
  const fortuneLikesRef = useRef(0);
  const countFortuneLikes = (count: number) => {
    const total = fortuneLikesRef.current + count;
    fortuneLikesRef.current = total % FORTUNE_LIKES;
    setFortuneProgress(fortuneLikesRef.current);
    // a burst that passes 99 several times still draws just one quẻ
    if (total < FORTUNE_LIKES) return;
    const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
    setFortuneDraws((prev) => [...prev, { id: `que-${Date.now()}`, name: 'Cả nhà', fortune }].slice(-10));
    if (config.autoTts) soundEngine.readFortune(fortune);
  };
  const lastTotalLikesRef = useRef<number | null>(null);
  const addLikes = (count: number) => {
    countFortuneLikes(count);
    const total = likesRef.current + count;
    const rains = Math.floor(total / LIKES_PER_RAIN);
    likesRef.current = total % LIKES_PER_RAIN;
    setLikeProgress(likesRef.current);
    // More likes during a rain make it last longer
    if (rains > 0) setRainUntil((until) => Math.max(until, Date.now()) + rains * RAIN_MS);
  };
  const [comments, setComments] = useState<CommentEvent[]>([]);

  const [currentGift, setCurrentGift] = useState<GiftEvent | null>(null);
  const [offerers, setOfferers] = useState<GiftEvent[]>([]);
  // Everyone who should go up and offer incense (a gift or an "adidaphat" comment), newest last
  const [offerRequests, setOfferRequests] = useState<OfferRequest[]>([]);
  // A gift of SPOTLIGHT_COINS+ coins in one go (combos added up within 15 s) gets the close-up camera
  const [spotlightRequests, setSpotlightRequests] = useState<OfferRequest[]>([]);
  const giftCoinsRef = useRef(new Map<string, { coins: number; since: number; done: boolean }>());
  const pendingThanksRef = useRef(new Map<string, { username: string; giftName: string; diamonds: number }>());
  const readPendingThanks = (username: string) => {
    const key = username.toLowerCase();
    const t = pendingThanksRef.current.get(key);
    if (!t) return;
    pendingThanksRef.current.delete(key);
    soundEngine.readGiftAcknowledgment(t.username, t.giftName, t.diamonds);
  };
  const requestSpotlightIfBig = (username: string, coins: number, avatarUrl = '') => {
    const key = username.toLowerCase();
    const now = Date.now();
    const prev = giftCoinsRef.current.get(key);
    const entry = prev && now - prev.since < 15000 ? prev : { coins: 0, since: now, done: false };
    entry.coins += coins;
    giftCoinsRef.current.set(key, entry);
    if (entry.done || entry.coins < SPOTLIGHT_COINS) return;
    entry.done = true;
    setSpotlightRequests((p) =>
      [...p, { id: `spot-${now}-${username}`, username, displayName: maskBanned(username), avatarUrl }].slice(-10)
    );
    soundEngine.playTempleBell(0.9);
  };
  const requestOffer = (username: string, avatarUrl = '') =>
    setOfferRequests((prev) =>
      [...prev, { id: `offer-${Date.now()}-${username}`, username, displayName: maskBanned(username), avatarUrl }].slice(-20)
    );
  const [auraIntensity, setAuraIntensity] = useState<number>(0.1);
  const [isGiftActive, setIsGiftActive] = useState<boolean>(false);
  const giftTimeoutRef = useRef<NodeJS.Timeout | null>(null);


  // Who commented or gave a gift recently, for the named share reminder (latest last)
  const recentInteractorsRef = useRef<Map<string, number>>(new Map());
  const noteInteractor = (name: string) => {
    const m = recentInteractorsRef.current;
    m.delete(name);
    m.set(name, Date.now());
    if (m.size > 50) m.delete(m.keys().next().value!);
  };

  // Newcomers take a free seat (or the longest-idle person's seat when full) and keep it; DevoteeCrowd walks them in
  const makeDevotee = (username: string, seat: number, extra: Partial<Devotee> = {}): Devotee => {
    const now = Date.now();
    return {
      id: `dev-${now}-${seat}`,
      username,
      displayName: maskBanned(username),
      joinedAt: now,
      lastActive: now,
      robeColor: ROBE_COLORS[seat % ROBE_COLORS.length],
      bowOffset: Math.random() * 0.9,
      seat,
      ...extra,
    };
  };
  // allowNew = false only updates people already in the hall
  const addOrUpdateDevotee = (username: string, update: (d?: Devotee) => Partial<Devotee>, allowNew = true) =>
    setDevotees((prev) => {
      const key = username.toLowerCase();
      const found = prev.find((d) => d.username.toLowerCase() === key);
      if (found) return prev.map((d) => (d === found ? { ...d, ...update(d), lastActive: Date.now() } : d));
      if (!allowNew) return prev;
      const { seat, evict } = pickSeat(prev);
      return [...prev.filter((d) => d !== evict), makeDevotee(username, seat, update())];
    });

  // Check URL params on mount for OBS Stage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'stage' || params.get('obs') === 'true') {
        setIsStandaloneObs(true);
        setConfig((prev) => ({ ...prev, viewMode: 'stage_only' }));
      }
    }
  }, []);


  // Real Buddhist music background lifecycle
  useEffect(() => {
    if (config.bgmEnabled) {
      soundEngine.startBuddhistMusic(config.buddhistMusicTrack, config.bgmVolume);
    } else {
      soundEngine.stopBuddhistMusic();
    }
  }, [config.bgmEnabled, config.buddhistMusicTrack, config.bgmVolume]);


  useEffect(() => {
    soundEngine.setSpeechRate(config.ttsSpeed);
  }, [config.ttsSpeed]);

  // Smooth decay of aura
  useEffect(() => {
    if (auraIntensity > 0.1) {
      const interval = setInterval(() => {
        setAuraIntensity((prev) => Math.max(0.1, prev - 0.05));
      }, 200);
      return () => clearInterval(interval);
    }
  }, [auraIntensity]);

  // Trigger Gift Event: "dù x1 hay x5 chỉ đọc 1 lần thôi"
  const handleTriggerGift = useCallback(
    (
      giftType: GiftCategory,
      giftName: string,
      prayerMeaning: string,
      username: string,
      countIncrement = 1,
      diamondsPerUnit = 1,
      avatarUrl = ''
    ) => {
      const cleanUser = username.trim() || 'Bạn';
      const now = Date.now();
      noteInteractor(cleanUser);

      let nextCombo = countIncrement;
      if (
        currentGift &&
        currentGift.username.toLowerCase() === cleanUser.toLowerCase() &&
        currentGift.giftType === giftType &&
        now - currentGift.timestamp < 4500
      ) {
        nextCombo = currentGift.comboCount + countIncrement;
      }

      const totalDiamonds = countIncrement * diamondsPerUnit;

      const newGift: GiftEvent = {
        id: `gift-${now}`,
        username: cleanUser,
        displayName: maskBanned(cleanUser),
        giftType,
        giftName,
        prayerMeaning,
        comboCount: nextCombo,
        diamonds: totalDiamonds,
        timestamp: now,
        avatarUrl,
      };

      setCurrentGift(newGift);
      // Newest giver kneels at the main mat (chủ lễ), the previous four move to the small mats
      requestOffer(cleanUser, avatarUrl);
      requestSpotlightIfBig(cleanUser, totalDiamonds, avatarUrl);
      setOfferers((prev) =>
        [newGift, ...prev.filter((o) => o.username.toLowerCase() !== cleanUser.toLowerCase())].slice(0, 5)
      );
      setIsGiftActive(true);
      setAuraIntensity(1);

      if (giftTimeoutRef.current) clearTimeout(giftTimeoutRef.current);
      giftTimeoutRef.current = setTimeout(() => {
        setIsGiftActive(false);
        setCurrentGift(null);
      }, 4000);

      // TOP THÀNH TÂM: every coin of a gift is worth 10 points
      addMerit(cleanUser, totalDiamonds * POINTS_PER_COIN, avatarUrl, totalDiamonds);

      // Update Devotee Crowd (only if they already entered with "adidaphat")
      addOrUpdateDevotee(
        cleanUser,
        (d) => ({
          isVip: true,
          totalDiamonds: (d?.totalDiamonds || 0) + totalDiamonds,
          activeComment: `${prayerMeaning} · ${maskBanned(cleanUser)} dâng ${giftName}`,
          commentTimestamp: now,
          avatarUrl: avatarUrl || d?.avatarUrl,
        }),
        false
      );

      setTimeout(() => {
        setDevotees((prev) =>
          prev.map((d) =>
            d.username.toLowerCase() === cleanUser.toLowerCase() && d.commentTimestamp === now
              ? { ...d, activeComment: undefined }
              : d
          )
        );
      }, 4500);

      // Lotus chime sound effect
      soundEngine.playLotusBloom(0.7);
      if (nextCombo % 4 === 0 || giftType === 'dang_hoa_sen') {
        soundEngine.playTempleBell(0.85);
      }

      // Every gift is thanked by name (soundEngine dedupes combos and skips small gifts when busy)
      // The name and blessing are read when the close-up starts (onSpotlightStart); if it never starts
      // (no 3D, or it waits too long in line) they are read anyway after 20 s
      if (config.autoTts && !pendingThanksRef.current.has(cleanUser.toLowerCase())) {
        const key = cleanUser.toLowerCase();
        pendingThanksRef.current.set(key, { username: cleanUser, giftName, diamonds: totalDiamonds });
        setTimeout(() => readPendingThanks(cleanUser), 20000);
      }
    },
    [currentGift, config.autoTts]
  );

  // Add Comment & Handle "adidaphat" Entry
  const handleAddComment = (username: string, commentText: string, avatarUrl = '') => {
    const cleanUser = username.trim() || 'Phật tử';
    noteInteractor(cleanUser);
    const now = Date.now();
    // Accepts "adidaphat", "A Di Đà Phật", "adi da phat 🙏", "Nam mô a di đà phật"...
    // The keyword (default "adidaphat") matches without accents, spaces or case: "A Di Đà Phật" counts too
    const isAdidaphat = lettersOnly(commentText).includes(lettersOnly(config.keyword || DEFAULT_KEYWORD) || DEFAULT_KEYWORD);

    const newComment: CommentEvent = {
      id: `c-${now}`,
      username: cleanUser,
      displayName: maskBanned(cleanUser),
      comment: maskBanned(commentText),
      timestamp: now,
    };

    setComments((prev) => [...prev.slice(-30), newComment]);
    addMerit(cleanUser, 1, avatarUrl); // one comment = one point

    addOrUpdateDevotee(
      cleanUser,
      (d) => ({ activeComment: maskBanned(commentText), commentTimestamp: now, avatarUrl: avatarUrl || d?.avatarUrl }),
      isAdidaphat
    );

    // Answer a prayer in the comment with a blessing for that topic (never during a lecture, rate-limited)
    const wish = detectWish(commentText);
    if (wish && config.autoTts && !soundEngine.isDharmaLecturePlaying() && shouldAnswer(cleanUser)) {
      soundEngine.speakPreferredBuddhistVoice(blessingFor(wish, formatUsernameForTts(cleanUser), config.channelName));
    }

    setTimeout(() => {
      setDevotees((prev) =>
        prev.map((d) =>
          d.username.toLowerCase() === cleanUser.toLowerCase() && d.commentTimestamp === now
            ? { ...d, activeComment: undefined }
            : d
        )
      );
    }, 4500);

    if (isAdidaphat) {
      requestOffer(cleanUser, avatarUrl);
      soundEngine.playMuoGong(1.2); // no voice for adidaphat offerers: only gift givers are announced
    }
  };

  const handleAddDevotee = (username: string) => addOrUpdateDevotee(username, () => ({}));

  const handleFollow = (username: string) => {
    if (config.autoTts) soundEngine.readFollowThanks(username);
  };

  // Share reminder thanking up to 3 people who commented or gave gifts in the last 5 minutes, newest first
  const remindShare = () => {
    const since = Date.now() - SHARE_REMINDER_MS;
    const names = [...recentInteractorsRef.current]
      .filter(([, t]) => t > since)
      .map(([name]) => name)
      .reverse()
      .slice(0, 3);
    soundEngine.readShareReminder(names);
  };

  useEffect(() => {
    if (!config.autoTts) return;
    const interval = setInterval(() => remindShare(), SHARE_REMINDER_MS);
    // Quiet live (no one joining, nothing to answer): bless the viewers and ask them to share
    const idle = setInterval(() => {
      if (soundEngine.quietForMs() > IDLE_BLESSING_MS) soundEngine.readIdleBlessing();
    }, 15000);
    return () => {
      clearInterval(interval);
      clearInterval(idle);
    };
  }, [config.autoTts]);

  // Every newcomer is greeted, once per session.
  // Try to greet immediately when the voice is free; otherwise batch every 2.5s.
  // This reduces the chance that short-stay viewers leave before hearing the greeting.
  const newJoinersRef = useRef<string[]>([]);
  const greetedRef = useRef<Set<string>>(new Set());

  const flushWelcomeJoiners = () => {
    if (!newJoinersRef.current.length || soundEngine.isDharmaLecturePlaying() || soundEngine.queuedSpeech() >= 3) return;
    const names = newJoinersRef.current.splice(0, 6);
    names.forEach((n) => greetedRef.current.add(n));
    for (let i = 0; i < names.length; i += 3) soundEngine.readWelcomeJoiners(names.slice(i, i + 3));
  };

  const handleJoin = (name: string, avatarUrl = '') => {
    // Anyone still around 10s after joining kneels in the hall (commenting adidaphat seats them sooner)
    setTimeout(() => addOrUpdateDevotee(name, (d) => ({ avatarUrl: avatarUrl || d?.avatarUrl })), SEAT_AFTER_JOIN_MS);
    if (greetedRef.current.has(name) || newJoinersRef.current.includes(name)) return;
    // Keep only the newest joiners when the room floods
    newJoinersRef.current = [...newJoinersRef.current, name].slice(-MAX_WAITING_JOINERS);
    // Try to greet right away if the voice is free
    if (config.autoTts && !soundEngine.isDharmaLecturePlaying() && soundEngine.queuedSpeech() < 2) {
      flushWelcomeJoiners();
    }
  };

  useEffect(() => {
    if (!config.autoTts) return;
    const interval = setInterval(flushWelcomeJoiners, WELCOME_CHECK_MS);
    return () => clearInterval(interval);
  }, [config.autoTts]);

  // Dashboard buttons drive the live stage page, which is the one that makes sound
  const uploadBackground = async (file: File) => {
    const res = await fetch('/api/background', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const result = await res.json().catch(() => ({ success: false }));
    if (!result.success) throw new Error(result.error || 'Upload failed');
    return result.url as string;
  };

  const resetBackground = async () => {
    await fetch('/api/background/reset', { method: 'POST' });
  };

  const sendControl = (action: string, text?: string) => {
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, text }),
    }).catch(() => {});
  };

  // Connect to TikTok LIVE
  const handleConnectTikTok = async (username: string) => {
    try {
      const res = await fetch('/api/tiktok/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!data.success) {
        setTikTokStatus((s) => ({ ...s, error: data.error || 'Connect failed', isConnecting: false }));
      }
    } catch (err) {
      setTikTokStatus((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Network error',
        isConnecting: false,
      }));
    }
  };

  const handleDisconnectTikTok = async () => {
    await fetch('/api/tiktok/disconnect', { method: 'POST' }).catch(() => {});
  };

  // SSE connection for TikTok events + control
  useEffect(() => {
    if (!IS_STAGE_PAGE && config.viewMode !== 'dual') return;
    const es = new EventSource('/api/tiktok/events');
    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        setTikTokStatus(data);
      } catch {}
    });
    es.addEventListener('chat', (e) => {
      try {
        const data = JSON.parse(e.data);
        handleAddComment(data.nickname || data.username, data.comment, data.avatar);
      } catch {}
    });
    es.addEventListener('gift', (e) => {
      try {
        const data = JSON.parse(e.data);
        // Map gift to category roughly by diamond count
        let giftType: GiftCategory = 'dang_huong';
        if (data.diamondCount >= 100) giftType = 'dang_hoa_sen';
        else if (data.diamondCount >= 20) giftType = 'le_phat';
        else if (data.diamondCount >= 5) giftType = 'qua_dao';
        handleTriggerGift(
          giftType,
          data.giftName || 'Hoa Sen',
          'Cầu Bình An',
          data.nickname || data.username,
          data.repeatCount || 1,
          data.diamondCount || 1,
          data.avatar
        );
      } catch {}
    });
    es.addEventListener('like', (e) => {
      try {
        const data = JSON.parse(e.data);
        addLikes(data.likeCount || 1);
      } catch {}
    });
    es.addEventListener('member', (e) => {
      try {
        const data = JSON.parse(e.data);
        handleJoin(data.nickname || data.username, data.avatar);
      } catch {}
    });
    es.addEventListener('follow', (e) => {
      try {
        const data = JSON.parse(e.data);
        handleFollow(data.nickname || data.username);
      } catch {}
    });
    es.addEventListener('control', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.action === 'setName' && data.text) {
          setConfig((c) => ({ ...c, channelName: data.text }));
          soundEngine.setChannelName(data.text);
        }
        if (data.action === 'setTopBoard') {
          setConfig((c) => ({ ...c, showTopBoard: data.text !== '0' }));
        }
        if (data.action === 'setKeyword' && data.text) {
          setConfig((c) => ({ ...c, keyword: data.text }));
        }
        if (data.action === 'setBoardTitle' && data.text) {
          setConfig((c) => ({ ...c, boardTitle: data.text }));
        }
        if (data.action === 'setBackground') {
          setConfig((c) => ({ ...c, background: data.text || undefined }));
        }
        if (data.action === 'speak' && data.text) {
          soundEngine.speakPreferredBuddhistVoice(data.text);
        }
        if (data.action === 'shareReminder') {
          remindShare();
        }
        if (data.action === 'bell') {
          soundEngine.playTempleBell(1);
        }
        if (data.action === 'setRate' && data.text) {
          const rate = parseFloat(data.text);
          if (!isNaN(rate)) {
            setConfig((c) => ({ ...c, ttsSpeed: rate }));
            soundEngine.setSpeechRate(rate);
          }
        }
      } catch {}
    });
    return () => es.close();
  }, [config.viewMode]);

  // Render
  return (
    <div className="min-h-screen bg-[#1a0f08] text-[#f5e6c8] font-temple">
      <HeaderNav config={config} tikTokStatus={tikTokStatus} />
      <main className="relative">
        {(config.viewMode === 'dual' || config.viewMode === 'stage_only' || isStandaloneObs) && (
          <div
            className={isStandaloneObs ? 'fixed inset-0 z-50' : 'relative'}
            style={isStandaloneObs ? { transform: `scale(${stageZoom})`, transformOrigin: 'top left' } : undefined}
          >
            <ChanhDienStage
              config={config}
              devotees={devotees}
              offerers={offerers}
              currentGift={currentGift}
              isGiftActive={isGiftActive}
              auraIntensity={auraIntensity}
              offerRequests={offerRequests}
              spotlightRequests={spotlightRequests}
              leaderboardDonors={leaderboardDonors}
              likeProgress={likeProgress}
              rainUntil={rainUntil}
              fortuneDraws={fortuneDraws}
              fortuneProgress={fortuneProgress}
              onSpotlightStart={(username) => readPendingThanks(username)}
            />
          </div>
        )}
        {(config.viewMode === 'dual' || config.viewMode === 'control_only') && !isStandaloneObs && (
          <div className="p-4 max-w-4xl mx-auto">
            <StreamerDeck
              config={config}
              comments={comments}
              onTriggerGift={handleTriggerGift}
              onAddComment={handleAddComment}
              onAddDevotee={handleAddDevotee}
              onUploadBackground={uploadBackground}
              onResetBackground={resetBackground}
              onSaveChannelName={(name) => sendControl('setName', name)}
              onUpdateConfig={(updates) => setConfig((prev) => ({ ...prev, ...updates }))}
              tikTokStatus={tikTokStatus}
              onConnectTikTok={handleConnectTikTok}
              onDisconnectTikTok={handleDisconnectTikTok}
            />
          </div>
        )}
      </main>
    </div>
  );
}
