// One-time Gmail sign-in for the JARVIS Email agent. Run on your own computer, not on Netlify:
//   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-token.mjs
// Opens a Google sign-in for gmail.readonly (read mail) and gmail.compose (save drafts), then prints GMAIL_REFRESH_TOKEN.
// JARVIS only reads mail and calls drafts.create. It never sends. Paste it into Netlify (Functions scope).
// Uses a Desktop OAuth client with a loopback redirect and PKCE. Nothing is saved to disk.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const clientId = process.env.GMAIL_CLIENT_ID?.trim(), clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (Desktop app OAuth client) first.');
  process.exit(1);
}
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('hex');
const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  const redirect = 'http://127.0.0.1:' + server.address().port;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent', state,
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  console.log('\nOpen this link, sign in with the mailbox JARVIS should read, and allow Gmail read and draft access:\n\n' + url + '\n');
  server.on('request', async (req, res) => {
    const query = new URL(req.url, redirect).searchParams;
    if (!query.has('code') && !query.has('error')) { res.writeHead(404).end(); return; }
    const done = message => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(message); server.close(); };
    if (query.get('state') !== state || !query.get('code')) { done('Sign-in failed or was cancelled. Run the script again.'); process.exitCode = 1; return; }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: query.get('code'), code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect }),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.refresh_token) { done('Google returned no refresh token. Run the script again.'); console.error(data.error || 'No refresh token.'); process.exitCode = 1; return; }
    done('Done. Return to the terminal for GMAIL_REFRESH_TOKEN.');
    console.log('GMAIL_REFRESH_TOKEN=' + data.refresh_token + '\n\nKeep it secret. Set it in Netlify with GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET.');
  });
});
