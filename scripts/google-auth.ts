/**
 * One consent flow per Google account (W2, plan B): opens the browser,
 * catches the loopback redirect, exchanges the code, and stores the
 * refresh token in the envelope-encrypted brain secret store as
 * `google/<short-name>`. Re-run any time — Google mints a fresh token.
 *
 *   bun scripts/google-auth.ts <short-name> <email>
 *
 * Requires GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in the
 * environment (bun auto-loads .env from the repo root). Scopes are
 * gmail.modify + drive — the §W2 minimum; sending is excluded by tool
 * surface and gateway policy, not by scope (Google offers no such scope).
 */

const [name, email] = process.argv.slice(2);
if (!name || !email) {
  console.error("usage: bun scripts/google-auth.ts <short-name> <email>");
  process.exit(2);
}
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing (see .env.example)");
  process.exit(2);
}

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
].join(" ");

const code = await new Promise<string>((resolve, reject) => {
  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("?", { status: 404 });
      const c = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      setTimeout(() => server.stop(true), 100);
      if (err || !c) {
        reject(new Error(err ?? "no code"));
        return new Response("Login failed — check the terminal.", { status: 400 });
      }
      resolve(c);
      return new Response(`<h2>${email} connected. You can close this tab.</h2>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", CLIENT_ID);
  auth.searchParams.set("redirect_uri", REDIRECT);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", SCOPES);
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("login_hint", email);
  console.log(`\nOpening browser for ${email} — log into THAT account; the`);
  console.log(`"Google hasn't verified this app" screen is expected: Advanced → continue.\n`);
  Bun.spawnSync(["open", auth.toString()]);
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
  }),
});
if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
const tokens = (await tokenRes.json()) as { refresh_token?: string; scope: string };
if (!tokens.refresh_token) throw new Error("no refresh_token returned — retry");

const store = Bun.spawnSync(
  ["bun", "packages/cli/src/main.ts", "secret", "set", `google/${name}`, tokens.refresh_token],
  { stdout: "inherit", stderr: "inherit" },
);
if (store.exitCode !== 0) throw new Error("brain secret set failed");
console.log(`granted scopes: ${tokens.scope}`);
console.log(`CONSENT-OK ${name}`);
