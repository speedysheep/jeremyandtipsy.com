# jeremyandtipsy.com !

Photo and video gallery for [jeremyandtipsy.com](https://jeremyandtipsy.com).

For everything not covered here — how the pipeline works, file naming, metadata,
troubleshooting — see [DETAILS.md](DETAILS.md).

## Setup (once)

```powershell
npm install
npx wrangler login
```

`wrangler login` is needed for anything involving videos (they're stored on Cloudflare
R2, not in git).

## Added a photo or video?

1. Drop photos into `public/pictures/`, videos into `public/videos/`.
2. Run:

   ```powershell
   npm run gallery
   ```
Files will be transcoded, metadata will be stripped, and filenames will be standardized to prevent data leakage.

3. Commit and push to `main`.

## Removed a photo or video?

```powershell
npm run deletePicture <name> yes
npm run deleteVideo <name> yes
```

Leave off the trailing `yes` first to see what it would do without deleting anything.
Then commit and push.

## Preview it locally

```powershell
npm run dev
```

## Deploying

Push to `main` on GitHub. Cloudflare builds and deploys automatically — that's it.
