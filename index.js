/**
 * Sweeney Family Admin — Cloudflare Worker Backend
 * 
 * Endpoints:
 *   POST /api/chat         — Chat with Claude → generate pages
 *   POST /api/deploy        — Push HTML to GitHub
 *   POST /api/site-map      — List files in repo
 *   GET  /api/page-source   — Fetch current page HTML from GitHub
 *   GET  /api/google/auth   — Start Google OAuth flow
 *   GET  /api/google/callback — Handle OAuth callback
 *   GET  /api/calendar       — Fetch upcoming calendar events
 *   GET  /api/gmail          — Fetch recent emails
 *   GET  /api/auth-status    — Check if Google is connected
 * 
 * Secrets (set via wrangler):
 *   ANTHROPIC_API_KEY
 *   GITHUB_TOKEN
 *   GITHUB_REPO_OWNER
 *   GITHUB_REPO_NAME
 *   GOOGLE_CLIENT_ID       — From Google Cloud Console OAuth credentials
 *   GOOGLE_CLIENT_SECRET   — From Google Cloud Console OAuth credentials
 * 
 * KV Namespace (bind in wrangler.toml):
 *   TOKENS                 — Stores Google OAuth refresh tokens per user
 */

// ============================================================
// System prompt for Claude
// ============================================================
const SYSTEM_PROMPT = `You are the admin assistant for the Sweeney family website at family.sweeneychris.com.

Your job is to help build and manage pages for this family site. You operate in two modes:

## EDIT MODE (when context.mode is "edit")
The user is editing an existing page. You will receive the current HTML source.
- Make TARGETED edits to the existing code — don't regenerate the whole page
- Preserve the existing structure, styles, and content unless asked to change them
- Always keep the edit widget script: <script src="/shared/edit-widget.js"></script>
- Always keep the "← Dashboard" link
- Return the COMPLETE updated HTML (not a diff)

## BUILD MODE (no context, or building from scratch)
Generate a COMPLETE, self-contained HTML page (HTML + CSS + JS in one file).
- Use consistent style: font-family -apple-system/sans-serif, background #F5F0E8, 
  color #2C2C2C, accent #2E6B8A, cards with white bg and border-radius 12px
- Always include a "← Dashboard" link back to /
- Always include: <script src="/shared/edit-widget.js"></script> before </body>
- Make it mobile-responsive
- Include sample/placeholder data so the preview looks realistic

## SITE STRUCTURE
- / — Family Dashboard (main hub with weather, calendar, gmail)
- /recipes — Recipe collection
- /camp — Summer camp tracker  
- /admin — Admin panel (don't modify)
- /shared/edit-widget.js — Edit button script (include on every page)

## RESPONSE FORMAT
Respond with JSON:
{
  "message": "Your conversational response",
  "page": {
    "html": "<!DOCTYPE html>...",
    "path": "/target-path",
    "filename": "index.html"
  }
}

If no page is being generated, omit "page":
{ "message": "Your response here" }

Keep messages concise and friendly.`;

// ============================================================
// Google OAuth config
// ============================================================
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

function getGoogleRedirectUri(request) {
  const url = new URL(request.url);
  return `${url.origin}/api/google/callback`;
}

// ============================================================
// Main handler
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://family.sweeneychris.com',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route requests
      if (path === '/api/chat' && request.method === 'POST') {
        return await handleChat(request, env, corsHeaders);
      }
      if (path === '/api/deploy' && request.method === 'POST') {
        return await handleDeploy(request, env, corsHeaders);
      }
      if (path === '/api/site-map' && request.method === 'POST') {
        return await handleSiteMap(env, corsHeaders);
      }
      if (path === '/api/page-source' && request.method === 'GET') {
        return await handlePageSource(url, env, corsHeaders);
      }
      if (path === '/api/google/auth' && request.method === 'GET') {
        return await handleGoogleAuth(request, url, env, corsHeaders);
      }
      if (path === '/api/google/callback' && request.method === 'GET') {
        return await handleGoogleCallback(request, url, env, corsHeaders);
      }
      if (path === '/api/calendar' && request.method === 'GET') {
        return await handleCalendar(request, url, env, corsHeaders);
      }
      if (path === '/api/gmail' && request.method === 'GET') {
        return await handleGmail(request, url, env, corsHeaders);
      }
      if (path === '/api/auth-status' && request.method === 'GET') {
        return await handleAuthStatus(request, env, corsHeaders);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, corsHeaders);
    }
  },
};

// ============================================================
// Helpers
// ============================================================
function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Get the user's email from Cloudflare Access JWT
function getUserEmail(request) {
  // Cloudflare Access sets this header with the authenticated user's JWT
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return 'default';
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return payload.email || 'default';
  } catch {
    return 'default';
  }
}

// Get a valid Google access token, refreshing if needed
async function getGoogleAccessToken(userEmail, env) {
  const stored = await env.TOKENS.get(`google:${userEmail}`, 'json');
  if (!stored || !stored.refresh_token) {
    return null;
  }

  // Check if access token is still valid (with 5 min buffer)
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at - 300000) {
    return stored.access_token;
  }

  // Refresh the token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (data.error) {
    // Refresh token may be revoked — clear stored tokens
    await env.TOKENS.delete(`google:${userEmail}`);
    return null;
  }

  // Store updated tokens
  await env.TOKENS.put(`google:${userEmail}`, JSON.stringify({
    refresh_token: stored.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in * 1000),
  }));

  return data.access_token;
}

// ============================================================
// POST /api/chat — Claude API
// ============================================================
async function handleChat(request, env, corsHeaders) {
  const { message, history = [], context = null } = await request.json();

  const messages = [...history.map(h => ({ role: h.role, content: h.content }))];

  let userContent = message;
  if (context && context.mode === 'edit' && context.currentSource) {
    userContent = `[EDITING PAGE: ${context.path}]\n[CURRENT HTML SOURCE]:\n${context.currentSource}\n\n[USER REQUEST]: ${message}`;
  }
  messages.push({ role: 'user', content: userContent });

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  const claudeData = await claudeRes.json();
  const responseText = claudeData.content?.[0]?.text || '';

  let parsed;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
  } catch {
    parsed = { message: responseText };
  }

  return jsonResponse(parsed, 200, corsHeaders);
}

// ============================================================
// POST /api/deploy — Push to GitHub
// ============================================================
async function handleDeploy(request, env, corsHeaders) {
  const { html, path, filename = 'index.html' } = await request.json();

  const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
  let repoFilePath;
  if (cleanPath === '' || cleanPath === 'dashboard') {
    repoFilePath = 'dashboard/index.html';
  } else {
    repoFilePath = `dashboard/${cleanPath}/${filename}`;
  }

  const owner = env.GITHUB_REPO_OWNER;
  const repo = env.GITHUB_REPO_NAME;
  const ghHeaders = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'sweeneychris-admin',
    'Accept': 'application/vnd.github.v3+json',
  };

  // Check if file exists (get SHA for update)
  let existingSha = null;
  const getRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${repoFilePath}?ref=main`,
    { headers: ghHeaders }
  );
  if (getRes.ok) {
    existingSha = (await getRes.json()).sha;
  }

  // Create or update
  const putRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${repoFilePath}`,
    {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Deploy ${repoFilePath} via admin panel`,
        content: btoa(unescape(encodeURIComponent(html))),
        branch: 'main',
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    }
  );

  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(`GitHub API error: ${err.message}`);
  }

  const result = await putRes.json();
  return jsonResponse({
    success: true,
    path: repoFilePath,
    commitUrl: result.commit?.html_url,
    message: `Deployed to family.sweeneychris.com/${cleanPath}`,
  }, 200, corsHeaders);
}

// ============================================================
// POST /api/site-map — List repo files
// ============================================================
async function handleSiteMap(env, corsHeaders) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/git/trees/main?recursive=1`,
    {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'sweeneychris-admin',
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  const data = await res.json();
  const htmlFiles = data.tree?.filter(f => f.path.endsWith('.html')).map(f => f.path) || [];
  return jsonResponse({ files: htmlFiles }, 200, corsHeaders);
}

// ============================================================
// GET /api/page-source — Fetch page HTML from GitHub
// ============================================================
async function handlePageSource(url, env, corsHeaders) {
  const pagePath = url.searchParams.get('path') || '/';
  const cleanPath = pagePath.replace(/^\//, '').replace(/\/$/, '');
  const filePath = (!cleanPath || cleanPath === '/') ? 'dashboard/index.html' : `dashboard/${cleanPath}/index.html`;

  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${filePath}?ref=main`,
    {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'sweeneychris-admin',
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  if (!res.ok) {
    return jsonResponse({ error: 'Page not found', path: filePath }, 404, corsHeaders);
  }

  const data = await res.json();
  const html = decodeURIComponent(escape(atob(data.content)));
  return jsonResponse({ html, path: pagePath, filePath, sha: data.sha }, 200, corsHeaders);
}

// ============================================================
// GET /api/google/auth — Start OAuth flow
// ============================================================
async function handleGoogleAuth(request, url, env, corsHeaders) {
  const userEmail = getUserEmail(request);
  const redirectUri = getGoogleRedirectUri(request);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  // Pass the user email through state so we know who to store tokens for
  authUrl.searchParams.set('state', userEmail);

  return Response.redirect(authUrl.toString(), 302);
}

// ============================================================
// GET /api/google/callback — Handle OAuth callback
// ============================================================
async function handleGoogleCallback(request, url, env, corsHeaders) {
  const code = url.searchParams.get('code');
  const userEmail = url.searchParams.get('state') || 'default';
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`<html><body><h2>Authorization failed</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const redirectUri = getGoogleRedirectUri(request);

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();

  if (tokens.error) {
    return new Response(`<html><body><h2>Token exchange failed</h2><p>${tokens.error_description}</p></body></html>`, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Store tokens in KV
  await env.TOKENS.put(`google:${userEmail}`, JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in * 1000),
  }));

  // Close the popup and notify the parent page
  return new Response(`
    <html><body>
      <h2 style="font-family:sans-serif;text-align:center;margin-top:3rem;">
        ✓ Google connected!
      </h2>
      <p style="font-family:sans-serif;text-align:center;color:#666;">
        This window will close automatically.
      </p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: 'google-auth-complete' }, '*');
        }
        setTimeout(() => window.close(), 2000);
      </script>
    </body></html>
  `, { headers: { 'Content-Type': 'text/html' } });
}

// ============================================================
// GET /api/auth-status — Check Google connection status
// ============================================================
async function handleAuthStatus(request, env, corsHeaders) {
  const userEmail = getUserEmail(request);
  const token = await getGoogleAccessToken(userEmail, env);
  return jsonResponse({
    google_connected: !!token,
    user: userEmail,
  }, 200, corsHeaders);
}

// ============================================================
// GET /api/calendar — Fetch upcoming events
// ============================================================
async function handleCalendar(request, url, env, corsHeaders) {
  const userEmail = getUserEmail(request);
  const accessToken = await getGoogleAccessToken(userEmail, env);

  if (!accessToken) {
    return jsonResponse({
      connected: false,
      message: 'Google Calendar not connected. Visit /api/google/auth to connect.',
    }, 200, corsHeaders);
  }

  const maxResults = url.searchParams.get('max') || '10';
  const now = new Date().toISOString();
  const weekFromNow = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    `timeMin=${encodeURIComponent(now)}&` +
    `timeMax=${encodeURIComponent(weekFromNow)}&` +
    `maxResults=${maxResults}&` +
    `singleEvents=true&` +
    `orderBy=startTime`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }
  );

  if (!calRes.ok) {
    const err = await calRes.json();
    return jsonResponse({ connected: true, error: err.error?.message || 'Calendar API error' }, 200, corsHeaders);
  }

  const calData = await calRes.json();
  const events = (calData.items || []).map(e => ({
    id: e.id,
    title: e.summary || '(No title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: !!e.start?.date,
    location: e.location || null,
    description: e.description ? e.description.substring(0, 200) : null,
    link: e.htmlLink,
  }));

  return jsonResponse({ connected: true, events }, 200, corsHeaders);
}

// ============================================================
// GET /api/gmail — Fetch recent emails
// ============================================================
async function handleGmail(request, url, env, corsHeaders) {
  const userEmail = getUserEmail(request);
  const accessToken = await getGoogleAccessToken(userEmail, env);

  if (!accessToken) {
    return jsonResponse({
      connected: false,
      message: 'Gmail not connected. Visit /api/google/auth to connect.',
    }, 200, corsHeaders);
  }

  const maxResults = url.searchParams.get('max') || '8';

  // Fetch message list
  const listRes = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&labelIds=INBOX`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (!listRes.ok) {
    const err = await listRes.json();
    return jsonResponse({ connected: true, error: err.error?.message || 'Gmail API error' }, 200, corsHeaders);
  }

  const listData = await listRes.json();
  const messageIds = (listData.messages || []).map(m => m.id);

  // Fetch details for each message (metadata only — no body content)
  const messages = await Promise.all(
    messageIds.map(async (id) => {
      const msgRes = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!msgRes.ok) return null;
      const msg = await msgRes.json();

      const headers = {};
      (msg.payload?.headers || []).forEach(h => {
        headers[h.name.toLowerCase()] = h.value;
      });

      return {
        id: msg.id,
        threadId: msg.threadId,
        from: headers.from || 'Unknown',
        subject: headers.subject || '(No subject)',
        date: headers.date || null,
        snippet: msg.snippet || '',
        unread: (msg.labelIds || []).includes('UNREAD'),
        link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
      };
    })
  );

  return jsonResponse({
    connected: true,
    messages: messages.filter(Boolean),
  }, 200, corsHeaders);
}
