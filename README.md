# Sky Rush

A fast, colourful 3D endless flyer for phones (portrait, 9:16). You pilot **Zip**, a jetpack hero who
rockets forward through a floating neon city. Swipe up and down to switch between three flight lanes,
dodge obstacles, collect coins and grab power-ups. The run keeps speeding up until you crash.

Built with plain HTML/CSS/JavaScript and [three.js](https://threejs.org) (vendored in `vendor/`, so no
build step and no network needed).

## Play

ES modules need to be served over HTTP. Any static server works:

```bash
python3 -m http.server 8080
# or: npx serve .
```

Then open `http://localhost:8080`.

### GitHub Pages

`.github/workflows/pages.yml` publishes the game every time `main` is pushed (or when you run the
workflow by hand from the Actions tab). One-time setup: in the repo go to **Settings → Pages** and set
**Source** to **GitHub Actions**. The game is then at `https://<owner>.github.io/<repo>/`.
Pages on a private repository needs a paid GitHub plan; on a free plan the repository must be public.

To test on a phone without Pages, run the local server and open `http://<your-computer-ip>:8080`
while the phone is on the same Wi-Fi. Use "Add to Home Screen" to run it full-screen; the web
manifest locks it to portrait.

## Controls

| Action | Touch | Keyboard |
| --- | --- | --- |
| Fly up one lane | Swipe / drag up | ↑ or W |
| Fly down one lane | Swipe / drag down | ↓ or S |
| Pause | Pause button | Esc or P |
| Start / restart | Tap "Play" | Space / Enter |

A long drag keeps stepping, so you can slide from the top lane to the bottom in one motion. The
character starts in the middle lane.

## Gameplay

- **Score** is the distance flown in meters. **Coins** are counted separately and banked between runs.
- **Speed** starts at 20 m/s and climbs towards 55 m/s as you go further.
- **Obstacles** get harder over time:
  - floating energy barriers, laser gates and floating rock islands that block one or two lanes
  - moving sweeper bars and spiked drones that slide between two lanes
  - enclosed tunnels with only one open lane
  - zig-zag narrow passages where the open lane keeps shifting
  - fast chains of walls later in the run
- Every obstacle pattern leaves at least one free lane, with enough time to reach it. Coin trails show
  you the safe line.
- **Power-ups**
  - **Shield** (blue): absorbs one crash (15 s)
  - **Coin magnet** (red): pulls in nearby coins (10 s)
  - **Turbo boost** (orange): big speed burst. You're invincible and smash through obstacles (5 s)
- The sky goes from day to sunset to neon night as the run continues.

## Project layout

```
index.html            page, HUD and menus
style.css             UI styling
src/main.js           game loop, states, HUD, camera
src/config.js         tuning: lanes, speeds, power-up durations
src/player.js         the character model and its animation
src/track.js          obstacle/coin/power-up generation and collisions
src/world.js          sky, city, floating islands, clouds, traffic, speed lines
src/fx.js             particle effects
src/input.js          swipe/drag and keyboard input
src/audio.js          synthesized sound effects (Web Audio)
vendor/               three.js r170 (MIT)
```

Most tuning lives in `src/config.js` (speed curve, lane spacing, power-up times) and in
`Track.generate()` in `src/track.js` (pattern weights and gaps).
