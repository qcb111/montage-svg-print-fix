# PDF tiling pattern 的正确配方

这份笔记是从一份"渲染效果很好"的参考 PDF 里逆推出来的（该文件 467 KB，
其中 410 KB 是嵌入字体，绘图部分只占约 20 KB，全部矢量）。

## 参考文件怎么做的

```
pattern 317: BBox [0 0 38 23]   XStep 37.9  YStep 22.9   Matrix [1 0 0 1 0 0]
             内容 = 68 条 pebble path（就是 SVG 里那个 38×23 单元的原文）

pattern 318: BBox [0 0 50 29]   XStep 49.9  YStep 28.9
             内容 = ~20 条斜线，从 (-17.95,-61.1) 画到 (111.95,13.89)
```

两个关键点：

### 1. `XStep/YStep = BBox − 0.1`

tile 之间**故意重叠 0.1 pt**，这样浮点/取整永远留不出白色细缝。
比"把内容复制九遍求无缝"简单，也更稳。

### 2. hatch 的 tile 要装「一整族线」

tile 是 50×29，里面放了约 20 条线，每条跨度 130 单位 —— 是 tile 宽的 **2.6 倍**。

含义：**把穿过这个 tile 的所有线都画出来，而且每条都画长到能完整穿过 tile**。
这样无论 tile 怎么裁，内容都不会丢，密度天然正确。

反面教材（我们最初的写法）：10×5.8 的 tile 里塞 3 条跨度 26 的线。
tile 太小、线相对太长，一个 tile 里只能看到碎片，连续性全靠相邻 tile 拼 —— 脆弱。

## 我们的发射器

```ts
// 一个 lattice 周期沿 x / y
const A = spacing / |nx|;
const B = spacing / |ny|;
const mult = 5;                  // tile = 5×5 个周期
const W = A * mult, H = B * mult;
const L = hypot(W, H) * 1.2;     // 每条线画到足够穿过 tile

for (i, j) 画一条过 (i*A, j*B)、方向 u、长度 L 的线

BBox   = [0, 0, W, H]
XStep  = W - 0.1
YStep  = H - 0.1
Matrix = [1, 0, 0, -1, 0, H]     // 内容按 y-down 写，只翻一次
```

实测结果与参考文件同构：`50 × 28.87 pt`，25 条线。

## 三个真 bug（都在注释里标了）

### 1. `<g fill="url(#...)">` 的继承

```svg
<g fill="url(#cement_1)"><path d="..." /></g>
```

如果只读元素自身的属性，`fill` 会落空 → 墙变白墙（填充丢失）。
必须维护一个**可继承属性栈**（`fill / stroke / stroke-width / *-opacity`）。

这是"hatch 消失了"的真凶，不是裁剪。

### 2. `fill="inherit"` 不能兜底成黑色

SVG 里会出现字面量 `fill="inherit"`。如果把它当成"默认黑色"，整条套管会被涂黑。
正确处理：向上取父级的值；取不到就当"无填充"。

### 3. 文字不能用 pdf-lib 的 `page.drawText`

它会给页面新建/重写内容流，把刚画好的图形盖掉。必须自己发：

```
BT /FT1 12 Tf 1 0 0 1 x y Tm <hex> Tj ET
```

字体只借用 pdf-lib 嵌入的 ref，挂到页面 `/Font` 资源上。

## 坐标系提醒

- 页面默认空间、Form XObject 的 CTM、pattern 空间、SVG 用户空间 —— 是**四个**不同的空间。
- 每个 pattern 的"单位 → 页面"比例可能不同（同一份文件里见过 1.0 和 0.24）。
- `Matrix` 的平移是相对**页面默认空间**的，不受绘制时的 CTM 影响。
- 非均匀缩放会让 hatch 的角度变化（30° → 23°），间距也要重新算：

```ts
dx = (x2 - x1) * sx;  dy = (y2 - y1) * sy;   // 方向先缩放再归一化
spacing = |A · n|                             // 间距随法向缩放
```
