# 在 `page.pdf()` 之前能做什么

报告由 Puppeteer `page.pdf()` 生成。这份笔记讨论的是：**能不能在生成阶段就避免"图案被光栅化"**，
而不是像本仓库现在这样事后替换。

结论先写：**根因在 Skia 的 PDF 后端里，在 `page.pdf()` 之前没有任何开关能把它关掉**。
能做的是"不让 DOM 里再出现图案填充"。

---

## 1. 根因

Chrome 打印 PDF 时由 Skia 的 PDF 设备输出。对**图案着色器**（SVG `<pattern>` 填充、图片着色器），
Skia 的做法是：把着色器在一整块填充区域上光栅化成一张位图，再挂成 `PatternType 1 + Image XObject`。
它**不会**输出 PDF 原生的矢量 `Tiling Pattern`。

这是实现选择，CSS/SVG 层面没有任何属性可以改变它
（`image-rendering` / `shape-rendering` / `patternUnits` / `patternTransform` 都无关）。

实测证据（本项目样本）：一个 38×23 的纹理单元，被铺满整列后存成一张 **827×752 px** 的图；
一份 4.68 MB 的报告里 **98%** 是这类图。

---

## 2. 能在生成阶段做的三件事

### A. 斜线 hatch → `clipPath` + 显式 `<line>`（推荐，几乎无风险）

原件里套管的**轮廓是矢量的**，说明 Chrome 打印时普通路径和描边都走矢量。所以把图案换成
"被裁剪的线族"，就能全矢量输出：

```html
<clipPath id="wall1"><path d="M20 10 L32 10 L32 190 L20 190 Z"/></clipPath>
<g clip-path="url(#wall1)" stroke="#000000" stroke-width="0.54" stroke-linecap="butt">
  <!-- JS 生成：30°，垂直间距 2.7 pt，向两侧各超出裁剪框一段，保证端点不露 -->
  <line x1="-60" y1="…" x2="100" y2="…"/>
  …
</g>
```

- 数量级：一面 700 pt 高的墙约 260 条线，8 面墙约 2,000 条 —— DOM 压力可忽略；
- 输出全矢量，放大无限清晰；
- `stroke-linecap: butt` 必设，否则端点会变粗、密度不对；
- 用**几何裁剪**（`clipPath`）而不是"只画框内的线段"更稳：后者在端点处容易差半像素。

### B. 点状纹理 → 三条路

| 做法 | 矢量 | 体积 | 风险 |
|---|---|---|---|
| B1 把图案展开成几万个 `<path>` | ✅ | 3–5 MB，DOM 很重 | 打印慢、文件反而更大 |
| B2 一小张 PNG + `background-repeat`（或 `<image>` 平铺） | ❌ 仍是位图 | **小**（一张 38×23 的图） | **未验证**：Chrome 打印时是"只存一张小图 + 平铺"，还是又光栅化成一大张 |
| B3 保持现在的 `<pattern>` | ❌ | 4.5 MB | 就是当前的问题 |

B2 是唯一可能"改两行 CSS 就把 4.5 MB 变成几十 KB"的做法，但**必须实测**：Chrome 打印对
`background-repeat` 的处理没有保证。判定方法很简单：

```
打印一页带 background-repeat 的小页面
→ pymupdf: page.get_images() / 遍历 /Subtype /Image 的 Width × Height
   只有一张 38×23 的小图  ⇒ B2 成立
   是一张 800×700 的大图   ⇒ B2 无效，只能走 A + 事后替换
```

### C. 顺带能做的三件小事

1. **烘焙半透明**：`fill-opacity` 叠在白底上等价于一个实色；烘焙掉就不需要 alpha mask
   （当前 52 张图里约一半是 `/SMask`）。
2. **`print-color-adjust: exact`**：否则背景类填充可能根本不打印。
3. **收紧 `viewBox`**：让 `viewBox` 精确等于绘图包围盒，"viewBox → 目标框"的映射没有歧义。

---

## 3. 推荐组合：A + 占位符契约

最稳的不是"全都在生成阶段搞定"，而是：

1. **绘图代码把 hatch 改成显式线**（A）——这部分彻底摆脱位图；
2. **纹理保留位图，但只留一张小图**（B2，若实测成立）；
3. **生成端把绘图框写进 sidecar JSON**（`getBoundingClientRect()` → PDF 点），
   `page.pdf()` 之后**立即**调用本仓库的 `apply`，`--rect` 直接来自 sidecar。

这样即使纹理仍是位图，文件也只有几十 KB 量级，hatch 是矢量的。
严格说第 3 步仍是"生成后改 PDF"，但它已经不是"事后考古"：

> **坐标由生成端给出，没有推断。** 这和第 7 项 roadmap 的"占位符 + `/PieceInfo`"是同一思路，
> 只是用 sidecar JSON 传参更简单，不需要改 PDF 结构。

## 4. 如果想完全不做后处理：换打印引擎

把 `page.pdf()` 换成能把 SVG 映射成 PDF `Tiling Pattern` 的引擎：

- WeasyPrint + CairoSVG：开源、支持 SVG pattern、输出矢量；
- Prince：商业，SVG 支持好；
- 自己 `svg2pdf` 生成单页矢量 PDF，再用 `pdf-lib` 拼进报告页。

好处是 PDF 天生就是矢量 + 小体积；代价是整份报告的**分页、字体、表格边框、页眉页脚**
都要重新验证一遍——工作量和风险都远大于 A/B/C。

---

## 5. 决策表

| 方案 | 改动量 | 收益 | 风险 |
|---|---|---|---|
| A 显式线（hatch） | 中（改绘图代码） | hatch 全矢量 | 低 |
| B2 小图平铺（纹理） | 小（改 CSS/SVG） | 体积从 MB 降到 KB | 中（需实测） |
| C sidecar + apply | 小（生成端加几行 + 调 CLI） | 全自动、座标准确 | 低 |
| 换打印引擎 | 大 | 彻底根治 | 高（整页回归） |

**建议顺序：先做 B2 的验证页（半天），再决定纹理要不要动；A 和 C 可以并行做。**
