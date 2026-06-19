# TD Maker

Web app for converting 3 photos (front / side / top) into a technical drawing with dimensions.

## Setup

```sh
cd app
npm install
npm run dev
```

Open [http://localhost:4321](http://localhost:4321).

From the repo root you can also run `start.bat` (Windows).

## Workflow

1. Upload 3 photos with a ruler
2. Background separation
3. Contour drawing
4. Scale (px/mm)
5. Contour review
6. 3D reconstruction (Visual Hull)
7. Vectorization
8. Dimension lines
9. Drawing layout
10. Export (DXF / SVG / PDF / PNG)

Calibration sheet: `/calibration.html` or **Calibrate** in the header.

## Docs

- `../photo-to-td-pipeline.md` — pipeline stages
- `../image-recognition-tools.md` — CV/AI tool notes
