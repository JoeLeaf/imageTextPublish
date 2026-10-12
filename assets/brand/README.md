# 应用品牌资产

原创矢量 logo：图片卡片、正文短线与向右上方的发布箭头，沿用界面蓝色，浅青色突出发布动作。源文件 `logo.svg` 可直接编辑，无第三方商标或素材。

`node scripts/generate-brand-assets.mjs` 从 SVG 生成 `app-icon.png`、Windows 多尺寸 ICO 和 macOS ICNS。修改 logo 后重新生成，再执行构建和打包。侧栏与标题栏直接引用 SVG，窗口引用 PNG，安装程序图标引用 ICO/ICNS。
