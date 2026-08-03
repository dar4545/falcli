# FAL Generation Workspace

Local Preact workspace for FAL-powered Chat, Image, and Video generation.

## Start

1. Copy your credentials into `.env`:

   ```text
   FAL_KEY=your-fal-key
   OPENROUTER_API_KEY=your-openrouter-token
   ```

2. Install once:

   ```powershell
   pnpm install
   ```

3. Start with one command:

   ```powershell
   pnpm start
   ```

Open the address printed by the server. It prefers `http://127.0.0.1:4173` and
automatically selects the next available port if that one is already in use. Generated
work is temporary until you choose **Keep**. Durable items live under `library/`; unkept
files under `temp/` are removed at startup and graceful shutdown.

`FAL_KEY` enables generation and FAL model discovery. The account usage panel additionally
requires that key to have FAL Admin scope; an ordinary generation key can still generate
when account usage is unavailable. `OPENROUTER_API_KEY` is used only to list language models;
Chat inference remains routed through FAL.

Stop with `Ctrl+C` so unfinished remote requests can be cancelled before temporary files are
removed. A forced process termination cannot guarantee remote cancellation, but stale local
temporary files are removed on the next startup. Kept Conversations, media, preferences, and
Prompt templates are ordinary files under `library/`.

## Checks

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Automated checks use fake upstream adapters and do not perform paid generation.

## Generation history report

An Admin-scoped `FAL_KEY` can retrieve a bounded account history, download retained
image/video outputs, and build a standalone report with an offline snapshot:

```powershell
pnpm history:report -- --start 2026-07-26 --end 2026-08-02
```

The inclusive calendar range is interpreted in `Asia/Shanghai`. Output is written to
`history/report.html`, with media under `history/images/` and `history/videos/` and
normalized JSON/CSV source data under `history/data/`.

Open `history/report.html` directly by double-clicking it. No Node process, terminal
command, local server, installation, or build step is required to use the report.
The saved snapshot appears immediately at page start without contacting FAL or showing
a loading screen. Use **Update** to fetch FAL request history and billing events from
`2026-07-26` through the current Asia/Shanghai date, update the metrics, charts, model
table, filters, and gallery in place, and verify the generated files. If files are missing, the
report shows file-by-file progress and asks for access to the `history` folder before
writing replacements under `images/` and `videos/`. When a directly opened file cannot
show a folder picker, drag the `history` folder onto the permission panel instead. This
repair flow requires a Chromium browser with File System Access support.

The report embeds the Admin-scoped `FAL_KEY` so its single-file live client can call
the official API directly. Treat `history/report.html` as a private credential-bearing
artifact: do not publish, commit, email, or share it. Newly discovered media is shown
from its retained FAL URL after a manual **Update**.

Verify the snapshot, embedded live client, and a mocked end-to-end refresh with:

```powershell
pnpm history:verify
```
