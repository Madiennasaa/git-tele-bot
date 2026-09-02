require('dotenv').config();
const { Bot, Keyboard } = require('grammy');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const bot = new Bot(process.env.BOT_TOKEN);

// --- Health check server ---
// Bot ini jalan pakai long polling (bot.start()), jadi nggak pernah buka port apapun.
// Banyak platform hosting (Northflank, Render, dll) ngecek "container hidup atau nggak"
// dengan cara nge-hit suatu port — kalau nggak ada yang listen, bisa dianggap unhealthy
// dan di-restart-loop terus. Server kecil ini cuma buat jawab health check itu,
// nggak ada hubungannya sama logic bot.
const http = require('http');
const HEALTH_PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(HEALTH_PORT, () => {
  console.log(`🩺 Health check server jalan di port ${HEALTH_PORT}`);
});

const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID;

// --- State persistence (buat catch-up kalau bot sempat mati) ---
// Path bisa di-override lewat env var STATE_DIR — dipakai buat arahin ke folder
// yang di-mount sebagai persistent volume (misal di Northflank), biar data ini
// nggak ilang tiap kali container di-redeploy/restart.
const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, '.bot-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Gagal simpan state:', e.message);
  }
}

function todayWibString() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
}

function currentHourWib() {
  return parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }),
    10
  );
}

// Custom Menu Keyboard
const mainMenu = new Keyboard()
  .text('📊 Stats Hari Ini')
  .text('🔥 Trending Global')
  .row()
  .text('🐍 Trending Python')
  .text('🐘 Trending PHP')
  .row()
  .text('🟨 Trending JS Ecosystem')
  .row()
  .text('🔥 Streak Ngoding')
  .text('📅 Rekap Mingguan')
  .resized();

// Helper Fetch GitHub API
async function fetchGithub(url) {
  const headers = {
    'User-Agent': 'Git-Bot-CLI',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API Error: ${res.statusText}`);
  return await res.json();
}

// 1. COMMAND /start & Menu Utama
bot.command('start', (ctx) => {
  ctx.reply(`👋 Halo Boss ${GITHUB_USERNAME}!\n\nBot Monitoring GitHub kamu aktif 24/7!\nPilih menu di bawah:`, {
    reply_markup: mainMenu
  });
});

// Helper Ambil Trending (per bahasa)
async function handleTrending(ctx, lang = '') {
  await ctx.reply(`🔍 Lagi nyari repo trending ${lang ? `berbahasa ${lang}` : 'global'}...`);

  try {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    const dateStr = date.toISOString().split('T')[0];

    let query = `created:>${dateStr}`;
    if (lang) query += ` language:${lang}`;

    const data = await fetchGithub(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`);

    if (!data.items || data.items.length === 0) {
      return ctx.reply('⚠️ Nggak nemu repo trending buat kriteria itu.', { reply_markup: mainMenu });
    }

    let msg = `🔥 *GitHub Trending — ${lang ? lang.toUpperCase() : 'Global'}*\n\n`;
    data.items.forEach((item, index) => {
      msg += `${index + 1}. *${item.full_name}*\n`;
      msg += `   ⭐ +${item.stargazers_count.toLocaleString()} • 🔤 ${item.language || 'Misc'}\n`;
      msg += `   📝 ${item.description ? item.description.substring(0, 60) + '...' : 'Tanpa deskripsi'}\n`;
      msg += `   🔗 ${item.html_url}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: mainMenu });
  } catch (err) {
    ctx.reply(`❌ Gagal ngambil data trending: ${err.message}`, { reply_markup: mainMenu });
  }
}

// Helper Ambil Trending khusus ekosistem JS (React, Next.js, Express, Node.js)
// Pakai "topic:" bukan cuma "language:javascript" biar hasilnya spesifik ke framework/lib-nya,
// bukan sekadar repo apapun yang kebetulan ditulis pakai JS.
async function handleTrendingJsEcosystem(ctx) {
  await ctx.reply('🔍 Lagi nyari repo trending seputar React, Next.js, Express, & Node.js...');

  try {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    const dateStr = date.toISOString().split('T')[0];

    const topics = [
      { key: 'react', label: 'React' },
      { key: 'nextjs', label: 'Next.js' },
      { key: 'express', label: 'Express' },
      { key: 'nodejs', label: 'Node.js' },
    ];

    const results = await Promise.all(
      topics.map(async (t) => {
        const query = `topic:${t.key} created:>${dateStr}`;
        try {
          const data = await fetchGithub(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`);
          return (data.items || []).map((item) => ({ ...item, __matchedTopic: t.label }));
        } catch (e) {
          return [];
        }
      })
    );

    // Gabungin semua hasil, dedup berdasarkan repo id (bisa aja 1 repo punya >1 topic)
    const merged = new Map();
    results.flat().forEach((item) => {
      if (!merged.has(item.id)) {
        merged.set(item.id, item);
      }
    });

    const topRepos = Array.from(merged.values())
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, 5);

    if (topRepos.length === 0) {
      return ctx.reply('⚠️ Nggak nemu repo trending buat ekosistem JS minggu ini.', { reply_markup: mainMenu });
    }

    let msg = `🟨 *GitHub Trending — JS Ecosystem*\n_(React / Next.js / Express / Node.js)_\n\n`;
    topRepos.forEach((item, index) => {
      msg += `${index + 1}. *${item.full_name}* _(${item.__matchedTopic})_\n`;
      msg += `   ⭐ +${item.stargazers_count.toLocaleString()} • 🔤 ${item.language || 'Misc'}\n`;
      msg += `   📝 ${item.description ? item.description.substring(0, 60) + '...' : 'Tanpa deskripsi'}\n`;
      msg += `   🔗 ${item.html_url}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: mainMenu });
  } catch (err) {
    ctx.reply(`❌ Gagal ngambil data trending JS: ${err.message}`, { reply_markup: mainMenu });
  }
}

// Command & Hearing Text buat Trending
bot.command('trending', (ctx) => handleTrending(ctx, ctx.match ? ctx.match.trim().toLowerCase() : ''));
bot.hears('🔥 Trending Global', (ctx) => handleTrending(ctx, ''));
bot.hears('🐍 Trending Python', (ctx) => handleTrending(ctx, 'python'));
bot.hears('🐘 Trending PHP', (ctx) => handleTrending(ctx, 'php'));
bot.command('trendingjs', (ctx) => handleTrendingJsEcosystem(ctx));
bot.hears('🟨 Trending JS Ecosystem', (ctx) => handleTrendingJsEcosystem(ctx));

// Helper Ambil Commit Hari Ini
async function getTodayCommits() {
  const todayWib = todayWibString();
  const endpoint = `https://api.github.com/users/${GITHUB_USERNAME}/events`;

  const events = await fetchGithub(endpoint);

  let todayCommits = 0;
  const repos = new Set();

  events.forEach(event => {
    if (event.type === 'PushEvent') {
      const eventDateWib = new Date(event.created_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });

      if (eventDateWib === todayWib) {
        todayCommits += event.payload.commits ? event.payload.commits.length : 1;
        repos.add(event.repo.name);
      }
    }
  });

  return { count: todayCommits, repos: Array.from(repos) };
}

// Handler Stats
async function handleStats(ctx) {
  try {
    const { count, repos } = await getTodayCommits();
    let msg = `📊 *Statistik Ngoding Hari Ini*\n\n`;
    msg += `💬 Total Commit: *${count} commit*\n`;
    msg += `📂 Repo Aktif (${repos.length}):\n`;

    if (repos.length > 0) {
      repos.forEach(r => msg += `  • ${r}\n`);
    } else {
      msg += `  (Belum ada repo yang disentuh hari ini)\n`;
    }

    ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainMenu });
  } catch (err) {
    ctx.reply(`❌ Gagal ngambil stats: ${err.message}`, { reply_markup: mainMenu });
  }
}

bot.command('stats', handleStats);
bot.hears('📊 Stats Hari Ini', handleStats);

// Handler Streak
async function handleStreak(ctx) {
  const state = loadState();
  const streak = state.streak || 0;

  let msg;
  if (streak === 0) {
    msg = `🔥 *Streak Ngoding*\n\nBelum ada streak aktif. Yuk mulai push commit hari ini!`;
  } else {
    msg = `🔥 *Streak Ngoding*\n\nKamu udah konsisten commit *${streak} hari* berturut-turut!\nTerakhir aktif: ${state.lastActiveDate || '-'}\n\nJangan putus, boss! 💪`;
  }

  ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainMenu });
}

bot.command('streak', handleStreak);
bot.hears('🔥 Streak Ngoding', handleStreak);

// Handler Rekap Mingguan — dibangun dari history harian yang disimpen tiap digest jalan,
// BUKAN query langsung ke GitHub, karena Events API cuma nyimpen histori terbatas & nggak reliable buat mundur 7 hari.
async function handleWeekly(ctx) {
  const state = loadState();
  const history = state.history || [];

  if (history.length === 0) {
    return ctx.reply(
      `📅 *Rekap Mingguan*\n\nBelum ada data histori. Rekap ini otomatis kekumpul tiap hari abis Daily Digest jalan (jam 20:00 WIB) — cek lagi beberapa hari ke depan ya.`,
      { parse_mode: 'Markdown', reply_markup: mainMenu }
    );
  }

  const last7 = history.slice(-7);
  const totalCommits = last7.reduce((sum, d) => sum + d.count, 0);
  const activeDays = last7.filter(d => d.count > 0).length;

  let msg = `📅 *Rekap Mingguan* _(${last7.length} hari terakhir)_\n\n`;
  last7.forEach((d) => {
    msg += `${d.count > 0 ? '✅' : '⬜'} ${d.date} — ${d.count} commit\n`;
  });
  msg += `\n💬 Total: *${totalCommits} commit*\n📆 Hari aktif: *${activeDays}/${last7.length}*\n🔥 Streak saat ini: *${state.streak || 0} hari*`;

  ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: mainMenu });
}

bot.command('weekly', handleWeekly);
bot.hears('📅 Rekap Mingguan', handleWeekly);

// --- Logic alert & digest, dipisah dari cron.schedule biar bisa dipanggil ulang buat catch-up ---
async function runStreakAlert(state) {
  if (!CHAT_ID) return;
  try {
    const { count } = await getTodayCommits();
    if (count === 0) {
      await bot.api.sendMessage(
        CHAT_ID,
        `⚠️ *STREAK ALERT!*\n\nWoi ${GITHUB_USERNAME}! Udah jam 7 malam tapi belum ada commit sama sekali hari ini 🙈\nMinimal push 1 baris kode gih pakai \`git ac\` biar streak ngoding gak putus!`,
        { parse_mode: 'Markdown' }
      );
    }
    state.lastAlertDate = todayWibString();
    saveState(state);
  } catch (e) {
    console.error('Cron Error (alert):', e.message);
  }
}

async function runDailyDigest(state) {
  if (!CHAT_ID) return;
  try {
    const today = todayWibString();
    const { count, repos } = await getTodayCommits();

    // --- Update streak ---
    // Streak nambah kalau hari ini ada commit DAN hari aktif terakhir adalah kemarin (nyambung).
    // Kalau hari aktif terakhir bukan kemarin (ada bolong), streak reset mulai dari 1.
    // Kalau hari ini nggak ada commit, streak putus jadi 0.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayWib = yesterday.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });

    if (count > 0) {
      if (state.lastActiveDate === yesterdayWib) {
        state.streak = (state.streak || 0) + 1;
      } else {
        state.streak = 1;
      }
      state.lastActiveDate = today;
    } else {
      state.streak = 0;
    }

    // --- Update history (buat rekap mingguan) ---
    state.history = state.history || [];
    // Hindari duplikat entry kalau digest sempat kepanggil 2x di hari yang sama (misal via catch-up)
    state.history = state.history.filter(d => d.date !== today);
    state.history.push({ date: today, count });
    state.history = state.history.slice(-30); // simpan max 30 hari terakhir

    let msg = `🌙 *Daily Digest Ngoding — ${new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' })}*\n\n`;
    msg += `🔥 Total Commit Hari Ini: *${count}*\n`;
    msg += `📈 Streak: *${state.streak} hari*\n`;
    if (repos.length > 0) {
      msg += `📂 Repo Terjamah:\n${repos.map(r => `• ${r}`).join('\n')}\n\n`;
      msg += `Mantap! Pertahankan konsistensinya boss! 💪`;
    } else {
      msg += `\nHari ini gak ada commit. Jangan lupa istirahat yang cukup biar besok fokus lagi! 👍`;
    }

    await bot.api.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
    state.lastDigestDate = today;
    saveState(state);
  } catch (e) {
    console.error('Cron Error (digest):', e.message);
  }
}

// CRON JOBS (jalan normal kalau bot nyala persis di jam segitu)
cron.schedule('0 19 * * *', () => runStreakAlert(loadState()), { timezone: 'Asia/Jakarta' });
cron.schedule('0 20 * * *', () => runDailyDigest(loadState()), { timezone: 'Asia/Jakarta' });

// Weekly report otomatis, tiap Minggu jam 21:00 WIB (habis daily digest hari itu jalan)
cron.schedule('0 21 * * 0', async () => {
  if (!CHAT_ID) return;
  const state = loadState();
  const history = state.history || [];
  if (history.length === 0) return;

  const last7 = history.slice(-7);
  const totalCommits = last7.reduce((sum, d) => sum + d.count, 0);
  const activeDays = last7.filter(d => d.count > 0).length;

  let msg = `📅 *Rekap Mingguan Otomatis*\n\n`;
  last7.forEach((d) => {
    msg += `${d.count > 0 ? '✅' : '⬜'} ${d.date} — ${d.count} commit\n`;
  });
  msg += `\n💬 Total: *${totalCommits} commit*\n📆 Hari aktif: *${activeDays}/${last7.length}*\n🔥 Streak saat ini: *${state.streak || 0} hari*`;

  try {
    await bot.api.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Cron Error (weekly):', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

// --- CATCH-UP: dicek sekali tiap kali bot baru nyala/restart ---
// Kalau bot sempat mati pas jam 19:00/20:00 lewat, begitu nyala lagi
// dia cek: "hari ini udah lewat jam segitu tapi belum pernah kekirim?"
// Kalau iya, langsung kirim saat itu juga (telat, tapi nggak silent-skip).
async function runCatchUpCheck() {
  const state = loadState();
  const today = todayWibString();
  const hour = currentHourWib();

  if (hour >= 19 && state.lastAlertDate !== today) {
    console.log('⏰ Catch-up: streak alert hari ini belum pernah dikirim, ngirim sekarang...');
    await runStreakAlert(state);
  }

  if (hour >= 20 && state.lastDigestDate !== today) {
    console.log('⏰ Catch-up: daily digest hari ini belum pernah dikirim, ngirim sekarang...');
    await runDailyDigest(state);
  }
}

// Start Bot
bot.start();
console.log('🤖 Bot Telegram GitHub Monitoring udah jalan...');
runCatchUpCheck();
