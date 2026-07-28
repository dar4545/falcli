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

Open `http://127.0.0.1:4173`. Generated work is temporary until you choose **Keep**.
Durable items live under `library/`; unkept files under `temp/` are removed at startup
and graceful shutdown.

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
