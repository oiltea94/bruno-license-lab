# Bruno License Lab

**Deploy once. Connect from Bruno.**

[![Node.js ≥22](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat&logo=nodedotjs&logoColor=white)](#deploy)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](#deploy)
[![Self-hosted](https://img.shields.io/badge/Self--hosted-2563EB?style=flat)](#deploy)

[English](README.md) · [简体中文](README.zh-CN.md)

Bruno License Lab is a self-hosted service for experimenting with Bruno’s license server protocol. It implements license activation, verification and refresh, and can run locally or on Cloudflare Workers. Deploy the service, then enter its URL, an email address and your configured activation key in Bruno’s built-in **License → License Server** screen.

The repository includes the complete server source, deployment scripts and tests. Use `npm run setup` for local or Cloudflare deployment, or the button below for deployment from GitHub. Terminal deployment requires Node.js 22+; browser deployment uses Cloudflare’s build environment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oiltea94/bruno-license-lab)

[Deploy](#deploy) · [Connect Bruno](#connect) · [Files & credentials](#files) · [Checks](#checks) · [Disclaimer](#disclaimer)

> Independent project. Generated keys are not official Bruno licenses. See the [disclaimer](#disclaimer).

<a id="deploy"></a>

## Deploy

| Option | Requirements | Entry point |
|---|---|---|
| Cloudflare in a browser | Cloudflare and GitHub accounts | Deploy button above |
| Local service | Node.js 22+ | `npm run setup` → Local |
| Cloudflare from a terminal | Node.js 22+ and a Cloudflare account | `npm run setup` → Cloudflare |

### Deploy from GitHub

1. Click the button, sign in to Cloudflare, and connect your GitHub account. The source repository must be public and contain these project files.
2. Choose the new repository and Worker names. Keep the build command empty and use `npm run deploy` as the deploy command.
3. Deploy without entering `CONNECT_CODE` or `SIGNING_KEY`. On the first deployment, the script automatically generates two independent random secrets and stores them in Cloudflare.
4. Open the build log of the deployment that initializes the secrets, find `License Key (CONNECT_CODE):`, and copy the value. The private `SIGNING_KEY` is never printed. Save the Key for future use.
5. Open the deployed URL followed by `/health`. Continue when it reports `status: "ok"` and `configured: true`, then use the Worker URL and your Key in Bruno's License Server screen.

Only account authorization and repository/Worker choices are required; no local npm installation or manual secret generation is needed. Browser deployment does not create a local Key file. The Key appears during first-time initialization, before upload, and becomes usable once initialization succeeds. If it is lost, retrieve it from the log of the attempt that stored the current secrets.

Later deployments through the connected repository or `npm run deploy` preserve both existing secrets. An incomplete secret pair stops initialization without overwriting either secret. If upload fails and neither secret was stored, a retry generates a new Key: save the Key from that retry. If both secrets were stored despite the error, a retry preserves them: use the Key printed by the earlier attempt. Wait for initial setup to finish before starting another deployment of the same Worker; simultaneous initializations are not coordinated. For an existing service, keep using your current Key. Running a fresh local `setup` against the same Worker can replace its secrets.

### Deploy from a terminal

Open a terminal in this folder:

```sh
npm ci
npm run setup
```

Choose **1 — Local** or **2 — Cloudflare**. Setup prints the **Server URL**, **License Key** and Key file location. Use `--lang en` or `--lang zh` to select the prompt language.

| Mode | Behavior |
|---|---|
| Local | Creates or reuses credentials and starts the service; wait for Ready and keep the terminal open |
| Cloudflare | Opens browser login, deploys and checks health; the service stays online when the terminal closes |

For a specific mode without the menu:

```sh
npm run setup -- --local
npm run setup -- --cloudflare
```

#### Local runtime

- Default URL: `http://127.0.0.1:8787`.
- Stop: Ctrl+C. Restart: run `npm run setup -- --local` again; existing credentials are reused.
- Health: `http://127.0.0.1:8787/health` should report `status: "ok"` and `configured: true`.
- To change port: `npm run setup -- --local --port 8788`.
- No Cloudflare account is needed. This foreground service listens only on the local computer; it is not installed as an OS service.

#### Cloudflare updates and domains

Complete the browser login and use the actual `workers.dev` URL printed by setup. Keep `.secrets/remote-connection-code.txt` for subsequent setup runs. To publish later code updates:

```sh
npm run deploy
```

The guided flow uses `workers.dev`. For a custom domain, configure it on the Worker and use that exact HTTPS origin; `PUBLIC_ORIGIN` may be set to fix the origin explicitly.

<a id="connect"></a>

## Connect Bruno

Open **License**, select **License Server**, then fill in:

| Field | Value |
|---|---|
| License Server URL | The deployed Worker URL or setup's Server URL, without an API path |
| Email | Your email address; format is checked, no verification email is sent |
| License Key | The complete Key from the log of the attempt that stored the current secrets, or terminal setup |

Click **Activate**.

<a id="files"></a>

## Files and credentials

| Path | Purpose |
|---|---|
| `worker.mjs` | Activation, verification, refresh and health endpoints |
| `scripts/` | Setup and deployment commands |
| `test/` | Service and setup regression tests |
| `package.json`, `package-lock.json` | Commands and pinned dependency versions |
| `wrangler.jsonc` | Worker configuration |
| `.dev.vars` | Generated local server secrets |
| `.secrets/` | Generated Key files |
| `node_modules/` | Dependencies installed by npm |

<details>
<summary>Credential backups and sharing source</summary>

Preserve `.dev.vars` and `.secrets/local-connection-code.txt` together. The local and hosted Keys are separate. Hosted signing secrets are stored in Cloudflare. If local credentials are incomplete, restore the matching files; setup does not automatically overwrite them. If a hosted secret upload fails, inspect the Cloudflare secrets before retrying. Changing the signing secret invalidates existing tokens.

To share source, include the source/configuration files, `scripts/`, `test/` and both READMEs. Exclude `.dev.vars`, `.secrets/`, dependencies, `.tooling/`, `.wrangler/`, `.tmp/`, `.npm-cache/` and `.dry-run/`. Setup displays the activation Key in its terminal output.

</details>

<a id="checks"></a>

## Check source and build

```sh
npm test
npm run dry-run
```

<a id="disclaimer"></a>

## Disclaimer

- **Independent project.** This project is independently developed and is not affiliated with, endorsed by, or maintained by the Bruno or Cloudflare teams. Product names identify compatibility only.
- **Purpose and authorization.** The project is intended for protocol research, interoperability experiments, and testing in environments you own or are authorized to operate. You are responsible for obtaining the permissions required for your use.
- **No official license grant.** Keys and tokens generated by this service are not licenses issued by Bruno. They do not establish a purchase or subscription, grant rights to paid software or cloud services, or replace authorization from the relevant rights holder. A successful activation response does not establish entitlement to those rights.
- **User responsibilities.** You are responsible for your deployment, access controls, credentials, backups, hosting charges, and compliance with applicable laws and third-party software licenses and service terms.
- **No warranty.** The project is provided “as is” and “as available,” without warranties regarding availability, compatibility, security, or fitness for a particular purpose. To the extent permitted by applicable law, the authors and contributors disclaim liability for losses resulting from use of the project. This does not exclude liability that applicable law does not permit to be excluded.
- **Scope of this notice.** This disclaimer does not grant intellectual-property rights or permission to use third-party services, and does not replace a software license or any permissions required for your use.
