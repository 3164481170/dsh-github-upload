# dsh-github-upload

把**已经做完的项目目录**一键推到 GitHub —— 只需要 `git` 和一个 GitHub 令牌，
不依赖 `gh` CLI，也不绑定 npm 发布流程。

> 与 `dsh-github-publisher` 的区别：那个插件面向「发布 DSH 插件」（bump 版本 →
> npm pack → 打 tag → 建 Release → 发 npm），且强依赖 `gh` CLI。这个插件只做一件事：
> **把本地项目传到 GitHub 上**。

## 它做什么

一次调用完成：

1. **预检**（只读）—— 目录内容、技术栈、体积、凭据扫描、git 状态、GitHub 账号、同名仓库是否存在
2. **生成 `.gitignore`** —— 按识别到的技术栈（Node / Python / Rust / Go / Java / .NET / Unity / Godot / C++ / 静态站点）
3. **`git init`** —— 只在还不是仓库时执行
4. **`git add` + `commit`** —— 提交身份优先用 git 配置，缺省用 GitHub 账号推导 noreply 邮箱
5. **建仓库** —— 走 GitHub REST API，默认私有；已存在则直接复用
6. **推送** —— 通过内存中的 `GIT_ASKPASS` 助手注入令牌

## 安装

```bash
# 本地源码目录（推荐，改完即生效）
dsh plugin --profile desktop add "link:C:/Users/郑/Documents/deepseek-harness/default-workspace/dsh-github-upload"

# 或随 profile 的 bundles 一起启用
```

装完**重启 DSH 桌面端**并刷新页面。

## 配置令牌

令牌保存为凭据（默认引用名 `GITHUB_TOKEN`），也可以直接用同名环境变量。
需要 **`repo`** 权限（私有仓库建仓/推送）；只推公开仓库可用 `public_repo`。

三种方式任选：

```text
# 1) 面板：侧边栏「GitHub 上传」→ 填令牌 → 保存并校验
# 2) 对话：gh_upload_token(action="set", value="ghp_...")
# 3) 环境变量：setx GITHUB_TOKEN "ghp_..."
```

## 用法

### 对话里（agent 工具）

```text
gh_upload_status(path="E:\\my-project")          # 只读预检，不写任何文件
gh_upload_project(path="E:\\my-project")         # 真正上传（默认私有仓库）
gh_upload_project(path="E:\\my-project", dryRun=true)   # 只预演
```

常用变体：

```text
gh_upload_project(path, repo="my-app", private=false)          # 公开仓库、指定名字
gh_upload_project(path, owner="my-org")                        # 传到组织
gh_upload_project(path, branch="trunk")                        # 指定分支
gh_upload_project(path, allowSensitive=true)                   # 放过凭据扫描（慎用）
gh_upload_project(path, allowForce=true)                       # 推送被拒时 --force-with-lease
```

### 面板

侧边栏图标「GitHub 上传」→ 填令牌 → 填项目目录 → **预检（只读）** → **上传到 GitHub**。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `path` | 工作区根目录 | 项目目录绝对路径 |
| `repo` | 按目录名推导 | 仓库名；也可直接粘 GitHub URL 自动解析 |
| `owner` | 令牌所属账号 | 用户名或组织名；也可粘 URL |
| `private` | `true` | 是否私有仓库 |
| `commitMessage` | 自动生成 | 提交信息 |
| `branch` | `main` | 推送分支 |
| `allowSensitive` | `false` | 扫描到疑似凭据时仍继续 |
| `allowForce` | `false` | 用 `--force-with-lease` 强推 |
| `dryRun` | `false` | 只预演，不写入、不推送 |

## 安全设计

- **令牌绝不落在命令行上**：通过内存中的 `GIT_ASKPASS` 脚本 + 子进程环境变量传递，
  因此不会出现在进程列表、`.git/config` 的 remote URL 或任何 git 配置文件里。
- **凭据扫描默认拦截**：命中 `.env`、`id_rsa`、`*.pem`、`*.jks`、私钥块、`ghp_*`、
  `AKIA*`、`sk-*` 等特征时，默认**中止上传**，需要显式 `allowSensitive=true` 才继续。
- **日志脱敏**：任何回显的错误与警告都会先经过令牌与 URL 凭据的脱敏。
- **符号链接不跟随**：避免读到项目外部的内容。
- **推送失败也给结构化结果**：仓库已建好，可直接重试；`non-fast-forward` 会提示
  `git pull --rebase` 或 `allowForce`。

## 前置要求

- 已安装 `git` 并在 PATH 中
- 一个具备 `repo` 权限的 GitHub 令牌

`gh` CLI **不需要**。

## 配置项（可选）

在 profile 的 `cordis.patch.yml` 给插件行加 `config`：

```yaml
- id: github-upload
  name: dsh-github-upload
  config:
    tokenRef: GITHUB_TOKEN      # 令牌的凭据引用名
    defaultPrivate: true        # 新仓库默认私有
    defaultBranch: main         # 推送分支
    commitMessage: ""           # 默认提交信息，留空则自动生成
    allowSensitive: false       # 允许上传扫描到凭据的项目
    timeoutMs: 600000           # 单条 git 命令超时（毫秒）
    maxScanFiles: 8000          # 凭据扫描文件数上限
```

## 卸载

```bash
dsh plugin --profile desktop remove dsh-github-upload
```

## 开发

```bash
node --test test/*.test.mjs        # 51 个用例：纯逻辑 + 假 git/API 的完整流程
node scripts/live-smoke.mjs        # 真实 git 的端到端冒烟（不联网）
node scripts/apply-harness.mjs     # 用 mock ctx 验证 apply() 的注册接线
node scripts/http-check.mjs http://127.0.0.1:PORT  # 对已启动的 host 做 HTTP 校验
```

## 结构

```
lib/detect.js    纯函数：技术栈识别、.gitignore 生成、凭据特征、命名规范化、脱敏
lib/scan.js      有界目录遍历 + 凭据扫描（不跟随符号链接）
lib/git.js       git 子进程封装 + 内存 askpass 助手
lib/github.js    最小 GitHub REST 客户端（whoami / 查仓库 / 建仓库）
lib/upload.js    预检与上传编排（依赖注入，可离线测）
lib/index.js     Host 半：HTTP 路由 + 三个 agent 工具
client.js        Web 面板
```
