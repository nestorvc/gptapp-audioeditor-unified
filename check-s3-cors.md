# S3 CORS Configuration Guide

## Why CORS is Needed

- **Server-side uploads** (current): Your server uploads processed files to S3 using AWS SDK → **No CORS needed** ✅
- **Browser uploads** (new): Browser uploads files directly to S3 using presigned URLs → **CORS required** ⚠️

## How to Check Current CORS Configuration

### Option 1: AWS Console (Easiest)

1. Go to [AWS S3 Console](https://s3.console.aws.amazon.com/)
2. Click on your bucket name (`${S3_BUCKET}`)
3. Go to **Permissions** tab
4. Scroll down to **Cross-origin resource sharing (CORS)**
5. Click **Edit**

### Option 2: AWS CLI

```bash
aws s3api get-bucket-cors --bucket YOUR_BUCKET_NAME
```

## Required CORS Configuration

Your S3 bucket needs CORS rules that allow:
- **PUT** method (for direct uploads)
- **Origin** of your widget domain (ChatGPT's domain or your domain)
- **Headers** for Content-Type

### Recommended CORS Configuration

```json
[
  {
    "AllowedHeaders": [
      "Content-Type",
      "Content-Length",
      "x-amz-date",
      "x-amz-content-sha256",
      "authorization"
    ],
    "AllowedMethods": [
      "PUT",
      "POST",
      "GET",
      "HEAD"
    ],
    "AllowedOrigins": [
      "https://chatgpt.com",
      "https://*.chatgpt.com",
      "https://*.oaistatic.com",
      "https://*.web-sandbox.oaiusercontent.com"
    ],
    "ExposeHeaders": [
      "ETag",
      "x-amz-request-id"
    ],
    "MaxAgeSeconds": 3000
  }
]
```

### For Development/Testing

If you need to test locally, temporarily add:
```json
"AllowedOrigins": [
  "*"  // ⚠️ Only for testing! Remove in production
]
```

## How to Set CORS Configuration

### Option 1: AWS Console

1. Go to your bucket → **Permissions** → **CORS**
2. Click **Edit**
3. Paste the JSON configuration above
4. Click **Save changes**

### Option 2: AWS CLI

Save the CORS config to a file `cors-config.json`:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST", "GET", "HEAD"],
    "AllowedOrigins": [
      "https://chatgpt.com",
      "https://*.chatgpt.com",
      "https://*.oaistatic.com",
      "https://*.web-sandbox.oaiusercontent.com"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Then run:
```bash
aws s3api put-bucket-cors --bucket YOUR_BUCKET_NAME --cors-configuration file://cors-config.json
```

## Testing CORS Configuration

After configuring CORS, test by:

1. Upload a file through your widget UI
2. Check browser console for CORS errors
3. If you see errors like:
   - `Access to fetch at '...' from origin '...' has been blocked by CORS policy`
   - Then CORS is not configured correctly

## Important Notes

- **CORS applies to the entire bucket**, not specific folders
- The `/uploads` folder doesn't need special CORS - it's just a path prefix
- Both `/ringtones` and `/uploads` folders will use the same CORS rules
- Make sure your `AllowedOrigins` includes ChatGPT's domains where your widget runs

## Security Best Practices

1. **Don't use `"*"` for AllowedOrigins in production** - specify exact domains
2. **Limit AllowedMethods** - only allow what you need (PUT for uploads)
3. **Set MaxAgeSeconds** - cache CORS preflight responses (3000 = 50 minutes)

