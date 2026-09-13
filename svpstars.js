const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { ethers } = require('ethers');
const readline = require('readline');
const { spawn } = require('child_process');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const INVITE_CODE  = '7C0TM814';
const BASE_URL     = 'https://rewards.svpstars.com';
const X_API        = 'https://api.x.com';
const X_AUTH       = 'https://x.com';
const X_BEARER     = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const FOLLOW_TARGET = 'svpchain';
const DELAY_MS     = 3000;

// ─── UTILS ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

function req(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        ...(opts.headers || {}),
      },
    };
    if (opts.body !== undefined) {
      const body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      options.headers['Content-Length'] = Buffer.byteLength(body);
      options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
    }
    const chunks = [];
    const r = https.request(options, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.hostname}${res.headers.location}`;
        return resolve({ status: res.statusCode, headers: res.headers, redirect: loc, body: '' });
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      const zlib = require('zlib');
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    r.on('error', reject);
    if (opts.body !== undefined) {
      const body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      r.write(body);
    }
    r.end();
  });
}

// ─── PARSE FILES ─────────────────────────────────────────────────────────────
function parseAkun(file) {
  const blocks = fs.readFileSync(file, 'utf8').trim().split(/\n\s*\n/);
  return blocks.map(b => {
    const lines = b.trim().split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length >= 2 ? { authtoken: lines[0], ct0: lines[1] } : null;
  }).filter(Boolean);
}

function parseWallets(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => l.trim()).filter(Boolean);
}

function parseSessions(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => l.trim()).filter(Boolean);
}

function parseDiscord(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// ─── WALLET LOGIN ─────────────────────────────────────────────────────────────
async function walletLogin(privkey) {
  const wallet = new ethers.Wallet(privkey);
  const address = wallet.address;

  const nonceRes = await req(`${BASE_URL}/api/v1/auth/nonce?address=${address}`);
  if (!nonceRes.body?.data?.nonce) throw new Error(`Nonce gagal: ${JSON.stringify(nonceRes.body)}`);

  const message = nonceRes.body.data.message
    || `Sign in to SVP Rewards\n\nAddress: ${address}\nNonce: ${nonceRes.body.data.nonce}`;
  const signature = await wallet.signMessage(message);

  const loginRes = await req(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': BASE_URL, 'Referer': `${BASE_URL}/` },
    body: { address, inviteCode: INVITE_CODE, signature },
  });

  if (!loginRes.body?.data?.token) throw new Error(`Login gagal: ${JSON.stringify(loginRes.body)}`);
  return { token: loginRes.body.data.token, address, user: loginRes.body.data.user };
}

// ─── START TASK ───────────────────────────────────────────────────────────────
async function startTask(token, taskId) {
  const res = await req(`${BASE_URL}/api/v1/tasks/${taskId}/start`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Origin': BASE_URL, 'Referer': `${BASE_URL}/` },
    body: {},
  });
  const userStatus = res.body?.data?.userStatus;
  const tgLink = res.body?.data?.tgLink || null;
  if (res.body?.code === 0 || userStatus === 'claimable' || userStatus === 'done') return { ok: true, tgLink, userStatus };
  const msg = JSON.stringify(res.body || '');
  if (msg.toLowerCase().includes('already')) return { ok: true, tgLink, userStatus: 'done' };
  throw new Error(`Start task ${taskId} gagal: ${msg}`);
}

// ─── CLAIM TASK ───────────────────────────────────────────────────────────────
async function claimTask(token, taskId, maxRetry = 10, retryDelay = 15000) {
  for (let i = 1; i <= maxRetry; i++) {
    const res = await req(`${BASE_URL}/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Origin': BASE_URL, 'Referer': `${BASE_URL}/` },
      body: {},
    });
    if (res.body?.code === 0) {
      return { points: res.body?.data?.pointsAwarded || res.body?.data?.totalPoints || 0 };
    }
    const msg = JSON.stringify(res.body || '');
    if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('done')) {
      return { points: 0, note: 'sudah pernah claim' };
    }
    if (res.body?.code === 1002) {
      console.log(`     ⏳ Claim task ${taskId} attempt ${i}/${maxRetry} — not ready, retry in ${retryDelay/1000}s...`);
      if (i < maxRetry) await sleep(retryDelay);
      continue;
    }
    throw new Error(`Claim task ${taskId} gagal: ${msg}`);
  }
  throw new Error(`Claim task ${taskId} gagal setelah ${maxRetry}x retry`);
}

// ─── TASK 1: KONEK X ──────────────────────────────────────────────────────────
async function connectX(token, akun) {
  const { authtoken, ct0 } = akun;
  const xCookie = `auth_token=${authtoken}; ct0=${ct0}; twid=u%3D0`;

  const startRes = await req(`${BASE_URL}/api/v1/social/x/start`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Origin': BASE_URL, 'Referer': `${BASE_URL}/` },
  });

  const authUrl = startRes.body?.data?.authUrl || startRes.body?.data?.url || startRes.redirect;
  if (!authUrl) throw new Error(`Gagal dapet authUrl: ${JSON.stringify(startRes.body)}`);

  const authUrlObj = new URL(authUrl);
  const getRes = await req(`https://x.com/i/api/2/oauth2/authorize?${authUrlObj.searchParams.toString()}`, {
    headers: {
      'Authorization': `Bearer ${X_BEARER}`,
      'Cookie': xCookie,
      'Accept': 'application/json',
      'X-Csrf-Token': ct0,
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'id',
      'Origin': 'https://x.com',
      'Referer': 'https://x.com/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
  });

  const authCode = getRes.body?.auth_code;
  if (!authCode) throw new Error(`auth_code tidak ditemukan: ${JSON.stringify(getRes.body)}`);

  const approveRes = await req(`${X_API}/2/oauth2/authorize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${X_BEARER}`,
      'Cookie': xCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://x.com',
      'Referer': 'https://x.com/',
      'X-Csrf-Token': ct0,
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'id',
    },
    body: new URLSearchParams({ approval: 'true', code: authCode, consent_flow: 'web_consent' }).toString(),
  });

  if (!approveRes.body?.redirect_uri) throw new Error(`Gagal dapat redirect_uri: ${JSON.stringify(approveRes.body)}`);

  const redirectUrl = new URL(approveRes.body.redirect_uri);
  const code  = redirectUrl.searchParams.get('code');
  const state = redirectUrl.searchParams.get('state');
  if (!code) throw new Error('Code OAuth2 tidak ditemukan');

  const callbackRes = await req(`${BASE_URL}/api/v1/social/x/callback?state=${state}&code=${code}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Referer': 'https://x.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
    },
  });

  if (callbackRes.redirect?.includes('x=linked') || callbackRes.status === 200 || callbackRes.status === 302) {
    if (!callbackRes.redirect?.includes('x=error')) return true;
  }
  throw new Error(`Callback X gagal: ${callbackRes.redirect || JSON.stringify(callbackRes.body)}`);
}

// ─── TASK 4: KONEK DISCORD ────────────────────────────────────────────────────
async function connectDiscord(svpToken, dcToken) {
  // 1. get discord oauth url dari svpstars
  const startRes = await req(`${BASE_URL}/api/v1/social/discord/start`, {
    headers: { 'Authorization': `Bearer ${svpToken}`, 'Origin': BASE_URL, 'Referer': `${BASE_URL}/` },
  });

  const authUrl = startRes.body?.data?.authUrl || startRes.body?.data?.url || startRes.redirect;
  if (!authUrl) throw new Error(`Gagal dapet Discord authUrl: ${JSON.stringify(startRes.body)}`);

  const authUrlObj = new URL(authUrl);
  const state = authUrlObj.searchParams.get('state');

  // 2. POST authorize ke discord pake user token
  const dcRes = await req(`https://discord.com/api/v9/oauth2/authorize?${authUrlObj.searchParams.toString()}`, {
    method: 'POST',
    headers: {
      'Authorization': dcToken,
      'Content-Type': 'application/json',
      'Origin': 'https://discord.com',
      'Referer': 'https://discord.com/',
      'X-Discord-Locale': 'en-US',
      'X-Discord-Timezone': 'Asia/Jakarta',
    },
    body: {
      authorize: true,
      guild_id: '1486654850166030442',
      permissions: '0',
      integration_type: 0,
      location_context: { guild_id: '10000', channel_id: '10000', channel_type: 10000 },
    },
  });

  // response berisi location/redirect dengan code
  const location = dcRes.body?.location || dcRes.redirect;
  if (!location) throw new Error(`Discord authorize gagal: ${JSON.stringify(dcRes.body)}`);

  const locationUrl = new URL(location);
  const code = locationUrl.searchParams.get('code');
  if (!code) throw new Error('Code Discord tidak ditemukan di redirect');

  // 3. callback ke svpstars
  const callbackRes = await req(`${BASE_URL}/api/v1/social/discord/callback?state=${state}&code=${code}`, {
    headers: {
      'Authorization': `Bearer ${svpToken}`,
      'Referer': 'https://discord.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
    },
  });

  if (callbackRes.redirect?.includes('discord=linked') || callbackRes.status === 200 || callbackRes.status === 302) {
    if (!callbackRes.redirect?.includes('discord=error')) return true;
  }
  throw new Error(`Callback Discord gagal: ${callbackRes.redirect || JSON.stringify(callbackRes.body)}`);
}

// ─── TASK 2: FOLLOW X ─────────────────────────────────────────────────────────
async function followX(akun) {
  const { authtoken, ct0 } = akun;
  const xHeaders = {
    'Authorization': `Bearer ${X_BEARER}`,
    'Cookie': `auth_token=${authtoken}; ct0=${ct0}`,
    'X-Csrf-Token': ct0,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': 'id',
    'Origin': 'https://x.com',
    'Referer': 'https://x.com/',
  };

  // cek dulu udah follow apa belum
  const checkRes = await req(`${X_API}/1.1/friendships/show.json?source_screen_name=me&target_screen_name=${FOLLOW_TARGET}`, {
    headers: xHeaders,
  });
  if (checkRes.body?.relationship?.source?.following === true) {
    return { note: 'sudah follow' };
  }

  // follow
  const body = `screen_name=${FOLLOW_TARGET}&skip_status=true`;
  const followRes = await req(`${X_API}/1.1/friendships/create.json`, {
    method: 'POST',
    headers: { ...xHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (followRes.status === 200) return { ok: true };
  throw new Error(`Follow gagal: ${JSON.stringify(followRes.body)}`);
}

// ─── TASK 3: TELEGRAM (via tele.py) ──────────────────────────────────────────
function runTele(sessionString, startParam) {
  const args = ['tele.py', sessionString];
  if (startParam) args.push(startParam);
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tele.py exit code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ─── PROSES 1 AKUN ───────────────────────────────────────────────────────────
async function processAkun(privkey, akun, session, label) {
  // Login
  console.log(`\n${label} 🔑 Wallet login...`);
  const { token, address } = await walletLogin(privkey);
  console.log(`${label} ✅ Login | ${address}`);
  console.log(`${label} 🔑 SVP Token: ${token}`);

  await sleep(1000);

  let pts1 = 0, pts2 = 0, pts3 = 0;

  // ── Task 1: Bind X ──
  console.log(`${label} 🐦 [Task 1] Start + Konek X...`);
  const { userStatus: s1 } = await startTask(token, 1);
  if (s1 === 'done') {
    console.log(`${label} ⏭️  Task 1 sudah done, skip`);
  } else {
    await sleep(1000);
    await connectX(token, akun);
    console.log(`${label} ✅ X linked!`);
    await sleep(5000);
    const { points: p1, note: n1 } = await claimTask(token, 1);
    pts1 = p1;
    console.log(`${label} 🎁 Task 1 claimed! +${pts1} pts${n1 ? ` (${n1})` : ''}`);
  }

  await sleep(2000);

  // ── Task 2: Follow X ──
  console.log(`${label} 👤 [Task 2] Start + Follow @${FOLLOW_TARGET}...`);
  const { userStatus: s2 } = await startTask(token, 2);
  if (s2 === 'done') {
    console.log(`${label} ⏭️  Task 2 sudah done, skip`);
  } else {
    await sleep(1000);
    const { note: fn } = await followX(akun);
    console.log(`${label} ✅ Follow OK${fn ? ` (${fn})` : ''}`);
    await sleep(3000);
    const { points: p2, note: n2 } = await claimTask(token, 2);
    pts2 = p2;
    console.log(`${label} 🎁 Task 2 claimed! +${pts2} pts${n2 ? ` (${n2})` : ''}`);
  }

  await sleep(2000);

  // ── Task 3: Join Telegram ──
  console.log(`${label} 📱 [Task 3] Start + Join Telegram...`);
  const { tgLink, userStatus: s3 } = await startTask(token, 3);
  if (s3 === 'done') {
    console.log(`${label} ⏭️  Task 3 sudah done, skip`);
  } else {
    const startParam = tgLink ? new URL(tgLink).searchParams.get('start') : null;
    console.log(`     tgLink: ${tgLink} | startParam: ${startParam}`);
    await sleep(1000);
    await runTele(session, startParam);
    console.log(`${label} ✅ Telegram done!`);
    await sleep(3000);
    const { points: p3, note: n3 } = await claimTask(token, 3);
    pts3 = p3;
    console.log(`${label} 🎁 Task 3 claimed! +${pts3} pts${n3 ? ` (${n3})` : ''}`);
  }

  // ── Task 4: Join Discord ──
  let pts4 = 0;
  console.log(`${label} 💬 [Task 4] Discord...`);
  const { userStatus: s4 } = await startTask(token, 4);
  if (s4 === 'done') {
    console.log(`${label} ⏭️  Task 4 sudah done, skip`);
  } else {
    console.log(`     → Buka browser, jalanin TM script`);
    console.log(`     → SVP token ada di atas ↑`);
    console.log(`     → Setelah ✅ DONE muncul di TM, tekan Enter`);
    await ask('     Tekan Enter setelah Discord terhubung: ');
    await sleep(2000);
    const { points: p4, note: n4 } = await claimTask(token, 4);
    pts4 = p4;
    console.log(`${label} 🎁 Task 4 claimed! +${pts4} pts${n4 ? ` (${n4})` : ''}`);
  }

  const total = pts1 + pts2 + pts3 + pts4;
  console.log(`${label} 🏆 Total: +${total} pts`);
  return address;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const privkeys = parseWallets('wallet.txt');
  const akuns    = parseAkun('akun.txt');
  const sessions = parseSessions('sessions.txt');
  const total    = Math.min(privkeys.length, akuns.length, sessions.length);

  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║        SVP Stars Bot             ║`);
  console.log(`╚══════════════════════════════════╝`);
  console.log(`Total akun: ${total}\n`);
  console.log(`  1 → 1 akun`);
  console.log(`  2 → Semua akun`);
  console.log(`  3 → From X to end\n`);

  const pilihan = await ask('Pilih [1/2/3]: ');
  let startIdx = 0, endIdx = total;

  if (pilihan === '1') {
    const no = await ask(`Nomor akun (1-${total}): `);
    const idx = parseInt(no) - 1;
    if (isNaN(idx) || idx < 0 || idx >= total) { console.log('Invalid'); process.exit(1); }
    startIdx = idx; endIdx = idx + 1;
  } else if (pilihan === '2') {
    startIdx = 0; endIdx = total;
  } else if (pilihan === '3') {
    const from = await ask(`Mulai dari akun ke- (1-${total}): `);
    const idx = parseInt(from) - 1;
    if (isNaN(idx) || idx < 0 || idx >= total) { console.log('Invalid'); process.exit(1); }
    startIdx = idx; endIdx = total;
  } else {
    console.log('Invalid'); process.exit(1);
  }

  console.log(`\nJalanin akun ${startIdx + 1} s/d ${endIdx}\n${'─'.repeat(50)}`);

  const results = [];
  for (let i = startIdx; i < endIdx; i++) {
    const label = `[${i+1}/${total}]`;
    try {
      const address = await processAkun(privkeys[i], akuns[i], sessions[i], label);
      results.push({ index: i+1, address, status: 'OK' });
    } catch (e) {
      console.error(`${label} ❌ ${e.message}`);
      results.push({ index: i+1, status: 'FAIL', error: e.message });
    }
    if (i < endIdx - 1) {
      console.log(`\nDelay ${DELAY_MS/1000}s...\n`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n${'─'.repeat(50)}\nSUMMARY:`);
  results.forEach(r => {
    const icon = r.status === 'OK' ? '✅' : '❌';
    console.log(`  ${icon} [${r.index}] ${r.status === 'OK' ? r.address : r.error}`);
  });
  console.log(`\nBerhasil: ${results.filter(r => r.status === 'OK').length}/${results.length}`);
}

main().catch(console.error);
