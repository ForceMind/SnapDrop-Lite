# 来源与许可证核验

核验日期：2026-10-19。

- 接管基线 `ade5b9f` 的 README 声明基于 RobinLinus/snapdrop；保留的 CSS、HTML 自定义元素及图标结构也来自该工程。
- 上游 `https://github.com/RobinLinus/snapdrop` 当前重定向至 `SnapDrop/snapdrop`。本次只读检出固定提交 `f2b672c9d48221d0ce6bda41a6d9b4a2b18a98d2`，其根 LICENSE 是 GPL version 3。
- 本库旧 LICENSE 为 Apache-2.0，README 则错误称为 ISC。仅更换产品名不能消除保留代码的来源或上游许可义务。
- 本次恢复完整上游 GPL-3.0 文本至根 LICENSE，将原 Apache 文本原样保留在 `licenses/Apache-2.0-existing.txt`。NOTICE 保留来源和修改声明；历史提交不重写。
- 根包和服务包的 SPDX 统一为 `GPL-3.0-only`。新增代码作为组合应用的一部分交付。依赖保留各自 MIT 许可；构建复制完整运行依赖许可至发行目录。
- 删除未使用的旧上游品牌图片、Sketch 源文件、声音及剪贴板兼容脚本。删除资产不表示剩余衍生代码变成独立原创。
- 本次没有逐提交重建最初导入来源；完整历史溯源仍列入发布前检查。此记录不把来源声明当作商标授权。
