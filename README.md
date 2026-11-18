# montage-svg-print-fix

把设计报告 PDF 里**被栅格化的示意图**，用生成该报告时用的 **SVG** 重新画成矢量后贴回去。

一次典型的结果（井身结构报告，WBG 列）：

| | 原件 | 修复后 |
|---|---:|---:|
| 文件大小 | 4.68 MB | **92.7 KB** |
| 位图对象 | 52 | **0** |
| 绘图 | 1 张 827×752 位图 | 118 个矢量图形 + 5 个 tiling pattern |

表格、字体、其它列一字未动。

---

## 为什么需要它

报告由浏览器打印生成（Chromium → PDF）。浏览器把 SVG 里的 `<pattern>` 填充
**当作着色器整体光栅化**：一个 38×23 的纹理单元被铺满整个列、存成一张 827×752 的位图。
于是同一份报告里 98% 的字节都是这些位图，放大还会看到"马赛克块"。

信息在导出这一步就丢了，事后无法真正还原——所以本工具**不再从 PDF 里反推几何**，
而是拿生成时的 SVG 直接发射矢量 PDF，再替换报告里对应的那一块。

## 快速开始

```bash
npm install
npm run build

# 1) 单独看 SVG 打印成矢量的效果（1 用户单位 = 1 pt）
node dist/index.js print --svg drawing.svg --out drawing.pdf

# 2) 替换报告里的示意图
node dist/index.js apply \
  --pdf  report.pdf \
  --svg  drawing.svg \
  --rect 366,48,500,790 \
  --cover 360,36,508,798 \
  --out  "report vector.pdf"

# 3) 字节账（诊断用）
node dist/index.js audit report.pdf
```

- `--rect x0,y0,x1,y1`：生成时把绘图放进去的框（**PDF 点**）。这是唯一的几何输入。
- `--cover a0,b0,a1,b1`：替换前先擦白的范围，默认等于 `--rect`；通常取单元格内部。

## 三个命令

| 命令 | 作用 |
|---|---|
| `apply` | 报告 + SVG → 矢量报告（主线） |
| `print` | SVG → 独立矢量 PDF（1:1），用来单独验证发射器 |
| `audit` | 字节账：每类对象占多少字节 |

## 文档

- [`docs/design.md`](docs/design.md) —— 思路与走过的路：为什么"矢量还原"失败，"从 SVG 发射"为什么对
- [`docs/pdf-pattern-notes.md`](docs/pdf-pattern-notes.md) —— PDF tiling pattern 的正确配方（含三个真 bug）
- [`docs/upstream-options.md`](docs/upstream-options.md) —— 能不能在 `page.pdf()` 之前就避免光栅化
- [`docs/roadmap.md`](docs/roadmap.md) —— 下一步可做的方向

## 源码

```
src/
  index.ts      153 行  CLI
  apply.ts      583 行  主线：定位 → 发射（图形/pattern/文字）→ 合成
  print.ts      229 行  同一发射器，独立页 1:1
  svgitems.ts   140 行  SVG 图元遍历（transform 栈 + 属性继承）
  svg.ts        181 行  <pattern> 单元解析（lines / shapes / viewBox / fill）
  svgpath.ts    308 行  SVG path 解析（含圆弧转贝塞尔）+ 转 PDF 操作符
  paints.ts     166 行  旧内容流遍历，收集每次填充的 bbox / pattern / CTM
  content.ts     99 行  内容流 tokenizer
  images.ts      98 行  图像解码（Flate / PNG 预测器）
  audit.ts      154 行  字节账
```

依赖只有 `pdf-lib`；Node ≥ 20。

## 已知限制

1. **`--rect` 必须由生成端提供**。工具里还有一条"自动拟合"的兜底路径，实测不可靠
   （曾给出 0.05 这种明显错误的缩放），计划删除。
2. **标注文字用 Helvetica**（SVG 里没有字体文件），与报告自带的 Calibri 略有差异。
3. **旧内容是被"覆盖"而不是"删除"**：视觉上干净，但旧文字仍在文本层里（可被选中/提取）。
   PDF 页面只有一条内容流，同一流里也画着整张表格，无法选择性删除。

## 许可

内部工具，未授权公开分发。
