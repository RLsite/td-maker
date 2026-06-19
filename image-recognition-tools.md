# כלי זיהוי תמונה — רלוונטי ל-TD Maker

---

## 1. זיהוי סרגל וקנה מידה (Scale Detection)
מציאת px/mm אוטומטית מהתמונה

| כלי | שיטה | הערות |
|-----|------|-------|
| Hough Transform | OpenCV קלאסי | מזהה קווים ישרים של סרגל |
| Ruler tick detection | תבנית תדרים | זיהוי חריצי מילימטר |
| Aruco / AprilTag | Marker ידוע | סמן בגודל קבוע בתמונה |
| QR / barcode | גודל ידוע | כסמן קנה מידה |

---

## 2. זיהוי קצוות ומתאר (Edge / Contour Detection)
ציור אוטומטי של מתאר האובייקט

| כלי | שיטה | הערות |
|-----|------|-------|
| Canny Edge | OpenCV קלאסי | מהיר, ללא AI |
| GrabCut / Watershed | OpenCV | הפרדת אובייקט מרקע |
| SAM / SAM2 | Meta, קוד פתוח | לחץ על האובייקט → מתאר |
| Segment Anything | ONNX / מקומי | ניתן להריץ על CPU |


---

## 3. סיווג כיוון הצילום (View Classification)
זיהוי אוטומטי: פנים / צד / על

| כלי | שיטה | הערות |
|-----|------|-------|
| Qwen2-VL (מקומי) | VLM | "מאיזה כיוון צולמה תמונה זו?" |
| CLIP | OpenAI, קוד פתוח | embedding → מיון לפי כיוון |
| ResNet / EfficientNet | Classifier | דורש אימון על דוגמאות |
| Aspect ratio heuristic | חישובי | יחס W:H → השערת כיוון |

---

## 4. זיהוי קווים הנדסיים (Line Detection)
לזיהוי קצוות ישרים של חלק מכאני

| כלי | שיטה | הערות |
|-----|------|-------|
| LSD — Line Segment Detector | OpenCV | מדויק, מהיר, ללא AI |
| Hough Lines P | OpenCV | קווים מקוטעים |
| HAWP | Neural | wireframe מדויק |
| LETR | Transformer | קוד פתוח, עם אימון |

---

## 5. מדידה ממשית מתמונה (Metric Measurement)
חישוב מידות בפועל

| כלי | שיטה | הערות |
|-----|------|-------|
| Homography + ruler | OpenCV | scale ידוע → מרחקים |
| DUSt3R / MASt3R | Neural, קוד פתוח | scale metric מ-2 תמונות |
| Depth Anything v2 | ByteDance, קוד פתוח | עומק יחסי |
| Qwen2-VL + ruler | VLM | הסקה סמנטית |

---

## 6. התאמה בין תמונות (Feature Matching)
יישור מבט-פנים / צד / על

| כלי | שיטה | הערות |
|-----|------|-------|
| SIFT / ORB | OpenCV קלאסי | ללא AI |
| SuperPoint + SuperGlue | Neural | מדויק מאד |
| LOFTR | Transformer | ללא keypoints מפורשים |
| DUSt3R | קוד פתוח | pose + matching ביחד |

---

## 7. VLM מקומי (בשימוש אצלנו)

| מודל | גודל | שרת |
|------|------|-----|
| **Qwen2-VL-2B-Instruct** | 2B | localhost:1234 |

**שאלות שניתן לשאול:**
- "מאיזה כיוון צולמה התמונה?"
- "כמה ס״מ רחב האובייקט לפי הסרגל?"
- "האם המתאר מקיף את האובייקט כראוי?"
- "האם זה מבט פנים, צד או על?"

---

*עודכן: יוני 2025*
