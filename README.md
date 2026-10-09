# dsh-artifact

中文 | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-artifact)](https://www.npmjs.com/package/dsh-artifact)
[![license](https://img.shields.io/npm/l/dsh-artifact)](./LICENSE)

dsh-artifact 为 [DeepSeek Harness](https://github.com/deepseek-ai) 提供工件（artifact）：智能体通过 `artifact` 工具写出自包含的 HTML 文档或幻灯片，写完即在对话右侧打开。

智能体生成的报告若只留在聊天记录中，会随对话滚走；若写入仓库，则成为无人再打开的 `.html` 文件。工件保存在工作区之外，按时间倒序集中列出，可就地阅读、编辑、对比历史版本，幻灯片还可放映并导出为 PowerPoint。

![智能体写完幻灯片后，右侧栏自动打开幻灯片编辑器](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/auto-open.gif)

## 安装

```sh
dsh plugin --profile web add dsh-artifact      # dsh web
dsh plugin --profile desktop add dsh-artifact  # 桌面版
```

插件在进程启动时加载，安装后需重启 `dsh web` 或桌面版。右侧栏与工件面板需要 DSH 0.1.7 及以上版本。

## 快速上手

向智能体提出需要保留的产出即可：

> 把这周的压测结果整理成一份报告。

> 做一份 4 页的幻灯片，主题是咖啡店季度回顾。

智能体调用 `artifact` 工具写入工件。写入完成时，若该对话正在屏幕上，工件会在右侧栏自动打开；对话中的工具行同时以工件名显示一个跳转链接，之后可随时点击重新打开。

## 常用用法

**阅读与查找。** 对话的「工件」标签页列出该会话写过的工件；左侧栏的「工件」面板列出所有会话的工件。工件面板中的文档可通过「在侧边栏打开」放到对话旁阅读。

![工件库：所有工件按时间倒序排列](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/library-cn.png)

**编辑幻灯片。** 要求制作演示文稿时，智能体写出的是幻灯片而非网页。幻灯片在编辑器中打开，支持直接修改文字、拖入图片、调整表格行列、切换主题、全屏放映与导出 `.pptx`；修改会保存回同一份工件，智能体下次读取时即可看到。编辑器由 [`@jannchie/slides`](https://github.com/Jannchie/slides) 提供。

![幻灯片编辑器：缩略图、舞台、格式面板与演讲备注](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/slides.png)

**对比历史版本。** 工件被重写后，旧版本会保留下来（默认每份最多 20 个），标题旁出现「历史」按钮。预览模式下按住「按住看这一版」可在同一位置切换新旧版本；源码模式下显示折叠了未变部分的差异。「恢复这一版」无需确认，被替换的内容同样保留为一个版本。

**自动打开的范围。** 仅在对话中实时完成的 `write` 会自动打开工件。重新进入会话时回放的旧调用、`read` 与 `list` 不会打开任何内容；右侧栏不可用时（例如未选中会话）也不会自动跳转到工件面板。

## `artifact` 工具

| 命令 | 参数 | 作用 |
|---|---|---|
| `list` | — | 按时间倒序列出所有工件 |
| `read` | `path` | 读取一份工件的完整内容 |
| `write` | `path`、`content`、`kind` | 新建或替换工件；`kind` 为 `html`（默认）或 `slides` |
| `delete` | `path` | 删除工件及其历史版本 |

`path` 相对于工件目录，`.html` 后缀可省略。智能体同时获得 `writing-artifacts` skill，用于约束 HTML 文档的结构与配色，以及幻灯片可用的格式子集。

## 存储与渲染

- 工件保存在 `$DSH_HOME/artifacts`（默认 `~/.dsh/artifacts`），历史版本位于其下的 `.versions/`，幻灯片中的图片位于 `.assets/`。
- HTML 工件在仅允许脚本的 sandbox iframe 中渲染，无网络访问、无同源权限，所需资源须内联。预览时注入应用当前的颜色变量，工件配色随主题变化。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: artifact
  config:
    root: /absolute/path/to/artifacts   # 工件目录，默认 $DSH_HOME/artifacts
    maxArtifactChars: 400000            # 单次写入的字符上限
    maxVersionsPerArtifact: 20          # 每份工件保留的历史版本数，0 为关闭
    promptSection: true                 # 在系统提示词中说明何时写工件
    skill: true                         # 注册 writing-artifacts skill
    palette:                            # 叠加在当前主题上、传给预览的颜色
      state-business-primary: '#e0552b'
```

插槽约定与通信协议等实现说明见 [NOTES.md](NOTES.md)。

## License

MIT
