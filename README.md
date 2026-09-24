# 学习通视频与 PPT 连播助手

适用于 Chrome + Tampermonkey 的用户脚本。它在学习通电脑端依次处理当前课程中可识别的未完成视频、音频和 PPT/文档任务点：视频可选择 1×、1.5× 或 2×，PPT 在可访问的阅读区域内逐屏下滑。脚本只在页面显示任务完成标记后切换到下一项。

[安装或更新脚本](https://raw.githubusercontent.com/FH150174/chaoxing-playback-helper/main/chaoxing-playback.user.js) · [查看源码](chaoxing-playback.user.js)

## 安装与使用

1. 在 Chrome 中安装 Tampermonkey。
2. 点击上方“安装或更新脚本”，按 Tampermonkey 提示安装。如果浏览器只显示源码，可复制全部内容并粘贴到 Tampermonkey 的新建脚本中。
3. 如果之前手动安装过旧版，先停用旧脚本，避免两个版本同时运行；确认新版正常后可删除旧版。
4. 刷新学习通电脑端课程学习页，点击右下角“开始连播”。默认选择 2×、静音自动播放和后台兼容。
5. 首次使用先观察一个视频和一个 PPT，确认任务点确实显示“已完成”。需要停止时，点击“停止连播”。

脚本配置仅保存在当前浏览器标签页的该课程会话中。通过安装链接安装的脚本可由 Tampermonkey 按更新地址检查新版本。

## 工作范围与限制

- PPT 按阅读区域可见高度约 80% 分步下滑；如果页面在底部继续加载新内容，会继续下滑。到底后仍未显示完成标记时，最多等待 60 秒，然后停止并提示。
- 高于 1× 时，脚本会拦截当前任务媒体的 ratechange 回调，尝试避免部分课程把速度改回 1× 并暂停。其他前端检测或平台服务端的进度规则可能仍会限制倍速。
- 后台兼容只处理网页失焦和可见性回调。Chrome 可能节流或冻结最小化窗口中的页面，因此最小化后无法保证连续运行。
- 章节测验、验证码、跨域且不可访问的播放器，以及无法识别的任务点需要手动处理。脚本不会伪造任务完成标记，也不会自行发送进度请求。

## 本地开发与验证

    npm ci
    npm test
    npm run check

脚本本身没有运行依赖；jsdom 只用于模拟课程页面并测试任务切换、视频与 PPT 处理。项目采用 [MIT 许可证](LICENSE)。

任务选择器参考 [OCS 发布源码](https://greasyfork.org/zh-CN/scripts/457151-ocs-%E7%BD%91%E8%AF%BE%E5%8A%A9%E6%89%8B/code) 和 [章节内 PPT 源码](https://greasyfork.org/zh-CN/scripts/446613-%E8%B6%85%E6%98%9F-%E5%AD%A6%E4%B9%A0%E9%80%9A%E7%AB%A0%E8%8A%82%E5%86%85ppt%E4%B8%8B%E8%BD%BD/code)。[超星课程说明](https://special.chaoxing.com/special/screen/tocard/185820374?courseId=205791416)介绍了 PPT、文档章节任务点。