# dsh-artifact

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-artifact)](https://www.npmjs.com/package/dsh-artifact)
[![license](https://img.shields.io/npm/l/dsh-artifact)](./LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai) 加上产物（artifact）：智能体写出自包含的 HTML 文档，你在对话旁边的标签页里读。

![产物浏览器正在渲染一份生成的速查表](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/cn.png)

没有它的话，智能体写的报告要么滚出聊天记录，要么变成仓库里一个没人再打开的 `.html`。产物存在 workspace 之外、按时间倒序列出、就地渲染——它比产生它的那次对话活得久，也跟着人走而不是跟着项目走。

## 安装

```sh
dsh plugin --profile web add dsh-artifact
```

装完重启 `dsh web`：插件在进程启动时装入。

## 上手

让智能体写点值得留下的东西：

> 把这周的压测结果整理成一份报告。

它会调用 `artifact` 工具，文档出现在**产物**标签页里。点进去读，`‹` 返回。

智能体同时拿到一个 `writing-artifacts` skill，所以它写出来的 HTML 是一份真正的文档——单栏正文、语义化标题、表格自己横向滚动、配色跟随你的主题——而不是拿一套应用外壳裹住三段话。

## `artifact` 工具

| 命令 | 参数 | 作用 |
|---|---|---|
| `list` | — | 列出全部产物，最新在前 |
| `read` | `path` | 返回一份产物的完整 HTML |
| `write` | `path`、`content` | 创建或整体替换一份产物 |
| `delete` | `path` | 删除一份产物 |

`path` 相对产物库解析，`.html` 后缀可省，所以 `write path:"q3-report"` 得到 `q3-report.html`。写入被约束在产物库内：解析后跑到外面的路径会被拒绝，而不是存到浏览器找不到的地方。

## 产物存在哪

`$DSH_HOME/artifacts`，默认 `~/.dsh/artifacts`——和 harness 自己的 sessions、storages 并排。

**刻意不放 workspace**：产物跟着人走而不是跟着项目走，仓库也不该被生成的 HTML 填满。

## 渲染

产物在 iframe 里渲染，只开 `allow-scripts`——**无网络、无同源**。远程样式表、CDN 脚本、网络字体、`fetch`、`localStorage`、cookie 全都用不了，所以产物必须把需要的东西全部内联。内置 skill 会教智能体这件事，只有你手写产物时才需要关心。

预览会把 app 的实时配色 token 注入进去，所以产物跟随你的主题——包括被别的插件覆盖过的主题。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: artifact
  config:
    # 产物目录，省略或 null 时用 $DSH_HOME/artifacts。
    root: /absolute/path/to/artifacts
    # 单次写入允许的最大字符数。
    maxArtifactChars: 400000
    # 是否注入「什么时候该写产物」的 system prompt 段落。
    promptSection: true
    # 是否注册内置的 writing-artifacts skill。
    skill: true
    # 交给产物的配色，层叠在实时主题之上。
    # 键不带 `--` 时按 alias token 解析。
    palette:
      state-business-primary: '#e0552b'
```

## 实现笔记

给其他插件作者的记录——slot 契约、双层信封的线上协议、以及四个值得知道的坑——在 [NOTES.md](NOTES.md)。

## License

MIT
