---
description: Launch the TD Maker Astro dev server
---

# Run TD Maker

## Launch

```bash
cd C:/harel/TD/app
npm run dev
```

The server starts at **http://localhost:4321**

## Notes

- The `app/` subdirectory is the Astro project root — always `cd` there first.
- First run may take ~10s to compile; subsequent hot-reloads are instant.
- All JS modules are under `app/public/scripts/` (td-core, td-segmentation, td-image-proc, td-depth, td-active-contour, td-upload, td-hull).
- The UI entrypoint is `app/src/pages/index.astro`.
- No env vars or build step needed for dev — `npm run dev` is sufficient.

## Verify it's running

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4321
# expect: 200
```
