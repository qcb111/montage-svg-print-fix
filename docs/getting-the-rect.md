# 怎么得到 `--rect`

`apply` 需要的几何输入只有一个框。这份笔记讲在两个场景里怎么把它拿准：
生成端程序化获取（推荐），以及从已有 PDF 里测量。

---

## 0. 先固定约定

`--rect` 和 `--cover` 都是 **PDF 点**，顺序是 **(左, 下, 右, 上)**，与 PDF 坐标一致（原点在左下，y 向上）：

```
--rect 366,48,500,790
        ↑   ↑  ↑   ↑
        左  下 右  上
```

这与 CSS 的 `(left, top, width, height)` **相反**，是最容易搞错的一点。

`--cover` 是要先擦白的范围，一般比 `--rect` 大 2–6 pt（取单元格内部），用来盖住旧图边缘。

---

## 1. 在 Puppeteer 里程序化取（推荐）

### 1.1 必须先在 print 媒体下量

`getBoundingClientRect()` 量的是**屏幕布局**。如果 `@media print` 改了字号、页边距、
页眉页脚，屏幕和打印的布局不同，量出来的框就是错的。

```js
await page.emulateMediaType('print');          // ← 必须先做
const info = await page.evaluate(() => {
  const el = document.querySelector('#wbg-drawing');   // 绘图根元素
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
```

### 1.2 换算：CSS px → pt

Chrome 打印时 **1 CSS px = 0.75 pt**（96 dpi → 72 dpi）。
再乘 `page.pdf({ scale })`、加页边距、翻转 y：

```js
const MM_TO_PT = 2.834645;
const K = 0.75 * (pdfOptions.scale ?? 1);

const mTop  = MM_TO_PT * (marginMm.top  ?? 0);
const mLeft = MM_TO_PT * (marginMm.left ?? 0);
const pageH = MM_TO_PT * pageHeightMm;

const rect = [
  mLeft + info.x * K,                              // 左
  pageH - mTop - (info.y + info.h) * K,            // 下  ← y 翻转
  mLeft + (info.x + info.w) * K,                   // 右
  pageH - mTop - info.y * K,                       // 上
].map((v) => Number(v.toFixed(2)));
```

### 1.3 写成 sidecar，别靠人抄

```js
writeFileSync('report.meta.json', JSON.stringify({
  pdf: 'report.pdf', svg: 'drawing.svg', rect, cover
}, null, 2));
```

```bash
node dist/index.js apply --pdf report.pdf --svg drawing.svg \
  --rect "$(jq -r '.rect | join(",")' report.meta.json)" \
  --cover "$(jq -r '.cover | join(",")' report.meta.json)" \
  --out "report vector.pdf"
```

---

## 2. 从 PDF 里量

### 2.1 方法 a：临时红框 + 读回（最可靠）

它**自动吸收所有缩放、边距、媒体重排的误差**，因为量的是"打印出来的结果"，不是"意图"。

```js
// 打印前，在页面里画一个红框
await page.evaluate(() => {
  const el = document.querySelector('#wbg-drawing');
  const r = el.getBoundingClientRect();
  const d = document.createElement('div');
  d.id = '__rect_probe';
  d.style.cssText =
    `position:absolute;left:${r.x + scrollX}px;top:${r.y + scrollY}px;` +
    `width:${r.width}px;height:${r.height}px;` +
    `outline:1pt solid rgb(255,0,0);pointer-events:none;z-index:999999`;
  document.body.appendChild(d);
});
await page.pdf({ path: 'probe.pdf', /* ... */ });
await page.evaluate(() => document.getElementById('__rect_probe')?.remove());
```

从 PDF 里读那唯一一条红色描边：

```python
import pymupdf
d = pymupdf.open('probe.pdf')
for dr in d[0].get_drawings():
    col = dr.get('color')
    if col and tuple(round(c, 2) for c in col) == (1.0, 0.0, 0.0):
        r = dr['rect']
        print(f"--rect {r.x0:.2f},{r.y0:.2f},{r.x1:.2f},{r.y1:.2f}")
```

`dr['rect']` 已经是 PDF 坐标（左下原点），**直接就是 `--rect`**。

### 2.2 方法 b：用表格竖线反推（不用改 HTML）

适合"报告已经生成好了"的情况。

```python
import pymupdf
d = pymupdf.open('report.pdf'); p = d[0]
print('page', p.rect)

xs = sorted({round(dr['rect'].x0, 1) for dr in p.get_drawings()
             if dr['rect'].width < 2.5 and dr['rect'].height > 200})
print('vertical rules:', xs)     # 例如 [182.3, 262.7, 359.2, 509.3, ...]
```

- 竖线给出**单元格左右边界** → 拿来做 `--cover`（内外各让 1–2 pt）；
- 行线给出上下边界；
- 绘图通常比单元格略小（有留白），`--rect` 最好取绘图的实际范围（用方法 a 或 c）。

### 2.3 方法 c：渲染 + 像素 bbox（要排除表格线）

```python
import pymupdf, numpy as np
d = pymupdf.open('report.pdf')
clip = pymupdf.Rect(366, 43, 502, 792)        # 大致范围，避开边框
pix = d[0].get_pixmap(dpi=300, clip=clip)
a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, 0]
ink = a < 245
keep_r = np.where(ink.mean(axis=1) < 0.6)[0]  # 剔除贯穿整行的表格线
keep_c = np.where(ink.mean(axis=0) < 0.6)[0]
s = 300 / 72
print('x', clip.x0 + keep_c.min()/s, '..', clip.x0 + keep_c.max()/s)
print('y', clip.y0 + keep_r.min()/s, '..', clip.y0 + keep_r.max()/s)
```

注意：若地层纹理铺满整列，上下边界会被纹理"撑满"，结果退化成单元格范围 —— 此时以方法 a 为准。

---

## 3. 怎么确认 `--rect` 是对的

从便宜到贵：

1. **看工具打印的数**：`apply` 会输出 `anchor band`（PDF 里套管的范围）。它必须**完全落在**
   `--rect` 内，且 `scale` 的 sx/sy 要接近生成端的横向/纵向压缩比
   （不会是 `0.05` 这种明显错误的值 —— 那说明回退到了自动拟合）。
2. **墨迹 bbox 对比**：原图与输出在同一 clip 下量 ink bbox，四个数应相差 < 2 pt。
3. **放大看边角**：新图刚好盖住旧图，不露旧线、不压到相邻列的表格线。

---

## 4. 常见坑

| 坑 | 表现 | 处理 |
|---|---|---|
| 用屏幕布局量 | 高度差 5–10% | 先 `emulateMediaType('print')` |
| 忘了 `scale` | 整体按比例缩放 | `K = 0.75 * scale` |
| y 没翻转 | 图上下颠倒 | `y_pdf = pageH - y_css` |
| 页边距没加 | 整体偏左上 | 加 `margin` |
| 单位混用 | 差 2.83 倍 | mm → pt：`× 2.834645` |
| `--cover` 用成了 `--rect` | 边缘残留旧线 | cover 比 rect 大 2–6 pt |
| 报告多页 | 只改了第 1 页 | 目前 `apply` 只处理 `getPages()[0]` |

**建议流程**：先用方法 a（红框探针）产一次 ground truth，再和程序化算出来的值对照；
两者一致说明换算公式正确，之后就只跑程序化那套，不再需要探针。
