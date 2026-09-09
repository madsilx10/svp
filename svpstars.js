const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { ethers } = require('ethers');
const readline = require('readline');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const INVITE_CODE = '7C0TM814';
const BASE_URL = 'https://rewards.svpstars.com';
const X_API = 'https://api.x.com';
const X_AUTH = 'https://x.com';
const DELAY_MS = 3000;

// ─── UTILS ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
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
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.hostname}${res.headers.location}`;
        return resolve({ status: res.statusCode, headers: res.headers, redirect: loc, body: '' });
      }

      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      } else if (enc === 'br') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (enc === 'deflate') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createInflate());
      }

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

// ─── PKCE HELPER ─────────────────────────────────────────────────────────────
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function generateState() {
  return crypto.randomBytes(16).toString('base64url');
}

// ─── PARSE ACCOUNTS ──────────────────────────────────────────────────────────
function parseAkun(file) {
  const blocks = fs.readFileSync(file, 'utf8').trim().split(/\n\s*\n/);
  const accounts = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      accounts.push({ authtoken: lines[0], ct0: lines[1] });
    }
  }
  return accounts;
}

function parseWallets(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// ─── STEP 1: WALLET LOGIN ────────────────────────────────────────────────────
async function walletLogin(privkey) {
  const wallet = new ethers.Wallet(privkey);
  const address = wallet.address;

  const nonceRes = await req(`${BASE_URL}/api/v1/auth/nonce?address=${address}`);
  if (!nonceRes.body?.data?.nonce) {
    throw new Error(`Nonce gagal: ${JSON.stringify(nonceRes.body)}`);
  }
  const nonce = nonceRes.body.data.nonce;

  // pakai message langsung dari API (bukan construct manual)
  const message = nonceRes.body.data.message
    || `Sign in to SVP Rewards\n\nAddress: ${address}\nNonce: ${nonce}`;

  console.log(`     message: ${JSON.stringify(message)}`);
  const signature = await wallet.signMessage(message);

  const loginRes = await req(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': BASE_URL, 'Referer': `${BASE_URL}/` },
    body: { address, inviteCode: INVITE_CODE, signature },
  });

  if (!loginRes.body?.data?.token) {
    throw new Error(`Login gagal: ${JSON.stringify(loginRes.body)}`);
  }

  return {
    token: loginRes.body.data.token,
    address,
    user: loginRes.body.data.user,
  };
}

// ─── STEP 2: KONEK X ─────────────────────────────────────────────────────────
async function connectX(jwtToken, xAccount) {
  const { authtoken, ct0 } = xAccount;
  const svpCookie = `_ga=GA1.1.000000000.0000000000; _ga_GQ09LVJ2ZP=GS2.1.0000000000$o1$g1$t0000000000$j0$l0$h0`;
  const xCookie = `auth_token=${authtoken}; ct0=${ct0}; twid=u%3D0`;

  const startRes = await req(`${BASE_URL}/api/v1/social/x/start`, {
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Cookie': svpCookie,
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/`,
    },
  });

  let authUrl;
  if (startRes.body?.data?.url) {
    authUrl = startRes.body.data.url;
  } else if (startRes.redirect) {
    authUrl = startRes.redirect;
  } else {
    const { verifier, challenge } = generatePKCE();
    const state = generateState();
    const clientId = 'VzRSdGNDVVhDQndZU2xVdHVETDI6MTpjaQ';
    const redirectUri = `${BASE_URL}/api/v1/social/x/callback`;
    const scope = 'tweet.read users.read follows.read offline.access';
    authUrl = `${X_AUTH}/i/oauth2/authorize?client_id=${clientId}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
    xAccount._verifier = verifier;
    xAccount._state = state;
  }

  if (!authUrl) throw new Error(`Gagal dapet auth URL X: ${JSON.stringify(startRes.body)}`);

  // Step 2: GET auth_code via /i/api/2/oauth2/authorize (JSON endpoint, bukan HTML)
  const authUrlObj = new URL(authUrl);
  const getAuthRes = await req(`https://x.com/i/api/2/oauth2/authorize?${authUrlObj.searchParams.toString()}`, {
    headers: {
      'Authorization': `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
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

  const authCode = getAuthRes.body?.auth_code;
  if (!authCode) {
    throw new Error(`auth_code tidak ditemukan. Status: ${getAuthRes.status} Body: ${JSON.stringify(getAuthRes.body)}`);
  }

  // Step 3: POST approve
  const approveBody = new URLSearchParams({
    approval: 'true',
    code: authCode,
    consent_flow: 'web_consent',
  }).toString();

  const approveRes = await req(`${X_API}/2/oauth2/authorize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
      'Cookie': xCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://x.com',
      'Referer': 'https://x.com/',
      'X-Csrf-Token': ct0,
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'id',
    },
    body: approveBody,
  });

  let code, state;
  if (approveRes.body?.redirect_uri) {
    const redirectUrl = new URL(approveRes.body.redirect_uri);
    code = redirectUrl.searchParams.get('code');
    state = redirectUrl.searchParams.get('state');
  } else {
    throw new Error(`Gagal dapat redirect_uri dari X: ${JSON.stringify(approveRes.body)}`);
  }

  if (!code) throw new Error('Code OAuth2 X tidak ditemukan');

  const callbackRes = await req(`${BASE_URL}/api/v1/social/x/callback?state=${state}&code=${code}`, {
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Cookie': svpCookie,
      'Referer': 'https://x.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
    },
  });

  if (
    callbackRes.redirect?.includes('x=linked') ||
    callbackRes.body?.message === 'ok' ||
    callbackRes.status === 200 ||
    callbackRes.status === 302
  ) {
    return true;
  }

  throw new Error(`Callback gagal: status ${callbackRes.status} ${JSON.stringify(callbackRes.body)}`);
}

// ─── STEP 3: CLAIM ───────────────────────────────────────────────────────────
async function claimTask(jwtToken, taskId = 1) {
  const claimRes = await req(`${BASE_URL}/api/v1/tasks/${taskId}/claim`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/`,
    },
    body: {},
  });

  if (claimRes.body?.code === 0) {
    const pts = claimRes.body?.data?.pointsAwarded || claimRes.body?.data?.totalPoints || 0;
    return { ok: true, points: pts };
  }

  const msg = JSON.stringify(claimRes.body || '');
  if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('done')) {
    return { ok: true, points: 0, note: 'sudah pernah claim' };
  }

  throw new Error(`Claim gagal: ${msg}`);
}

// ─── PROSES 1 AKUN ───────────────────────────────────────────────────────────
async function processAkun(privkey, akun, label) {
  console.log(`\n${label} 🔑 Wallet login...`);
  const { token, address, user } = await walletLogin(privkey);
  console.log(`${label} ✅ Login | ${address} | xHandle: ${user?.xHandle || '(kosong)'}`);

  await sleep(1000);

  console.log(`${label} 🐦 Konek X...`);
  await connectX(token, akun);
  console.log(`${label} ✅ X linked!`);

  await sleep(1000);

  console.log(`${label} 🎁 Claim...`);
  const { points, note } = await claimTask(token);
  console.log(`${label} ✅ Claim OK! +${points} pts${note ? ` (${note})` : ''}`);

  return address;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const privkeys = parseWallets('wallet.txt');
  const akuns = parseAkun('akun.txt');
  const total = Math.min(privkeys.length, akuns.length);

  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║        SVP Stars Bot             ║`);
  console.log(`╚══════════════════════════════════╝`);
  console.log(`Total akun tersedia: ${total}\n`);
  console.log(`  1 → 1 akun`);
  console.log(`  2 → Semua akun`);
  console.log(`  3 → From X to end\n`);

  const pilihan = await ask('Pilih [1/2/3]: ');

  let startIdx = 0;
  let endIdx = total;

  if (pilihan === '1') {
    const no = await ask(`Nomor akun (1-${total}): `);
    const idx = parseInt(no) - 1;
    if (isNaN(idx) || idx < 0 || idx >= total) {
      console.log('Nomor tidak valid.'); process.exit(1);
    }
    startIdx = idx;
    endIdx = idx + 1;

  } else if (pilihan === '2') {
    startIdx = 0;
    endIdx = total;

  } else if (pilihan === '3') {
    const from = await ask(`Mulai dari akun ke- (1-${total}): `);
    const idx = parseInt(from) - 1;
    if (isNaN(idx) || idx < 0 || idx >= total) {
      console.log('Nomor tidak valid.'); process.exit(1);
    }
    startIdx = idx;
    endIdx = total;

  } else {
    console.log('Pilihan tidak valid.'); process.exit(1);
  }

  console.log(`\nJalanin akun ${startIdx + 1} s/d ${endIdx}`);
  console.log(`${'─'.repeat(50)}`);

  const results = [];

  for (let i = startIdx; i < endIdx; i++) {
    const label = `[${i + 1}/${total}]`;
    try {
      const address = await processAkun(privkeys[i], akuns[i], label);
      results.push({ index: i + 1, address, status: 'OK' });
    } catch (err) {
      console.error(`${label} ❌ ${err.message}`);
      results.push({ index: i + 1, status: 'FAIL', error: err.message });
    }

    if (i < endIdx - 1) {
      console.log(`\nDelay ${DELAY_MS / 1000}s...`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`SUMMARY:`);
  results.forEach(r => {
    const icon = r.status === 'OK' ? '✅' : '❌';
    const info = r.status === 'OK' ? r.address : r.error;
    console.log(`  ${icon} [${r.index}] ${info}`);
  });
  const ok = results.filter(r => r.status === 'OK').length;
  console.log(`\nBerhasil: ${ok}/${results.length}`);
}

main().catch(console.error);
