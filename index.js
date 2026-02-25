/**
 * Sweeney Family Admin — Cloudflare Worker Backend v3
 * 
 * Endpoints:
 *   POST /api/chat           — Chat with Claude → generate pages
 *   POST /api/deploy          — Push HTML to GitHub
 *   POST /api/site-map        — List files in repo
 *   GET  /api/page-source     — Fetch current page HTML from GitHub
 *   GET  /api/google/auth     — Start Google OAuth (requires ?user=chris or ?user=wife)
 *   GET  /api/google/callback — Handle OAuth callback
 *   GET  /api/calendar        — Fetch merged calendar events from all connected accounts
 *   GET  /api/gmail           — Fetch merged inbox from all connected accounts
 *   GET  /api/connections      — List which Google accounts are connected
 *   DELETE /api/google/disconnect — Disconnect a Google account (?user=chris)
 * 
 * Secrets:
 *   ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * 
 * KV Namespace: TOKENS
 */

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
{ "message": "Your response here" }`;

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

// Valid user keys for Google connections
const VALID_USERS = ['chris', 'wife'];

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
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/api/chat' && request.method === 'POST') return await handleChat(request, env, corsHeaders);
      if (path === '/api/deploy' && request.method === 'POST') return await handleDeploy(request, env, corsHeaders);
      if (path === '/api/site-map' && request.method === 'POST') return await handleSiteMap(env, corsHeaders);
      if (path === '/api/page-source' && request.method === 'GET') return await handlePageSource(url, env, corsHeaders);
      if (path === '/api/google/auth' && request.method === 'GET') return await handleGoogleAuth(request, url, env);
      if (path === '/api/google/callback' && request.method === 'GET') return await handleGoogleCallback(request, url, env);
      if (path === '/api/google/disconnect' && request.method === 'DELETE') return await handleDisconnect(url, env, corsHeaders);
      if (path === '/api/calendar' && request.method === 'GET') return await handleCalendar(url, env, corsHeaders);
      if (path === '/api/gmail' && request.method === 'GET') return await handleGmail(url, env, corsHeaders);
      if (path === '/api/connections' && request.method === 'GET') return await handleConnections(env, corsHeaders);

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return json({ error: err.message }, 500, corsHeaders);
    }
  },
};

// ============================================================
// Helpers
// ============================================================
function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function getGoogleAccessToken(userKey, env) {
  const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
  if (!stored || !stored.refresh_token) return null;

  // Check if access token is still valid (5 min buffer)
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at - 300000) {
    return stored.access_token;
  }

  // Refresh
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
    await env.TOKENS.delete(`google:${userKey}`);
    return null;
  }

  await env.TOKENS.put(`google:${userKey}`, JSON.stringify({
    ...stored,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in * 1000),
  }));

  return data.access_token;
}

// ============================================================
// POST /api/chat
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

  return json(parsed, 200, corsHeaders);
}

// ============================================================
// POST /api/deploy
// ============================================================
async function handleDeploy(request, env, corsHeaders) {
  const { html, path, filename = 'index.html' } = await request.json();

  const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
  const repoFilePath = (!cleanPath || cleanPath === 'dashboard')
    ? 'dashboard/index.html'
    : `dashboard/${cleanPath}/${filename}`;

  const ghHeaders = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'sweeneychris-admin',
    'Accept': 'application/vnd.github.v3+json',
  };

  let existingSha = null;
  const getRes = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${repoFilePath}?ref=main`,
    { headers: ghHeaders }
  );
  if (getRes.ok) existingSha = (await getRes.json()).sha;

  const putRes = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${repoFilePath}`,
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
    throw new Error(`GitHub: ${err.message}`);
  }

  const result = await putRes.json();
  return json({
    success: true,
    path: repoFilePath,
    commitUrl: result.commit?.html_url,
    message: `Deployed to family.sweeneychris.com/${cleanPath}`,
  }, 200, corsHeaders);
}

// ============================================================
// POST /api/site-map
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
  return json({ files: htmlFiles }, 200, corsHeaders);
}

// ============================================================
// GET /api/page-source
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

  if (!res.ok) return json({ error: 'Page not found' }, 404, corsHeaders);

  const data = await res.json();
  const html = decodeURIComponent(escape(atob(data.content)));
  return json({ html, path: pagePath, filePath, sha: data.sha }, 200, corsHeaders);
}

// ============================================================
// GET /api/google/auth — Start OAuth (?user=chris or ?user=wife)
// ============================================================
async function handleGoogleAuth(request, url, env) {
  const userKey = url.searchParams.get('user');
  if (!userKey || !VALID_USERS.includes(userKey)) {
    return new Response('Missing or invalid ?user param. Use ?user=chris or ?user=wife', { status: 400 });
  }

  const redirectUri = getGoogleRedirectUri(request);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', userKey);

  return Response.redirect(authUrl.toString(), 302);
}

// ============================================================
// GET /api/google/callback
// ============================================================
async function handleGoogleCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const userKey = url.searchParams.get('state') || 'unknown';
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`<html><body><h2>Authorization failed</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const redirectUri = getGoogleRedirectUri(request);

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

  // Get the user's email for display purposes
  let googleEmail = '';
  try {
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json();
    googleEmail = info.email || '';
  } catch {}

  await env.TOKENS.put(`google:${userKey}`, JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in * 1000),
    email: googleEmail,
    connected_at: new Date().toISOString(),
  }));

  const displayName = userKey.charAt(0).toUpperCase() + userKey.slice(1);

  return new Response(`
    <html><body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F5F0E8">
      <div style="text-align:center">
        <div style="font-size:3rem;margin-bottom:1rem">✓</div>
        <h2 style="color:#2C2C2C;margin-bottom:0.5rem">${displayName}'s Google connected!</h2>
        <p style="color:#6B6B6B">${googleEmail}<br>This window will close automatically.</p>
      </div>
      <script>
        if (window.opener) window.opener.postMessage({ type: 'google-auth-complete', user: '${userKey}' }, '*');
        setTimeout(() => window.close(), 2000);
      </script>
    </body></html>
  `, { headers: { 'Content-Type': 'text/html' } });
}

// ============================================================
// GET /api/connections — Which accounts are connected?
// ============================================================
async function handleConnections(env, corsHeaders) {
  const connections = {};

  for (const userKey of VALID_USERS) {
    const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
    connections[userKey] = stored ? {
      connected: true,
      email: stored.email || 'Unknown',
      connected_at: stored.connected_at || null,
    } : { connected: false };
  }

  return json({ connections }, 200, corsHeaders);
}

// ============================================================
// DELETE /api/google/disconnect?user=chris
// ============================================================
async function handleDisconnect(url, env, corsHeaders) {
  const userKey = url.searchParams.get('user');
  if (!userKey || !VALID_USERS.includes(userKey)) {
    return json({ error: 'Invalid user' }, 400, corsHeaders);
  }

  await env.TOKENS.delete(`google:${userKey}`);
  return json({ success: true, message: `${userKey} disconnected` }, 200, corsHeaders);
}

// ============================================================
// GET /api/calendar — Merged calendar from all connected accounts
// ============================================================
async function handleCalendar(url, env, corsHeaders) {
  const maxResults = url.searchParams.get('max') || '10';
  const now = new Date().toISOString();
  const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const allEvents = [];

  for (const userKey of VALID_USERS) {
    const accessToken = await getGoogleAccessToken(userKey, env);
    if (!accessToken) continue;

    try {
      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${encodeURIComponent(now)}&` +
        `timeMax=${encodeURIComponent(twoWeeksOut)}&` +
        `maxResults=${maxResults}&` +
        `singleEvents=true&` +
        `orderBy=startTime`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      if (!calRes.ok) continue;

      const calData = await calRes.json();
      const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
      const ownerEmail = stored?.email || userKey;

      const events = (calData.items || []).map(e => ({
        id: e.id,
        title: e.summary || '(No title)',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !!e.start?.date,
        location: e.location || null,
        description: e.description ? e.description.substring(0, 200) : null,
        link: e.htmlLink,
        owner: userKey,
        ownerEmail,
      }));

      allEvents.push(...events);
    } catch (err) {
      // Skip this user's calendar on error
    }
  }

  // Sort all events by start time
  allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

  // Check connection status
  const connectedUsers = [];
  for (const userKey of VALID_USERS) {
    const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
    if (stored) connectedUsers.push(userKey);
  }

  return json({
    events: allEvents,
    connected_users: connectedUsers,
    any_connected: connectedUsers.length > 0,
  }, 200, corsHeaders);
}

// ============================================================
// GET /api/gmail — Merged inbox from all connected accounts
// ============================================================
async function handleGmail(url, env, corsHeaders) {
  const maxPerUser = parseInt(url.searchParams.get('max') || '5');
  const allMessages = [];

  for (const userKey of VALID_USERS) {
    const accessToken = await getGoogleAccessToken(userKey, env);
    if (!accessToken) continue;

    try {
      const listRes = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxPerUser}&labelIds=INBOX`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      if (!listRes.ok) continue;

      const listData = await listRes.json();
      const messageIds = (listData.messages || []).map(m => m.id);

      const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
      const ownerEmail = stored?.email || userKey;

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
            timestamp: msg.internalDate ? parseInt(msg.internalDate) : 0,
            snippet: msg.snippet || '',
            unread: (msg.labelIds || []).includes('UNREAD'),
            link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
            owner: userKey,
            ownerEmail,
          };
        })
      );

      allMessages.push(...messages.filter(Boolean));
    } catch (err) {
      // Skip this user on error
    }
  }

  // Sort by date (newest first)
  allMessages.sort((a, b) => b.timestamp - a.timestamp);

  const connectedUsers = [];
  for (const userKey of VALID_USERS) {
    const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
    if (stored) connectedUsers.push(userKey);
  }

  return json({
    messages: allMessages,
    connected_users: connectedUsers,
    any_connected: connectedUsers.length > 0,
  }, 200, corsHeaders);
}
