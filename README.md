# Alpha Guard

gmgn.ai Top100 持仓监控插件。当黑名单地址的持仓比例达到设定阈值时，在页面顶部弹出风险提示横幅，帮你避开高风险代币。

## 功能

- 实时拦截 gmgn.ai 的持仓数据接口，自动解析 Top100 持仓地址
- 自定义黑名单地址，支持添加备注名
- 持仓比例阈值可调（默认 5%），达到即触发风险横幅
- SPA 路由感知，切换代币页面自动清理/重新检测
- 一键开关，关闭后不影响正常浏览

## 安装方法

1. 点击本页面右上角绿色的 **Code** 按钮，选择 **Download ZIP**
2. 解压下载的文件
3. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions`
4. 打开右上角的 **开发者模式**
5. 点击 **加载已解压的扩展程序**
6. 选择解压后的 `AlphaGuard` 文件夹（包含 `manifest.json` 的那一层）

## 使用方法

1. 安装后点击浏览器右上角的插件图标打开设置面板
2. 添加你想监控的黑名单地址（0x 开头），可选填备注名
3. 设置持仓比例阈值（默认 5%）
4. 打开 gmgn.ai 任意代币页面，插件会自动开始监控
5. 如果检测到黑名单地址持仓超过阈值，页面顶部会弹出红色警告横幅

## 技术栈

- Chrome Extension Manifest V3
- Vanilla JavaScript
- 通过 MAIN world 注入拦截 fetch / XHR 请求
- ISOLATED world 与 MAIN world 通过 postMessage 通信
