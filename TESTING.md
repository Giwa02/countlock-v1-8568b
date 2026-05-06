# CountLock — Testing Quickstart

## 1. Install

```bash
npm install
```

> **Note:** `netlify-cli` pulls a `sharp` binary from GitHub on first install.
> If that's blocked on your network, run:
> `npm install --ignore-scripts`
> The CLI itself still works — only the image-processing features of sharp are affected.

## 2. Configure env

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Key | Where to find it |
|-----|-----------------|
| `SUPABASE_URL` | Pre-filled: `https://spavmunneesbihkdjzgp.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → MaintainX Project → Settings → API → `service_role` |
| `COUNTLOCK_ORG_ID` | Pre-filled: UPI Manufacturing |
| `MOCK_COUNT` | Pre-filled `true` — counts come from a random number, no Roboflow needed |

Leave everything else blank for now. `MOCK_COUNT=true` means you can test the full UI/DB flow without a Roboflow model.

## 3. Run

```bash
npm run dev
```

Opens at **http://localhost:8888**

Netlify Dev proxies the Vite frontend (`:5173`) and the Netlify Functions together on `:8888`. The `/api/*` routes call `/.netlify/functions/*` automatically.

## 4. Test the happy path

1. Click **Upload CSV** and upload `sample-countlock.csv`
2. Confirm a project appears with 3 kits and 10 parts
3. Open a kit → operator screen loads, camera preview starts
4. Tap **Picture** for each part — mock count appears, part pill updates
5. Tap **Finished** — kit locks, status shows Pass or mismatch list
6. Tap a locked kit → Re-open button visible
7. Tap **Re-open** → kit reopens, tap Picture again, Finished again
8. Click **Export** on the project screen → CSV downloads

## 5. Run tests

```bash
npm test
```

Expected: 12 tests, all `ok`.

## 6. When you're ready for real Roboflow

```env
MOCK_COUNT=false
ROBOFLOW_MODEL_URL=https://detect.roboflow.com/YOUR_PROJECT/YOUR_VERSION
ROBOFLOW_API_KEY=your_key_here
```

## 7. Deploy to Netlify

```bash
# Install Netlify CLI globally if needed
npm install -g netlify-cli

# Link or create a Netlify site
netlify init

# Set env vars (or do it in the Netlify dashboard)
netlify env:set SUPABASE_URL https://spavmunneesbihkdjzgp.supabase.co
netlify env:set SUPABASE_SERVICE_ROLE_KEY your_service_role_key
netlify env:set COUNTLOCK_ORG_ID cae14322-1b10-408f-8307-138b7850a945
netlify env:set MOCK_COUNT true

# Deploy
netlify deploy --prod
```

## API surface (for manual curl testing)

```bash
BASE=http://localhost:8888/api

# List projects
curl $BASE/projects

# Upload CSV
curl -X POST $BASE/projects \
  -H "Content-Type: application/json" \
  -d '{"csvText":"part,1,2\nexpected #,3,6\nKit 1,,","filename":"test.csv"}'

# Capture (mock mode — any base64 string works)
curl -X POST $BASE/count-image \
  -H "Content-Type: application/json" \
  -d '{"kitId":"<kit-id>","partId":"1","imageBase64":"data:image/jpeg;base64,/9j/fake"}'

# Finish kit
curl -X POST $BASE/kits \
  -H "Content-Type: application/json" \
  -d '{"kitId":"<kit-id>","action":"finish"}'

# Re-open kit
curl -X POST $BASE/kits \
  -H "Content-Type: application/json" \
  -d '{"kitId":"<kit-id>","action":"reopen"}'
```
