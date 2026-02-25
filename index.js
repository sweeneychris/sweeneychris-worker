/**
 * Sweeney Family Admin — Cloudflare Worker Backend v5
 *
 * Uses Claude tool use (generate_page) for structured page generation
 * instead of XML parsing. More reliable — HTML is JSON-escaped by the API.
 */

const SYSTEM_PROMPT = `You are the admin assistant for the Sweeney family website at family.sweeneychris.com.

## HOW TO RESPOND
- For conversation (no page changes): just reply with text.
- To create or edit a page: reply with a brief message explaining what you did, then call the generate_page tool with the complete HTML.

## EDIT MODE (when you receive [EDITING PAGE])
You will receive the current HTML source. Make TARGETED edits:
- Preserve existing structure, styles, and content unless asked to change them
- Always keep: <script src="/shared/edit-widget.js"></script>
- Always keep the "← Dashboard" link
- Return the COMPLETE updated HTML via the generate_page tool

## BUILD MODE
Generate a COMPLETE, self-contained HTML page (HTML + CSS + JS in one file) via the generate_page tool.
- Style: font-family -apple-system/sans-serif, background #F5F0E8, color #2C2C2C, accent #2E6B8A
- Cards: white background, border-radius 12px
- Always include a "← Dashboard" link back to /
- Always include: <script src="/shared/edit-widget.js"></script> before </body>
- Mobile-responsive
- Include realistic sample data

## SITE STRUCTURE
- / — Family Dashboard
- /recipes — Recipes
- /camp — Camp tracker
- /admin — Admin panel (don't modify)

Keep messages concise and friendly.`;

const TOOLS = [
  {
    name: 'generate_page',
    description: 'Generate or update a complete HTML page for the family website. Use this whenever you need to create a new page or modify an existing one. Always provide a complete, self-contained HTML document.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The URL path for the page, e.g. "/recipes", "/camp", "/"',
        },
        html: {
          type: 'string',
          description: 'The complete HTML document including <!DOCTYPE html>, all CSS, JS, and content',
        },
      },
      required: ['path', 'html'],
    },
  },
];

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

const VALID_USERS = ['chris', 'wife'];

function getGoogleRedirectUri(request) {
  const url = new URL(request.url);
  return `${url.origin}/api/google/callback`;
}

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

function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function getGoogleAccessToken(userKey, env) {
  const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
  if (!stored || !stored.refresh_token) return null;
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at - 300000) {
    return stored.access_token;
  }
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
  if (data.error) { await env.TOKENS.delete(`google:${userKey}`); return null; }
  await env.TOKENS.put(`google:${userKey}`, JSON.stringify({
    ...stored, access_token: data.access_token, expires_at: Date.now() + (data.expires_in * 1000),
  }));
  return data.access_token;
}

// ============================================================
// POST /api/chat — Uses Claude tool use for structured page generation
// ============================================================
async function handleChat(request, env, corsHeaders) {
  const { message, history = [], context = null } = await request.json();

  const messages = [...history.map(h => ({ role: h.role, content: h.content }))];

  let userContent = message;
  if (context && context.mode === 'edit' && context.currentSource) {
    userContent = `[EDITING PAGE: ${context.path}]\n[CURRENT HTML SOURCE]:\n${context.currentSource}\n\n[USER REQUEST]: ${message}`;
  }
  messages.push({ role: 'user', content: userContent });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  function sendEvent(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    writer.write(encoder.encode(payload));
  }

  const streamPromise = (async () => {
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6-20250514',
          max_tokens: 16384,
          stream: true,
          thinking: { type: 'adaptive' },
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
        }),
      });

      if (!claudeRes.ok) {
        const err = await claudeRes.text();
        sendEvent('error', { message: `Claude API error: ${claudeRes.status}` });
        writer.close();
        return;
      }

      const reader = claudeRes.body.getReader();
      const decoder = new TextDecoder();
      let fullMessageText = '';
      let toolCalls = [];
      let sentPageStatus = false;
      let sentThinkingStatus = false;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);

            // Thinking block started — show status
            if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
              if (!sentThinkingStatus) {
                sendEvent('status', { text: 'Thinking...' });
                sentThinkingStatus = true;
              }
            }

            // Tool use block started — buffer its JSON input
            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              toolCalls.push({ name: event.content_block.name, input_json: '' });
              if (!sentPageStatus) {
                sendEvent('status', { text: 'Building page...' });
                sentPageStatus = true;
              }
            }

            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta') {
                // Stream message text to the client in real-time
                fullMessageText += event.delta.text;
                sendEvent('text', { text: event.delta.text });
              } else if (event.delta?.type === 'input_json_delta') {
                // Buffer tool input JSON (not streamed to client)
                const lastTool = toolCalls[toolCalls.length - 1];
                if (lastTool) lastTool.input_json += event.delta.partial_json;
              }
              // thinking_delta is intentionally ignored — not shown to client
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Build final result from text + tool calls
      const result = { message: fullMessageText.trim(), page: null };

      const pageCall = toolCalls.find(t => t.name === 'generate_page');
      if (pageCall) {
        try {
          const input = JSON.parse(pageCall.input_json);
          result.page = { path: input.path, html: input.html };
        } catch {}
      }

      if (!result.message && result.page) {
        result.message = "Here's the updated page:";
      }

      sendEvent('done', result);

    } catch (err) {
      sendEvent('error', { message: err.message });
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders,
    },
  });
}

// ============================================================
// POST /api/deploy
// ============================================================
async function handleDeploy(request, env, corsHeaders) {
  const { html, path, filename = 'index.html' } = await request.json();
  const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
  const repoFilePath = (!cleanPath || cleanPath === 'dashboard') ? 'dashboard/index.html' : `dashboard/${cleanPath}/${filename}`;
  const ghHeaders = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'sweeneychris-admin',
    'Accept': 'application/vnd.github.v3+json',
  };
  let existingSha = null;
  const getRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${repoFilePath}?ref=main`, { headers: ghHeaders });
  if (getRes.ok) existingSha = (await getRes.json()).sha;

  const putRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${repoFilePath}`, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Deploy ${repoFilePath} via admin panel`,
      content: btoa(unescape(encodeURIComponent(html))),
      branch: 'main',
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  if (!putRes.ok) { const err = await putRes.json(); throw new Error(`GitHub: ${err.message}`); }
  const result = await putRes.json();
  return json({ success: true, path: repoFilePath, commitUrl: result.commit?.html_url, message: `Deployed to family.sweeneychris.com/${cleanPath}` }, 200, corsHeaders);
}

// ============================================================
// POST /api/site-map
// ============================================================
async function handleSiteMap(env, corsHeaders) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/git/trees/main?recursive=1`, {
    headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'sweeneychris-admin', 'Accept': 'application/vnd.github.v3+json' },
  });
  const data = await res.json();
  return json({ files: data.tree?.filter(f => f.path.endsWith('.html')).map(f => f.path) || [] }, 200, corsHeaders);
}

// ============================================================
// GET /api/page-source
// ============================================================
async function handlePageSource(url, env, corsHeaders) {
  const pagePath = url.searchParams.get('path') || '/';
  const cleanPath = pagePath.replace(/^\//, '').replace(/\/$/, '');
  const filePath = (!cleanPath || cleanPath === '/') ? 'dashboard/index.html' : `dashboard/${cleanPath}/index.html`;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${filePath}?ref=main`, {
    headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'sweeneychris-admin', 'Accept': 'application/vnd.github.v3+json' },
  });
  if (!res.ok) return json({ error: 'Page not found' }, 404, corsHeaders);
  const data = await res.json();
  return json({ html: decodeURIComponent(escape(atob(data.content))), path: pagePath, filePath, sha: data.sha }, 200, corsHeaders);
}

// ============================================================
// Google OAuth endpoints
// ============================================================
async function handleGoogleAuth(request, url, env) {
  const userKey = url.searchParams.get('user');
  if (!userKey || !VALID_USERS.includes(userKey)) return new Response('Use ?user=chris or ?user=wife', { status: 400 });
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

async function handleGoogleCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const userKey = url.searchParams.get('state') || 'unknown';
  const error = url.searchParams.get('error');
  if (error) return new Response(`<html><body><h2>Failed</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`, { headers: { 'Content-Type': 'text/html' } });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      code, redirect_uri: getGoogleRedirectUri(request), grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (tokens.error) return new Response(`<html><body><h2>Failed</h2><p>${tokens.error_description}</p></body></html>`, { headers: { 'Content-Type': 'text/html' } });

  let googleEmail = '';
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } });
    googleEmail = (await r.json()).email || '';
  } catch {}

  await env.TOKENS.put(`google:${userKey}`, JSON.stringify({
    refresh_token: tokens.refresh_token, access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in * 1000), email: googleEmail, connected_at: new Date().toISOString(),
  }));

  const name = userKey.charAt(0).toUpperCase() + userKey.slice(1);
  return new Response(`<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F5F0E8"><div style="text-align:center"><div style="font-size:3rem;margin-bottom:1rem">✓</div><h2>${name}'s Google connected!</h2><p style="color:#666">${googleEmail}</p></div><script>if(window.opener)window.opener.postMessage({type:'google-auth-complete',user:'${userKey}'},'*');setTimeout(()=>window.close(),2000)</script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
}

async function handleConnections(env, corsHeaders) {
  const connections = {};
  for (const u of VALID_USERS) {
    const s = await env.TOKENS.get(`google:${u}`, 'json');
    connections[u] = s ? { connected: true, email: s.email || 'Unknown', connected_at: s.connected_at } : { connected: false };
  }
  return json({ connections }, 200, corsHeaders);
}

async function handleDisconnect(url, env, corsHeaders) {
  const userKey = url.searchParams.get('user');
  if (!userKey || !VALID_USERS.includes(userKey)) return json({ error: 'Invalid user' }, 400, corsHeaders);
  await env.TOKENS.delete(`google:${userKey}`);
  return json({ success: true }, 200, corsHeaders);
}

// ============================================================
// GET /api/calendar
// ============================================================
async function handleCalendar(url, env, corsHeaders) {
  const max = url.searchParams.get('max') || '10';
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 14 * 86400000).toISOString();
  const allEvents = [];

  for (const userKey of VALID_USERS) {
    const token = await getGoogleAccessToken(userKey, env);
    if (!token) continue;
    try {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(future)}&maxResults=${max}&singleEvents=true&orderBy=startTime`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) continue;
      const d = await r.json();
      const stored = await env.TOKENS.get(`google:${userKey}`, 'json');
      (d.items || []).forEach(e => allEvents.push({
        id: e.id, title: e.summary || '(No title)', start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date, allDay: !!e.start?.date, location: e.location || null,
        link: e.htmlLink, owner: userKey, ownerEmail: stored?.email || userKey,
      }));
    } catch {}
  }

  allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));
  const connected = [];
  for (const u of VALID_USERS) { if (await env.TOKENS.get(`google:${u}`)) connected.push(u); }
  return json({ events: allEvents, connected_users: connected, any_connected: connected.length > 0 }, 200, corsHeaders);
}

// ============================================================
// GET /api/gmail
// ============================================================
async function handleGmail(url, env, corsHeaders) {
  const max = parseInt(url.searchParams.get('max') || '5');
  const allMessages = [];

  for (const userKey of VALID_USERS) {
    const token = await getGoogleAccessToken(userKey, env);
    if (!token) continue;
    try {
      const listRes = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&labelIds=INBOX`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!listRes.ok) continue;
      const ids = ((await listRes.json()).messages || []).map(m => m.id);
      const stored = await env.TOKENS.get(`google:${userKey}`, 'json');

      const msgs = await Promise.all(ids.map(async id => {
        const r = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) return null;
        const msg = await r.json();
        const h = {};
        (msg.payload?.headers || []).forEach(x => h[x.name.toLowerCase()] = x.value);
        return {
          id: msg.id, from: h.from || 'Unknown', subject: h.subject || '(No subject)',
          date: h.date || null, timestamp: msg.internalDate ? parseInt(msg.internalDate) : 0,
          snippet: msg.snippet || '', unread: (msg.labelIds || []).includes('UNREAD'),
          link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`, owner: userKey, ownerEmail: stored?.email || userKey,
        };
      }));
      allMessages.push(...msgs.filter(Boolean));
    } catch {}
  }

  allMessages.sort((a, b) => b.timestamp - a.timestamp);
  const connected = [];
  for (const u of VALID_USERS) { if (await env.TOKENS.get(`google:${u}`)) connected.push(u); }
  return json({ messages: allMessages, connected_users: connected, any_connected: connected.length > 0 }, 200, corsHeaders);
}
