# dsh-artifact

给 dsh（DeepSeek Harness）加上 Claude Code 式的 **artifact（产物）**：让 agent 写出自包含的 HTML 文档，用户在应用内的产物浏览器里直接看。

一个 artifact 就是产物库里的一个 HTML 文件。四个面共享这一份东西：

- **AI 工具 `artifact`** —— agent 在对话里 `list` / `read` / `write` / `delete`。
- **system prompt 段落** —— 告诉模型这个面存在、产物存在哪、什么时候该用。
- **`writing-artifacts` skill** —— 随包内置的写作指南：产物存放位置、沙箱禁止什么、文档该长什么样、什么时候不该写 artifact。
- **产物浏览器 UI** —— 侧边栏 `sidebar.footer.action` 里的入口 + 全屏面板：左边列表（按修改时间倒序），右边沙箱 iframe 渲染，可切源码视图，可删除。

因为存的就是普通 HTML，所以人能用浏览器打开、agent 能当文本改写、应用内能直接渲染——一种格式，三个读者。

## 安装

```sh
# 从 registry 安装
dsh plugin --profile web add dsh-artifact

# 或从本仓库安装
dsh plugin --profile web add file:./dsh-artifact
```

装完**必须重启** `dsh web`：插件在进程启动时装入，运行中的实例不会捡起新装的行。

## 产物存在哪

默认是 `$DSH_HOME/artifacts`，也就是 `~/.dsh/artifacts`——和 dsh 自己的 `sessions/`、`storages/` 并排，属于 harness 用户数据。

**刻意不放 workspace。** 产物跟着人走而不是跟着项目走，仓库也不该被生成的 HTML 填满。

工具的 `path` 参数一律相对该目录解析，且**解析后必须落在目录内**，否则直接拒绝——`../`、绝对路径指向别处都拒。这条不是事后加的校验而是解析器本身的性质：一个找不回来的产物正是它要防的失败。

## 为什么用 `node:fs` 而不是 `ctx.fs`

产物库是 `$DSH_HOME` 下的自有数据，不是 workspace 内容。三件事让文件系统服务在这里不合用：

1. 该服务**没有 delete，也没有 mkdir**（只有 12 个方法：resolve / stat / lstat / readText / readBytes / streamText / listDir / writeText / editText / contains / processPath / fileUrl），本插件一半操作在那边没有对应物；
2. 它的沙箱是用来把写入约束在会话 workspace 里的，而产物库正在 workspace 之外——默认 `workspace-write` 策略下**每一次产物写入都会被拒**，直到用户批准一次提权；
3. 约束改由本插件自己保证：每个路径要么解析进 `root`，要么被拒。

## 配置

bundle 的 `cordis.patch.yml` 插入一个 `artifact` row，可在 profile 的 `cordis.patch.yml`（或 `--patch`）里覆盖：

```yaml
- id: artifact
  config:
    # 产物目录；省略或 null 时用 $DSH_HOME/artifacts。
    root: /absolute/path/to/artifacts
    # 单次写入允许的最大字符数。
    maxArtifactChars: 400000
    # 是否注入「什么时候该写 artifact、产物存在哪」的 system prompt 段落。
    promptSection: true
    # 是否注册内置的 writing-artifacts skill。
    skill: true
```

关掉 `promptSection` 只是去掉那段主动提示，工具本身的 description 仍然带着同一套规则。

## AI 工具：`artifact`

| 命令 | 参数 | 说明 |
|---|---|---|
| `list` | — | 列出全部产物，按修改时间倒序，带标题。 |
| `read` | `path` | 返回一份产物的完整 HTML。 |
| `write` | `path`, `content` | 创建或整体替换一份产物。 |
| `delete` | `path` | 删除一份产物。 |

`path` 相对产物库解析，漏掉 `.html` 后缀会自动补上。工具 description 和 prompt 段落里都写明了产物库的绝对路径，所以模型知道东西落在哪。

没有增量修改形式：`write` 永远是整份替换，所以改一份产物要输出完整的新文档。

## 沙箱

预览用的 iframe 只开了 `allow-scripts`，**没有 `allow-same-origin`**。模型写出来的标记因此够不到宿主页面的 origin、storage 和 cookie。代价是产物必须自包含：

- 不能 `<link>` 或 `@import` 远程样式表；
- 不能 `<script src="…">` 外链；
- 不能用网络字体，不能 `fetch` / XHR / WebSocket；
- 不能碰 `localStorage` / `sessionStorage` / cookie（同源被拒，一碰就抛）。

CSS 写进 `<style>`，JS 写进 `<script>`，图片用 `data:` URI，字体用系统字体栈。内置的 `writing-artifacts` skill 把这些连同文档骨架、明暗主题适配一起教给了模型。

## 两个半部分

| 半部分 | 文件 | 内容 |
|---|---|---|
| Host | `lib/index.js` | `artifact` Remote 服务、`artifact` 工具、prompt 段落、runtime skill |
| Client | `lib/client.js` | `sidebar.footer.action` 入口、`shell.overlay` 浏览器面板 |

几个绕过去的坑，都写在代码注释里：

- **内置 skill 走 `ctx.skills.register()` 的 runtime skill 路径**，不是 `customSkillDirs`。bundle 插件是个 npm 包，skill 目录会落在 `node_modules` 里，任何扫 project / user 根目录的 catalog 都看不见它。
- **线上方法名一律带 `Artifact` 后缀**。客户端网关给每个 namespace 建一个 `RemoteNamespaceService`，任何与该类同名的方法都会被拒——它自己占着 `remove`、`has`、`install`、`name`、`empty` 等等。裸动词随时可能在下个网关版本撞上。
- **`$mount` 之后用 `ctx.get("remote.artifact")` 取 namespace**，不能写 `ctx.remote.artifact`：属性访问会过注入守卫，而声明 `inject: ["remote.artifact"]` 会死锁——`apply()` 正是创建那个服务的人。
- **`Config` 用 `z.string()` 而不是 `z.string().optional()`**。schemastery 不是 Zod，字段默认可选，只有 `.required()` 和 `.default()`；调 `.optional()` 会在模块求值阶段直接崩。

## i18n

UI 文案走 `ctx.locale.register("artifact", { zh, en })`，两个 slot 注册都声明 `locale: "artifact"`，因此组件拿到框架注入的 `t` 位，语言切换实时生效。

## 内置 skill 写什么

`writing-artifacts` 的第一节就是「先选形态」：

- **文档** —— 报告、分析、参考、纪要、对比。散文 + 标题 + 表格。**这是主流形态**，多数 artifact 是拿来读的。
- **交互工具** —— 计算器、计时器、数据浏览器。只在交互本身就是交付物时才写。

默认写文档。用户要一份报告、你却套上侧边栏工具栏和一堆卡片，结果比朴素页面更差——正文被埋在没人要的壳里。

文档形态的具体约束：语义化标签、约 `70ch` 的单栏正文宽度、≥16px 字号、`line-height: 1.6`、表格用 `<th scope>` + 等宽数字 + 自己的横向滚动容器、结论放第一屏、带 `@media print`。

还有一节「避免 AI slop」，取自 Anthropic 官方 [web-artifacts-builder](https://github.com/anthropics/skills/blob/main/skills/web-artifacts-builder/SKILL.md) 的设计约束：不要过度居中布局、紫色/靛蓝渐变、到处一致的圆角、Inter 字体；另外加了表情符号当小标题、徽章泛滥、发光状态点、玻璃拟态。

## 发布（npm trusted publisher）

`.github/workflows/publish.yml` 用 **OIDC 可信发布**，仓库里没有任何 `NPM_TOKEN`——npm 拿 GitHub Actions 的 OIDC 令牌换一个短期凭证，所以发布只能从这个仓库的这个工作流发生，笔记本和 fork 都发不了。

npmjs.com 上一次性配置：

```
https://www.npmjs.com/package/dsh-artifact/access
  → Trusted publisher → GitHub Actions
Organization or user: Jannchie
Repository:           dsh-artifact
Workflow filename:    publish.yml
Environment:          留空
```

工作流文件名必须完全一致。之后发版：

```sh
# 1. 改 package.json 里的 version
git tag v0.2.0
git push origin v0.2.0
```

工作流会核对标签版本与 `package.json` 是否一致，不一致直接失败——避免发出一个没人打过标签的版本。也可以在 Actions 页面手动触发。

需要 npm ≥ 11.5.1（Node 22 自带的是 10.x，所以工作流里显式升级了 npm）。

## 开发

```sh
npm run check   # 对 lib/*.js 做 node --check
```

## License

MIT
