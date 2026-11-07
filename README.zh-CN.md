# Bruno License Lab

**部署服务，直接在 Bruno 中接入。**

[English](README.md) · [简体中文](README.zh-CN.md)

Bruno License Lab 是一个可自行部署的 Bruno 许可证协议实验服务，实现了许可证的激活、校验和刷新接口，支持本地运行和 Cloudflare Workers 部署。部署后，在 Bruno 原生的 **License → License Server** 界面填写服务地址、邮箱及你配置的激活 Key，即可接入自己的服务。

仓库包含完整服务端源码、部署脚本和测试。运行 `npm run setup` 可选择本地或 Cloudflare 部署，也可通过下方按钮从 GitHub 部署。终端部署需要 Node.js 22+；网页部署使用 Cloudflare 的构建环境。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oiltea94/bruno-license-lab)

Node.js 22+

[部署](#deploy) · [接入 Bruno](#connect) · [文件与凭据](#files) · [开发检查](#checks) · [免责声明](#disclaimer)

> 独立项目。生成的 Key 不是 Bruno 官方许可证。详见[免责声明](#disclaimer)。

<a id="deploy"></a>

## 部署

| 方式 | 准备条件 | 入口 |
|---|---|---|
| Cloudflare 网页部署 | Cloudflare 和 GitHub 账号 | 上方部署按钮 |
| 本地运行 | Node.js 22+ | `npm run setup` → 本地 |
| Cloudflare 终端部署 | Node.js 22+ 和 Cloudflare 账号 | `npm run setup` → Cloudflare |

### 从 GitHub 网页部署

1. 点击按钮，登录 Cloudflare 并连接 GitHub 账号。源仓库需要公开，并已上传本项目文件。
2. 选择新仓库和 Worker 的名称。构建命令留空，部署命令使用 `npm run deploy`。
3. 直接部署，无需填写 `CONNECT_CODE` 或 `SIGNING_KEY`。首次部署时，脚本会自动生成两个独立的随机密钥并保存到 Cloudflare。
4. 打开初始化密钥的那次部署的构建日志，找到 `License Key (CONNECT_CODE):`，复制并保存后面的值。私有的 `SIGNING_KEY` 不会显示。
5. 打开部署后的地址并加上 `/health`。确认返回 `status: "ok"` 和 `configured: true` 后，在 Bruno 的 License Server 界面填写 Worker 地址和刚才保存的 Key。

只需完成账号授权并选择仓库和 Worker，无需本机安装 npm，也无需手动生成密钥。网页部署不会生成本机 Key 文件。首次初始化时，日志会在上传前显示 Key，初始化成功后即可使用；如果忘记保存，可回到实际保存当前密钥的那次部署日志查找。

后续通过绑定仓库更新或运行 `npm run deploy`，都会保留已有的两项密钥。若远程只存在其中一项，脚本会停止初始化，保留现有密钥。若上传失败且远程未保存任何一项密钥，重试会生成新 Key，请保存重试日志中的新值；若报错前两项密钥实际上已保存，重试会保留它们，请使用上一次日志中的 Key。同一个 Worker 请等首次初始化结束后再启动下一次部署；脚本没有协调多个同时运行的初始化任务。已经部署过的服务继续使用原来的 Key。在新的本地目录对同一 Worker 执行 `setup` 可能替换其密钥。

### 从终端部署

在本目录打开终端：

```sh
npm ci
npm run setup
```

选择 **1 — 本地运行** 或 **2 — Cloudflare**。setup 会显示 **Server URL**、**License Key** 和 Key 文件位置。提示语言可用 `--lang zh` 或 `--lang en` 指定。

| 方式 | 行为 |
|---|---|
| 本地运行 | 创建或复用凭据并启动服务；等待 Ready，保持终端打开 |
| Cloudflare | 打开浏览器登录、发布并检查健康状态；关闭终端后服务继续运行 |

也可跳过菜单，直接指定方式：

```sh
npm run setup -- --local
npm run setup -- --cloudflare
```

#### 本地运行说明

- 默认地址：`http://127.0.0.1:8787`。
- 停止：Ctrl+C。重启：再次执行 `npm run setup -- --local`，已有凭据会复用。
- 健康检查：`http://127.0.0.1:8787/health` 应显示 `status: "ok"` 和 `configured: true`。
- 换端口：`npm run setup -- --local --port 8788`。
- 不需要 Cloudflare 账号。服务在前台运行且仅监听本机，没有安装为操作系统服务。

#### Cloudflare 更新与域名

完成浏览器登录，使用 setup 输出的实际 `workers.dev` 地址。保留 `.secrets/remote-connection-code.txt`，供以后 setup 使用。后续更新代码执行：

```sh
npm run deploy
```

引导流程使用 `workers.dev`。如需自定义域名，在 Worker 中配置域名，并使用完全相同的 HTTPS origin；可设置 `PUBLIC_ORIGIN` 显式固定该 origin。

<a id="connect"></a>

## 在 Bruno 中使用

打开 **License**，选择 **License Server**，填写：

| 字段 | 内容 |
|---|---|
| License Server URL | 部署后的 Worker 地址或 setup 输出的 Server URL，不加 API 路径 |
| Email | 你的邮箱；只检查格式，不发送验证邮件 |
| License Key | 实际保存当前密钥的那次部署日志或终端 setup 输出的完整 Key |

点击 **Activate**。

<a id="files"></a>

## 文件与凭据

| 路径 | 用途 |
|---|---|
| `worker.mjs` | 激活、验证、刷新和健康检查接口 |
| `scripts/` | 初始化与部署命令 |
| `test/` | 服务和部署流程的回归测试 |
| `package.json`、`package-lock.json` | 命令与固定版本的依赖清单 |
| `wrangler.jsonc` | Worker 配置 |
| `.dev.vars` | 运行后生成的本地服务密钥 |
| `.secrets/` | 运行后生成的 Key 文件 |
| `node_modules/` | npm 安装的依赖 |

<details>
<summary>凭据备份与源码分享说明</summary>

成对保存 `.dev.vars` 与 `.secrets/local-connection-code.txt`。本地和远程 Key 相互独立，远程签名密钥保存在 Cloudflare。本地凭据不完整时请还原匹配的文件，setup 不会自动覆盖。远程上传密钥失败时，先检查 Cloudflare 密钥状态再重试。更换签名密钥会使旧令牌失效。

分享源码时，保留源码及配置文件、`scripts/`、`test/` 和两份 README。排除 `.dev.vars`、`.secrets/`、依赖、`.tooling/`、`.wrangler/`、`.tmp/`、`.npm-cache/`、`.dry-run/`。setup 的终端输出会显示激活 Key。

</details>

<a id="checks"></a>

## 检查源码与构建

```sh
npm test
npm run dry-run
```

<a id="disclaimer"></a>

## 免责声明

- **独立项目。** 本项目独立开发，与 Bruno 或 Cloudflare 团队没有隶属关系，也未由其认可或维护。第三方产品名称仅用于说明兼容性。
- **用途与授权。** 本项目用于协议研究、互操作实验，以及在你拥有或获准操作的环境中进行测试。使用者负责取得实际使用所需的权限。
- **不授予官方许可证。** 本服务生成的 Key 和令牌不是 Bruno 官方签发的许可证，不代表已购买产品或订阅服务，不授予付费软件或云服务的使用权，也不替代相关权利人的授权。客户端显示激活成功，不等于已取得这些权利。
- **使用者责任。** 使用者负责自身部署、访问控制、凭据保管、数据备份和托管费用，并遵守适用法律、第三方软件许可证及服务条款。
- **无担保。** 本项目按“现状”和“可用状态”提供，不对可用性、兼容性、安全性或特定用途适用性作出担保。在适用法律允许的范围内，作者及贡献者不对使用本项目造成的损失承担责任；本条不排除适用法律规定不得排除的责任。
- **声明范围。** 本声明不授予知识产权或第三方服务的使用许可，也不替代软件许可证或实际使用所需的授权。
