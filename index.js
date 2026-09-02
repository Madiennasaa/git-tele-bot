require('dotenv').config();
const { Bot } = require('grammy');
const cron = require('node-cron');

const bot = new Bot(process.env.BOT_TOKEN);

const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID;

// Helper Fetch GitHub API
async function fetchGithub(url) {
  const headers = { 'User-Agent': 'Git-Bot-CLI' };
  if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API Error: ${res.statusText}`);
  return await res.json();
}

// 1. COMMAND /start
bot.command('start', (ctx) => {
  ctx.reply(`👋 Halo Boss ${GITHUB_USERNAME}!\n\nBot Monitoring GitHub kamu aktif!\n\nPerintah:\n/trending [bahasa] - Cek repo trending\n/stats - Cek commit harian`);
});

// 2. COMMAND /trending [language]
bot.command('trending', async (ctx) => {
  const lang = ctx.match ? ctx.match.trim().toLowerCase() : '';
  await ctx.reply(`🔍 Lagi nyari repo trending ${lang ? `berbahasa ${lang}` : 'global'}...`);

  try {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    const dateStr = date.toISOString().split('T')[0];

    let query = `created:>${dateStr}`;
    if (lang) query += ` language:${lang}`;

    const data = await fetchGithub(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`);

    if (!data.items || data.items.length === 0) {
      return ctx.reply('⚠️ Nggak nemu repo trending buat kriteria itu.');
    }

    let msg = `🔥 *GitHub Trending — ${lang ? lang.toUpperCase() : 'Global'}*\n\n`;
    data.items.forEach((item, index) => {
      msg += `${index + 1}. *${item.full_name}*\n`;
      msg += `   ⭐ +${item.stargazers_count.toLocaleString()} • 🔤 ${item.language || 'Misc'}\n`;
      msg += `   📝 ${item.description ? item.description.substring(0, 60) + '...' : 'Tanpa deskripsi'}\n`;
      msg += `   🔗 ${item.html_url}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    ctx.reply(`❌ Gagal ngambil data trending: ${err.message}`);
  }
});

// Helper Ambil Commit Hari Ini
async function getTodayCommits() {
  const today = new Date().toISOString().split('T')[0];
  const events = await fetchGithub(`https://api.github.com/users/${GITHUB_USERNAME}/events`);

  let todayCommits = 0;
  const repos = new Set();

  events.forEach(event => {
    if (event.type === 'PushEvent') {
      const eventDate = event.created_at.split('T')[0];
      if (eventDate === today) {
        todayCommits += event.payload.commits ? event.payload.commits.length : 1;
        repos.add(event.repo.name);
      }
    }
  });

  return { count: todayCommits, repos: Array.from(repos) };
}

// 3. COMMAND /stats
bot.command('stats', async (ctx) => {
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

    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`❌ Gagal ngambil stats: ${err.message}`);
  }
});

// 4. CRON JOB: Reminder Streak Jam 19:00 WIB
cron.schedule('0 19 * * *', async () => {
  if (!CHAT_ID) return;
  try {
    const { count } = await getTodayCommits();
    if (count === 0) {
      bot.api.sendMessage(
        CHAT_ID,
        `⚠️ *STREAK ALERT!*\n\nWoi ${GITHUB_USERNAME}! Udah jam 7 malam tapi belum ada commit sama sekali hari ini 🙈\nMinimal push 1 baris kode gih pakai \`git ac\` biar streak ngoding gak putus!`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (e) {
    console.error('Cron Error:', e.message);
  }
});

// 5. CRON JOB: Daily Report Jam 20:00 WIB
cron.schedule('0 20 * * *', async () => {
  if (!CHAT_ID) return;
  try {
    const { count, repos } = await getTodayCommits();
    let msg = `🌙 *Daily Digest Ngoding — ${new Date().toLocaleDateString('id-ID')}*\n\n`;
    msg += `🔥 Total Commit Hari Ini: *${count}*\n`;
    if (repos.length > 0) {
      msg += `📂 Repo Terjamah:\n${repos.map(r => `• ${r}`).join('\n')}\n\n`;
      msg += `Mantap! Pertahankan konsistensinya boss! 💪`;
    } else {
      msg += `\nHari ini gak ada commit. Jangan lupa istirahat yang cukup biar besok fokus lagi! 👍`;
    }

    bot.api.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Cron Error:', e.message);
  }
});

// Start Bot
bot.start();
console.log('🤖 Bot Telegram GitHub Monitoring udah jalan...');
