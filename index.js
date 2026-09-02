require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const chokidar = require('chokidar');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT_ID = process.env.MY_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROJECTS_DIR = path.resolve('/home/ahmad/projects');

if (!TOKEN || !ALLOWED_CHAT_ID) {
  console.error('❌ Error: TELEGRAM_TOKEN atau MY_CHAT_ID belum diisi di .env!');
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ERROR HANDLER: Biar bot gak crash pas internet RTO/timeout
bot.catch((err) => {
  console.error(`⚠️ Network/Grammy Error:`, err.error || err.message);
});

console.log(`👀 Bot interaktif aktif! Memantau folder: ${PROJECTS_DIR}`);

const userState = {};

// 1. WATCHER MULTI-REPO
const watcher = chokidar.watch(PROJECTS_DIR, {
  ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/dist/**', '**/build/**'],
  persistent: true,
  ignoreInitial: true
});

let debounceTimer = null;
let changedFilesByRepo = {};

watcher.on('all', (event, filePath) => {
  const relative = path.relative(PROJECTS_DIR, filePath);
  const repoName = relative.split(path.sep)[0];
  const repoPath = path.join(PROJECTS_DIR, repoName);

  if (!fs.existsSync(path.join(repoPath, '.git'))) return;

  if (!changedFilesByRepo[repoName]) changedFilesByRepo[repoName] = new Set();

  const fileRelative = path.relative(repoPath, filePath);
  changedFilesByRepo[repoName].add(`${event.toUpperCase()}: ${fileRelative}`);

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => sendMultiRepoNotification(), 5000);
});

function sendMultiRepoNotification() {
  for (const [repoName, files] of Object.entries(changedFilesByRepo)) {
    if (files.size === 0) continue;

    const fileList = Array.from(files).join('\n');
    const message = `📦 *Repo:* \`${repoName}\`\n⚠️ *Perubahan Terdeteksi!*\n\n\`\`\`\n${fileList}\n\`\`\`\nPilih aksi yang mau kamu lakukan:`;

    const keyboard = new InlineKeyboard()
      .text('✅ Auto Commit', `commit_auto:${repoName}`).row()
      .text('✏️ Custom Commit Msg', `commit_custom:${repoName}`).row()
      .text('❌ Abaikan', 'ignore');

    bot.api.sendMessage(ALLOWED_CHAT_ID, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }).catch(err => console.error('Gagal kirim notif:', err.message));
  }
  changedFilesByRepo = {};
}

// 2. TAMPILAN DASHBOARD /START
bot.command('start', async (ctx) => {
  if (ctx.chat.id.toString() !== ALLOWED_CHAT_ID.toString()) return;

  const keyboard = new InlineKeyboard()
    .text('➕ Bikin Repo Baru', 'action_newrepo').row()
    .text('📤 Publish Folder Lokal', 'action_publishrepo').row()
    .text('🐙 List Repo GitHub Saya', 'action_listgithub').row()
    .text('📁 List Folder Lokal', 'action_listrepos');

  await ctx.reply('🤖 *Git Assistant Bot Ready!*\nPilih aksi langsung dari tombol di bawah:', {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
});

// 3. HANDLE CALLBACK QUERY (PENCET TOMBOL)
bot.on('callback_query:data', async (ctx) => {
  if (ctx.from.id.toString() !== ALLOWED_CHAT_ID.toString()) return;

  const data = ctx.callbackQuery.data;

  try {
    if (data === 'action_newrepo') {
      userState[ctx.from.id] = { action: 'awaiting_newrepo_name' };
      await ctx.reply('✍️ Ketik **nama repo baru** yang mau kamu buat (lokal + GitHub):');
    }
    else if (data === 'action_publishrepo') {
      userState[ctx.from.id] = { action: 'awaiting_publish_name' };
      await ctx.reply('✍️ Ketik **nama folder lokal** di `/projects/` yang mau di-publish ke GitHub:');
    }
    else if (data === 'action_listgithub') {
      if (!GITHUB_TOKEN) return ctx.reply('❌ `GITHUB_TOKEN` belum diisi di `.env`!');
      await ctx.reply('⏳ Mengambil daftar repo dari GitHub API...');

      const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'Node-Bot'
        }
      });
      const repos = await res.json();

      if (!res.ok) return ctx.reply(`❌ Error API: ${repos.message}`);

      const listStr = repos.map((r, i) => `${i + 1}. [${r.name}](${r.html_url}) ${r.private ? '🔒' : '🌐'}`).join('\n');
      await ctx.reply(`🐙 *Daftar Repo GitHub Kamu (${repos.length}):*\n\n${listStr}`, { parse_mode: 'Markdown', disable_web_page_preview: true });
    }
    else if (data === 'action_listrepos') {
      const folders = fs.readdirSync(PROJECTS_DIR).filter(f => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory());
      await ctx.reply(`📂 *Folder Lokal di Projects:*\n\n${folders.map(f => `• \`${f}\``).join('\n')}`, { parse_mode: 'Markdown' });
    }
    else if (data.startsWith('commit_auto:')) {
      const repoName = data.split(':')[1];
      executeCommit(ctx, repoName, `Auto-commit via Tele Bot [${new Date().toLocaleTimeString()}]`);
    }
    else if (data.startsWith('commit_custom:')) {
      const repoName = data.split(':')[1];
      userState[ctx.from.id] = { action: 'awaiting_commit_msg', repoName: repoName };
      await ctx.reply(`✍️ Ketik pesan commit khusus buat repo \`${repoName}\`:`, { parse_mode: 'Markdown' });
    }
    else if (data === 'ignore') {
      await ctx.editMessageText('🙈 Perubahan diabaikan.');
    }

    await ctx.answerCallbackQuery().catch(() => {});
  } catch (err) {
    console.error('Callback error:', err.message);
  }
});

// 4. HANDLE CHAT BIASA (INPUT TEKS)
bot.on('message:text', async (ctx) => {
  if (ctx.chat.id.toString() !== ALLOWED_CHAT_ID.toString()) return;

  const state = userState[ctx.from.id];
  if (!state) return;

  const textInput = ctx.message.text.trim();

  if (state.action === 'awaiting_commit_msg') {
    const repoName = state.repoName;
    delete userState[ctx.from.id];
    await ctx.reply(`🔄 Memproses commit dengan pesan: *"${textInput}"*...`, { parse_mode: 'Markdown' });
    executeCommit(ctx, repoName, textInput);
  }
  else if (state.action === 'awaiting_newrepo_name') {
    delete userState[ctx.from.id];
    createNewRepo(ctx, textInput);
  }
  else if (state.action === 'awaiting_publish_name') {
    delete userState[ctx.from.id];
    publishExistingFolder(ctx, textInput);
  }
});

function executeCommit(ctx, repoName, commitMsg) {
  const repoPath = path.join(PROJECTS_DIR, repoName);
  const safeMsg = commitMsg.replace(/"/g, '\\"');
  const gitCommand = `git -C "${repoPath}" add . && git -C "${repoPath}" commit -m "${safeMsg}" && git -C "${repoPath}" push`;

  exec(gitCommand, (error, stdout) => {
    if (error) {
      return ctx.reply(`❌ *Gagal Commit ${repoName}:*\n\`\`\`\n${error.message}\n\`\`\``, { parse_mode: 'Markdown' });
    }
    ctx.reply(`🚀 *${repoName} Berhasil di-Push!*\n💬 Msg: _"${commitMsg}"_`, { parse_mode: 'Markdown' });
  });
}

async function createNewRepo(ctx, repoName) {
  const repoPath = path.join(PROJECTS_DIR, repoName);
  if (fs.existsSync(repoPath)) return ctx.reply(`⚠️ Folder \`${repoName}\` udah ada!`, { parse_mode: 'Markdown' });

  await ctx.reply(`⏳ Bikin repo baru \`${repoName}\`...`, { parse_mode: 'Markdown' });
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${repoName}\nCreated via Tele Bot.`);

  if (GITHUB_TOKEN) {
    try {
      const response = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Node-Bot' },
        body: JSON.stringify({ name: repoName, private: true })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);

      const initCmd = `cd "${repoPath}" && git init && git add . && git commit -m "Initial commit" && git branch -M main && git remote add origin ${data.clone_url} && git push -u origin main`;
      exec(initCmd, (err) => {
        if (err) return ctx.reply(`❌ Gagal Git lokal: ${err.message}`);
        ctx.reply(`🚀 *Repo Berhasil Dibuat!*\nGitHub: ${data.html_url}`, { parse_mode: 'Markdown' });
      });
    } catch (err) { ctx.reply(`❌ Error: ${err.message}`); }
  } else {
    exec(`cd "${repoPath}" && git init`, () => ctx.reply(`✅ Repo lokal \`${repoName}\` dibuat.`, { parse_mode: 'Markdown' }));
  }
}

async function publishExistingFolder(ctx, repoName) {
  const repoPath = path.join(PROJECTS_DIR, repoName);
  if (!fs.existsSync(repoPath)) return ctx.reply(`❌ Folder \`${repoName}\` gak ketemu!`, { parse_mode: 'Markdown' });

  await ctx.reply(`⏳ Publish folder \`${repoName}\` ke GitHub...`, { parse_mode: 'Markdown' });
  try {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Node-Bot' },
      body: JSON.stringify({ name: repoName, private: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);

    const setupCmd = `cd "${repoPath}" && git init && git branch -M main && (git remote remove origin 2>/dev/null || true) && git remote add origin ${data.clone_url} && git add . && git commit -m "Initial publish" && git push -u origin main`;

    exec(setupCmd, (err) => {
      if (err) {
        const fallbackCmd = `cd "${repoPath}" && git branch -M main && (git remote remove origin 2>/dev/null || true) && git remote add origin ${data.clone_url} && git push -u origin main`;
        exec(fallbackCmd, (fbErr) => {
          if (fbErr) return ctx.reply(`❌ Push Gagal: ${fbErr.message}`);
          ctx.reply(`🚀 *Folder ${repoName} Published!*\nGitHub: ${data.html_url}`, { parse_mode: 'Markdown' });
        });
        return;
      }
      ctx.reply(`🚀 *Folder ${repoName} Published!*\nGitHub: ${data.html_url}`, { parse_mode: 'Markdown' });
    });
  } catch (err) { ctx.reply(`❌ Error: ${err.message}`); }
}

bot.start();
