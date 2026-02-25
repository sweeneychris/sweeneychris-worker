/**
 * Sweeney Family Admin — Cloudflare Worker Backend
 * 
 * This Worker handles:
 * 1. Chat messages → Claude API → generated code
 * 2. Deploy requests → GitHub API → push to repo → Cloudflare auto-deploys
 * 
 * Environment variables (set as Worker secrets):
 *   ANTHROPIC_API_KEY  — Claude API key
 *   GITHUB_TOKEN       — GitHub personal access token (fine-grained, repo scope)
 *   GITHUB_REPO_OWNER  — GitHub username
 *   GITHUB_REPO_NAME   — Repository name (e.g., "sweeneychris-family")
 * 
 * Deploy: npx wrangler deploy
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

## SITE STRUCTURE
- / — Family Dashboard (main hub)
- /recipes — Recipe collection
- /camp — Summer camp tracker
- /admin — Admin panel (don't modify)
- /shared/edit-widget.js — Edit button script (include on every page)

## RESPONSE FORMAT
Respond with JSON in this exact format:
{
  "message": "Your conversational response to the user",
  "page": {
    "html": "<!DOCTYPE html>...",
    "path": "/target-path",
    "filename": "index.html"
  }
}

If no page is being generated (just conversation), omit the "page" field:
{
  "message": "Your response here"
}

Keep messages concise and friendly.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // CORS headers for the admin frontend
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://family.sweeneychris.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /api/chat — Send message to Claude, get response + optional generated page
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const { message, history = [], context = null } = await request.json();

        // Build messages array with conversation history
        const messages = [
          ...history.map(h => ({ role: h.role, content: h.content })),
        ];

        // If we have edit context, prepend it to the user message
        let userContent = message;
        if (context && context.mode === 'edit' && context.currentSource) {
          userContent = `[EDITING PAGE: ${context.path}]\n[CURRENT HTML SOURCE]:\n${context.currentSource}\n\n[USER REQUEST]: ${message}`;
        }

        messages.push({ role: 'user', content: userContent });

        // Call Claude API
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

        // Parse the JSON response from Claude
        let parsed;
        try {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
        } catch {
          parsed = { message: responseText };
        }

        return new Response(JSON.stringify(parsed), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // GET /api/page-source — Fetch current HTML source of a page from GitHub
    if (url.pathname === '/api/page-source' && request.method === 'GET') {
      try {
        const pagePath = url.searchParams.get('path') || '/';
        const owner = env.GITHUB_REPO_OWNER;
        const repo = env.GITHUB_REPO_NAME;

        // Map URL path to file path in repo
        let filePath;
        const cleanPath = pagePath.replace(/^\//, '').replace(/\/$/, '');
        if (cleanPath === '' || cleanPath === '/') {
          filePath = 'dashboard/index.html';
        } else {
          filePath = `dashboard/${cleanPath}/index.html`;
        }

        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=main`,
          {
            headers: {
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'User-Agent': 'sweeneychris-admin',
              'Accept': 'application/vnd.github.v3+json',
            },
          }
        );

        if (!res.ok) {
          return new Response(JSON.stringify({ error: 'Page not found', path: filePath }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const data = await res.json();
        // GitHub returns base64-encoded content
        const html = decodeURIComponent(escape(atob(data.content)));

        return new Response(JSON.stringify({
          html,
          path: pagePath,
          filePath,
          sha: data.sha,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // POST /api/deploy — Push generated page to GitHub
    if (url.pathname === '/api/deploy' && request.method === 'POST') {
      try {
        const { html, path, filename = 'index.html' } = await request.json();
        
        // Determine the file path in the repo
        // path="/recipes" → "dashboard/recipes/index.html" or just the right subfolder
        const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
        let repoFilePath;
        
        if (cleanPath === '' || cleanPath === 'dashboard') {
          repoFilePath = 'dashboard/index.html';
        } else {
          repoFilePath = `${cleanPath}/${filename}`;
        }

        const owner = env.GITHUB_REPO_OWNER;
        const repo = env.GITHUB_REPO_NAME;
        const branch = 'main';

        // Check if file already exists (to get its SHA for updates)
        let existingSha = null;
        const getRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${repoFilePath}?ref=${branch}`,
          {
            headers: {
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'User-Agent': 'sweeneychris-admin',
              'Accept': 'application/vnd.github.v3+json',
            },
          }
        );

        if (getRes.ok) {
          const existing = await getRes.json();
          existingSha = existing.sha;
        }

        // Create or update the file
        const putRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${repoFilePath}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'User-Agent': 'sweeneychris-admin',
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: `Deploy ${repoFilePath} via admin panel`,
              content: btoa(unescape(encodeURIComponent(html))),
              branch,
              ...(existingSha ? { sha: existingSha } : {}),
            }),
          }
        );

        if (!putRes.ok) {
          const err = await putRes.json();
          throw new Error(`GitHub API error: ${err.message}`);
        }

        const result = await putRes.json();

        return new Response(JSON.stringify({
          success: true,
          path: repoFilePath,
          commitUrl: result.commit?.html_url,
          message: `Deployed to family.sweeneychris.com/${cleanPath}`,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // POST /api/site-map — List all files in the repo
    if (url.pathname === '/api/site-map' && request.method === 'POST') {
      try {
        const owner = env.GITHUB_REPO_OWNER;
        const repo = env.GITHUB_REPO_NAME;

        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`,
          {
            headers: {
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'User-Agent': 'sweeneychris-admin',
              'Accept': 'application/vnd.github.v3+json',
            },
          }
        );

        const data = await res.json();
        const htmlFiles = data.tree
          ?.filter(f => f.path.endsWith('.html'))
          ?.map(f => f.path) || [];

        return new Response(JSON.stringify({ files: htmlFiles }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
