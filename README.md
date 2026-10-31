# Sketchy Robotics — event system

One Node server, three pages:

| URL | Who | What |
|---|---|---|
| `/` | Guests (iPad) | Pick a style → who's in the photo → selfie → see your sketch and your place in line. Installable as a home-screen app. |
| `/admin` | You | Themes & master prompts, queue management, prompt testing, OpenAI settings. Password = Secret `ADMIN_PASSWORD`. |
| `/studio` | Operator (Chrome + USB) | Plotter Studio with an **Event queue** panel: Auto-run draws every ready sketch; pauses for a paper change between drawings. |

## Secrets (Replit → Tools → Secrets)
- `OPENAI_API_KEY` — from platform.openai.com (paid API key, separate from ChatGPT Plus)
- `ADMIN_PASSWORD` — anything you like (default `sketchy`)

## How a theme works
Admin → Themes → + Add theme → paste a master prompt into each combination box (Single male, Single female, Two males, Two females, Male+female, Female+male, Male+pet, Female+pet). Upload a square thumbnail. Combinations with an empty box are simply not offered on the iPad. Prompts are stored in `data/themes/<slug>/prompts/*.txt`.

## Event day
1. Operator laptop: open `/studio` in Chrome, Connect arm, Home, SET pen height, Set paper center.
2. Turn on **Auto-run queue**. Leave "Pause after each drawing" on unless you have a paper feeder.
3. iPad: open `/`, Add to Home Screen once; guests take it from there.
4. Admin on your phone: `/admin` to watch the queue, retry failures, move someone to the front.

## Durable storage
Autoscale deployments wipe the local disk on every redeploy. The server mirrors everything in `data/` (themes, prompts, thumbnails, photos, line art, queue) to **Replit Object Storage** and restores from it at startup. Set it up once: in the Repl, open **Tools → Object Storage → Create bucket** (default bucket, any name). No code or secrets needed — the SDK finds it automatically. Admin → Settings shows "✓ bucket connected" when it's working. Without a bucket the app still runs, but a redeploy starts empty.
