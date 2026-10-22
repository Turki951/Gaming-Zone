const crypto = require("crypto");

const DISCORD_API = "https://discord.com/api/v10";
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1368605532385968259";
const SESSION_COOKIE = "gz_session";
const STATE_COOKIE = "gz_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function getSecret() {
  return process.env.DISCORD_CLIENT_SECRET || "";
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      })
  );
}

function cookie(name, value, maxAge, httpOnly = true) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "Secure",
    "SameSite=None",
    httpOnly ? "HttpOnly" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function getOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function getRedirectUri(req) {
  return process.env.DISCORD_REDIRECT_URI || `${getOrigin(req)}/api/auth/discord/callback`;
}

function sign(value) {
  return crypto.createHmac("sha256", getSecret()).update(value).digest("base64url");
}

function createSessionToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSessionToken(token) {
  if (!token || !token.includes(".") || !getSecret()) return null;
  const [payload, signature] = token.split(".");
  const expected = sign(payload);
  const a = Buffer.from(signature || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

function avatarUrl(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  }
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function snowflakeDate(id) {
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(html);
}

function popupPage(message, user) {
  const data = JSON.stringify({ type: "gz-discord-auth", ok: !!user, user: user || null, message })
    .replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GAMING ZONE</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f5f5f5;font-family:system-ui,sans-serif;text-align:center;padding:24px}p{color:#c8a850;font-weight:700}</style></head>
<body><div><h1 style="font-size:20px">GAMING ZONE</h1><p id="m"></p></div>
<script>
var d=${data};
document.getElementById('m').textContent=d.message;
try{localStorage.setItem('gz_discord_user_pending',JSON.stringify(d));}catch(e){}
if(window.opener){try{window.opener.postMessage(d,'*');}catch(e){}setTimeout(function(){window.close();},900);}
else{setTimeout(function(){location.replace('/');},1200);}
</script></body></html>`;
}

function login(req, res) {
  if (!getSecret()) {
    return sendHtml(res, 500, popupPage("لم يتم ضبط DISCORD_CLIENT_SECRET على الخادم بعد.", null));
  }
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: getRedirectUri(req),
    scope: "identify email",
    state,
    prompt: "none",
  });
  res.writeHead(302, {
    Location: `https://discord.com/oauth2/authorize?${params}`,
    "Set-Cookie": cookie(STATE_COOKIE, state, 600),
    "Cache-Control": "no-store",
  });
  res.end();
}

async function callback(req, res) {
  const url = new URL(req.url, getOrigin(req));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const clearState = cookie(STATE_COOKIE, "", 0);

  if (url.searchParams.get("error")) {
    return sendHtml(res, 400, popupPage("تم إلغاء تسجيل الدخول عبر ديسكورد.", null), { "Set-Cookie": clearState });
  }
  const cookies = parseCookies(req);
  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    return sendHtml(res, 400, popupPage("انتهت صلاحية طلب تسجيل الدخول، حاول مرة أخرى.", null), { "Set-Cookie": clearState });
  }

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: getSecret(),
        grant_type: "authorization_code",
        code,
        redirect_uri: getRedirectUri(req),
      }),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}: ${await tokenRes.text()}`);
    const token = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) throw new Error(`user ${userRes.status}`);
    const raw = await userRes.json();

    const user = {
      id: raw.id,
      username: raw.username,
      name: raw.global_name || raw.username,
      email: raw.verified ? raw.email || "" : "",
      avatarUrl: avatarUrl(raw),
      createdAt: snowflakeDate(raw.id),
      provider: "discord",
    };

    return sendHtml(res, 200, popupPage(`أهلاً ${user.name}! تم تسجيل الدخول بنجاح.`, user), {
      "Set-Cookie": [clearState, cookie(SESSION_COOKIE, createSessionToken(user), SESSION_TTL_SECONDS)],
    });
  } catch (error) {
    console.error("Discord OAuth error:", error.message);
    return sendHtml(res, 502, popupPage("تعذّر إكمال تسجيل الدخول عبر ديسكورد، حاول مرة أخرى.", null), { "Set-Cookie": clearState });
  }
}

function me(req, res) {
  const user = readSessionToken(parseCookies(req)[SESSION_COOKIE]);
  if (!user) return sendJson(res, 401, { user: null });
  const { exp, ...publicUser } = user;
  return sendJson(res, 200, { user: publicUser });
}

function logout(req, res) {
  return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
}

module.exports = { login, callback, me, logout };
