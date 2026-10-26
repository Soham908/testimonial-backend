# Portable stress-test toolkit

This is the Git-tracked text-only copy of the old ignored `codex-stress-test/` workspace. The original local folder is retained. See [the backend handover](../../BACKEND_HANDOVER.md) for architecture, setup, historical results and known limitations.

## Included

- `hinglish-distributor-scripts.json`: 100 answers / 20 identities.
- `round-2-negative-scripts.json`: 50 answers / 10 additional identities, mixed with a more critical tone.
- The five TypeScript audio/video/upload tools, with command comments pointing here.
- Both rounds' audio/video manifests and three historical submission reports in `stress-results/`.

The datasets answer five education questions from the internal Zeist client, not FMCG product-satisfaction questions. Each entry is `{ distributor_name, question_index, script_text }` and question indexes run from 1 through 5 per identity. These are synthetic test records.

## Reuse or regenerate media

For direct reuse, copy the old `audio/`, `videos/`, `round-2/audio/`, `round-2/videos/` into the same relative paths here. The committed manifests contain metadata only. Copy `sample video.mp4` here if regenerating MP4s; alternatively pass the generator `--base` argument. Generated media are ignored by the nested `.gitignore`.

Commands below run from the repository root after `npm ci`. TTS commands consume paid ElevenLabs credits and load `ELEVENLABS_API_KEY` from the private `.env`. FFmpeg commands run locally and require FFmpeg/ffprobe on PATH.

```powershell
# Original 100-answer dataset:
npx tsx --env-file=.env tools/stress-test/generate-hinglish-audio.ts
npx tsx tools/stress-test/generate-upload-videos.ts

# Round 2's 50-answer dataset:
npx tsx --env-file=.env tools/stress-test/generate-round-2-audio.ts
npx tsx tools/stress-test/generate-round-2-videos.ts
```

If `npx` fails on Windows, use `.\node_modules\.bin\tsx.cmd` in its place. The generators skip existing completed files. Audio scripts do not detect changed text under the same identity/filename; keep each new dataset in a new version/folder rather than editing generated samples in place. The historical cost constants are estimates, not current provider pricing. The original video tool relies on `-shortest`; Round 2 also passes explicit audio duration to handle a stream-copy edge case.

## Validate and submit

Omitting `--execute` makes the uploader a local validation only. It requires actual MP4 files matching the selected manifest, not merely the committed JSON.

```powershell
# Original dataset, local validation:
npx tsx tools/stress-test/run-upload-stress-test.ts

# Round 2, local validation:
npx tsx tools/stress-test/run-upload-stress-test.ts --scripts tools/stress-test/round-2-negative-scripts.json --manifest tools/stress-test/round-2/video-manifest.json --video-dir tools/stress-test/round-2/videos
```

For an authorized future remote run, add `--execute`, a fresh `--run-id`, and optionally `--concurrency 5`. Add `--smoke` to select one distributor's **five** videos. Default target is the historically deployed `https://insight-backend.thezeist.com`; override with `--base-url` or `STRESS_BASE_URL` if the environment changes.

The runner creates real synthetic accounts through `/register`, resolves their IDs, validates question indexes, requests presigned URLs, uploads bytes to S3 and confirms each segment. Accounts are registered with the test password `password`; fake phone numbers derive deterministically from run ID and sorted identity position. No tokens are persisted. Reusing a run ID can produce 409 registration conflicts; the script does not resume/login automatically. Registration must be enabled on the server and the Zeist client/questions must exist.

It writes reports under this directory's `stress-results/`, with per-phase submission timings and distributor IDs. It does not wait for asynchronous processing and does not capture returned segment IDs. Poll processing separately or use backend logs/database reporting. Partial failures must be inspected individually; do not interpret the process exit code alone as success. Concurrent checkpoints write a shared report file, so the final post-run report is the reliable completed-run artifact.

Historical manifests/reports preserve the original workstation's relative or absolute paths for provenance. Do not assume every old path exists after cloning; the current video lookup uses `video_filename` under the chosen `--video-dir`. Copies of generated media avoid repeated TTS charges. S3/DB data already uploaded remain on their configured services.
