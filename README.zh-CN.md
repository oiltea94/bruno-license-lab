# Bruno License Lab

**部署服务，直接在 Bruno 中接入。**

[![Node.js ≥22](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat&logo=nodedotjs&logoColor=white)](#deploy)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](#deploy)
[![自托管](https://img.shields.io/badge/Self--hosted-2563EB?style=flat)](#deploy)

[English](README.md) · [简体中文](README.zh-CN.md)

Bruno License Lab 是一个可自行部署的 Bruno 许可证协议实验服务，支持 Cloudflare Workers 和本地运行。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oiltea94/bruno-license-lab)

[部署](#deploy) · [接入 Bruno](#connect) · [开发检查](#checks) · [免责声明](#disclaimer)

> 独立项目。生成的 Key 不是 Bruno 官方许可证。详见[免责声明](#disclaimer)。

<a id="deploy"></a>

## 部署

### Cloudflare

1. 点击上方部署按钮，登录 Cloudflare 并授权 GitHub，选择新仓库和 Worker 名称。
2. 构建命令留空，部署命令保持默认（`npx wrangler deploy` 或 `npm run deploy`），无需手动配置密钥。
3. 在初始化日志中找到 `License Key (CONNECT_CODE):`，复制并保存后面的 Key。
4. 等待部署成功，使用 Worker 地址和 Key [接入 Bruno](#connect)。

后续更新保留原 Key。仓库所有者可直接在 Cloudflare 控制台连接现有仓库。

<details>
<summary>部署排错与自定义域名</summary>

- **仓库重名：** 部署按钮会创建新仓库；换一个名称，或在 Cloudflare 控制台连接已有仓库。
- **日志没有 Key：** 确认构建使用最新代码。若提示 `Existing credentials preserved`，请使用原 Key，或到首次保存密钥的构建日志查找。
- **确认服务状态：** 访问 Worker 地址加 `/health`，应返回 `status: "ok"` 和 `configured: true`。
- **部署失败后重试：** 若密钥已保存，重试保留原 Key，即使上次代码部署失败也是如此；若未保存，重试会生成新 Key，请保存新值。只有一项密钥时，先在 Cloudflare 恢复缺失项。首次初始化完成前，请勿同时启动另一次部署。
- **自定义域名：** 在 Worker 中配置域名，并在 Bruno 中填写完全相同的 HTTPS origin；可用 `PUBLIC_ORIGIN` 显式固定该 origin。

</details>

### 本地运行

需要 Node.js 22+。在项目目录运行：

```sh
npm ci
npm run setup
```

保存输出中的 **Server URL** 和 **License Key**，等待 **Ready** 后接入 Bruno。使用期间保持终端打开，按 **Ctrl+C** 停止。

<details>
<summary>端口、语言与凭据备份</summary>

- 默认地址：`http://127.0.0.1:8787`，仅监听本机。
- 重启：再次运行 `npm run setup`，复用已有凭据。
- 换端口：`npm run setup -- --port 8788`。
- 切换语言：`npm run setup -- --lang zh` 或 `--lang en`。
- 备份：成对保存 `.dev.vars` 和 `.secrets/local-connection-code.txt`。凭据不完整时，还原同一份备份中的两个文件；setup 不会自动覆盖已有凭据。

</details>

<a id="connect"></a>

## 接入 Bruno

打开 **License → License Server**，填写后点击 **Activate**：

| 字段 | 内容 |
|---|---|
| License Server URL | Worker 地址或本地 Server URL，不加 API 路径 |
| Email | 你的邮箱，只检查格式，无需邮件验证 |
| License Key | 部署初始化日志或本地 setup 输出的完整 Key |

<a id="checks"></a>

## 开发检查

```sh
npm test
npm run dry-run
```

<a id="disclaimer"></a>

## 免责声明

<details>
<summary>查看完整声明</summary>

- **独立项目。** 本项目独立开发，与 Bruno 或 Cloudflare 团队没有隶属关系，也未由其认可或维护。第三方产品名称仅用于说明兼容性。
- **用途与授权。** 本项目用于协议研究、互操作实验，以及在你拥有或获准操作的环境中进行测试。使用者负责取得实际使用所需的权限。
- **不授予官方许可证。** 本服务生成的 Key 和令牌不是 Bruno 官方签发的许可证，不代表已购买产品或订阅服务，不授予付费软件或云服务的使用权，也不替代相关权利人的授权。客户端显示激活成功，不等于已取得这些权利。
- **使用者责任。** 使用者负责自身部署、访问控制、凭据保管、数据备份和托管费用，并遵守适用法律、第三方软件许可证及服务条款。
- **无担保。** 本项目按“现状”和“可用状态”提供，不对可用性、兼容性、安全性或特定用途适用性作出担保。在适用法律允许的范围内，作者及贡献者不对使用本项目造成的损失承担责任；本条不排除适用法律规定不得排除的责任。
- **声明范围。** 本声明不授予知识产权或第三方服务的使用许可，也不替代软件许可证或实际使用所需的授权。

</details>
