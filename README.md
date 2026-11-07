# Bruno License Lab

**Deploy once. Connect from Bruno.**

[English](README.md) · [简体中文](README.zh-CN.md)

This folder contains the complete source, dependencies manifest, deployment scripts and tests. It can be copied and deployed independently. Terminal deployment requires Node.js 22+; the GitHub button uses Cloudflare’s build environment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oiltea94/bruno-license-lab)

Node.js 22+

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
3. Fill in the two secret fields below. Use a password manager to generate two different random 64-character ASCII strings; each field accepts 32–512 visible ASCII characters.
4. Deploy, then open the deployed URL followed by `/health`. Continue when it reports `status: "ok"` and `configured: true`.

| Secret | Purpose |
|---|---|
| `CONNECT_CODE` | The **License Key** you enter in Bruno; save this value |
| `SIGNING_KEY` | The server's private signing secret; do not enter it in Bruno |

Use the deployed Worker URL and your `CONNECT_CODE` in Bruno's License Server screen. Browser deployment does not create a local Key file. For updates, use the connected repository or `npm run deploy`; running a fresh local `setup` against the same Worker can replace its secrets. The button requires account authorization and secret input on first use; no local npm installation is needed for this browser flow.

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
| License Server URL | Setup's Server URL, without an API path |
| Email | Your email address; format is checked, no verification email is sent |
| License Key | The complete Key printed by setup |

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
