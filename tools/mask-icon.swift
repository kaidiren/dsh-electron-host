// mask-icon.swift —— 把一张方形图片做成 macOS 应用图标（圆角 + 透明角）
//
// 为什么需要它：源图通常是「带白底和阴影的成品图」，直接转 icns 会在四角露出白方块；
// 而 macOS 不会替图标裁圆角（圆角是画在图标内的），所以必须自己做遮罩。
//
// 用法：
//   swiftc -O tools/mask-icon.swift -o /tmp/mask-icon
//   /tmp/mask-icon <源图> <输出.png> <裁边px> <圆角系数> <画面缩放>
//
// 本仓库当前图标用的参数（1024 画布 / 内容区 824 / Apple 网格）：
//   /tmp/mask-icon src.jpg out.png 44 0.28 1.05
//
// 参数含义：
//   裁边    四周各裁掉多少像素，用来去掉源图自带的白边（先用像素扫描量出来）
//   圆角系数 圆角半径 = 内容区边长 × 该系数；0.2237 ≈ Apple 标准，0.28 更圆（能切掉底角白边）
//   画面缩放 内容按该倍数放大后居中绘制，用来把源图残余的浅色边推到遮罩之外
import Foundation
import CoreGraphics
import ImageIO

let a = CommandLine.arguments
guard a.count >= 6 else {
    print("usage: mask-icon <in> <out.png> <cropInset> <radiusFactor> <zoom>")
    exit(2)
}
let inset = Int(a[3]) ?? 0
let radiusFactor = Double(a[4]) ?? 0.2237
let zoom = Double(a[5]) ?? 1.0

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    print("读取源图失败")
    exit(1)
}

let cropRect = CGRect(x: inset, y: inset,
                      width: img.width - inset * 2, height: img.height - inset * 2)
guard let cropped = img.cropping(to: cropRect) else { print("裁剪失败"); exit(1) }

let canvas = 1024
let margin = 100
let rectSize = canvas - margin * 2
let radius = Double(rectSize) * radiusFactor

let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8,
                          bytesPerRow: canvas * 4, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    print("创建上下文失败")
    exit(1)
}
ctx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))

let box = CGRect(x: CGFloat(margin), y: CGFloat(margin),
                 width: CGFloat(rectSize), height: CGFloat(rectSize))
ctx.addPath(CGPath(roundedRect: box, cornerWidth: CGFloat(radius),
                   cornerHeight: CGFloat(radius), transform: nil))
ctx.clip()

let drawSize = CGFloat(rectSize) * CGFloat(zoom)
let drawRect = CGRect(x: box.midX - drawSize / 2, y: box.midY - drawSize / 2,
                      width: drawSize, height: drawSize)
ctx.interpolationQuality = .high
ctx.draw(cropped, in: drawRect)

guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL,
                                                 "public.png" as CFString, 1, nil) else {
    print("写出失败")
    exit(1)
}
CGImageDestinationAddImage(dest, out, nil)
guard CGImageDestinationFinalize(dest) else { print("写文件失败"); exit(1) }
print("ok: inset=\(inset) radius=\(Int(radius)) zoom=\(zoom) -> \(a[2])")
