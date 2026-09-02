require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const chokidar = require('chokidar');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT_ID = process.env.MY_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// DAFTAR MULTIPLE FOLDER PROJEK (WSL + WINDOWS MOUNT)
const PROJECTS_DIRS = [
  path.resolve('/home/ahmad/projects'),
  path.resolve('/mnt/d/Proyek')
].filter(dir => fs.existsSync(dir));

// Standar .gitignore otomatis
const DEFAULT_GITIGNORE = `
# Environment variables
.env
.env.local
.env.*.local

# Dependencies
node_modules/
/vendor/

# Build & Output
dist/
build/
*.exe
*.o
*.so

# System & IDE files
.DS_Store
Thumbs.db
.vscode/
.idea/
`;

if (!TOKEN || !ALLOWED_CHAT_ID) {
  console.error('❌ Error: TELEGRAM_TOKEN atau MY_CHAT_ID belum diisi di .env!');
  process.exit(1);
}

const bot = new Bot(TOKEN);

bot.catch((err) => {
  console.error(`⚠️ Network/Grammy Error:`, err.error || err.message);
});

console.log(`👀 Bot aktif! Memantau folder:\n${PROJECTS_DIRS.join('\n')}`);

const userState = {};

// Helper Menu Utama
async function sendMainMenu(ctx, text = '🤖 *Git Assistant Bot Ready!*\nPilih aksi di bawah:') {
  const keyboard = new InlineKeyboard()
    .text('➕ Bikin Repo Baru', 'action_newrepo').row()
    .text('📤 Publish Folder Lokal', 'action_publishrepo').row()
    .text('🐙 List Repo GitHub Saya', 'action_listgithub').row()
    .text('📁 List Folder Lokal', 'action_listrepos');

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// Helper mastiin .gitignore & bersihin index git dari file sensitif secara SINKRON
function sanitizeAndIgnore(repoPath) {
  const gitignorePath = path.join(repoPath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE.trim());
  } else {
    let content = fs.readFileSync(gitignorePath, 'utf8');
    if (!content.includes('.env')) content += '\n.env\n';
    if (!content.includes('node_modules')) content += '\nnode_modules/\n';
    fs.writeFileSync(gitignorePath, content);
  }

  try {
    execSync(`git -C "${repoPath}" rm -r --cached node_modules .env dist build 2>/dev/null || true`);
  } catch (e) {}
}

// 1. WATCHER MULTI-PATH
const watcher = chokidar.watch(PROJECTS_DIRS, {
  ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**'],
  persistent: true,
  ignoreInitial: true
});

let debounceTimer = null;
let changedFilesByRepo = {};

watcher.on('all', (event, filePath) => {
  let targetParent = PROJECTS_DIRS.find(d => filePath.startsWith(d));
  if (!targetParent) return;

  const relative = path.relative(targetParent, filePath);
  const repoName = relative.split(path.sep)[0];
  const repoPath = path.join(targetParent, repoName);

  if (!fs.existsSync(path.join(repoPath, '.git'))) return;

  const repoKey = `${targetParent}::${repoName}`;
  if (!changedFilesByRepo[repoKey]) changedFilesByRepo[repoKey] = new Set();

  const fileRelative = path.relative(repoPath, filePath);
  changedFilesByRepo[repoKey].add(`${event.toUpperCase()}: ${fileRelative}`);

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => sendMultiRepoNotification(), 5000);
});

function sendMultiRepoNotification() {
  for (const [repoKey, files] of Object.entries(changedFilesByRepo)) {
    if (files.size === 0) continue;

    const [parentDir, repoName] = repoKey.split('::');
    const fileList = Array.from(files).join('\n');
    const message = `📦 *Repo:* \`${repoName}\`\n📍 *Loc:* \`${parentDir}\`\n⚠️ *Perubahan Terdeteksi!*\n\n\`\`\`\n${fileList}\n\`\`\`\nPilih aksi yang mau kamu lakukan:`;

    const keyboard = new InlineKeyboard()
      .text('✅ Auto Commit', `commit_auto:${encodeURIComponent(repoKey)}`).row()
      .text('✏️ Custom Commit Msg', `commit_custom:${encodeURIComponent(repoKey)}`).row()
      .text('❌ Abaikan', 'ignore');

    bot.api.sendMessage(ALLOWED_CHAT_ID, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }).catch(err => console.error('Gagal kirim notif:', err.message));
  }
  changedFilesByRepo = {};
}

// 2. /START COMMAND
bot.command('start', async (ctx) => {
  if (ctx.chat.id.toString() !== ALLOWED_CHAT_ID.toString()) return;
  await sendMainMenu(ctx);
});

// 3. HANDLE CALLBACK QUERY (PENCET TOMBOL)
bot.on('callback_query:data', async (ctx) => {
  if (ctx.from.id.toString() !== ALLOWED_CHAT_ID.toString()) return;

  const data = ctx.callbackQuery.data;

  try {
    if (data === 'action_newrepo') {
      userState[ctx.from.id] = { action: 'awaiting_newrepo_name' };
      await ctx.reply('✍️ Ketik **nama repo baru** yang mau dibuat (di WSL `/home/ahmad/projects/`):');
    }
    else if (data === 'action_publishrepo') {
      const keyboard = new InlineKeyboard();
      let totalFolder = 0;

      PROJECTS_DIRS.forEach(parentDir => {
        const folders = fs.readdirSync(parentDir).filter(f => fs.statSync(path.join(parentDir, f)).isDirectory());
        folders.forEach(f => {
          const fullPath = path.join(parentDir, f);
          keyboard.text(`📁 ${f} (${path.basename(parentDir)})`, `do_publish:${encodeURIComponent(fullPath)}`).row();
          totalFolder++;
        });
      });

      if (totalFolder === 0) {
        await ctx.reply('❌ Nggak ada folder projek ditemukan di path lokal kamu.');
        return sendMainMenu(ctx);
      }

      await ctx.reply('👇 *Pilih folder lokal yang mau kamu publish ke GitHub:*', {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
    else if (data.startsWith('do_publish:')) {
      const fullPath = decodeURIComponent(data.split(':')[1]);
      publishFolderByPath(ctx, fullPath);
    }
    else if (data === 'action_listgithub') {
      if (!GITHUB_TOKEN) return ctx.reply('❌ `GITHUB_TOKEN` belum diisi di `.env`!');
      await ctx.reply('⏳ Mengambil daftar repo dari GitHub API...');

      const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'Node-Bot' }
      });
      const repos = await res.json();

      if (!res.ok) {
        await ctx.reply(`❌ Error API: ${repos.message}`);
      } else {
        const listStr = repos.map((r, i) => `${i + 1}. [${r.name}](${r.html_url}) ${r.private ? '🔒' : '🌐'}`).join('\n');
        await ctx.reply(`🐙 *Daftar Repo GitHub Kamu (${repos.length}):*\n\n${listStr}`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }
      await sendMainMenu(ctx, '👇 Pilih menu selanjutnya:');
    }
    else if (data === 'action_listrepos') {
      let listText = '📂 *Daftar Folder Lokal:*\n\n';
      PROJECTS_DIRS.forEach(parentDir => {
        const folders = fs.readdirSync(parentDir).filter(f => fs.statSync(path.join(parentDir, f)).isDirectory());
        listText += `📍 *${parentDir}*\n${folders.map(f => `  • \`${f}\``).join('\n')}\n\n`;
      });
      await ctx.reply(listText, { parse_mode: 'Markdown' });
      await sendMainMenu(ctx, '👇 Pilih menu selanjutnya:');
    }
    else if (data.startsWith('commit_auto:')) {
      const repoKey = decodeURIComponent(data.split(':')[1]);
      // Ubah teks pesan notif biar tombolnya ilang & gak bisa dipencet 2x
      await ctx.editMessageText('🔄 *Memproses Auto Commit & Push...*', { parse_mode: 'Markdown' }).catch(() => {});
      executeCommitByKey(ctx, repoKey, null);
    }
    else if (data.startsWith('commit_custom:')) {
      const repoKey = decodeURIComponent(data.split(':')[1]);
      userState[ctx.from.id] = { action: 'awaiting_commit_msg', repoKey: repoKey };
      // Ubah teks notif lama biar gak berantakan
      await ctx.editMessageText('✍️ *Menunggu input pesan commit khusus...*', { parse_mode: 'Markdown' }).catch(() => {});
      await ctx.reply(`Ketik pesan commit khusus buat repo ini:`);
    }
    else if (data === 'ignore') {
      await ctx.editMessageText('🙈 Perubahan diabaikan.');
      await sendMainMenu(ctx, '👇 Pilih menu selanjutnya:');
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
    const repoKey = state.repoKey;
    delete userState[ctx.from.id];
    await ctx.reply(`🔄 Memproses commit: *"${textInput}"*...`, { parse_mode: 'Markdown' });
    executeCommitByKey(ctx, repoKey, textInput);
  }
  else if (state.action === 'awaiting_newrepo_name') {
    delete userState[ctx.from.id];
    createNewRepo(ctx, textInput);
  }
});

// FUNGSI EXECUTE COMMIT (MURNI CONVENTIONAL COMMIT)
// FUNGSI EXECUTE COMMIT (DETEKSI CONVENTIONAL COMMIT + DETAIL FILE)
function executeCommitByKey(ctx, repoKey, commitMsg) {
  const [parentDir, repoName] = repoKey.split('::');
  const repoPath = path.join(parentDir, repoName);

  sanitizeAndIgnore(repoPath);

  let finalMsg = commitMsg;

  // Kalau Auto Commit (commitMsg null/kosong), racik pesan pintar!
  if (!finalMsg || finalMsg.trim() === '') {
    try {
      // 1. Ambil status file (A = Added, M = Modified, D = Deleted)
      const statusOutput = execSync(`git -C "${repoPath}" status --porcelain`).toString().trim();
      const lines = statusOutput.split('\n').filter(Boolean);

      if (lines.length > 0) {
        let type = 'chore';
        const fileDetails = [];

        lines.forEach(line => {
          const status = line.substring(0, 2).trim();
          const filePath = line.substring(3).trim();
          const fileName = path.basename(filePath);

          // Tentukan tipe commit berdasarkan status Git
          if (status.includes('A') || status === '??') {
            type = 'feat'; // Ada file/fitur baru
          } else if (status.includes('D')) {
            type = 'refactor'; // Ada penghapusan/restrukturisasi
          } else if (status.includes('M') && type !== 'feat') {
            type = 'fix'; // Edit file yang ada
          }

          fileDetails.push(`${fileName} (${status})`);
        });

        // 2. Susun format: "type(scope): detail perubahannya"
        const scope = repoName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const summary = fileDetails.slice(0, 3).join(', ');
        const extraCount = fileDetails.length > 3 ? ` +${fileDetails.length - 3} more` : '';

        finalMsg = `${type}(${scope}): update ${summary}${extraCount}`;
      } else {
        finalMsg = `chore(${repoName}): update project files`;
      }
    } catch (e) {
      finalMsg = `chore(${repoName}): update project files`;
    }
  }

  const safeMsg = finalMsg.replace(/"/g, '\\"');
  const gitCommand = `git -C "${repoPath}" add . && git -C "${repoPath}" commit -m "${safeMsg}" && git -C "${repoPath}" push`;

  exec(gitCommand, async (error) => {
    if (error) {
      await ctx.reply(`❌ *Gagal Commit ${repoName}:*\n\`\`\`\n${error.message}\n\`\`\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`🚀 *${repoName} Berhasil di-Push!*\n💬 Commit: \`${finalMsg}\``, { parse_mode: 'Markdown' });
    }
    sendMainMenu(ctx, '👇 Pilih menu selanjutnya:');
  });
}

async function createNewRepo(ctx, repoName) {
  const defaultParent = PROJECTS_DIRS[0];
  const repoPath = path.join(defaultParent, repoName);

  if (fs.existsSync(repoPath)) {
    await ctx.reply(`⚠️ Folder \`${repoName}\` udah ada!`, { parse_mode: 'Markdown' });
    return sendMainMenu(ctx);
  }

  await ctx.reply(`⏳ Bikin repo baru \`${repoName}\`...`, { parse_mode: 'Markdown' });
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${repoName}\nCreated via Tele Bot.`);
  sanitizeAndIgnore(repoPath);

  if (GITHUB_TOKEN) {
    try {
      const response = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Node-Bot' },
        body: JSON.stringify({ name: repoName, private: true })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);

      const initCmd = `cd "${repoPath}" && git init && git add . && git commit -m "feat: initial project setup" && git branch -M main && git remote add origin ${data.clone_url} && git push -u origin main`;
      exec(initCmd, async (err) => {
        if (err) {
          await ctx.reply(`❌ Gagal Git lokal: ${err.message}`);
        } else {
          await ctx.reply(`🚀 *Repo Berhasil Dibuat!*\nGitHub: ${data.html_url}`, { parse_mode: 'Markdown' });
        }
        sendMainMenu(ctx, '👇 Pilih menu selanjutnya:');
      });
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
      sendMainMenu(ctx);
    }
  }
}

async function publishFolderByPath(ctx, repoPath) {
  const repoName = path.basename(repoPath);
  sanitizeAndIgnore(repoPath);

  await ctx.reply(`⏳ Publish folder \`${repoName}\` ke GitHub...`, { parse_mode: 'Markdown' });
  try {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Node-Bot' },
      body: JSON.stringify({ name: repoName, private: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);

    const setupCmd = `cd "${repoPath}" && git init && git branch -M main && (git remote remove origin 2>/dev/null || true) && git remote add origin ${data.clone_url} && git add . && git commit -m "feat: initial release via Tele Bot" && git push -u origin main`;

    exec(setupCmd, (err) => {
      if (err) {
        const fallbackCmd = `cd "${repoPath}" && git branch -M main && (git remote remove origin 2>/dev/null || true) && git remote add origin ${data.clone_url} && git push -u origin main`;
        exec(fallbackCmd, async (fbErr) => {
          if (fbErr) {
            await ctx.reply(`❌ Push Gagal: ${fbErr.message}`);
          } else {
            await ctx.reply(`🚀 *Folder ${repoName} Published!*\nGitHub: ${data.html_url}`, { parse_mode: 'Markdown' });
          }
          sendMainMenu(ctx, '👇 Pilih menu selanjutnya:');
        });
        return;
      }
      ctx.reply(`🚀 *Folder ${repoName} Published!*\nGitHub: ${data.html_url}`, { parse_mode: 'Markdown' });
      sendMainMenu(ctx, '👇 Pilih menu selanjutnya:');
    });
  } catch (err) {
    await ctx.reply(`❌ Error: ${err.message}`);
    sendMainMenu(ctx);
  }
}

// FUNGSI CEK SISA PERUBAHAN PAS BOT BARU NYALA
function checkPendingGitChanges() {
  PROJECTS_DIRS.forEach(parentDir => {
    if (!fs.existsSync(parentDir)) return;

    const folders = fs.readdirSync(parentDir).filter(f => fs.statSync(path.join(parentDir, f)).isDirectory());

    folders.forEach(repoName => {
      const repoPath = path.join(parentDir, repoName);
      if (!fs.existsSync(path.join(repoPath, '.git'))) return;

      exec(`git -C "${repoPath}" status --porcelain`, (err, stdout) => {
        if (err || !stdout.trim()) return;

        const repoKey = `${parentDir}::${repoName}`;
        const fileList = stdout.trim();

        const message = `📦 *Repo:* \`${repoName}\`\n📍 *Loc:* \`${parentDir}\`\n⚠️ *Perubahan Ditemukan Pas Bot Startup!*\n\n\`\`\`\n${fileList}\n\`\`\`\nPilih aksi:`;

        const keyboard = new InlineKeyboard()
          .text('✅ Auto Commit', `commit_auto:${encodeURIComponent(repoKey)}`).row()
          .text('✏️ Custom Commit Msg', `commit_custom:${encodeURIComponent(repoKey)}`).row()
          .text('❌ Abaikan', 'ignore');

        bot.api.sendMessage(ALLOWED_CHAT_ID, message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        }).catch(() => {});
      });
    });
  });
}

// Panggil pengecekan pas startup
checkPendingGitChanges();

bot.start();
