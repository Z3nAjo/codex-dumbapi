# Dummy JSON API

Requires Node.js 20 or newer. No dependencies to install.

```sh
npm start
```

Open the admin URL printed in the terminal (normally http://localhost:80).
Create a route name, choose GET, POST, PUT, DELETE, or ALL, enter valid JSON, and save.
Use the route list to edit, test, or delete an existing route.
Route paths allow literal segments and `{name}` parameters, separated by slashes,
up to 240 characters total. Literal segments allow letters, numbers, underscores
and hyphens (up to 80 characters each). Parameter names must be unique and use
letters, digits, and underscores, starting with a letter or underscore.

Use **Public tunnel → Tunnel settings** in the admin panel to select ngrok,
Cloudflare Tunnel, or a custom tool. Click **Start tunnel** to save settings
and start it; **Stop** ends the process started by this app. The tool must be
installed and authenticated separately where required. Status and tool output
are shown in the panel. "Running" means the process is running; inspect output
for connection status. The API works locally even when the tunnel fails.

Port 80 is preferred. If it is busy or unavailable, the server automatically
selects a free port. Tunnel commands receive the actual port automatically.
You can also set `PORT=8080 npm start` (an unavailable explicit port fails).

Try the included example:

```sh
curl https://wreath-resale-scoundrel.ngrok-free.dev/api/hello
```

Each route lives in its own JSON file in `routes/`. Simple names use
`<route_name>.json`; nested and parameter paths use a stable hashed filename.
The `name` property always stores the readable route path:

```json
{
  "name": "hello",
  "method": "GET",
  "response": { "message": "Hello from your dummy API!", "success": true }
}
```

The configured method returns the static `response` value with HTTP 200 and
JSON content type, regardless of request body or query parameters. Any JSON
value is supported, including arrays, strings, numbers, booleans, and null.
Changes apply immediately without restarting. An unsupported method returns
405; missing routes return 404. ALL accepts any HTTP method and returns the same
static JSON. HEAD follows HTTP semantics and omits the response body. CORS
preflight requests receive an empty 204 response; ordinary OPTIONS requests
to ALL routes receive the configured JSON. API endpoints support CORS.

The server listens on loopback. The admin panel and configuration endpoints
require a localhost Host header, so they are blocked through the provided
tunnel presets. Keep the original public Host header when configuring other
tools. Dummy API routes are public through the tunnel; avoid storing secrets.
ngrok's free plan may show a browser interstitial; API clients can send the
`ngrok-skip-browser-warning: true` header when needed.

Run verification with `npm test`.

## Request logging

The admin panel has Turn on / Resume, Pause, Clean logs, Show / Hide, and
Download file controls. Turning on logging automatically shows the viewer.
Hiding the viewer does not stop recording; pausing keeps existing logs.
Logging starts paused, and its enabled state persists across server restarts.

API calls (including errors and preflight requests) are recorded in
`data/requests.jsonl`, one JSON object per line, with timestamps, duration,
request method, URL, headers and body, and response status, headers and body.
The viewer refreshes every two seconds and shows the latest 100 entries.
The download contains the complete file. Clean logs empties the file without
changing the recording state. Request and response bodies are capped at 1 MB
per entry, with truncation flags and total byte counts; bodies are decoded as
UTF-8 text. HEAD responses have an empty body. Headers and bodies are stored
as received, so logs can contain credentials or other data sent by clients.
Logs and logging controls are only available through the local admin panel.
Runtime logs and settings are excluded from Git. Set `LOG_DIR` to customize
their storage directory.

## Path parameters and query strings

Create `users/{name}/orders/{id}` in the admin panel and use placeholders in
JSON string values, including nested objects and arrays:

```json
{
  "name": "{name}",
  "orderId": "{id}",
  "message": "Hello {name}!"
}
```

`/api/users/Ana/orders/001?prop=a` returns:

```json
{"name":"Ana","orderId":"001","message":"Hello Ana!"}
```

Parameters match one nonempty URL segment and are URL-decoded as strings.
JSON substitution is safe for quotes and other special characters. It applies
to string values, not object keys; unknown placeholders remain unchanged.
Other JSON values retain their configured types. The saved configuration is
never changed by a request. Query strings and request bodies are ignored:
`/api/1?prop=a` matches the same route as `/api/1`.

Literal segments take precedence over parameters at the first differing
segment. Routes differing only in parameter names cannot both be created.
The admin panel shows inline string fields for each saved path parameter.
Fill them in, then click Test saved route.

## Tunnel configuration and replacement

`tunnel.config.json` contains the default tool configuration. Changes saved in
the panel persist in `data/tunnel.json` (excluded from Git) and override those
defaults. Stop the tunnel before editing settings. Settings persist, but the
tunnel does not auto-start after restarting the server. Server shutdown stops
its managed tunnel. The app does not stop tunnels started in other terminals.

The API and routing code do not depend on ngrok. All providers use the same
executable plus argument-array interface, with no shell evaluation:

```json
{
  "provider": "custom",
  "command": "your-tunnel-tool",
  "args": ["--target", "{localUrl}"],
  "publicUrl": "https://your-public-host.example"
}
```

Placeholders: `{port}` is the current server port, `{localUrl}` is its loopback
HTTP URL, and `{publicUrl}` is the configured public origin. Arguments are
passed separately, so no shell quoting is needed. Commands run with the API
process's existing environment. Do not put credentials into command arguments;
use the tool's normal authentication or environment setup instead.

The Cloudflare preset uses `cloudflared tunnel --url {localUrl} --no-autoupdate`.
Leaving the public URL empty enables detection of common ngrok/Cloudflare
URLs in tool output; for other tools, enter their public URL manually. The
ngrok preset omits `--url` when its public URL is empty. You can still run any
tunnel manually against the printed local port instead of using the controls.

Local control endpoints are `GET/PUT /admin/tunnel` and
`POST /admin/tunnel/start` or `/admin/tunnel/stop`. Mutations require
`Content-Type: application/json`. Set `TUNNEL_SETTINGS_FILE` to change the
runtime settings file location.
