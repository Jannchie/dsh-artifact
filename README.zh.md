# dsh-artifact

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-artifact)](https://www.npmjs.com/package/dsh-artifact)
[![license](https://img.shields.io/npm/l/dsh-artifact)](./LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai) 加上工件（artifact）：智能体写出自包含的 HTML 文档，每次调用都留下一个跳转链接，点开就在对话旁读，整个工件库则在侧边栏里。

![工件浏览器正在渲染一份生成的速查表](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/cn.png)

![工件库：所有工件按时间倒序排列](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/library-cn.png)

没有它的话，智能体写的报告要么滚出聊天记录，要么变成仓库里一个没人再打开的 `.html`。工件存在 workspace 之外、按时间倒序列出、就地渲染——它比产生它的那次对话活得久，也跟着人走而不是跟着项目走。

## 安装

```sh
dsh plugin --profile web add dsh-artifact
```

装完重启 `dsh web`：插件在进程启动时装入。

## 上手

让智能体写点值得留下的东西：

> 把这周的压测结果整理成一份报告。

它会调用 `artifact` 工具。对话里这次调用会带出文档名，一个跳转链接；点它，智能体刚写完的东西就在右侧栏里打开，和你正在读的那条消息并排。该会话写的工件也列在**工件**标签页里；所有会话的工件都在左侧栏「插件」旁的**工件**面板里（DSH 0.1.7+）。点进去读，`‹` 返回。

这个版本之前写的工件、以及在 DSH 0.1.7 之前的宿主上写的工件没有会话记录，只出现在工件库里。

智能体同时拿到一个 `writing-artifacts` skill，所以它写出来的 HTML 是一份真正的文档——单栏正文、语义化标题、表格自己横向滚动、配色跟随你的主题——而不是拿一套应用外壳裹住三段话。

## 打开一份工件

三条入口，每一条都是应用自己的：

- **调用上的跳转链接。** 对话里每次 `artifact` 调用都把工件名画成一条带下划线的链接。按下它，文档在右侧栏打开，就停在你还在读的那条消息旁边。再按一条链接只是把同一个标签页挪过去，不会叠出一摞。
- **右侧栏标签页。** 右侧栏的「+」把**工件**当成一个页面提供，所以在还没有链接可点之前就能先开着它；智能体接着说，你在旁边接着读、接着对比。
- **工件面板。** 左侧栏的**工件**图标打开全部工件，不分会话，最新在前。

当右侧栏接不住这次跳转时——宿主早于 DSH 0.1.7，或者当前没有选中会话——链接会退回工件面板，所以它总能打开点什么。工件面板的详情页上也有一个「在侧边栏打开」按钮，供你在库里翻到某份文档、想换个地方读的时候用。

链接的存在是会告诉模型的，同时也会告诉它别自己写链接：工件库路径是内部数据，用它拼出来的 markdown 链接只会静默失败。

## `artifact` 工具

| 命令 | 参数 | 作用 |
|---|---|---|
| `list` | — | 列出全部工件，最新在前 |
| `read` | `path` | 返回一份工件的完整 HTML |
| `write` | `path`、`content` | 创建或整体替换一份工件 |
| `delete` | `path` | 删除一份工件 |

`path` 相对工件库解析，`.html` 后缀可省，所以 `write path:"q3-report"` 得到 `q3-report.html`。工件库是一层平铺的架子：跑到外面、落进子目录、或者以点开头的路径都会被拒绝，而不是存到浏览器找不到的地方。

版本历史刻意没有做进这个工具。模型刚写完这份文档，它知道自己写了什么；"这版改了什么"是人隔一天才会问的问题，所以答案放在人正看着的那个面板里。

## 版本历史

被智能体反复重写的工件会留下它替换掉的内容。打开一份写过不止一次的工件，标题旁会出现「历史」按钮；只写过一次的工件——大多数都是——看不到任何与历史有关的东西。

版本排在文档上方的时间轴上。选中一个，它会与当前版本并存，而不是取代它：

- **预览**模式下按住「按住看这一版」，旧版会占据屏幕上同一个位置——同样的尺寸、同样的滚动位置——改动会自己跳出来，而不用在两个半宽栏之间来回找。
- **源码**模式下两版对齐成逐行 diff，中间长段没改的会折叠起来。

「恢复这一版」把旧版重新变成当前内容。它不需要二次确认：被顶掉的内容和任何一次覆盖一样会存进历史，所以恢复本身也能被恢复撤销。

版本存在工件旁边的 `.versions/` 下，每份工件保留最近 20 个（`maxVersionsPerArtifact`）。内容没变的重写不算一个版本。删除工件会连同它的历史一起删掉。

## 工件存在哪

`$DSH_HOME/artifacts`，默认 `~/.dsh/artifacts`——和 harness 自己的 sessions、storages 并排。

**刻意不放 workspace**：工件跟着人走而不是跟着项目走，仓库也不该被生成的 HTML 填满。

## 渲染

工件在 iframe 里渲染，只开 `allow-scripts`——**无网络、无同源**。远程样式表、CDN 脚本、网络字体、`fetch`、`localStorage`、cookie 全都用不了，所以工件必须把需要的东西全部内联。内置 skill 会教智能体这件事，只有你手写工件时才需要关心。

预览会把 app 的实时配色 token 注入进去，所以工件跟随你的主题——包括被别的插件覆盖过的主题。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: artifact
  config:
    # 工件目录，省略或 null 时用 $DSH_HOME/artifacts。
    root: /absolute/path/to/artifacts
    # 单次写入允许的最大字符数。
    maxArtifactChars: 400000
    # 每份工件保留多少个被替换掉的旧版本，0 表示彻底关掉历史。
    maxVersionsPerArtifact: 20
    # 是否注入「什么时候该写工件」的 system prompt 段落。
    promptSection: true
    # 是否注册内置的 writing-artifacts skill。
    skill: true
    # 交给工件的配色，层叠在实时主题之上。
    # 键不带 `--` 时按 alias token 解析。
    palette:
      state-business-primary: '#e0552b'
```

## 实现笔记

给其他插件作者的记录——slot 契约、双层信封的线上协议、以及四个值得知道的坑——在 [NOTES.md](NOTES.md)。

## License

MIT
