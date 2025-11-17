# Audio Editor Unified Project

Unified project combining the MCP server and widget development for the Audio Editor ChatGPT app.

## Project Structure

- `src/server/` - MCP server code (TypeScript)
- `src/widgets/` - Widget React components and hooks
- `build/server/` - Compiled server code
- `dist/widgets/` - Built widget assets (used by MCP server)

## Development

### Run Both Server and Widgets

```bash
pnpm install
pnpm dev
```

This runs:
- **MCP Server** on port 8000 (TypeScript watch mode)
- **Widget Dev Server** on port 3000 (Vite)

### Run Separately

**Server only:**
```bash
pnpm dev:server
```


**Widgets only:**
```bash
pnpm dev:widgets
```

Then open:
- Audio Editor: http://localhost:3000/components/audio-editor/index.html

## Building

Build both server and widgets:

```bash
pnpm build
```

Or build separately:
- `pnpm build:server` - Build TypeScript server code
- `pnpm build:widgets` - Build React widgets to `/dist/widgets`

The widget build generates:
- `audio-editor.js` and `audio-editor.css` in `/dist/widgets`

These files are then used by the MCP server (in `/src/server`) which inlines them into self-contained HTML widgets for ChatGPT.

## Production

```bash
pnpm build
pnpm start
```

## Environment Variables

Create a `.env` file in the project root with:

```env
PORT=8000
BASE_URL=http://localhost:8000
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
S3_BUCKET=your-bucket
S3_KEY_PREFIX=audio-editor
S3_PUBLIC_BASE_URL=https://your-cdn.com
S3_OBJECT_ACL=public-read
```

## Features

- Audio editing with waveform visualization
- Trim controls with start/end markers
- Fade in/out effects
- Export to multiple formats (MP3, WAV, FLAC, OGG, M4A)
- MCP server integration for ChatGPT

