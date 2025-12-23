# Audio Editor Unified Project

Unified project combining the MCP server and widget development for the Audio Editor ChatGPT app. Provides interactive audio editing capabilities including trimming, format conversion, vocal separation, BPM/key detection, and more.

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

# AWS S3 Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
S3_BUCKET=your-bucket
S3_UPLOADS_FOLDER=uploads
S3_EXPORTS_FOLDER=exports
S3_PUBLIC_BASE_URL=https://your-cdn.com
S3_OBJECT_ACL=public-read

# LALAL.AI Configuration (for vocal separation)
LALALAI_KEY=your-lalalai-key
```

### Environment Variable Descriptions

- `PORT` - Server port (default: 8000)
- `BASE_URL` - Base URL for the API (used in production)
- `AWS_REGION` - AWS region for S3 bucket
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` - AWS credentials
- `S3_BUCKET` - S3 bucket name for storing audio files
- `S3_UPLOADS_FOLDER` - Folder prefix for uploaded audio files (e.g., "uploads")
- `S3_EXPORTS_FOLDER` - Folder prefix for exported/processed audio files (e.g., "exports")
- `S3_PUBLIC_BASE_URL` - Optional CDN URL for S3 files (if using CloudFront or similar)
- `S3_OBJECT_ACL` - S3 object ACL (e.g., "public-read")
- `LALALAI_KEY` - API key for LALAL.AI vocal separation service

## Features

### Audio Editing
- **Waveform visualization** - Visual representation of audio for precise editing
- **Trim controls** - Start/end markers for precise audio trimming
- **Fade in/out effects** - Customizable fade durations
- **Format conversion** - Export to MP3, WAV, FLAC, OGG, M4A, M4R (ringtone)
- **Dual track processing** - Process vocals and music tracks separately or combined

### Advanced Features
- **Vocal separation** - Extract vocals or remove vocals using LALAL.AI
- **BPM detection** - Automatic BPM detection using Essentia.js
- **Key detection** - Musical key detection (e.g., "C Major", "A Minor")
- **Ringtone editor** - Specialized editor for creating ringtones (M4R format)
- **Direct S3 uploads** - Presigned URLs for efficient file uploads

### MCP Integration
- **ChatGPT integration** - Interactive widgets within ChatGPT conversations
- **Multiple MCP tools** - Format conversion, trimming, vocal separation, and more
- **Analytics tracking** - Event tracking for usage analytics

## API Endpoints

- `POST /mcp` - MCP protocol endpoint for ChatGPT integration
- `POST /api/audio-export` - Export audio with trimming and format conversion
- `POST /api/audio-process` - Process audio from URL with custom parameters
- `POST /api/s3-presigned-url` - Generate presigned S3 upload URLs
- `POST /api/detect-bpm-key` - Detect BPM and musical key
- `POST /api/extract-vocals` - Extract or remove vocals from audio
- `POST /api/analytics/track` - Track analytics events

## S3 File Cleanup

This project uses **AWS S3 Lifecycle Rules** to automatically delete uploaded and exported audio files after 24 hours. This helps manage storage costs and keeps your S3 bucket clean.

### Setup Instructions

1. **Navigate to your S3 bucket** in AWS Console
2. Go to **Management** → **Lifecycle rules** → **Create lifecycle rule**

3. **Create rule for uploads folder:**
   - Rule name: `delete-uploads-after-24h`
   - Rule scope: Limit scope using filters
   - Prefix: `uploads/` (or your `S3_UPLOADS_FOLDER` value)
   - Expire current versions of objects: **Enabled**
   - Days after object creation: `1`

4. **Create rule for exports folder:**
   - Rule name: `delete-exports-after-24h`
   - Rule scope: Limit scope using filters
   - Prefix: `exports/` (or your `S3_EXPORTS_FOLDER` value)
   - Expire current versions of objects: **Enabled**
   - Days after object creation: `1`

### How It Works

- Files uploaded to `S3_UPLOADS_FOLDER` are automatically deleted after 24 hours
- Files exported to `S3_EXPORTS_FOLDER` are automatically deleted after 24 hours
- Cleanup runs automatically via AWS S3 Lifecycle Rules (no code required)
- Cleanup typically runs once per day (around midnight UTC)

### Alternative: AWS CLI Setup

If you prefer using AWS CLI:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket YOUR_BUCKET_NAME \
  --lifecycle-configuration '{
    "Rules": [
      {
        "Id": "delete-uploads-after-24h",
        "Status": "Enabled",
        "Filter": {"Prefix": "uploads/"},
        "Expiration": {"Days": 1}
      },
      {
        "Id": "delete-exports-after-24h",
        "Status": "Enabled",
        "Filter": {"Prefix": "exports/"},
        "Expiration": {"Days": 1}
      }
    ]
  }'
```

**Note:** Replace `uploads/` and `exports/` with your actual folder names from `S3_UPLOADS_FOLDER` and `S3_EXPORTS_FOLDER` environment variables.

